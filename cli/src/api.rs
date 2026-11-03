use crate::config::Config;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;
use ureq::http::Response;
use ureq::{Agent, RequestBuilder};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub memory_id: String,
    pub user_id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub body: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub recall_count: i64,
    pub last_recalled_at: i64,
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
pub struct Hit {
    pub score: f64,
    pub memory: Memory,
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
    pub bytes: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
struct Published {
    artifact: Artifact,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    #[serde(default)]
    pub elsewhere: Vec<Elsewhere>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Elsewhere {
    pub score: f64,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub tags: Vec<String>,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest<'a> {
    pub query: &'a str,
    pub tags: &'a [String],
    pub any: bool,
    pub limit: u32,
    pub min_score: f64,
    pub mode: &'a str,
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

/// The service names a page by a kebab-case slug of at most 100 characters: lower case, every run
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

/// A page is published under the name the caller gave, or the name of the file it was written to.
/// Both go through the same slug, so neither reaches the service in a shape it refuses.
pub fn artifact_name(path: &Path, given: Option<&str>) -> Result<String> {
    let source = match given {
        Some(given) => given.to_string(),
        None => path.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
    };
    let name = slug(&source);
    if name.is_empty() {
        bail!("{source:?} holds no letter or digit to name a page by");
    }
    Ok(name)
}

fn check(mut response: Response<ureq::Body>, what: &str) -> Result<Response<ureq::Body>> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let text = response.body_mut().read_to_string().unwrap_or_default();
    if status.is_server_error() {
        bail!(
            "{what} failed: the recall service had an error ({status}): {}",
            text.trim()
        );
    }
    let hint = match status.as_u16() {
        300..=399 => "; Cloudflare Access redirected the call, check RECALL_ENDPOINT",
        401 | 403 => "; run recall login",
        _ => "",
    };
    bail!("{what} failed with {status}: {}{hint}", text.trim())
}

/// A page runs to 16 MB, and a long session's transcript to several; neither fits in the twenty
/// seconds every other call gets.
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
    #[serde(default)]
    pub host: String,
    /// The name the user gave this host on the dashboard's labels tab, empty when it carries none.
    #[serde(default)]
    pub label: String,
    pub created_at: i64,
    pub last_used_at: i64,
    pub current: bool,
}

impl Device {
    fn machine(&self) -> &str {
        if self.host.is_empty() { &self.name } else { &self.host }
    }
}

#[derive(Deserialize)]
struct Devices {
    devices: Vec<Device>,
}

/// `to_session_id` is the one session the message is addressed to, or empty for every session the
/// host has registered.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub message_id: String,
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
    pub expires_at: i64,
}

#[derive(Deserialize)]
struct Sent {
    message: Message,
}

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
    /// The name the user gave `host` on the dashboard's labels tab, empty when it carries none.
    #[serde(default)]
    pub host_label: String,
    pub cwd: String,
    pub repo: String,
    pub branch: String,
    pub commit: String,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: crate::sessions::Focus,
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
    #[serde(default)]
    pub host_label: String,
    pub cwd: String,
    pub repo: String,
    pub branch: String,
    pub started_at: i64,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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

/// One usage delta: the event the hooks wrote, with the host and the repo it was spent in. Those
/// two ride along rather than being read from the session row, so a session that already ended
/// still has its closing tokens counted under the host that spent them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageBody<'a> {
    host: &'a str,
    repo: &'a str,
    /// The transcript files this delta read. It is what says their tokens are counted, which a
    /// run reading the same files back long after has nothing else to ask.
    files: &'a [String],
    #[serde(flatten)]
    event: &'a serde_json::Value,
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

/// How far into one of a session's transcript files the service has been written. It is the only
/// mark an archive resumes from, so nothing a host keeps locally can put the two out of step.
#[derive(Debug, Serialize, Deserialize)]
pub struct HeldFile {
    pub file: String,
    pub bytes: i64,
}

#[derive(Deserialize)]
struct HeldFiles {
    files: Vec<HeldFile>,
    #[serde(default)]
    counted: Vec<String>,
}

#[derive(Deserialize)]
struct Extent {
    offset: i64,
}

/// The device a message is queued against, and the one session on it the message is for; an empty
/// `session_id` reaches every session that host has registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub device_id: String,
    pub session_id: String,
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
        .filter(|device| {
            device.name == to || device.machine() == to || (!device.label.is_empty() && device.label == to)
        })
        .collect();
    let mut machines: Vec<&str> = named.iter().map(|device| device.machine()).collect();
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
            .post(format!("{}/v1/device/code", self.endpoint))
            .send_json(serde_json::json!({ "device_name": device_name }))?;
        Ok(check(response, "starting the device login")?.body_mut().read_json()?)
    }

    pub fn poll(&self, device_code: &str) -> Result<Poll> {
        let mut response = self
            .agent
            .post(format!("{}/v1/device/token", self.endpoint))
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
        let response = self.authed(self.agent.get(self.url("/v1/devices"))).call()?;
        let devices: Devices = check(response, "listing devices")?.body_mut().read_json()?;
        Ok(devices.devices)
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<bool> {
        let response = self
            .authed(
                self.agent
                    .delete(self.url(&format!("/v1/devices/{}", encode(device_id)))),
            )
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("revoking device {device_id}"))?;
        Ok(true)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.config.endpoint)
    }

    fn memory_path(name: &str) -> String {
        format!("/v1/memories/{}", encode(name))
    }

    pub fn save(&self, name: &str, body: &SaveBody) -> Result<Saved> {
        let response = self
            .authed(self.agent.put(self.url(&Self::memory_path(name))))
            .send_json(body)?;
        Ok(check(response, &format!("saving {name}"))?.body_mut().read_json()?)
    }

    pub fn get(&self, name: &str) -> Result<Option<Memory>> {
        self.read(name, &Self::memory_path(name))
    }

    pub fn recall(&self, name: &str) -> Result<Option<Memory>> {
        self.read(name, &format!("{}?recall=true", Self::memory_path(name)))
    }

    fn read(&self, name: &str, path: &str) -> Result<Option<Memory>> {
        let response = self.authed(self.agent.get(self.url(path))).call()?;
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
        let mut query = vec![format!("since={since}"), format!("limit={limit}")];
        query.extend(tags.iter().map(|tag| format!("tag={}", encode(tag))));
        if !cursor.is_empty() {
            query.push(format!("cursor={}", encode(cursor)));
        }
        let response = self
            .authed(self.agent.get(self.url(&format!("/v1/memories?{}", query.join("&")))))
            .call()?;
        Ok(check(response, "listing memories")?.body_mut().read_json()?)
    }

    pub fn search(&self, request: &SearchRequest) -> Result<SearchResult> {
        let response = self
            .authed(self.agent.post(self.url("/v1/search")))
            .send_json(request)?;
        Ok(check(response, "searching")?.body_mut().read_json()?)
    }

    fn session_path(session_id: &str) -> String {
        format!("/v1/sessions/{}", encode(session_id))
    }

    pub fn sessions(&self) -> Result<Vec<Session>> {
        let response = self.authed(self.agent.get(self.url("/v1/sessions"))).call()?;
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
            let mut query = "/v1/sessions?scope=history".to_string();
            if !cursor.is_empty() {
                query.push_str(&format!("&cursor={}", encode(&cursor)));
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
        let path = format!("/v1/sessions?scope=search&q={}&limit={limit}", encode(query));
        let response = self.authed(self.agent.get(self.url(&path))).call()?;
        let found: SessionHits = check(response, "searching sessions")?.body_mut().read_json()?;
        Ok(found.hits)
    }

    /// One of a session's transcript files, written out as it arrives. A transcript runs to
    /// megabytes, so it is streamed into the file rather than gathered in memory first.
    pub fn read_transcript(&self, session_id: &str, file: &str, into: &mut impl std::io::Write) -> Result<u64> {
        let path = format!("{}/transcript?file={}", Self::session_path(session_id), encode(file));
        let request = self
            .agent
            .get(self.url(&path))
            .config()
            .timeout_global(Some(PUBLISH_TIMEOUT))
            .build();
        let response = self.authed(request).call()?;
        let mut body = check(response, &format!("reading {file} of session {session_id}"))?.into_body();
        Ok(std::io::copy(&mut body.as_reader(), into)?)
    }

    pub fn sync_session(&self, session_id: &str, body: &SessionBody) -> Result<()> {
        let response = self
            .authed(self.agent.put(self.url(&Self::session_path(session_id))))
            .send_json(body)?;
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

    /// Sends every event of one stretch. The events are the hooks' own: nothing here reads inside
    /// one, so a counter the hooks learn to read needs no change in this binary.
    pub fn post_usage(
        &self,
        session_id: &str,
        host: &str,
        repo: &str,
        files: &[String],
        events: &[serde_json::Value],
    ) -> Result<usize> {
        for event in events {
            let response = self
                .authed(
                    self.agent
                        .post(self.url(&format!("{}/usage", Self::session_path(session_id)))),
                )
                .send_json(UsageBody {
                    host,
                    repo,
                    files,
                    event,
                })?;
            check(response, &format!("sending usage for session {session_id}"))?;
        }
        Ok(events.len())
    }

    /// What the service holds of one session: how far into each transcript file it has been
    /// written, counted off the stored objects, and which files have had their tokens counted. It
    /// answers only for a session the account already has on record. The count is a listing, so
    /// it is asked once per session and read from there.
    pub fn transcript_held(&self, session_id: &str) -> Result<crate::transcripts::Held> {
        let response = self
            .authed(
                self.agent
                    .get(self.url(&format!("{}/transcript", Self::session_path(session_id)))),
            )
            .call()?;
        let held: HeldFiles = check(response, &format!("reading the archive of session {session_id}"))?
            .body_mut()
            .read_json()?;
        Ok(crate::transcripts::Held {
            bytes: held.files.into_iter().map(|file| (file.file, file.bytes)).collect(),
            counted: held.counted.into_iter().collect(),
        })
    }

    /// Appends one stretch to one of a session's transcript files and answers where the file
    /// reaches once it is in. A stretch is stored under the offset it was sent at and only where
    /// nothing is yet, so one already there — a retry, or another writer that reached the offset
    /// first — is refused with where the file now reaches. That is the same answer: it is where
    /// the next stretch goes.
    pub fn append_transcript(&self, session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<i64> {
        let path = format!(
            "{}/transcript?file={}&offset={offset}",
            Self::session_path(session_id),
            encode(file)
        );
        let mut response = self
            .authed(self.agent.put(self.url(&path)))
            .header("content-type", "application/x-ndjson")
            .send(bytes)?;
        if response.status().as_u16() == 409 {
            let extent: Extent = response.body_mut().read_json()?;
            return Ok(extent.offset);
        }
        let extent: Extent = check(response, &format!("archiving {file} of session {session_id}"))?
            .body_mut()
            .read_json()?;
        Ok(extent.offset)
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
    pub fn send(&self, target: &Target, from_session_id: &str, body: &str) -> Result<Message> {
        let response = self
            .authed(self.agent.post(self.url("/v1/messages")))
            .send_json(serde_json::json!({
                "toDeviceId": target.device_id,
                "toSessionId": target.session_id,
                "fromSessionId": from_session_id,
                "body": body,
            }))?;
        let sent: Sent = check(response, &format!("sending to {}", target.device_id))?
            .body_mut()
            .read_json()?;
        Ok(sent.message)
    }

    /// Publishes the page on disk, so its HTML travels from the file to the service without
    /// passing through whatever asked for it. An existing name is replaced and keeps its URL.
    pub fn publish_file(&self, path: &Path, name: Option<&str>) -> Result<Artifact> {
        let name = artifact_name(path, name)?;
        let html = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let request = self
            .agent
            .put(self.url(&format!("/v1/artifacts/{}", encode(&name))))
            .config()
            .timeout_global(Some(PUBLISH_TIMEOUT))
            .build();
        let response = self.authed(request).send(&html[..])?;
        let published: Published = check(response, &format!("publishing {name}"))?
            .body_mut()
            .read_json()
            .with_context(|| {
                format!("reading back where {name} is published; a service older than 0.8 names no url")
            })?;
        Ok(published.artifact)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(device_id: &str, name: &str) -> Device {
        Device {
            device_id: device_id.to_string(),
            name: name.to_string(),
            host: name.to_string(),
            label: String::new(),
            created_at: 0,
            last_used_at: 0,
            current: false,
        }
    }

    fn relogin(device_id: &str, name: &str, host: &str, last_used_at: i64, label: &str) -> Device {
        Device {
            host: host.to_string(),
            label: label.to_string(),
            last_used_at,
            ..device(device_id, name)
        }
    }

    fn labelled_device(device_id: &str, name: &str, label: &str) -> Device {
        Device {
            label: label.to_string(),
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
