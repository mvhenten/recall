use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

/// A record carrying an inbox is one the daemon can deliver to; the rest say why it cannot.
/// `Adopted` is the one state no hook writes: a session that was already running when its hooks
/// were replaced has `recall sessions --adopt` read its record out of its transcript instead, and
/// that reading can carry no inbox.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum State {
    Registered(Inbox),
    Off,
    NoInbox,
    Adopted,
    Failed { error: String },
}

impl State {
    pub fn inbox(&self) -> Option<&Inbox> {
        match self {
            State::Registered(inbox) => Some(inbox),
            _ => None,
        }
    }
}

/// The credential that writes into a session, which no log line and no error may carry.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Token(pub String);

impl std::fmt::Debug for Token {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
}

/// `socket` and `token` are `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` as
/// the hook inherited them.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Inbox {
    pub socket: PathBuf,
    pub token: Token,
}

/// The two prompts a focus line is built from: the one that opened the session and the latest.
/// The hooks truncate both; nothing here calls a model.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Focus {
    pub first: String,
    pub latest: String,
}

/// How far into one of a session's transcript files the hooks have counted, and the last message
/// they counted there. A session writes one file of its own and one per delegated turn, and each
/// is read on its own: the message ids of one say nothing about another.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageFile {
    pub offset: i64,
    pub message_id: String,
}

/// The stretch of transcript the hooks read and have not seen land. Each event is one model's
/// share of the delta, and it is sent as the hooks wrote it: the reading is theirs, and nothing
/// here parses or recomputes it. `files`, `high_water` and `prompts` are where the next stretch
/// starts, and they move only once every event has been taken.
///
/// `files` is absent on a delta the hooks fixed before the files were read apart. Reading that as
/// none rather than refusing the whole record is what keeps a session live across the update that
/// added it: the stretch still goes out, and it names no file, because the record never said
/// which ones it read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsagePending {
    pub seq: i64,
    pub high_water: i64,
    pub prompts: i64,
    #[serde(default)]
    pub files: BTreeMap<String, UsageFile>,
    pub events: Vec<serde_json::Value>,
}

impl UsagePending {
    /// The transcript files this delta read, which is what says their tokens are counted. A delta
    /// naming none read none, so nothing is counted against a file on its account.
    pub fn files_read(&self) -> Vec<String> {
        self.files.keys().cloned().collect()
    }
}

/// How `hooks/session-start.mjs` left one Claude Code session. It writes
/// `$XDG_RUNTIME_DIR/recall/sessions/<session-id>.json` at mode 600 for every session, registered
/// or not, `hooks/recall-memories.mjs` rewrites the moving fields on every prompt, and
/// `recall sessions --end` removes it; the daemon only ever reads the directory.
///
/// `pid` is the Claude process that owns the session, whatever the state, so a record outliving a
/// session that never reached session end is removed on the next pass. `usageCountedAt`, which the
/// hooks use to throttle their own counting, is theirs alone and is not read back here, and so are
/// `usageFiles`, `usageHighWater` and `usagePrompts`, which say how far into each of the session's
/// transcript files the usage this host sent has reached. The archive keeps a mark of its own, on
/// the service, so neither reading can skip or replay the other.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub cwd: PathBuf,
    pub pid: i32,
    /// Absent on a record written before the registry described a session rather than just
    /// addressing one. Every field a later release added reads as empty rather than throwing away
    /// a record a running session still depends on; only `cwd`, `pid` and `state`, which the
    /// registry has always carried, are required, so a record malformed in any other way is still
    /// refused.
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub last_activity_at: i64,
    #[serde(default)]
    pub prompts: i64,
    #[serde(default)]
    pub focus: Focus,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub permission_mode: String,
    #[serde(default)]
    pub transcript_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_pending: Option<UsagePending>,
    #[serde(flatten)]
    pub state: State,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub session_id: String,
    pub record: Record,
}

#[derive(Debug, Clone)]
pub struct Registered {
    pub session_id: String,
    pub path: PathBuf,
    pub inbox: Inbox,
}

pub const DELIVER_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the service waits for the receipt naming the session that took an order. It mirrors
/// `TAKER_WINDOW_MS` in src/mailbox.ts, and the two have to agree: a session that takes an order
/// after the service has given up runs work its sender was already told nobody started.
pub const TAKER_WINDOW: Duration = Duration::from_secs(10);

/// What the walk over this host's sessions may spend: the window less one write timeout, so the
/// receipt is written while the send is still waiting even when the last session the walk tries
/// runs that timeout out.
pub const ORDER_WALK: Duration = TAKER_WINDOW.saturating_sub(DELIVER_TIMEOUT);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Fanout {
    pub delivered: usize,
    pub pruned: usize,
}

/// Whether the Claude process a record names is still there. A record outlives its process until a
/// sweep unlinks it, so this is what tells a session still running from one the registry has not
/// caught up with.
pub fn alive(pid: i32) -> bool {
    let procfs = Path::new("/proc");
    if procfs.is_dir() {
        return procfs.join(pid.to_string()).is_dir();
    }
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

fn read(path: &Path) -> Option<Status> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let record: Record = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(Status { session_id, record })
}

/// A session the registry outlived, carrying whatever its record still held: the delta it never
/// got to send goes out with the notice that the session is over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub session_id: String,
    pub host: String,
    pub repo: String,
    pub transcript_path: PathBuf,
    pub usage_pending: Option<UsagePending>,
}

/// What one pass over the registry found: the sessions still running, newest first, and the ones
/// it unlinked because their Claude process is gone. A session that ends without its SessionEnd
/// hook leaves a record here and a row on the service, and `ended` is the only notice either gets.
#[derive(Debug, Default)]
pub struct Scan {
    pub live: Vec<(PathBuf, Status)>,
    pub ended: Vec<Ended>,
}

/// A record whose Claude process is gone, or whose socket has been removed, is unlinked on the way
/// past, so a session that never reached session end leaves nothing behind; a record that cannot be
/// parsed is left alone, because a half-written file becomes readable on the next pass. Only a dead
/// process ends a session: a socket can go while Claude stays, and that session is still running.
pub fn scan(dir: &Path) -> Scan {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Scan::default();
    };
    let mut live: Vec<(SystemTime, PathBuf, Status)> = Vec::new();
    let mut ended = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(status) = read(&path) else {
            continue;
        };
        let socketless = match &status.record.state {
            State::Registered(inbox) => !inbox.socket.exists(),
            _ => false,
        };
        if !alive(status.record.pid) {
            let _ = std::fs::remove_file(&path);
            ended.push(Ended {
                session_id: status.session_id,
                host: status.record.host,
                repo: status.record.repo,
                transcript_path: status.record.transcript_path,
                usage_pending: status.record.usage_pending,
            });
            continue;
        }
        if socketless {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        live.push((modified, path, status));
    }
    live.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.2.session_id.cmp(&right.2.session_id))
    });
    ended.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    Scan {
        live: live.into_iter().map(|(_, path, status)| (path, status)).collect(),
        ended,
    }
}

/// Every session still running, newest first.
pub fn status(dir: &Path) -> Vec<(PathBuf, Status)> {
    scan(dir).live
}

/// Every record the registry holds, read and nothing more. The sweep that unlinks the record of a
/// session whose process is gone belongs to one pass; a second pass sweeping as well would take
/// those records away before the notices they owe the service had gone out with them.
pub fn records(dir: &Path) -> Vec<Status> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<Status> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .filter_map(|path| read(&path))
        .collect();
    found.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    found
}

/// The record this host wrote for one session, whatever state the hook left it in.
pub fn record(dir: &Path, session_id: &str) -> Option<Record> {
    read(&record_path(dir, session_id)).map(|status| status.record)
}

/// The session a send is running inside, found by the inbox socket Claude passes down to
/// everything that session starts. Only a registered session is a candidate, so the handle the
/// header hands back always names a session that can receive the reply. A socket carrying more
/// than one registered session, as a delegated turn does, names none of them, because there is no
/// telling from here which of them asked. The registry is read and not swept: only the daemon may
/// retire a record, since it is also what tells the service the session is over.
pub fn sending_session(dir: &Path, socket: &Path) -> Option<String> {
    let mut owned = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| read(&entry.path()))
        .filter(|status| status.record.state.inbox().is_some_and(|inbox| inbox.socket == socket))
        .map(|status| status.session_id);
    let only = owned.next()?;
    owned.next().is_none().then_some(only)
}

fn record_path(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{session_id}.json"))
}

/// Takes a session's record out of the registry. The record carries the session's last usage
/// delta, so the command that ends a session reads it before removing it.
pub fn forget(dir: &Path, session_id: &str) {
    let _ = std::fs::remove_file(record_path(dir, session_id));
}

/// Moves the stretch that landed on and leaves every other field alone: the record is rewritten
/// from its own JSON rather than from `Record`, which models only what this binary reads, so the
/// fields the hooks own survive. A record that is gone is a session that ended under the send, and
/// nothing about it is worth keeping.
///
/// A delta naming no file moved no file along, so the marks are left where the hooks put them. A
/// delta the hooks fixed before the files were read apart is the only one that can, and writing
/// an empty set over its marks would have the next pass read every transcript from the top and
/// count again what it has already counted.
pub fn commit_usage(dir: &Path, session_id: &str, pending: &UsagePending) -> Result<()> {
    let path = record_path(dir, session_id);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let mut document: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("reading the record of session {session_id}"))?;
    let Some(fields) = document.as_object_mut() else {
        bail!("the record of session {session_id} is not a JSON object");
    };
    if !pending.files.is_empty() {
        fields.insert("usageFiles".to_string(), serde_json::to_value(&pending.files)?);
    }
    fields.insert("usageHighWater".to_string(), pending.high_water.into());
    fields.insert("usagePrompts".to_string(), pending.prompts.into());
    fields.remove("usagePending");
    std::fs::write(&path, format!("{}\n", serde_json::to_string(&document)?))
        .with_context(|| format!("writing the record of session {session_id}"))
}

pub const IDLE_AFTER: Duration = Duration::from_secs(300);
pub const FOCUS_SEPARATOR: &str = " → ";

/// State is read, never stored: a session prompted within `IDLE_AFTER` is busy and one that has
/// sat quiet since is idle. A session that is gone is one its own host deleted, so it is never
/// listed at all.
pub fn state(last_activity_at: i64, now: i64) -> &'static str {
    if now.saturating_sub(last_activity_at) < IDLE_AFTER.as_millis() as i64 {
        return "busy";
    }
    "idle"
}

/// How long ago, in the largest unit that still reads as a duration: 45s, 12m, 3h, 2d.
pub fn age(since: i64, now: i64) -> String {
    let seconds = now.saturating_sub(since).max(0) / 1000;
    for (unit, size) in [("d", 86_400), ("h", 3_600), ("m", 60)] {
        if seconds >= size {
            return format!("{}{unit}", seconds / size);
        }
    }
    format!("{seconds}s")
}

/// What the user typed, of a prompt a focus line holds. Claude Code writes several kinds of entry
/// as a user turn — a task notification, a system reminder, the expansion of a slash command — and
/// hooks/messaging.mjs moves the focus on before any of that is known, so one of them reaches a
/// record as markup. A focus read off a transcript is already clear of them, since adopt::typed
/// drops the entry outright.
pub fn user_written(prompt: &str) -> &str {
    if crate::adopt::ENVELOPES
        .iter()
        .any(|envelope| prompt.starts_with(envelope))
    {
        return "";
    }
    prompt
}

/// The focus line: the prompt that opened the session, then the latest one.
pub fn focus_line(focus: &Focus) -> String {
    if focus.first.is_empty() {
        return focus.latest.clone();
    }
    if focus.latest.is_empty() || focus.latest == focus.first {
        return focus.first.clone();
    }
    format!("{}{FOCUS_SEPARATOR}{}", focus.first, focus.latest)
}

/// The sessions worth delivering to, newest registration first.
fn registered(dir: &Path) -> Vec<Registered> {
    status(dir)
        .into_iter()
        .filter_map(|(path, status)| match status.record.state {
            State::Registered(inbox) => Some(Registered {
                session_id: status.session_id,
                path,
                inbox,
            }),
            _ => None,
        })
        .collect()
}

/// The registry file name is the session id Claude reports on the hook's stdin, and the delivered
/// frame carries it back, so a registration that outlived its session is dropped by Claude instead
/// of landing in whatever session now owns the socket.
fn frames(registered: &Registered, body: &str) -> String {
    let auth = serde_json::json!({ "type": "auth", "token": registered.inbox.token });
    let user = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": body },
        "session_id": registered.session_id,
    });
    format!("{auth}\n{user}\n")
}

async fn send(registered: &Registered, body: &str) -> Result<()> {
    let socket = &registered.inbox.socket;
    let mut stream = UnixStream::connect(socket)
        .await
        .with_context(|| format!("connecting to {}", socket.display()))?;
    stream
        .write_all(frames(registered, body).as_bytes())
        .await
        .with_context(|| format!("writing to {}", socket.display()))?;
    stream
        .flush()
        .await
        .with_context(|| format!("flushing {}", socket.display()))
}

/// A session that has stopped reading its socket is treated as one that refused the message.
/// The pump awaits delivery inside the same select! that drives its heartbeat, so a wedged
/// Claude would otherwise take the whole host's mailbox connection down with it.
async fn write_frames(registered: &Registered, body: &str, limit: Duration) -> Result<()> {
    tokio::time::timeout(limit, send(registered, body))
        .await
        .with_context(|| {
            format!(
                "{} did not take the message within {}ms",
                registered.inbox.socket.display(),
                limit.as_millis()
            )
        })?
}

/// A socket that refuses the write loses its registration, since nothing else will carry the
/// message to it.
async fn write_or_prune(registered: &Registered, body: &str, limit: Duration, fanout: &mut Fanout) {
    match write_frames(registered, body, limit).await {
        Ok(()) => fanout.delivered += 1,
        Err(_) => {
            let _ = std::fs::remove_file(&registered.path);
            fanout.pruned += 1;
        }
    }
}

/// The one session Claude accepts a message for on each inbox socket: a child session shares its
/// parent's socket, and only the newest registration on a socket names a session Claude still
/// takes, so anything behind it is not addressable at all.
fn addressable(dir: &Path) -> Vec<Registered> {
    let mut sockets = HashSet::new();
    registered(dir)
        .into_iter()
        .filter(|registered| sockets.insert(registered.inbox.socket.clone()))
        .collect()
}

async fn write_all(registrations: Vec<Registered>, body: &str) -> Fanout {
    let mut fanout = Fanout::default();
    for registered in registrations {
        write_or_prune(&registered, body, DELIVER_TIMEOUT, &mut fanout).await;
    }
    fanout
}

/// Delivers a host-addressed message to the sessions registered now, once per inbox socket. The
/// service only pushes to a socket that was attached when the message was sent, and the daemon
/// writes it the moment it arrives, so these are the sessions that were running then. No timestamp
/// is compared: a host's own clock and the stamps the service puts on a message differ by skew,
/// which says nothing about who should read it.
pub async fn to_host(dir: &Path, body: &str) -> Fanout {
    write_all(addressable(dir), body).await
}

/// What became of an order on this host. `Retired` is a host with no session that took it, which
/// leaves nothing behind for a later session, so the sender is told the order reached nobody.
#[derive(Debug, PartialEq, Eq)]
pub enum Placed {
    Taken(String),
    Retired,
}

/// Delivers an order to the one session that should act on it: the newest registered now, by the
/// same rule `to_host` picks its sessions by. A session that will not take the write loses its
/// registration and the next one is offered the order, since no other connection will ever see it.
///
/// The walk spends at most `ORDER_WALK`, and a session is only offered the order while what is
/// left of that budget still covers the write. Past it the order is retired here: the sender is
/// about to be told nobody took it, and a session taking it after that would run work its sender
/// believes never started.
pub async fn to_one(dir: &Path, body: &str) -> Placed {
    let deadline = Instant::now() + ORDER_WALK;
    for registered in addressable(dir) {
        let Some(limit) = left(deadline) else {
            return Placed::Retired;
        };
        if place(&registered, body, limit).await {
            return Placed::Taken(registered.session_id);
        }
    }
    Placed::Retired
}

/// How long is left of the walk's budget, or nothing once it is spent.
fn left(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .map(|left| left.min(DELIVER_TIMEOUT))
}

/// Delivers an order to the one session it names. A session this host cannot address, or one that
/// will not take the write, is the end of it: no other session was addressed.
pub async fn to_one_session(dir: &Path, session_id: &str, body: &str) -> Placed {
    let Some(registered) = addressable(dir)
        .into_iter()
        .find(|registered| registered.session_id == session_id)
    else {
        return Placed::Retired;
    };
    if place(&registered, body, DELIVER_TIMEOUT).await {
        return Placed::Taken(registered.session_id);
    }
    Placed::Retired
}

async fn place(registered: &Registered, body: &str, limit: Duration) -> bool {
    let mut fanout = Fanout::default();
    write_or_prune(registered, body, limit, &mut fanout).await;
    fanout.delivered == 1
}

/// Delivers a message body to the one session named, so a handle reaches that session and nothing
/// else sharing its socket. A session this host cannot address takes nothing: it has ended, lost
/// its inbox, or sits behind a newer registration on its socket, which Claude would discard.
pub async fn to_session(dir: &Path, session_id: &str, body: &str) -> Fanout {
    let mut fanout = Fanout::default();
    let Some(registered) = addressable(dir)
        .into_iter()
        .find(|registered| registered.session_id == session_id)
    else {
        return fanout;
    };
    write_or_prune(&registered, body, DELIVER_TIMEOUT, &mut fanout).await;
    fanout
}

/// Resolves once the registry has held no live session for `idle`, which is the daemon's cue to
/// let go of the lock. A SessionStart hook brings it straight back with `recall listen --ensure`.
/// Every pass hands `tick` the sessions it unlinked, since the same tick that notices a Claude
/// process is gone is the only thing that can tell the service; it is handed an empty list on a
/// pass that unlinked nothing, because it is also the beat the daemon's other sweeps run on.
pub async fn idle_exit(dir: &Path, check: Duration, idle: Duration, mut tick: impl FnMut(Vec<Ended>)) {
    let mut beat = tokio::time::interval(check);
    let mut empty_since: Option<Instant> = None;
    loop {
        beat.tick().await;
        let scan = scan(dir);
        tick(scan.ended);
        if scan
            .live
            .iter()
            .any(|(_, status)| status.record.state.inbox().is_some())
        {
            empty_since = None;
            continue;
        }
        if empty_since.get_or_insert_with(Instant::now).elapsed() >= idle {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::AsyncReadExt;
    use tokio::net::UnixListener;

    const STARTED_AT: i64 = 1_762_000_000_000;

    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let dir = std::env::temp_dir().join(format!("recall-sessions-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("sessions")).unwrap();
            Sandbox { dir }
        }

        fn sessions(&self) -> PathBuf {
            self.dir.join("sessions")
        }

        fn record(&self, session_id: &str, pid: i32, state: State) {
            self.record_started(session_id, pid, STARTED_AT, state);
        }

        fn record_started(&self, session_id: &str, pid: i32, started_at: i64, state: State) {
            let record = Record {
                cwd: self.dir.clone(),
                pid,
                session_id: session_id.to_string(),
                host: "laptop".to_string(),
                repo: "repo:github.com/mvhenten/recall".to_string(),
                branch: "work".to_string(),
                commit: "feat(sessions): list every host's sessions".to_string(),
                started_at,
                last_activity_at: 1_762_000_060_000,
                prompts: 2,
                focus: Focus {
                    first: "list the sessions".to_string(),
                    latest: "why is the worker test red".to_string(),
                },
                mode: "interactive".to_string(),
                permission_mode: "default".to_string(),
                transcript_path: PathBuf::new(),
                usage_pending: None,
                state,
            };
            std::fs::write(
                self.sessions().join(format!("{session_id}.json")),
                serde_json::to_string(&record).unwrap(),
            )
            .unwrap();
        }

        fn register(&self, session_id: &str, socket: &Path, pid: i32) {
            self.register_started(session_id, socket, pid, STARTED_AT);
        }

        fn register_started(&self, session_id: &str, socket: &Path, pid: i32, started_at: i64) {
            self.record_started(
                session_id,
                pid,
                started_at,
                State::Registered(Inbox {
                    socket: socket.to_path_buf(),
                    token: Token("t-inbox".to_string()),
                }),
            );
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn read_frames(listener: &UnixListener) -> Vec<Value> {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut text = String::new();
        stream.read_to_string(&mut text).await.unwrap();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    #[tokio::test]
    async fn a_message_arrives_as_an_auth_frame_then_a_user_frame() {
        let sandbox = Sandbox::new("deliver");
        let socket = sandbox.dir.join("inbox.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let mine = std::process::id() as i32;
        sandbox.register("s-parent", &socket, mine);
        sandbox.register("s-child", &socket, mine);

        let delivery = tokio::spawn(async move { read_frames(&listener).await });
        let fanout = to_host(&sandbox.sessions(), "ship it").await;

        assert_eq!(
            fanout,
            Fanout {
                delivered: 1,
                pruned: 0
            }
        );
        let frames = delivery.await.unwrap();
        assert_eq!(frames[0], serde_json::json!({ "type": "auth", "token": "t-inbox" }));
        assert_eq!(frames[1]["type"], "user");
        assert_eq!(
            frames[1]["message"],
            serde_json::json!({ "role": "user", "content": "ship it" })
        );
        assert!(
            frames[1]["session_id"] == "s-parent" || frames[1]["session_id"] == "s-child",
            "{:?}",
            frames[1]
        );
        assert_eq!(frames.len(), 2);
    }

    #[tokio::test]
    async fn a_handle_reaches_one_session_where_a_host_send_reaches_them_all() {
        let sandbox = Sandbox::new("to-session");
        let dir = sandbox.sessions();
        let mine = std::process::id() as i32;
        let here = sandbox.dir.join("here.sock");
        let there = sandbox.dir.join("there.sock");
        let addressed = UnixListener::bind(&here).unwrap();
        let passed_over = UnixListener::bind(&there).unwrap();
        sandbox.register("s-here", &here, mine);
        sandbox.register("s-there", &there, mine);

        let delivery = tokio::spawn(async move { read_frames(&addressed).await });
        let one = to_session(&dir, "s-here", "only you").await;

        assert_eq!(
            one,
            Fanout {
                delivered: 1,
                pruned: 0
            }
        );
        let frames = delivery.await.unwrap();
        assert_eq!(frames[1]["session_id"], "s-here");
        assert_eq!(
            frames[1]["message"],
            serde_json::json!({ "role": "user", "content": "only you" })
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), passed_over.accept())
                .await
                .is_err(),
            "the other session on this host must hear nothing of a message addressed to one handle"
        );

        assert_eq!(
            to_session(&dir, "s-gone", "nobody").await,
            Fanout::default(),
            "a handle this host no longer has registered takes nothing"
        );
    }

    #[tokio::test]
    async fn a_session_behind_a_newer_registration_on_its_socket_takes_nothing() {
        let sandbox = Sandbox::new("shared-socket");
        let dir = sandbox.sessions();
        let mine = std::process::id() as i32;
        let socket = sandbox.dir.join("inbox.sock");
        let listening = UnixListener::bind(&socket).unwrap();
        sandbox.register("s-parent", &socket, mine);
        sandbox.register("s-child", &socket, mine);

        let newest = registered(&dir).remove(0).session_id;
        let behind = if newest == "s-parent" { "s-child" } else { "s-parent" };

        assert_eq!(
            to_session(&dir, behind, "the frame Claude would discard").await,
            Fanout::default(),
            "only the newest registration on a socket names a session Claude still accepts"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listening.accept())
                .await
                .is_err(),
            "a session Claude would not accept must not be written to at all"
        );
    }

    #[tokio::test]
    async fn a_host_send_reaches_every_socket_on_this_host() {
        let sandbox = Sandbox::new("fanout-sockets");
        let mine = std::process::id() as i32;
        let here = sandbox.dir.join("here.sock");
        let there = sandbox.dir.join("there.sock");
        let left = UnixListener::bind(&here).unwrap();
        let right = UnixListener::bind(&there).unwrap();
        sandbox.register("s-here", &here, mine);
        sandbox.register("s-there", &there, mine);

        let delivery = tokio::spawn(async move { (read_frames(&left).await, read_frames(&right).await) });
        let fanout = to_host(&sandbox.sessions(), "all of you").await;

        assert_eq!(
            fanout,
            Fanout {
                delivered: 2,
                pruned: 0
            }
        );
        let (first, second) = delivery.await.unwrap();
        for frames in [first, second] {
            assert_eq!(
                frames[1]["message"],
                serde_json::json!({ "role": "user", "content": "all of you" })
            );
        }
    }

    #[tokio::test]
    async fn an_order_reaches_one_of_several_listening_sessions_and_names_it() {
        let sandbox = Sandbox::new("order-one-of-three");
        let mine = std::process::id() as i32;
        let sockets: Vec<PathBuf> = (0..3)
            .map(|index| sandbox.dir.join(format!("inbox-{index}.sock")))
            .collect();
        let listeners: Vec<UnixListener> = sockets.iter().map(|path| UnixListener::bind(path).unwrap()).collect();
        for (index, socket) in sockets.iter().enumerate() {
            sandbox.register(&format!("s-{index}"), socket, mine);
        }

        let accepting = tokio::spawn(async move {
            let mut written = Vec::new();
            for (index, listener) in listeners.iter().enumerate() {
                if tokio::time::timeout(Duration::from_millis(250), listener.accept())
                    .await
                    .is_ok()
                {
                    written.push(index);
                }
            }
            written
        });
        let placed = to_one(&sandbox.sessions(), "rerun the migration").await;

        let Placed::Taken(session_id) = placed else {
            panic!("a host with three registered sessions must place an order, got {placed:?}");
        };
        assert!(
            ["s-0", "s-1", "s-2"].contains(&session_id.as_str()),
            "the order names the session it went to, got {session_id}"
        );
        assert_eq!(
            accepting.await.unwrap().len(),
            1,
            "exactly one of the three inboxes is written to"
        );
    }

    /// The service gives up on an order `TAKER_WINDOW` after it pushed it and tells the sender
    /// nobody took it. The walk has to be over by then, write timeout included, or a session takes
    /// an order whose sender has already been told it failed.
    #[test]
    fn the_order_walk_and_the_write_it_ends_on_fit_inside_the_window_the_service_waits() {
        assert!(!ORDER_WALK.is_zero(), "the walk has to be allowed one session");
        assert!(
            ORDER_WALK + DELIVER_TIMEOUT <= TAKER_WINDOW,
            "{ORDER_WALK:?} of walking plus {DELIVER_TIMEOUT:?} of writing must fit in {TAKER_WINDOW:?}"
        );
    }

    #[tokio::test]
    async fn an_order_a_host_has_no_session_for_is_retired_rather_than_held() {
        let sandbox = Sandbox::new("order-nobody");
        let dir = sandbox.sessions();

        assert_eq!(
            to_one(&dir, "rerun the migration").await,
            Placed::Retired,
            "a host with nothing registered keeps no order for a session that starts later"
        );
        assert_eq!(
            to_one_session(&dir, "s-gone", "rerun the migration").await,
            Placed::Retired,
            "an order named at a session this host no longer has is nobody else's to take"
        );
    }

    /// The session the order is offered first has a socket nothing is reading, which is what a
    /// session whose Claude died leaves behind. Nothing else will ever see the order, so this host
    /// is the only chance it gets and the next session here has to be offered it.
    #[tokio::test]
    async fn an_order_a_dead_session_will_not_take_goes_to_the_next_one_that_will() {
        let sandbox = Sandbox::new("order-walks-on");
        let mine = std::process::id() as i32;
        let dead = sandbox.dir.join("dead.sock");
        let live = sandbox.dir.join("live.sock");
        drop(UnixListener::bind(&dead).unwrap());
        let listening = UnixListener::bind(&live).unwrap();
        sandbox.register("s-live", &live, mine);
        sandbox.register("s-dead", &dead, mine);

        let accepting = tokio::spawn(async move { read_frames(&listening).await });
        let placed = to_one(&sandbox.sessions(), "rerun the migration").await;

        assert_eq!(placed, Placed::Taken("s-live".to_string()));
        assert_eq!(
            accepting.await.unwrap()[1]["message"],
            serde_json::json!({ "role": "user", "content": "rerun the migration" })
        );
        assert_eq!(
            to_one_session(&sandbox.sessions(), "s-dead", "rerun the migration").await,
            Placed::Retired,
            "the session that would not take it lost its registration"
        );
    }

    #[test]
    fn a_session_whose_process_is_gone_loses_its_registration() {
        let sandbox = Sandbox::new("prune");
        let socket = sandbox.dir.join("inbox.sock");
        std::fs::write(&socket, "").unwrap();
        sandbox.register("s-live", &socket, std::process::id() as i32);
        sandbox.register("s-dead", &socket, i32::MAX);
        sandbox.register(
            "s-socketless",
            &sandbox.dir.join("gone.sock"),
            std::process::id() as i32,
        );

        let live = registered(&sandbox.sessions());

        assert_eq!(
            live.iter().map(|entry| entry.session_id.as_str()).collect::<Vec<_>>(),
            vec!["s-live"]
        );
        assert!(!sandbox.sessions().join("s-dead.json").exists());
        assert!(!sandbox.sessions().join("s-socketless.json").exists());
    }

    #[test]
    fn a_session_the_hook_passed_over_stays_until_its_process_is_gone() {
        let sandbox = Sandbox::new("status");
        let socket = sandbox.dir.join("inbox.sock");
        std::fs::write(&socket, "").unwrap();
        let mine = std::process::id() as i32;
        sandbox.record("s-off", mine, State::Off);
        sandbox.record("s-no-inbox", mine, State::NoInbox);
        sandbox.record(
            "s-failed",
            mine,
            State::Failed {
                error: "EACCES, permission denied".to_string(),
            },
        );
        sandbox.record("s-crashed", i32::MAX, State::Off);
        sandbox.register("s-live", &socket, mine);
        sandbox.register("s-pruned", &sandbox.dir.join("gone.sock"), mine);

        let statuses = status(&sandbox.sessions());
        let mut by_id: Vec<(&str, &State)> = statuses
            .iter()
            .map(|(_, status)| (status.session_id.as_str(), &status.record.state))
            .collect();
        by_id.sort_by_key(|(session_id, _)| *session_id);

        assert_eq!(
            by_id,
            vec![
                (
                    "s-failed",
                    &State::Failed {
                        error: "EACCES, permission denied".to_string(),
                    }
                ),
                (
                    "s-live",
                    &State::Registered(Inbox {
                        socket: socket.clone(),
                        token: Token("t-inbox".to_string()),
                    })
                ),
                ("s-no-inbox", &State::NoInbox),
                ("s-off", &State::Off),
            ]
        );
        assert!(
            !sandbox.sessions().join("s-crashed.json").exists(),
            "a skipped session that never reached session end is pruned with its process"
        );
        assert!(!sandbox.sessions().join("s-pruned.json").exists());
        assert_eq!(statuses[0].1.record.cwd, sandbox.dir);
        assert_eq!(
            registered(&sandbox.sessions())
                .iter()
                .map(|entry| entry.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["s-live"],
            "only a record carrying a socket is one the daemon delivers to"
        );
    }

    #[test]
    fn the_registry_reads_back_the_json_the_hook_writes() {
        const DOCUMENT: &str = r#"{"pid":4242,"cwd":"/src","sessionId":"s-1","host":"laptop",
            "repo":"repo:github.com/mvhenten/recall","branch":"work","commit":"feat: list sessions",
            "startedAt":1762000000000,"lastActivityAt":1762000060000,"usageCountedAt":1762000060000,"prompts":2,
            "focus":{"first":"list the sessions","latest":"why is CI red"},"mode":"interactive",
            "permissionMode":"default""#;
        let document = |state: &str| format!("{DOCUMENT},{state}}}");

        let registered: Record = serde_json::from_str(&document(
            r#""state":"registered","socket":"/run/user/1000/cc-socks/4242.sock","token":"t""#,
        ))
        .unwrap();
        assert_eq!(
            registered.state,
            State::Registered(Inbox {
                socket: PathBuf::from("/run/user/1000/cc-socks/4242.sock"),
                token: Token("t".to_string()),
            })
        );
        assert_eq!(registered.pid, 4242);
        assert_eq!(registered.cwd, PathBuf::from("/src"));
        assert_eq!(registered.session_id, "s-1");
        assert_eq!(registered.started_at, 1_762_000_000_000);
        assert_eq!(registered.prompts, 2);
        assert_eq!(registered.focus.latest, "why is CI red");
        assert_eq!(registered.permission_mode, "default");
        assert!(format!("{registered:?}").contains("<redacted>"), "{registered:?}");
        assert!(!format!("{registered:?}").contains("\"t\""), "{registered:?}");

        let skipped: Record = serde_json::from_str(&document(r#""state":"no-inbox""#)).unwrap();
        assert_eq!(skipped.state, State::NoInbox);
        assert_eq!(skipped.pid, 4242);

        let failed: Record = serde_json::from_str(&document(r#""state":"failed","error":"EACCES""#)).unwrap();
        assert_eq!(
            failed.state,
            State::Failed {
                error: "EACCES".to_string()
            }
        );
    }

    #[test]
    fn state_is_read_off_the_last_prompt() {
        let now = 1_762_000_300_000;
        assert_eq!(state(now, now), "busy");
        assert_eq!(state(now - 299_999, now), "busy");
        assert_eq!(state(now - 300_000, now), "idle");
    }

    #[test]
    fn an_age_reads_in_the_largest_unit_that_still_fits() {
        let now = 1_762_000_000_000;
        assert_eq!(age(now - 45_000, now), "45s");
        assert_eq!(age(now - 720_000, now), "12m");
        assert_eq!(age(now - 10_800_000, now), "3h");
        assert_eq!(age(now - 172_800_000, now), "2d");
        assert_eq!(age(now + 5_000, now), "0s");
    }

    #[test]
    fn a_focus_line_is_the_first_prompt_and_the_latest() {
        let focus = |first: &str, latest: &str| Focus {
            first: first.to_string(),
            latest: latest.to_string(),
        };
        assert_eq!(
            focus_line(&focus("ship it", "why is CI red")),
            "ship it → why is CI red"
        );
        assert_eq!(focus_line(&focus("ship it", "ship it")), "ship it");
        assert_eq!(focus_line(&focus("ship it", "")), "ship it");
        assert_eq!(focus_line(&focus("", "ship it")), "ship it");
        assert_eq!(focus_line(&Focus::default()), "");
    }

    #[test]
    fn a_prompt_the_harness_wrote_is_no_focus_line() {
        assert_eq!(
            user_written("<task-notification>a subagent finished</task-notification>"),
            ""
        );
        assert_eq!(user_written("<system-reminder>be brief</system-reminder>"), "");
        assert_eq!(user_written("why is CI red"), "why is CI red");
        assert_eq!(user_written("<div> renders nothing"), "<div> renders nothing");
    }

    #[test]
    fn the_socket_names_the_sending_session_only_while_one_registered_session_holds_it() {
        let sandbox = Sandbox::new("sending-session");
        let dir = sandbox.sessions();
        let mine = std::process::id() as i32;
        let socket = sandbox.dir.join("inbox.sock");
        sandbox.register("s-here", &socket, mine);
        sandbox.register("s-elsewhere", &sandbox.dir.join("other.sock"), mine);

        assert_eq!(sending_session(&dir, &socket), Some("s-here".to_string()));
        assert_eq!(sending_session(&dir, &sandbox.dir.join("unknown.sock")), None);

        sandbox.register("s-delegated", &socket, mine);
        assert_eq!(sending_session(&dir, &socket), None);
    }

    #[tokio::test]
    async fn the_daemon_gives_up_the_lock_once_no_session_is_left() {
        let sandbox = Sandbox::new("idle");
        let check = Duration::from_millis(5);
        let idle = Duration::from_millis(40);

        let socket = sandbox.dir.join("inbox.sock");
        std::fs::write(&socket, "").unwrap();
        sandbox.register("s-live", &socket, std::process::id() as i32);
        let busy = tokio::time::timeout(
            Duration::from_millis(120),
            idle_exit(&sandbox.sessions(), check, idle, |_| {}),
        )
        .await;
        assert!(busy.is_err(), "a registered session must hold the daemon open");

        std::fs::remove_file(sandbox.sessions().join("s-live.json")).unwrap();
        tokio::time::timeout(
            Duration::from_millis(500),
            idle_exit(&sandbox.sessions(), check, idle, |_| {}),
        )
        .await
        .expect("an empty registry must let the daemon exit");
    }

    #[tokio::test]
    async fn the_tick_that_unlinks_a_dead_session_reports_it_ended() {
        let sandbox = Sandbox::new("ended");
        let check = Duration::from_millis(5);
        let socket = sandbox.dir.join("inbox.sock");
        std::fs::write(&socket, "").unwrap();
        sandbox.register("s-dead", &socket, i32::MAX);
        sandbox.register(
            "s-socketless",
            &sandbox.dir.join("gone.sock"),
            std::process::id() as i32,
        );
        sandbox.record("s-skipped", i32::MAX, State::Off);

        let mut reported = Vec::new();
        let _ = tokio::time::timeout(
            Duration::from_millis(200),
            idle_exit(&sandbox.sessions(), check, Duration::from_millis(40), |ended| {
                reported.extend(ended);
            }),
        )
        .await;

        assert_eq!(
            reported
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["s-dead", "s-skipped"],
            "only a session whose process is gone has ended; a socket can go while Claude stays"
        );
        assert!(!sandbox.sessions().join("s-socketless.json").exists());
    }

    const HOOK_RECORD: &str = r#"{
      "state": "off",
      "pid": 42,
      "cwd": "/src/recall",
      "sessionId": "s-usage",
      "host": "laptop",
      "repo": "repo:github.com/mvhenten/recall",
      "branch": "work",
      "commit": "feat(usage): count what a session spends",
      "startedAt": 1762000000000,
      "lastActivityAt": 1762000060000,
      "usageCountedAt": 1762000060000,
      "prompts": 2,
      "focus": { "first": "count the tokens", "latest": "count the tokens" },
      "mode": "interactive",
      "permissionMode": "default",
      "transcriptPath": "/home/you/.claude/projects/recall/s-usage.jsonl",
      "usageFiles": { "main": { "offset": 1200, "messageId": "msg-1" } },
      "usageHighWater": 6,
      "usagePrompts": 1,
      "usagePending": {
        "seq": 6,
        "highWater": 8,
        "prompts": 2,
        "files": {
          "main": { "offset": 4800, "messageId": "msg-3" },
          "agent-7f21": { "offset": 900, "messageId": "msg-9" }
        },
        "events": [
          {
            "seq": 6,
            "provider": "claude",
            "account": "you@example.com",
            "model": "claude-opus-4",
            "prompts": 2,
            "at": 1762000050000,
            "inputTokens": 11,
            "outputTokens": 22,
            "cacheWriteTokens": 33,
            "cacheReadTokens": 44
          },
          {
            "seq": 7,
            "provider": "claude",
            "account": "you@example.com",
            "model": "claude-haiku-4",
            "prompts": 0,
            "at": 1762000055000,
            "inputTokens": 1,
            "outputTokens": 2,
            "cacheWriteTokens": 3,
            "cacheReadTokens": 4
          }
        ]
      }
    }"#;

    #[test]
    fn the_record_carries_the_delta_the_hooks_fixed() {
        let sandbox = Sandbox::new("usage-read");
        std::fs::write(sandbox.sessions().join("s-usage.json"), HOOK_RECORD).unwrap();

        let record = record(&sandbox.sessions(), "s-usage").expect("the record parses");
        let pending = record.usage_pending.expect("the pending delta parses");
        assert_eq!((pending.seq, pending.high_water, pending.prompts), (6, 8, 2));
        assert_eq!(
            pending.files["main"],
            UsageFile {
                offset: 4800,
                message_id: "msg-3".to_string(),
            }
        );
        assert_eq!(
            pending.files["agent-7f21"].offset, 900,
            "a delegated turn is read and marked on its own"
        );
        assert_eq!(
            pending.events.iter().map(|event| &event["model"]).collect::<Vec<_>>(),
            vec!["claude-opus-4", "claude-haiku-4"],
            "an event is passed on as the hooks wrote it"
        );
        assert_eq!(pending.events[0]["cacheReadTokens"], 44);
    }

    /// What a binary that counted a session's transcript as one whole file left behind: the delta
    /// names `end` and `messageId` where the current one names `files`, and the mark it reads from
    /// sits on the record itself.
    const OLD_RECORD: &str = r#"{
      "state": "off",
      "pid": 42,
      "cwd": "/src/recall",
      "sessionId": "s-old",
      "host": "laptop",
      "repo": "repo:github.com/mvhenten/recall",
      "branch": "work",
      "commit": "feat(usage): count what a session spends",
      "startedAt": 1762000000000,
      "lastActivityAt": 1762000060000,
      "usageCountedAt": 1762000060000,
      "prompts": 2,
      "focus": { "first": "count the tokens", "latest": "count the tokens" },
      "mode": "interactive",
      "permissionMode": "default",
      "transcriptPath": "/home/you/.claude/projects/recall/s-old.jsonl",
      "usageOffset": 1200,
      "usageMessageId": "msg-1",
      "usageHighWater": 6,
      "usagePrompts": 1,
      "usagePending": {
        "seq": 6,
        "end": 4800,
        "highWater": 8,
        "prompts": 2,
        "messageId": "msg-3",
        "events": [{ "seq": 6, "model": "claude-opus-4", "prompts": 2, "inputTokens": 11 }]
      }
    }"#;

    #[test]
    fn a_session_live_across_the_update_that_added_the_files_is_still_listed() {
        let sandbox = Sandbox::new("usage-old-shape");
        let mine = std::process::id() as i32;
        std::fs::write(
            sandbox.sessions().join("s-old.json"),
            OLD_RECORD.replace("\"pid\": 42", &format!("\"pid\": {mine}")),
        )
        .unwrap();

        let record = record(&sandbox.sessions(), "s-old").expect("a delta written without files still parses");
        let pending = record.usage_pending.expect("the delta it never sent is still there");
        assert!(pending.files.is_empty());
        assert_eq!(pending.events.len(), 1);
        assert_eq!(
            status(&sandbox.sessions())
                .iter()
                .map(|(_, listed)| listed.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["s-old"],
            "the session is listed, not dropped over the one field its binary never wrote"
        );
    }

    #[test]
    fn a_delta_in_the_current_shape_still_names_the_files_it_read() {
        let sandbox = Sandbox::new("usage-current-shape");
        std::fs::write(sandbox.sessions().join("s-usage.json"), HOOK_RECORD).unwrap();

        let pending = record(&sandbox.sessions(), "s-usage").unwrap().usage_pending.unwrap();

        assert_eq!(pending.files_read(), vec!["agent-7f21", "main"]);
    }

    #[test]
    fn a_delta_naming_no_file_counts_against_none_and_leaves_the_marks_alone() {
        let sandbox = Sandbox::new("usage-old-commit");
        let path = sandbox.sessions().join("s-old.json");
        std::fs::write(&path, OLD_RECORD).unwrap();
        let pending = record(&sandbox.sessions(), "s-old").unwrap().usage_pending.unwrap();

        assert!(
            pending.files_read().is_empty(),
            "an absent set of files is no file, not one standing in for them all"
        );

        commit_usage(&sandbox.sessions(), "s-old", &pending).unwrap();

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            written.get("usageFiles").is_none(),
            "no file moved on, so the mark the hooks read is left where they put it"
        );
        assert_eq!(written["usageOffset"], 1200);
        assert_eq!(written["usageHighWater"], 8);
        assert!(
            written.get("usagePending").is_none(),
            "a delta that landed is not sent again"
        );
    }

    #[test]
    fn committing_a_delta_moves_the_marks_on_and_leaves_the_hooks_fields_alone() {
        let sandbox = Sandbox::new("usage-commit");
        let path = sandbox.sessions().join("s-usage.json");
        std::fs::write(&path, HOOK_RECORD).unwrap();
        let pending = record(&sandbox.sessions(), "s-usage").unwrap().usage_pending.unwrap();

        commit_usage(&sandbox.sessions(), "s-usage", &pending).unwrap();

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written["usageFiles"]["main"],
            json!({ "offset": 4800, "messageId": "msg-3" })
        );
        assert_eq!(written["usageFiles"]["agent-7f21"]["offset"], 900);
        assert_eq!(written["usageHighWater"], 8);
        assert_eq!(
            written["usagePrompts"], 2,
            "the prompts this delta carried are marked spent"
        );
        assert!(
            written.get("usagePending").is_none(),
            "a delta that landed is not sent again"
        );
        assert_eq!(written["usageCountedAt"], 1_762_000_060_000_i64);
        assert_eq!(
            written["transcriptPath"],
            "/home/you/.claude/projects/recall/s-usage.jsonl"
        );
        assert_eq!(written["prompts"], 2);
    }

    #[test]
    fn the_delta_of_a_session_whose_process_is_gone_leaves_with_it() {
        let sandbox = Sandbox::new("usage-scan");
        let dead = HOOK_RECORD.replace("\"pid\": 42", &format!("\"pid\": {}", i32::MAX));
        std::fs::write(sandbox.sessions().join("s-usage.json"), dead).unwrap();

        let scanned = scan(&sandbox.sessions());

        let ended = scanned
            .ended
            .first()
            .expect("a session whose process is gone is reported");
        assert_eq!((ended.session_id.as_str(), ended.host.as_str()), ("s-usage", "laptop"));
        assert_eq!(
            ended.usage_pending.as_ref().map(|pending| pending.events.len()),
            Some(2),
            "the delta the record still held goes out with the notice that the session is over"
        );
        assert!(!sandbox.sessions().join("s-usage.json").exists());
    }

    #[test]
    fn committing_a_delta_for_a_session_that_ended_writes_nothing_back() {
        let sandbox = Sandbox::new("usage-gone");
        std::fs::write(sandbox.sessions().join("s-usage.json"), HOOK_RECORD).unwrap();
        let pending = record(&sandbox.sessions(), "s-usage").unwrap().usage_pending.unwrap();

        forget(&sandbox.sessions(), "s-usage");

        commit_usage(&sandbox.sessions(), "s-usage", &pending).unwrap();
        assert!(!sandbox.sessions().join("s-usage.json").exists());
    }
}
