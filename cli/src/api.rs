use crate::config::Config;
use crate::transcripts::Appended;
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ureq::http::Response;
use ureq::{Agent, RequestBuilder};

/// A business date as `/v2` writes one: an instant carrying its offset. Everything this host keeps
/// is epoch milliseconds, so the two readings live here and nowhere else. A number no instant can
/// be read out of is corrupt local state: reading it as the epoch would archive 1970 as the date
/// the session ran, which nothing downstream could tell from a session that really did.
pub fn written(ms: i64) -> Result<String> {
    Ok(Timestamp::from_millisecond(ms)
        .with_context(|| format!("{ms} is no instant this host can write as a date"))?
        .to_string())
}

mod iso {
    use super::{Deserializer, Serializer, Timestamp, written};
    use serde::Deserialize;

    pub fn serialize<S: Serializer>(ms: &i64, out: S) -> Result<S::Ok, S::Error> {
        out.serialize_str(&written(*ms).map_err(serde::ser::Error::custom)?)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(read: D) -> Result<i64, D::Error> {
        let text = String::deserialize(read)?;
        text.parse::<Timestamp>()
            .map(|at| at.as_millisecond())
            .map_err(serde::de::Error::custom)
    }
}

/// The words `/v2` writes an enum in, and the ones this host has always read them as. A clap flag,
/// a markdown frontmatter and a memory file all say `project`, so the case the wire carries is
/// turned here rather than at every place that prints one.
fn capitalised(word: &str) -> String {
    let lowered = word.to_lowercase();
    let mut chars = lowered.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn lowered<'de, D: Deserializer<'de>>(read: D) -> Result<String, D::Error> {
    Ok(String::deserialize(read)?.to_lowercase())
}

/// How a session's mode reads on the wire, where "the host could not tell" is a word of its own
/// rather than an empty string.
fn mode_out(mode: &str) -> &'static str {
    match mode {
        "interactive" => "Interactive",
        "headless" => "Headless",
        _ => "Unknown",
    }
}

fn mode_in<'de, D: Deserializer<'de>>(read: D) -> Result<String, D::Error> {
    let mode = String::deserialize(read)?;
    Ok(match mode.as_str() {
        "Interactive" => "interactive".to_string(),
        "Headless" => "headless".to_string(),
        _ => String::new(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub memory_id: String,
    #[serde(rename = "memoryName")]
    pub name: String,
    pub description: String,
    #[serde(rename = "type", deserialize_with = "lowered")]
    pub kind: String,
    pub body: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub recall_count: i64,
}

#[derive(Debug, Serialize)]
pub struct SaveBody<'a> {
    pub description: &'a str,
    #[serde(rename = "type")]
    pub kind: &'a str,
    pub body: &'a str,
    pub tags: &'a [String],
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub memory: Memory,
    pub created: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub score: f64,
    pub memory: Memory,
    #[serde(default)]
    pub in_scope: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub memories: Vec<Memory>,
    pub next_cursor: String,
}

#[derive(Deserialize)]
struct Single {
    memory: Memory,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub name: String,
    pub url: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub description: String,
    pub read: String,
    pub write: String,
    pub file_count: i64,
    pub bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_writer: String,
    #[serde(default)]
    pub share_count: i64,
    /// The artifact's live shares, present only where the listing was asked for them. It is what
    /// `recall shares` with no name reads, so sharing needs no collection of its own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<Share>,
}

/// Who one share admits, read straight off the `mode` the service discriminates its union on. A
/// link share carries no address: the token is printed once by the call that mints it and the
/// service holds only its hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Audience {
    Link,
    Email { address: String },
}

/// One grant of read access to one artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    #[serde(flatten)]
    pub audience: Audience,
    pub share_id: String,
    pub name: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_used_at: i64,
    pub uses: i64,
}

/// What one share answers. `address` is the whole address a recipient opens, printed on this one
/// response; `replaced` says a link share was already there and its token is now dead, and
/// `renewed` says the address already held a live share and its expiry moved instead.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    pub share: Share,
    pub address: String,
    #[serde(default)]
    pub replaced: bool,
    #[serde(default)]
    pub renewed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Shares {
    pub shares: Vec<Share>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Revoked {
    pub revoked: i64,
    pub shares: Vec<Share>,
}

/// Which shares a revoke names, which is exactly one of the three.
#[derive(Debug)]
pub enum Unshare {
    Link,
    Email(String),
    All,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub artifacts: Vec<Artifact>,
    pub next_cursor: String,
    pub total: i64,
    pub cut: bool,
}

#[derive(Debug, Deserialize)]
struct Adopted {
    adopted: i64,
}

/// What one publish sends. Every field is filled in by the caller rather than inferred by the
/// service, which is what makes a republish naming no title replace the old title with the name.
#[derive(Debug)]
pub struct PublishInput {
    pub name: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub read: String,
    pub write: String,
    pub replace: bool,
    pub files: Vec<PathBuf>,
}

/// What a listing is asked for. Each field passes straight to `GET /v2/artifacts`.
#[derive(Debug, Default)]
pub struct ArtifactQuery {
    pub query: String,
    pub kind: String,
    pub sort: String,
    pub limit: Option<u32>,
    pub cursor: String,
    /// Returns each row's shares instead of its count, which is what `recall shares` with no name
    /// walks cursor to cursor.
    pub shares: bool,
}

/// What one publish answers. `owned_by_another` says the name belongs to another account of this
/// recall, which published it with `write: account`; the publish went through and rewrote that
/// artifact's title and both its permissions, so the caller is told whose name they wrote under
/// rather than reading a URL that looks like their own.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub artifact: Artifact,
    #[serde(default)]
    pub owned_by_another: bool,
}

/// What a search answers with. `count` and `scopes` cover every match; `results` is the first page
/// of the ranking. A caller reading a count in the hundreds narrows with a scope it was told about
/// rather than paging blind.
#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub count: u32,
    pub results: Vec<Hit>,
    pub scopes: Vec<ScopeCount>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScopeCount {
    pub scope: String,
    pub count: u32,
}

/// What the prompt hook asks for: a handful of memories, without their bodies, ranked with the
/// ambient scope first.
#[derive(Debug, Serialize, Deserialize)]
pub struct InjectResult {
    pub hits: Vec<Injected>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Injected {
    pub score: f64,
    #[serde(rename = "memoryName")]
    pub name: String,
    #[serde(rename = "type", deserialize_with = "lowered")]
    pub kind: String,
    pub tags: Vec<String>,
    pub description: String,
    pub in_scope: bool,
}

/// What a search asks for. An empty `scope` searches every memory, which is the default; an empty
/// `prefer_scope` ranks on score alone.
pub struct SearchRequest<'a> {
    pub query: &'a str,
    pub scope: &'a [String],
    pub prefer_scope: &'a [String],
    pub limit: u32,
    pub min_score: f64,
    pub mode: &'a str,
}

pub struct InjectRequest<'a> {
    pub query: &'a str,
    pub prefer_scope: &'a [String],
    pub limit: u32,
    pub min_score: f64,
}

pub struct Client {
    agent: Agent,
    config: Config,
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

const MAX_NAME_LENGTH: usize = 100;

/// The cursor the service sends is what ends the walk through every share, so the walk is bounded
/// rather than trusting it to empty.
const MAX_SHARE_PAGES: usize = 100;

/// The service names an artifact by a kebab-case slug of at most 100 characters: lower case, every run
/// of anything else a single dash.
fn slug(text: &str) -> String {
    let mut name = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<&str>>()
        .join("-");
    name.truncate(MAX_NAME_LENGTH);
    name.trim_end_matches('-').to_string()
}

/// An artifact is published under the name the caller gave, or the name of the first file it was
/// written to. Both go through the same slug, so neither reaches the service in a shape it refuses.
pub fn artifact_name(path: &Path, given: Option<&str>) -> Result<String> {
    let source = match given {
        Some(given) => given.to_string(),
        None => path.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
    };
    let name = slug(&source);
    if name.is_empty() {
        bail!("{source:?} holds no letter or digit to name an artifact by");
    }
    Ok(name)
}

#[derive(Deserialize)]
struct Refusal {
    error: String,
}

/// The refusal the service named, where it named one. Every refusal it sends carries an `error`
/// the reader is meant to act on — which name is taken, when it was last written, what to pass
/// instead — and that string is printed as it stands rather than the JSON around it. A refusal
/// from the edge rather than the service names nothing, and reads as whatever it sent.
fn refused(text: &str) -> Option<String> {
    match serde_json::from_str::<Refusal>(text) {
        Ok(refusal) if !refusal.error.is_empty() => Some(refusal.error),
        _ => None,
    }
}

fn check(mut response: Response<ureq::Body>, what: &str) -> Result<Response<ureq::Body>> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let text = response.body_mut().read_to_string().unwrap_or_default();
    let named = refused(&text);
    let message = named.clone().unwrap_or_else(|| text.trim().to_string());
    if status.is_server_error() {
        bail!("{what} failed: the recall service had an error ({status}): {message}");
    }
    let hint = match status.as_u16() {
        300..=399 => "; Cloudflare Access redirected the call, check RECALL_ENDPOINT",
        401 | 403 if named.is_none() => "; run recall login",
        _ => "",
    };
    bail!("{what} failed with {status}: {message}{hint}")
}

/// The bytes one append crosses as, which is what the sender weighs against the ceiling the
/// service answers 413 with. It is built here and nowhere else because `send_json` writes pretty
/// JSON: a thousand records carry a line break and four spaces each that nothing on this side ever
/// counted, so an append weighed under the ceiling went over it on the wire and the service
/// refused a file that could never be sent any other way.
pub fn append_body(file: &str, from: i64, records: &[String], closed: bool) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "file": file, "from": from, "records": records, "closed": closed }))
        .expect("an append of strings serializes")
}

/// An artifact runs to 64 MB, and a long session's transcript to several; neither fits in the
/// twenty seconds every other call gets.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(300);

fn agent() -> Agent {
    Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

#[derive(Debug, Deserialize)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Deserialize)]
struct GrantError {
    error: String,
    #[serde(default)]
    error_description: String,
}

#[derive(Deserialize)]
struct Granted {
    access_token: String,
}

pub enum Poll {
    Granted(String),
    Pending,
    SlowDown,
    Denied,
    Expired,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    /// The machine this login was made from.
    pub host: String,
    /// The name to print for that machine: the label its owner gave it on the dashboard, and the
    /// machine's own name where it carries none. It is never empty.
    pub host_label: String,
    pub created_at: i64,
    pub last_used_at: i64,
    pub current: bool,
}

#[derive(Deserialize)]
struct Devices {
    devices: Vec<Device>,
}

/// A service too old to name a kind sends news, which is what every message was before orders.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    News,
    Order,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::News => "news",
            Kind::Order => "order",
        }
    }
}

/// What the service made of a send. News is published to whoever was attached and nothing more is
/// owed, which is a `Fanout`. An order names the session that took it, and `reason` is what the
/// sender is told when none did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Outcome {
    Fanout,
    #[serde(rename_all = "camelCase")]
    Taken {
        session_id: String,
    },
    Untaken {
        reason: String,
    },
}

/// `to_session_id` is the one session the message is addressed to, or empty for every session the
/// host has registered.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub message_id: String,
    #[serde(default)]
    pub kind: Kind,
    pub to_device_id: String,
    pub to_session_id: String,
    pub from_device_id: String,
    /// The sending host as its owner names it, its label first; empty from a service too old to
    /// name a sender, and the header then falls back to the device id.
    #[serde(default)]
    pub from_host: String,
    /// The handle of the session that sent it, which `recall send` takes back verbatim; empty when
    /// the sender named no session.
    #[serde(default)]
    pub from_name: String,
    pub body: String,
    pub created_at: i64,
}

/// `outcome` is absent from a service that predates orders, which is the only thing that tells
/// such a service apart from one that answered.
#[derive(Debug, Serialize, Deserialize)]
pub struct Sent {
    pub message: Message,
    #[serde(default)]
    pub outcome: Option<Outcome>,
}

/// What `recall post` resolves an address to. The vocabulary is `recall send`'s, with the one word
/// the bus has no use for: the fleet, which is every host signed in as this user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Board {
    Fleet,
    Host(String),
    Session(String),
}

/// The word that addresses every host on the account. It is read before the device listing, so a
/// host that answers to `fleet` is posted to by its label or its device id.
pub const FLEET: &str = "fleet";

/// `to` is read exactly as `recall send` reads it — a device id, a host's name or its label, or a
/// session handle — with `fleet` naming the whole account. A fleet post costs no listing at all.
pub fn resolve_board_target(
    devices: &[Device],
    sessions: impl FnOnce() -> Result<Vec<Session>>,
    to: &str,
) -> Result<Board> {
    if to == FLEET {
        return Ok(Board::Fleet);
    }
    let target = resolve_target(devices, sessions, to)?;
    if target.session_id.is_empty() {
        return Ok(Board::Host(target.device_id));
    }
    Ok(Board::Session(target.session_id))
}

/// One message on the board. `from_host` and `from_name` are resolved where it was posted and ride
/// with it, exactly as a bus message's do, so a session reading one looks nothing up.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardMessage {
    pub message_id: String,
    pub scope: String,
    pub target: String,
    pub from_device_id: String,
    pub from_host: String,
    pub from_name: String,
    pub body: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardTaker {
    pub session_id: String,
    pub device_id: String,
    pub host: String,
    pub picked_up_at: i64,
}

/// A message as the board shows it. One still waiting carries no taker at all, so nothing can print
/// an empty session as the one that took it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum BoardEntry {
    Waiting {
        message: BoardMessage,
    },
    #[serde(rename_all = "camelCase")]
    Taken {
        message: BoardMessage,
        taken_by: BoardTaker,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardPage {
    entries: Vec<BoardEntry>,
    next_cursor: String,
}

#[derive(Deserialize)]
struct PickedUp {
    messages: Vec<BoardMessage>,
}

/// How many pages of the board one listing walks.
const MAX_BOARD_PAGES: usize = 20;

/// One Claude Code session on one of the hosts signed in as this user, as the service holds it.
/// `name` is the handle `recall send` takes to reach this one session, so the listing doubles as
/// an address book.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub name: String,
    /// The name Claude Code gave the session, which is what its owner calls it. Empty for a
    /// session whose transcript the service has not read a name out of yet.
    #[serde(default)]
    pub agent_name: String,
    pub device_id: String,
    pub host: String,
    /// The name to print for that host: its label where it carries one, and the host itself
    /// otherwise. It is never empty.
    pub host_label: String,
    pub cwd: String,
    pub repo: String,
    pub branch: String,
    pub commit: String,
    #[serde(with = "iso")]
    pub started_at: i64,
    #[serde(with = "iso")]
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: crate::sessions::Focus,
    #[serde(deserialize_with = "mode_in")]
    pub mode: String,
    pub permission_mode: String,
    pub pid: i64,
    pub current: bool,
}

/// One session the account has on record, running or long over, as a lookup or a search gives it
/// back. `name` is the handle `recall send` takes and `agent_name` the name Claude Code gave the
/// session; either addresses it, as does the session id itself.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSession {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub agent_name: String,
    pub host: String,
    pub host_label: String,
    pub cwd: String,
    pub repo: String,
    pub branch: String,
    #[serde(with = "iso")]
    pub started_at: i64,
    #[serde(with = "iso")]
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: crate::sessions::Focus,
    pub running: bool,
}

/// One session a search found, and the stretch of its transcript that answered. The excerpt is
/// what the session said, verbatim.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    pub session: PastSession,
    pub score: f64,
    pub excerpt: Excerpt,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    pub speaker: String,
    pub text: String,
    #[serde(with = "iso")]
    pub at: i64,
}

/// One session and the transcript files the archive holds of it, which is everything a host needs
/// to put the session back on disk.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub session: PastSession,
    pub files: Vec<HeldFile>,
    /// How many sessions the name answered for. A name recurs, so more than one is ordinary and
    /// the most recently active is what came back; a caller writing to disk off that pick is told
    /// there was a choice.
    #[serde(default = "one")]
    pub matches: i64,
}

fn one() -> i64 {
    1
}

#[derive(Deserialize)]
struct SessionHits {
    hits: Vec<SessionHit>,
}

#[derive(Debug, Clone, Copy)]
pub struct SessionBody<'a> {
    pub host: &'a str,
    pub cwd: &'a str,
    pub repo: &'a str,
    pub branch: &'a str,
    pub commit: &'a str,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: &'a crate::sessions::Focus,
    pub mode: &'a str,
    pub permission_mode: &'a str,
    pub pid: i64,
}

impl SessionBody<'_> {
    /// The record as `/v2` takes one: the two dates carrying their offsets, and a mode that names
    /// the reading the host could not make rather than leaving the field blank.
    fn sent(&self, focus: &crate::sessions::Focus) -> Result<serde_json::Value> {
        Ok(serde_json::json!({
            "host": self.host,
            "cwd": self.cwd,
            "repo": self.repo,
            "branch": self.branch,
            "commit": self.commit,
            "startedAt": written(self.started_at)?,
            "lastActivityAt": written(self.last_activity_at)?,
            "prompts": self.prompts,
            "focus": focus,
            "mode": mode_out(self.mode),
            "permissionMode": self.permission_mode,
            "pid": self.pid,
        }))
    }
}

#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<Session>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryIds {
    session_ids: Vec<String>,
    next_cursor: String,
}

/// One of a session's transcript files as the archive holds it, said apart by the path that wrote
/// it. The two answer in places of different kinds — a stretch names a byte of the file on disk
/// and a record names a line of it, which redaction cannot move — so which of them holds a file is
/// what says whether a reader weighs its own copy in bytes or in records.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "held", rename_all = "camelCase")]
pub enum HeldFile {
    /// `bytes` is what the archive stores and `through` is how far into the file on disk that
    /// reaches; the two differ because a stretch goes up redacted. `named` is whether every key
    /// behind the reach names both ends of the span it holds, and reads as false where the service
    /// does not say — the reading that stops rather than the one that writes a local transcript
    /// over.
    Bytes {
        file: String,
        bytes: i64,
        through: i64,
        #[serde(default)]
        named: bool,
    },
    /// `bytes` is a length of the archive and no place in the file on disk, so a reader weighs its
    /// own copy against `records` and against nothing else.
    Records { file: String, bytes: i64, records: i64 },
}

impl HeldFile {
    pub fn file(&self) -> &str {
        match self {
            HeldFile::Bytes { file, .. } | HeldFile::Records { file, .. } => file,
        }
    }

    pub fn bytes(&self) -> i64 {
        match self {
            HeldFile::Bytes { bytes, .. } | HeldFile::Records { bytes, .. } => *bytes,
        }
    }
}

#[derive(Deserialize)]
struct HeldFiles {
    files: Vec<HeldFile>,
    #[serde(default)]
    counted: Vec<String>,
}

/// What the archive holds of one session: a row per file, and the files whose tokens have been
/// counted. The two move apart — a running session's records are archived on a beat of their own,
/// with no counting pass behind them — so neither ever stands in for the other.
#[derive(Debug, Default)]
pub struct Held {
    pub files: Vec<HeldFile>,
    pub counted: HashSet<String>,
}

/// The ordinal one file is waiting for, which is what an append answers with whether it landed or
/// was beaten to the place it was offered at. It is the only coordinate the two sides share.
#[derive(Deserialize)]
struct Waiting {
    next: i64,
}

/// The device a message is queued against, and the one session on it the message is for; an empty
/// `session_id` reaches every session that host has registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub device_id: String,
    pub session_id: String,
}

impl Target {
    /// Where the message is addressed, in the one shape every `/v2` endpoint carries. A session is
    /// addressed by itself and the device it runs on is read off it, where `/v1` had the caller
    /// name both and an empty session id meant every session on the device.
    fn addressed(&self) -> serde_json::Value {
        if self.session_id.is_empty() {
            return serde_json::json!({ "scope": "host", "target": self.device_id });
        }
        serde_json::json!({ "scope": "session", "target": self.session_id })
    }
}

/// `to` is a device id, a host's name or the label it carries, any of which reach every session on
/// that host, or a session handle, the name Claude Code gave a session or a session id, any of
/// which reach that one session. A device answers
/// first, so `sessions` is called only for a target no device claims and an ordinary host send
/// costs no listing.
///
/// A machine signing in more than once holds a login per sign-in, all under the one host, so they
/// collapse to the most recently used rather than reading as a crowd. That is a last-seen mark and
/// not a liveness signal — a token baked into a container goes on moving it without a daemon
/// behind it — but it is the best of them the service holds. Two distinct hosts answering to one
/// name or label is the real ambiguity: that names them all rather than picking one, and only the
/// device id settles it on its own.
pub fn resolve_target(devices: &[Device], sessions: impl FnOnce() -> Result<Vec<Session>>, to: &str) -> Result<Target> {
    let host = |device_id: &str| {
        Ok(Target {
            device_id: device_id.to_string(),
            session_id: String::new(),
        })
    };
    if devices.iter().any(|device| device.device_id == to) {
        return host(to);
    }
    let named: Vec<&Device> = devices
        .iter()
        .filter(|device| device.name == to || device.host == to || device.host_label == to)
        .collect();
    let mut machines: Vec<&str> = named.iter().map(|device| device.host.as_str()).collect();
    machines.sort_unstable();
    machines.dedup();
    match machines.as_slice() {
        [_] => {
            let newest = named
                .iter()
                .max_by_key(|device| device.last_used_at)
                .expect("a named machine holds at least one login");
            return host(&newest.device_id);
        }
        [] => {}
        _ => {
            let candidates: Vec<String> = named
                .iter()
                .map(|device| format!("{} ({})", device.name, device.device_id))
                .collect();
            bail!(
                "ambiguous target {to}: it names {} hosts; pass one of these device ids instead: {}",
                machines.len(),
                candidates.join(", ")
            )
        }
    }
    let listed = sessions()?;
    let addressed: Vec<&Session> = listed
        .iter()
        .filter(|session| session.name == to || session.agent_name == to || session.session_id == to)
        .collect();
    match addressed.as_slice() {
        [session] => Ok(Target {
            device_id: session.device_id.clone(),
            session_id: session.session_id.clone(),
        }),
        [] => bail!(
            "no host or session named {to}; recall devices lists the hosts signed in as you with any label they carry and recall sessions the handle of each live session"
        ),
        many => {
            let ids: Vec<&str> = many.iter().map(|session| session.session_id.as_str()).collect();
            bail!(
                "ambiguous target {to}: {} sessions answer to it; pass one of these session ids instead: {}",
                many.len(),
                ids.join(", ")
            )
        }
    }
}

pub struct DeviceLogin {
    agent: Agent,
    endpoint: String,
}

impl DeviceLogin {
    pub fn new(endpoint: &str) -> DeviceLogin {
        DeviceLogin {
            agent: agent(),
            endpoint: endpoint.trim_end_matches('/').to_string(),
        }
    }

    pub fn start(&self, device_name: &str) -> Result<DeviceStart> {
        let response = self
            .agent
            .post(format!("{}/v2/device/code", self.endpoint))
            .send_json(serde_json::json!({ "device_name": device_name }))?;
        Ok(check(response, "starting the device login")?.body_mut().read_json()?)
    }

    pub fn poll(&self, device_code: &str) -> Result<Poll> {
        let mut response = self
            .agent
            .post(format!("{}/v2/device/token", self.endpoint))
            .send_json(serde_json::json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
            }))?;
        if response.status().as_u16() == 400 {
            let grant: GrantError = response.body_mut().read_json()?;
            return match grant.error.as_str() {
                "authorization_pending" => Ok(Poll::Pending),
                "slow_down" => Ok(Poll::SlowDown),
                "access_denied" => Ok(Poll::Denied),
                "expired_token" => Ok(Poll::Expired),
                _ => bail!("the device login failed: {} {}", grant.error, grant.error_description),
            };
        }
        let granted: Granted = check(response, "finishing the device login")?.body_mut().read_json()?;
        Ok(Poll::Granted(granted.access_token))
    }
}

impl Client {
    pub fn new(config: Config) -> Client {
        Client { agent: agent(), config }
    }

    fn authed<B>(&self, request: RequestBuilder<B>) -> RequestBuilder<B> {
        request.header("authorization", format!("Bearer {}", self.config.token))
    }

    pub fn devices(&self) -> Result<Vec<Device>> {
        let response = self.authed(self.agent.get(self.url("/v2/devices"))).call()?;
        let devices: Devices = check(response, "listing devices")?.body_mut().read_json()?;
        Ok(devices.devices)
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<bool> {
        let response = self
            .authed(
                self.agent
                    .delete(self.url(&format!("/v2/devices/{}", encode(device_id)))),
            )
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("revoking device {device_id}"))?;
        Ok(true)
    }

    /// Revokes this host's own login, which it finds by reading its row off the listing. `/v1`
    /// answered a path segment that meant a different device depending on who sent the request,
    /// which is one nothing could be reasoned about from the outside.
    pub fn revoke_this_device(&self) -> Result<bool> {
        let Some(current) = self.devices()?.into_iter().find(|device| device.current) else {
            return Ok(false);
        };
        self.revoke_device(&current.device_id)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.config.endpoint)
    }

    fn memory_path(name: &str) -> String {
        format!("/v2/memories/{}", encode(name))
    }

    /// Whether the save created the memory or replaced one is the status and no longer a field
    /// beside it: `/v1` answered 201 and `created: true` together, which is one reading written
    /// twice and two things to keep in step.
    pub fn save(&self, name: &str, body: &SaveBody) -> Result<Saved> {
        let response = self
            .authed(self.agent.put(self.url(&Self::memory_path(name))))
            .send_json(SaveBody {
                kind: &capitalised(body.kind),
                ..*body
            })?;
        let created = response.status().as_u16() == 201;
        let single: Single = check(response, &format!("saving {name}"))?.body_mut().read_json()?;
        Ok(Saved {
            memory: single.memory,
            created,
        })
    }

    pub fn get(&self, name: &str) -> Result<Option<Memory>> {
        let response = self.authed(self.agent.get(self.url(&Self::memory_path(name)))).call()?;
        self.read(name, response)
    }

    /// Recalling a memory is a write, so it is a POST of its own: `/v1` folded it into the GET
    /// behind a query parameter, and every reader had to decide whether it meant to count as one.
    pub fn recall(&self, name: &str) -> Result<Option<Memory>> {
        let response = self
            .authed(
                self.agent
                    .post(self.url(&format!("{}/recall", Self::memory_path(name)))),
            )
            .send_empty()?;
        self.read(name, response)
    }

    fn read(&self, name: &str, response: Response<ureq::Body>) -> Result<Option<Memory>> {
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        let single: Single = check(response, &format!("reading {name}"))?.body_mut().read_json()?;
        Ok(Some(single.memory))
    }

    pub fn delete(&self, name: &str) -> Result<bool> {
        let response = self
            .authed(self.agent.delete(self.url(&Self::memory_path(name))))
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("deleting {name}"))?;
        Ok(true)
    }

    pub fn list(&self, tags: &[String], since: i64, cursor: &str, limit: u32) -> Result<Page> {
        let mut query = vec![format!("since={}", encode(&written(since)?)), format!("limit={limit}")];
        query.extend(tags.iter().map(|tag| format!("tags={}", encode(tag))));
        if !cursor.is_empty() {
            query.push(format!("cursor={}", encode(cursor)));
        }
        let response = self
            .authed(self.agent.get(self.url(&format!("/v2/memories?{}", query.join("&")))))
            .call()?;
        Ok(check(response, "listing memories")?.body_mut().read_json()?)
    }

    pub fn search(&self, request: &SearchRequest) -> Result<SearchResult> {
        let response = self
            .authed(self.agent.post(self.url("/v2/memories/search")))
            .send_json(serde_json::json!({
                "query": request.query,
                "scope": request.scope,
                "preferScope": request.prefer_scope,
                "limit": request.limit,
                "minScore": request.min_score,
                "mode": capitalised(request.mode),
            }))?;
        Ok(check(response, "searching")?.body_mut().read_json()?)
    }

    pub fn inject(&self, request: &InjectRequest) -> Result<InjectResult> {
        let response = self
            .authed(self.agent.post(self.url("/v2/memories/inject")))
            .send_json(serde_json::json!({
                "query": request.query,
                "preferScope": request.prefer_scope,
                "limit": request.limit,
                "minScore": request.min_score,
            }))?;
        Ok(check(response, "reading memories for a prompt")?
            .body_mut()
            .read_json()?)
    }

    fn session_path(session_id: &str) -> String {
        format!("/v2/sessions/{}", encode(session_id))
    }

    pub fn sessions(&self) -> Result<Vec<Session>> {
        let response = self.authed(self.agent.get(self.url("/v2/sessions"))).call()?;
        let listed: Sessions = check(response, "listing sessions")?.body_mut().read_json()?;
        Ok(listed.sessions)
    }

    /// Every session this account has on record, read to the last page. A host sending its past
    /// sessions back needs the whole set before it starts, since a transcript says nothing about
    /// whether the service already holds the session it describes.
    pub fn session_history_ids(&self) -> Result<HashSet<String>> {
        let mut held = HashSet::new();
        let mut cursor = String::new();
        loop {
            let mut query = "/v2/history".to_string();
            if !cursor.is_empty() {
                query.push_str(&format!("?cursor={}", encode(&cursor)));
            }
            let response = self.authed(self.agent.get(self.url(&query))).call()?;
            let page: HistoryIds = check(response, "listing the sessions on record")?
                .body_mut()
                .read_json()?;
            held.extend(page.session_ids);
            if page.next_cursor.is_empty() {
                return Ok(held);
            }
            cursor = page.next_cursor;
        }
    }

    /// One session, by its session id, by the name Claude Code gave it, or by the handle
    /// `recall send` takes. A name that answers for more than one session gives back the most
    /// recently active of them, which is the one a caller typing a name from memory means.
    pub fn session(&self, target: &str) -> Result<Option<StoredSession>> {
        let response = self
            .authed(self.agent.get(self.url(&Self::session_path(target))))
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        Ok(Some(
            check(response, &format!("reading session {target}"))?
                .body_mut()
                .read_json()?,
        ))
    }

    /// The sessions whose transcripts answer a query, across every host signed in as this user.
    pub fn search_sessions(&self, query: &str, limit: u32) -> Result<Vec<SessionHit>> {
        let path = format!("/v2/history?q={}&limit={limit}", encode(query));
        let response = self.authed(self.agent.get(self.url(&path))).call()?;
        let found: SessionHits = check(response, "searching sessions")?.body_mut().read_json()?;
        Ok(found.hits)
    }

    /// One of a session's transcript files, as it arrives. A transcript runs to megabytes, so it
    /// is read a buffer at a time rather than gathered in memory first.
    pub fn transcript_body(&self, session_id: &str, file: &str) -> Result<ureq::BodyReader<'static>> {
        let path = format!("{}/transcript?file={}", Self::session_path(session_id), encode(file));
        let request = self
            .agent
            .get(self.url(&path))
            .config()
            .timeout_global(Some(PUBLISH_TIMEOUT))
            .build();
        let response = self.authed(request).call()?;
        let body = check(response, &format!("reading {file} of session {session_id}"))?.into_body();
        Ok(body.into_reader())
    }

    /// One of a session's transcript files, written out as it arrives.
    pub fn read_transcript(&self, session_id: &str, file: &str, into: &mut impl std::io::Write) -> Result<u64> {
        Ok(std::io::copy(&mut self.transcript_body(session_id, file)?, into)?)
    }

    /// The focus line is the session's first prompt and its latest, which the host reads straight
    /// out of what the user typed. A key pasted into a prompt would otherwise reach the service
    /// and the dashboard in the clear, so it goes through the same reading every stretch of every
    /// transcript goes through. Both the hooks' sync and the backfill's send the record this way,
    /// so neither route carries one up.
    pub fn sync_session(&self, session_id: &str, body: &SessionBody) -> Result<()> {
        let focus = crate::sessions::Focus {
            first: crate::redact::text(&body.focus.first),
            latest: crate::redact::text(&body.focus.latest),
        };
        let response = self
            .authed(self.agent.put(self.url(&Self::session_path(session_id))))
            .send_json(body.sent(&focus)?)?;
        check(response, &format!("syncing session {session_id}"))?;
        Ok(())
    }

    /// Sends what this host's registry says about one session. The record is the document, so the
    /// command the hooks start and the daemon's own tick send the same reading of it.
    pub fn sync_record(&self, session_id: &str, record: &crate::sessions::Record) -> Result<()> {
        self.sync_session(
            session_id,
            &SessionBody {
                host: &record.host,
                cwd: &record.cwd.to_string_lossy(),
                repo: &record.repo,
                branch: &record.branch,
                commit: &record.commit,
                started_at: record.started_at,
                last_activity_at: record.last_activity_at,
                prompts: record.prompts,
                focus: &record.focus,
                mode: &record.mode,
                permission_mode: &record.permission_mode,
                pid: i64::from(record.pid),
            },
        )
    }

    /// Sends every event of one stretch, with the host and the repo it was spent in. Those two
    /// ride along rather than being read from the session row, so a session that already ended
    /// still has its closing tokens counted under the host that spent them.
    ///
    /// The events are the hooks' own and nothing here reads a counter out of one, so a counter
    /// they learn to read needs no change in this binary. Two fields are this binary's: the
    /// instant, which `/v2` takes with its offset named rather than as a count of milliseconds,
    /// and whether the reading is durable, which a hook pass is not.
    pub fn post_usage(
        &self,
        session_id: &str,
        host: &str,
        repo: &str,
        files: &[String],
        events: &[serde_json::Value],
    ) -> Result<usize> {
        for event in events {
            let mut delta = event.clone();
            let Some(fields) = delta.as_object_mut() else {
                bail!("a usage delta of session {session_id} is no JSON object");
            };
            let at = fields.get("at").and_then(serde_json::Value::as_i64).unwrap_or_default();
            fields.insert("at".to_string(), written(at)?.into());
            fields.entry("durable").or_insert(false.into());
            fields.insert("host".to_string(), host.into());
            fields.insert("repo".to_string(), repo.into());
            fields.insert("files".to_string(), files.into());
            let response = self
                .authed(
                    self.agent
                        .post(self.url(&format!("{}/usage", Self::session_path(session_id)))),
                )
                .send_json(&delta)?;
            check(response, &format!("sending usage for session {session_id}"))?;
        }
        Ok(events.len())
    }

    /// What the archive holds of one session: a row per transcript file, counted off the stored
    /// objects, and which files have had their tokens counted. It answers only for a session the
    /// account already has on record, and it is a listing, so it is asked once per session.
    pub fn transcript_files(&self, session_id: &str) -> Result<Held> {
        let response = self
            .authed(
                self.agent
                    .get(self.url(&format!("{}/files", Self::session_path(session_id)))),
            )
            .call()?;
        let held: HeldFiles = check(response, &format!("reading the archive of session {session_id}"))?
            .body_mut()
            .read_json()?;
        Ok(Held {
            files: held.files,
            counted: held.counted.into_iter().collect(),
        })
    }

    /// Appends a run of records to one of a session's transcript files and answers the ordinal the
    /// file waits at once they are in. The record at index `i` holds ordinal `from + i`, so an
    /// ordinal is a position and never a field, and `from` has to be the ordinal the file is
    /// waiting for: a run offered anywhere else is refused with the one it really waits at, which
    /// is where the next run begins.
    pub fn append_records(
        &self,
        session_id: &str,
        file: &str,
        from: i64,
        records: &[String],
        closed: bool,
    ) -> Result<Appended> {
        let mut response = self
            .authed(
                self.agent
                    .post(self.url(&format!("{}/records", Self::session_path(session_id))))
                    .header("content-type", "application/json"),
            )
            .send(&append_body(file, from, records, closed)[..])?;
        if response.status().as_u16() == 409 {
            // Every refusal of a run of records carries the ordinal to send from, because the only
            // thing a host can do with one is send again from there. A session the byte path wrote
            // is answered ordinal 0, which is the replay that takes it over.
            let refused: serde_json::Value = response.body_mut().read_json()?;
            if let Some(next) = refused.get("next").and_then(serde_json::Value::as_i64) {
                return Ok(Appended::Refused(next));
            }
            let named = refused.get("error").and_then(serde_json::Value::as_str).unwrap_or("");
            bail!("archiving {file} of session {session_id} was refused: {named}");
        }
        let waiting: Waiting = check(response, &format!("archiving {file} of session {session_id}"))?
            .body_mut()
            .read_json()?;
        Ok(Appended::Written(waiting.next))
    }

    pub fn end_session(&self, session_id: &str) -> Result<bool> {
        let response = self
            .authed(self.agent.delete(self.url(&Self::session_path(session_id))))
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("ending session {session_id}"))?;
        Ok(true)
    }

    /// `from_session_id` is the session this send is running inside, which the service turns into
    /// the handle the delivered message tells its reader to answer on. It is empty where the
    /// sending process cannot say which session asked, and the header then names the host.
    pub fn send(&self, target: &Target, kind: Kind, from_session_id: &str, body: &str) -> Result<Sent> {
        let response = self
            .authed(self.agent.post(self.url("/v2/messages")))
            .send_json(serde_json::json!({
                "kind": kind.as_str(),
                "address": target.addressed(),
                "fromSessionId": from_session_id,
                "body": body,
            }))?;
        let sent: Sent = check(response, &format!("sending to {}", target.device_id))?
            .body_mut()
            .read_json()?;
        Ok(sent)
    }

    /// Puts one message on the board, where it waits for the first session that picks it up rather
    /// than for whoever is attached. `from_session_id` names the session posting it, as a send's
    /// does, and is empty where the posting process cannot say which session asked.
    pub fn post_board(&self, target: &Board, from_session_id: &str, body: &str) -> Result<BoardMessage> {
        let address = match target {
            Board::Fleet => serde_json::json!({ "scope": "fleet" }),
            Board::Host(device_id) => serde_json::json!({ "scope": "host", "target": device_id }),
            Board::Session(session_id) => serde_json::json!({ "scope": "session", "target": session_id }),
        };
        let posted = serde_json::json!({ "address": address, "fromSessionId": from_session_id, "body": body });
        let response = self.authed(self.agent.post(self.url("/v2/board"))).send_json(&posted)?;
        Ok(check(response, "posting to the board")?.body_mut().read_json()?)
    }

    /// The whole board, walked page to page so the listing prints all of it.
    pub fn board(&self) -> Result<Vec<BoardEntry>> {
        let mut entries: Vec<BoardEntry> = Vec::new();
        let mut cursor = String::new();
        for _ in 0..MAX_BOARD_PAGES {
            let query = if cursor.is_empty() {
                "/v2/board".to_string()
            } else {
                format!("/v2/board?cursor={}", encode(&cursor))
            };
            let response = self.authed(self.agent.get(self.url(&query))).call()?;
            let page: BoardPage = check(response, "reading the board")?.body_mut().read_json()?;
            entries.extend(page.entries);
            if page.next_cursor.is_empty() {
                return Ok(entries);
            }
            cursor = page.next_cursor;
        }
        bail!("reading the board did not reach its last page in {MAX_BOARD_PAGES} reads");
    }

    /// Takes this session's board messages, which is the acknowledgement: what comes back is what
    /// this session's own claim won, and no other session will ever be handed it.
    pub fn pickup(&self, session_id: &str) -> Result<Vec<BoardMessage>> {
        let response = self
            .authed(self.agent.post(self.url("/v2/board/pickup")))
            .send_json(serde_json::json!({ "sessionId": session_id }))?;
        let picked: PickedUp = check(response, "picking up the board")?.body_mut().read_json()?;
        Ok(picked.messages)
    }

    /// Publishes the files on disk, so their bytes travel from the file to the service without
    /// passing through whatever asked for it. The files land in the order they were named, which is
    /// the track order of an audio artifact, and the first of them is what the bare address serves.
    ///
    /// A name that already holds an artifact is refused unless `replace` says otherwise, and the
    /// refusal the service sends names what is there and is printed as it stands.
    pub fn publish(&self, input: &PublishInput) -> Result<Published> {
        let files = artifact_files(&input.files)?;
        let manifest = serde_json::json!({
            "type": input.kind,
            "title": input.title,
            "description": input.description,
            "read": input.read,
            "write": input.write,
            "files": files
                .iter()
                .map(|file| serde_json::json!({ "path": file.path, "bytes": file.bytes }))
                .collect::<Vec<_>>(),
        });
        let manifest = manifest.to_string();
        let boundary = boundary(&manifest, &files);
        let body = multipart(&boundary, &manifest, &files);
        let replace = if input.replace { "?replace=true" } else { "" };
        let request = self
            .agent
            .put(self.url(&format!("/v2/artifacts/{}{replace}", encode(&input.name))))
            .header("content-type", &format!("multipart/form-data; boundary={boundary}"))
            .config()
            .timeout_global(Some(PUBLISH_TIMEOUT))
            .build();
        let response = self.authed(request).send(&body[..])?;
        let published: Published = check(response, &format!("publishing {}", input.name))?
            .body_mut()
            .read_json()
            .with_context(|| format!("reading back where {} is published", input.name))?;
        Ok(published)
    }

    pub fn artifacts(&self, query: &ArtifactQuery) -> Result<ArtifactPage> {
        let mut params: Vec<String> = Vec::new();
        if !query.query.is_empty() {
            params.push(format!("q={}", encode(&query.query)));
        }
        if !query.kind.is_empty() {
            params.push(format!("type={}", encode(&query.kind)));
        }
        if !query.sort.is_empty() {
            params.push(format!("sort={}", encode(&query.sort)));
        }
        if let Some(limit) = query.limit {
            params.push(format!("limit={limit}"));
        }
        if !query.cursor.is_empty() {
            params.push(format!("cursor={}", encode(&query.cursor)));
        }
        if query.shares {
            params.push("shares=true".to_string());
        }
        let suffix = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let response = self
            .authed(self.agent.get(self.url(&format!("/v2/artifacts{suffix}"))))
            .call()?;
        Ok(check(response, "listing artifacts")?.body_mut().read_json()?)
    }

    /// Deletes the artifact and every one of its files. A name that holds none answers false, which
    /// is what the command reports rather than claiming it removed something.
    pub fn unpublish(&self, name: &str) -> Result<bool> {
        let response = self
            .authed(self.agent.delete(self.url(&format!("/v2/artifacts/{}", encode(name)))))
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("unpublishing {name}"))?;
        Ok(true)
    }

    /// Pulls the artifacts published before a row carried their type into the listing. It is run
    /// once per deployment: a migration cannot read storage and nothing sweeps on a schedule.
    pub fn adopt_artifacts(&self) -> Result<i64> {
        let response = self
            .authed(self.agent.post(self.url("/v2/artifacts/adopt")))
            .send_empty()?;
        let adopted: Adopted = check(response, "adopting artifacts")?.body_mut().read_json()?;
        Ok(adopted.adopted)
    }

    /// Shares one artifact. `address` names an email share and its absence a link share, whose
    /// token the answer prints once and no later call reads back.
    pub fn share(&self, name: &str, address: Option<&str>) -> Result<Shared> {
        let body = match address {
            Some(address) => serde_json::json!({ "mode": "email", "address": address }),
            None => serde_json::json!({ "mode": "link" }),
        };
        let response = self
            .authed(
                self.agent
                    .post(self.url(&format!("/v2/artifacts/{}/shares", encode(name)))),
            )
            .send_json(&body)?;
        Ok(check(response, &format!("sharing {name}"))?.body_mut().read_json()?)
    }

    pub fn shares(&self, name: &str) -> Result<Vec<Share>> {
        let response = self
            .authed(
                self.agent
                    .get(self.url(&format!("/v2/artifacts/{}/shares", encode(name)))),
            )
            .call()?;
        let held: Shares = check(response, &format!("reading the shares on {name}"))?
            .body_mut()
            .read_json()?;
        Ok(held.shares)
    }

    /// Every share the account holds, grouped by artifact. The listing is walked cursor to cursor,
    /// so the whole of it prints and not only the first page.
    pub fn every_share(&self) -> Result<Vec<Artifact>> {
        let mut shared: Vec<Artifact> = Vec::new();
        let mut cursor = String::new();
        for _ in 0..MAX_SHARE_PAGES {
            let page = self.artifacts(&ArtifactQuery {
                sort: "name".to_string(),
                shares: true,
                cursor: cursor.clone(),
                ..ArtifactQuery::default()
            })?;
            shared.extend(
                page.artifacts
                    .into_iter()
                    .filter(|artifact| !artifact.shares.is_empty()),
            );
            if page.next_cursor.is_empty() {
                return Ok(shared);
            }
            cursor = page.next_cursor;
        }
        bail!("listing every share did not reach its last page in {MAX_SHARE_PAGES} reads");
    }

    pub fn unshare(&self, name: &str, scope: &Unshare) -> Result<Revoked> {
        let selector = match scope {
            Unshare::Link => "link".to_string(),
            Unshare::Email(address) => format!("email={}", encode(address)),
            Unshare::All => "all=true".to_string(),
        };
        let response = self
            .authed(
                self.agent
                    .delete(self.url(&format!("/v2/artifacts/{}/shares?{selector}", encode(name)))),
            )
            .call()?;
        Ok(check(response, &format!("revoking the shares on {name}"))?
            .body_mut()
            .read_json()?)
    }
}

/// The boundary of one publish body. A file holds arbitrary bytes, so a fixed boundary is a string
/// an audio file can contain, and a file containing it splits its own part and is refused for a
/// byte count the caller can do nothing about. Each publish draws its own and then reads the bytes
/// it is about to send: a candidate that occurs in any part is discarded and the next one drawn, so
/// the boundary that ships appears nowhere in the body it delimits.
fn boundary(manifest: &str, files: &[PublishFile]) -> String {
    let mut seed = u128::from(std::process::id())
        ^ SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or_default();
    loop {
        let candidate = format!("recall-publish-{seed:032x}");
        let needle = candidate.as_bytes();
        let clear = !contains(manifest.as_bytes(), needle) && files.iter().all(|file| !contains(&file.body, needle));
        if clear {
            return candidate;
        }
        seed = seed
            .wrapping_mul(0x5851_f42d_4c95_7f2d)
            .wrapping_add(0x1405_7b7e_f767_814f);
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

#[derive(Debug)]
struct PublishFile {
    path: String,
    bytes: usize,
    body: Vec<u8>,
}

/// The path each file answers on under the artifact, taken from the file's own name so a reader
/// finds it where the markdown or the HTML pointed at it.
fn artifact_files(paths: &[PathBuf]) -> Result<Vec<PublishFile>> {
    if paths.is_empty() {
        bail!("name at least one file to publish");
    }
    let mut files = Vec::new();
    let mut taken = HashSet::new();
    for path in paths {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        if name.is_empty() || !name.starts_with(|first: char| first.is_ascii_alphanumeric()) {
            bail!("{} has no file name a reader could address it by", path.display());
        }
        if !taken.insert(name.clone()) {
            bail!("{name} is named twice; one publish holds each file once");
        }
        let body = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        files.push(PublishFile {
            path: name,
            bytes: body.len(),
            body,
        });
    }
    Ok(files)
}

fn multipart(boundary: &str, manifest: &str, files: &[PublishFile]) -> Vec<u8> {
    let mut body: Vec<u8> = Vec::new();
    let mut part = |headers: String, bytes: &[u8]| {
        body.extend_from_slice(format!("--{boundary}\r\n{headers}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    };
    part(
        "content-disposition: form-data; name=\"manifest\"\r\ncontent-type: application/json".to_string(),
        manifest.as_bytes(),
    );
    for file in files {
        part(
            format!(
                "content-disposition: form-data; name=\"file\"; filename=\"{}\"",
                file.path
            ),
            &file.body,
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/v2` takes a business date as an instant carrying its offset and refuses anything else, so
    /// a host whose dates read differently syncs no session at all.
    #[test]
    fn a_date_goes_up_as_an_instant_carrying_its_offset_and_reads_back_as_itself() {
        let shaped = |at: i64| {
            let written = written(at).unwrap();
            let (date, time) = written.split_once('T').expect("a date and a time");
            assert_eq!(date.len(), 10, "{written}");
            assert!(time.ends_with('Z'), "{written}");
            assert!(time.len() >= 9, "{written}");
            written
        };

        assert_eq!(shaped(1_762_000_000_000), "2025-11-01T12:26:40Z");
        assert_eq!(shaped(0), "1970-01-01T00:00:00Z");
        assert_eq!(shaped(1_762_000_000_123), "2025-11-01T12:26:40.123Z");

        let read: Session = serde_json::from_value(serde_json::json!({
            "sessionId": "s-1",
            "name": "laptop-9f8a",
            "agentName": "",
            "deviceId": "d-1",
            "host": "laptop",
            "hostLabel": "laptop",
            "cwd": "/home/you/src/recall",
            "repo": "",
            "branch": "",
            "commit": "",
            "startedAt": "2025-11-01T13:26:40.123+01:00",
            "lastActivityAt": written(1_762_000_000_000).unwrap(),
            "prompts": 0,
            "focus": { "first": "", "latest": "" },
            "mode": "Headless",
            "permissionMode": "default",
            "pid": 1,
            "current": false,
        }))
        .expect("a session as /v2 answers with one");
        assert_eq!(read.started_at, 1_762_000_000_123, "an offset other than Z is read too");
        assert_eq!(read.last_activity_at, 1_762_000_000_000);
        assert_eq!(read.mode, "headless", "and the mode reads in this host's own words");
    }

    /// A message names where it is going in the one `address` every `/v2` endpoint carries: a
    /// device for every session on a host, and a session for that one session.
    #[test]
    fn a_target_is_addressed_by_the_one_thing_it_names() {
        let host = Target {
            device_id: "d-1".to_string(),
            session_id: String::new(),
        };
        let session = Target {
            device_id: "d-1".to_string(),
            session_id: "9f8a1b2c".to_string(),
        };

        assert_eq!(
            host.addressed(),
            serde_json::json!({ "scope": "host", "target": "d-1" })
        );
        assert_eq!(
            session.addressed(),
            serde_json::json!({ "scope": "session", "target": "9f8a1b2c" }),
            "the device a session runs on is read off the session rather than named twice"
        );
    }

    #[test]
    fn reads_a_share_off_the_mode_the_service_discriminates_on() {
        let listed: Shares = serde_json::from_str(
            r#"{"shares":[
                {"mode":"link","shareId":"sh_one","name":"release-notes","createdAt":1,"expiresAt":2,"lastUsedAt":1,"uses":0},
                {"mode":"email","shareId":"sh_two","name":"release-notes","address":"jo@example.org","createdAt":1,"expiresAt":2,"lastUsedAt":1,"uses":3}
            ]}"#,
        )
        .expect("the share listing");
        let modes: Vec<&Audience> = listed.shares.iter().map(|share| &share.audience).collect();
        assert!(
            matches!(modes.as_slice(), [Audience::Link, Audience::Email { address }] if address == "jo@example.org")
        );
        assert_eq!(listed.shares[1].uses, 3);
    }

    /// A device as `/v2` answers with one, where the label is always filled in: a host carrying
    /// none is named by itself.
    fn device(device_id: &str, name: &str) -> Device {
        Device {
            device_id: device_id.to_string(),
            name: name.to_string(),
            host: name.to_string(),
            host_label: name.to_string(),
            created_at: 0,
            last_used_at: 0,
            current: false,
        }
    }

    fn relogin(device_id: &str, name: &str, host: &str, last_used_at: i64, label: &str) -> Device {
        Device {
            host: host.to_string(),
            host_label: label.to_string(),
            last_used_at,
            ..device(device_id, name)
        }
    }

    fn labelled_device(device_id: &str, name: &str, label: &str) -> Device {
        Device {
            host_label: label.to_string(),
            ..device(device_id, name)
        }
    }

    fn session(session_id: &str, name: &str, device_id: &str) -> Session {
        Session {
            session_id: session_id.to_string(),
            name: name.to_string(),
            agent_name: String::new(),
            device_id: device_id.to_string(),
            host: "laptop".to_string(),
            host_label: String::new(),
            cwd: "/home/you/src/recall".to_string(),
            repo: "repo:github.com/mvhenten/recall".to_string(),
            branch: "work".to_string(),
            commit: "feat(messaging): address one session".to_string(),
            started_at: 1_762_000_000_000,
            last_activity_at: 1_762_000_060_000,
            prompts: 2,
            focus: crate::sessions::Focus::default(),
            mode: "interactive".to_string(),
            permission_mode: "default".to_string(),
            pid: 4242,
            current: false,
        }
    }

    fn host(device_id: &str) -> Target {
        Target {
            device_id: device_id.to_string(),
            session_id: String::new(),
        }
    }

    #[test]
    fn a_file_name_becomes_the_page_name() {
        let name = |path: &str| artifact_name(Path::new(path), None).unwrap();
        assert_eq!(name("/home/you/Burn Up Chart.html"), "burn-up-chart");
        assert_eq!(name("burn_up.v2.html"), "burn-up-v2");
        assert_eq!(name("./reports/--Q3--.html"), "q3");
        assert!(artifact_name(Path::new("/home/you/....html"), None).is_err());
    }

    #[test]
    fn a_given_name_goes_through_the_same_slug() {
        let name = |given: &str| artifact_name(Path::new("page.html"), Some(given)).unwrap();
        assert_eq!(name("Q3 Report"), "q3-report");
        assert_eq!(name("already-a-slug"), "already-a-slug");
        assert_eq!(name(&"long".repeat(40)).len(), 100);
        assert_eq!(name(&format!("{} tail", "a".repeat(99))), "a".repeat(99));
        assert!(artifact_name(Path::new("page.html"), Some("!!")).is_err());
    }

    #[test]
    fn a_host_resolves_by_device_name_without_listing_the_sessions() {
        let devices = [device("d-1", "laptop"), device("d-2", "desktop")];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };

        assert_eq!(resolve_target(&devices, refuse, "desktop").unwrap(), host("d-2"));
        assert_eq!(resolve_target(&devices, refuse, "d-1").unwrap(), host("d-1"));
        let error = resolve_target(&devices, || Ok(Vec::new()), "deskstop")
            .unwrap_err()
            .to_string();
        assert!(error.contains("no host or session named deskstop"), "{error}");
    }

    #[test]
    fn a_handle_or_a_session_id_resolves_to_the_one_session_it_names() {
        let devices = [device("d-1", "laptop"), device("d-2", "desktop")];
        let sessions = || {
            Ok(vec![
                session("9f8a1b2c", "desktop-9f8a", "d-2"),
                session("c4e21a99", "laptop-c4e2", "d-1"),
            ])
        };
        let desktop_session = Target {
            device_id: "d-2".to_string(),
            session_id: "9f8a1b2c".to_string(),
        };

        assert_eq!(
            resolve_target(&devices, sessions, "desktop-9f8a").unwrap(),
            desktop_session
        );
        assert_eq!(resolve_target(&devices, sessions, "9f8a1b2c").unwrap(), desktop_session);
        let error = resolve_target(&devices, sessions, "desktop-9f8b")
            .unwrap_err()
            .to_string();
        assert!(error.contains("no host or session named desktop-9f8b"), "{error}");
    }

    #[test]
    fn a_label_reaches_the_host_that_carries_it() {
        let devices = [labelled_device("d-1", "ip-10-0-7-31", "core"), device("d-2", "desktop")];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };

        assert_eq!(resolve_target(&devices, refuse, "core").unwrap(), host("d-1"));
        assert_eq!(resolve_target(&devices, refuse, "ip-10-0-7-31").unwrap(), host("d-1"));
    }

    #[test]
    fn a_machine_signed_in_twice_answers_on_its_newest_login() {
        let devices = [
            relogin("d-1", "core-box", "core-box", 10, "core"),
            relogin("d-2", "core-box-2", "core-box", 20, "core"),
        ];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };

        assert_eq!(resolve_target(&devices, refuse, "core").unwrap(), host("d-2"));
        assert_eq!(resolve_target(&devices, refuse, "core-box").unwrap(), host("d-2"));
        assert_eq!(resolve_target(&devices, refuse, "d-1").unwrap(), host("d-1"));
    }

    #[test]
    fn two_hosts_that_answer_to_one_label_are_refused() {
        let devices = [
            labelled_device("d-1", "ip-10-0-7-31", "core"),
            labelled_device("d-2", "ip-10-0-7-32", "core"),
        ];
        let error = resolve_target(&devices, || Ok(Vec::new()), "core")
            .unwrap_err()
            .to_string();
        assert!(error.contains("ambiguous target core"), "{error}");
        assert!(error.contains("ip-10-0-7-31 (d-1), ip-10-0-7-32 (d-2)"), "{error}");
    }

    #[test]
    fn a_label_that_collides_with_another_hosts_name_is_refused() {
        let devices = [device("d-1", "core"), labelled_device("d-2", "tower", "core")];
        let error = resolve_target(&devices, || Ok(Vec::new()), "core")
            .unwrap_err()
            .to_string();
        assert!(error.contains("ambiguous target core"), "{error}");
        assert!(error.contains("core (d-1), tower (d-2)"), "{error}");
    }

    #[test]
    fn a_device_id_passes_through_even_when_it_is_also_a_name() {
        let devices = [device("d-1", "laptop"), device("d-2", "d-1")];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };
        assert_eq!(resolve_target(&devices, refuse, "d-1").unwrap(), host("d-1"));
    }

    #[test]
    fn a_device_answers_before_a_session_handle_that_reads_the_same() {
        let devices = [device("d-1", "laptop"), device("d-2", "laptop-c4e2")];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };
        assert_eq!(resolve_target(&devices, refuse, "laptop-c4e2").unwrap(), host("d-2"));
    }

    #[test]
    fn prints_the_refusal_the_service_named_and_nothing_around_it() {
        let body = serde_json::json!({
            "error": "panel-episode-12 already holds an audio artifact of 41.2 MB, last written 2026-11-04T09:12Z by you@example.com; pass --replace to replace it",
            "artifact": { "name": "panel-episode-12", "type": "audio", "bytes": 43_200_100 },
        })
        .to_string();
        let named = refused(&body).expect("the service named a refusal");
        assert!(
            named.starts_with("panel-episode-12 already holds an audio artifact"),
            "{named}"
        );
        assert!(named.ends_with("pass --replace to replace it"), "{named}");
        assert_eq!(refused("<html>Access denied</html>"), None);
        assert_eq!(refused("{\"error\":\"\"}"), None);
    }

    #[test]
    fn names_each_file_by_its_own_name_and_refuses_one_twice() {
        let dir = std::env::temp_dir().join(format!("recall-publish-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let one = dir.join("Track-01.MP3");
        let two = dir.join("track-02.mp3");
        std::fs::write(&one, "first").unwrap();
        std::fs::write(&two, "second-track").unwrap();

        let files = artifact_files(&[one.clone(), two.clone()]).unwrap();
        assert_eq!(
            files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
            ["track-01.mp3", "track-02.mp3"]
        );
        assert_eq!(files.iter().map(|file| file.bytes).collect::<Vec<_>>(), [5, 12]);

        let twice = artifact_files(&[one.clone(), one.clone()]).unwrap_err().to_string();
        assert!(twice.contains("named twice"), "{twice}");
        assert!(artifact_files(&[]).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_the_manifest_first_and_a_part_per_file() {
        let files = vec![PublishFile {
            path: "index.html".into(),
            bytes: 10,
            body: b"<p>one</p>".to_vec(),
        }];
        let body = String::from_utf8(multipart("xyz", "{\"type\":\"site\"}", &files)).unwrap();
        assert_eq!(
            body,
            "--xyz\r\ncontent-disposition: form-data; name=\"manifest\"\r\ncontent-type: application/json\r\n\r\n{\"type\":\"site\"}\r\n--xyz\r\ncontent-disposition: form-data; name=\"file\"; filename=\"index.html\"\r\n\r\n<p>one</p>\r\n--xyz--\r\n"
        );
    }

    #[test]
    fn draws_a_boundary_no_part_holds() {
        let manifest = "{\"type\":\"audio\"}";
        let plain = boundary(manifest, &[]);
        let held = vec![PublishFile {
            path: "track-01.mp3".into(),
            bytes: plain.len(),
            body: plain.clone().into_bytes(),
        }];
        let drawn = boundary(manifest, &held);
        assert_ne!(drawn, plain);
        assert!(
            !held[0]
                .body
                .windows(drawn.len())
                .any(|window| window == drawn.as_bytes())
        );
    }

    #[test]
    fn two_sessions_that_answer_to_one_handle_are_refused() {
        let devices = [device("d-1", "laptop")];
        let sessions = || {
            Ok(vec![
                session("c4e21a99", "laptop-c4e2", "d-1"),
                session("c4e2ff00", "laptop-c4e2", "d-1"),
            ])
        };

        let error = resolve_target(&devices, sessions, "laptop-c4e2")
            .unwrap_err()
            .to_string();
        assert!(error.contains("ambiguous target laptop-c4e2"), "{error}");
        assert!(error.contains("c4e21a99, c4e2ff00"), "{error}");
    }
}
