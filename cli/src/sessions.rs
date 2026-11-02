use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

/// A record carrying an inbox is one the daemon can deliver to; the rest say why it cannot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum State {
    Registered(Inbox),
    Off,
    NoInbox,
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

/// How `hooks/session-start.mjs` left one Claude Code session. It writes
/// `$XDG_RUNTIME_DIR/recall/sessions/<session-id>.json` at mode 600 for every session, registered
/// or not, `hooks/recall-memories.mjs` rewrites the moving fields on every prompt, and
/// `hooks/session-end.mjs` removes it; the daemon only ever reads the directory.
///
/// `pid` is the Claude process that owns the session, whatever the state, so a record outliving a
/// session that never reached session end is removed on the next pass. `syncStartedAt`, which the hooks
/// use to throttle their own syncing, is theirs alone and is not read back here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub cwd: PathBuf,
    pub pid: i32,
    pub session_id: String,
    pub host: String,
    pub repo: String,
    pub branch: String,
    pub commit: String,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: Focus,
    pub mode: String,
    pub permission_mode: String,
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

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Fanout {
    pub delivered: usize,
    pub pruned: usize,
}

fn alive(pid: i32) -> bool {
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

/// What one pass over the registry found: the sessions still running, newest first, and the ones
/// it unlinked because their Claude process is gone. A session that ends without its SessionEnd
/// hook leaves a record here and a row on the service, and `ended` is the only notice either gets.
#[derive(Debug, Default)]
pub struct Scan {
    pub live: Vec<(PathBuf, Status)>,
    pub ended: Vec<String>,
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
            ended.push(status.session_id);
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
    ended.sort();
    Scan {
        live: live.into_iter().map(|(_, path, status)| (path, status)).collect(),
        ended,
    }
}

/// Every session still running, newest first.
pub fn status(dir: &Path) -> Vec<(PathBuf, Status)> {
    scan(dir).live
}

/// The record this host wrote for one session, whatever state the hook left it in.
pub fn record(dir: &Path, session_id: &str) -> Option<Record> {
    read(&dir.join(format!("{session_id}.json"))).map(|status| status.record)
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
pub fn registered(dir: &Path) -> Vec<Registered> {
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
async fn write_frames(registered: &Registered, body: &str) -> Result<()> {
    tokio::time::timeout(DELIVER_TIMEOUT, send(registered, body))
        .await
        .with_context(|| {
            format!(
                "{} did not take the message within {} seconds",
                registered.inbox.socket.display(),
                DELIVER_TIMEOUT.as_secs()
            )
        })?
}

/// A socket that refuses the write loses its registration; the message is acked either way,
/// because the mailbox has no better host to hand it to.
async fn write_or_prune(registered: &Registered, body: &str, fanout: &mut Fanout) {
    match write_frames(registered, body).await {
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

/// Delivers a message body to every live session, once per inbox socket.
pub async fn fanout(dir: &Path, body: &str) -> Fanout {
    let mut fanout = Fanout::default();
    for registered in addressable(dir) {
        write_or_prune(&registered, body, &mut fanout).await;
    }
    fanout
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
    write_or_prune(&registered, body, &mut fanout).await;
    fanout
}

/// Resolves once the registry has held no live session for `idle`, which is the daemon's cue to
/// let go of the lock. A SessionStart hook brings it straight back with `recall listen --ensure`.
/// Each pass hands `ended` the sessions it unlinked, since the same tick that notices a Claude
/// process is gone is the only thing that can tell the service.
pub async fn idle_exit(dir: &Path, check: Duration, idle: Duration, mut ended: impl FnMut(Vec<String>)) {
    let mut tick = tokio::time::interval(check);
    let mut empty_since: Option<Instant> = None;
    loop {
        tick.tick().await;
        let scan = scan(dir);
        if !scan.ended.is_empty() {
            ended(scan.ended);
        }
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
    use serde_json::Value;
    use tokio::io::AsyncReadExt;
    use tokio::net::UnixListener;

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
            let record = Record {
                cwd: self.dir.clone(),
                pid,
                session_id: session_id.to_string(),
                host: "laptop".to_string(),
                repo: "repo:github.com/mvhenten/recall".to_string(),
                branch: "work".to_string(),
                commit: "feat(sessions): list every host's sessions".to_string(),
                started_at: 1_762_000_000_000,
                last_activity_at: 1_762_000_060_000,
                prompts: 2,
                focus: Focus {
                    first: "list the sessions".to_string(),
                    latest: "why is the worker test red".to_string(),
                },
                mode: "interactive".to_string(),
                permission_mode: "default".to_string(),
                state,
            };
            std::fs::write(
                self.sessions().join(format!("{session_id}.json")),
                serde_json::to_string(&record).unwrap(),
            )
            .unwrap();
        }

        fn register(&self, session_id: &str, socket: &Path, pid: i32) {
            self.record(
                session_id,
                pid,
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
        let fanout = fanout(&sandbox.sessions(), "ship it").await;

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
        let fanout = fanout(&sandbox.sessions(), "all of you").await;

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
            "startedAt":1762000000000,"lastActivityAt":1762000060000,"syncStartedAt":1762000060000,"prompts":2,
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
            reported,
            vec!["s-dead".to_string(), "s-skipped".to_string()],
            "only a session whose process is gone has ended; a socket can go while Claude stays"
        );
        assert!(!sandbox.sessions().join("s-socketless.json").exists());
    }
}
