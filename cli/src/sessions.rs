use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

/// One live Claude Code session. `hooks/session-start.mjs` writes
/// `$XDG_RUNTIME_DIR/recall/sessions/<session-id>.json` at mode 600 and `hooks/session-end.mjs`
/// removes it; the daemon only ever reads the directory.
///
/// ```json
/// {
///   "socket": "/run/user/1000/cc-socks/4242.sock",
///   "token": "<CLAUDE_CODE_MESSAGING_TOKEN>",
///   "pid": 4242,
///   "cwd": "/home/you/src/recall"
/// }
/// ```
///
/// `socket` and `token` are `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` as
/// the hook inherited them, `pid` is the Claude process the socket belongs to, and the file name
/// is the session id Claude reports on the hook's stdin. The file name is what a delivered frame
/// carries as `session_id`, so a registration that outlived its session is dropped by Claude
/// instead of landing in whatever session now owns the socket.
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub socket: PathBuf,
    pub token: String,
    pub pid: i32,
    pub cwd: PathBuf,
}

/// Holds the inbox token back, so no log line or error can carry the credential that writes into
/// a session.
impl std::fmt::Debug for Session {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Session")
            .field("socket", &self.socket)
            .field("token", &"<redacted>")
            .field("pid", &self.pid)
            .field("cwd", &self.cwd)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct Registered {
    pub session_id: String,
    pub path: PathBuf,
    pub session: Session,
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

fn read(path: &Path) -> Option<Registered> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let session: Session = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(Registered {
        session_id,
        path: path.to_path_buf(),
        session,
    })
}

/// The sessions worth delivering to, newest registration first. An entry whose process is gone or
/// whose socket has been removed is unlinked on the way past; one that cannot be parsed is left
/// alone, because a half-written file becomes readable on the next pass.
pub fn registered(dir: &Path) -> Vec<Registered> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut live: Vec<(SystemTime, Registered)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(registered) = read(&path) else {
            continue;
        };
        if !alive(registered.session.pid) || !registered.session.socket.exists() {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        live.push((modified, registered));
    }
    live.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.session_id.cmp(&right.1.session_id))
    });
    live.into_iter().map(|(_, registered)| registered).collect()
}

pub const MESSAGING_OFF: &str = "messaging is off; run recall config set messaging.enabled true to turn it on";
pub const NO_INBOX: &str =
    "Claude set no CLAUDE_CODE_MESSAGING_SOCKET or CLAUDE_CODE_MESSAGING_TOKEN, so this session has no inbox";

/// The registration a session still holds: the process the daemon writes into and where it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Live {
    pub pid: i32,
    pub cwd: PathBuf,
}

/// What became of one session's registration: the state the hook last recorded for it, in plain
/// words, next to the registration the daemon can still see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub session_id: String,
    pub at: String,
    pub state: String,
    pub reason: String,
    pub registration: Option<Live>,
}

fn reason(state: &str, registration: Option<&Live>) -> String {
    if let Some(error) = state.strip_prefix("failed:") {
        return format!("writing the registration failed: {error}");
    }
    match (state, registration) {
        ("registered", Some(live)) => format!("registered, pid {} in {}", live.pid, live.cwd.display()),
        ("registered", None) => "registered, then dropped because the session or its socket is gone".to_string(),
        ("unregistered", _) => "the session ended".to_string(),
        ("off", _) => MESSAGING_OFF.to_string(),
        ("no-session", _) => "Claude reported no session id".to_string(),
        ("no-inbox", _) => NO_INBOX.to_string(),
        (other, _) => other.to_string(),
    }
}

/// Reads `messaging:<state>` back out of one hooks log line, which is a timestamp, a session id,
/// an outcome that may carry spaces, and a duration. Lines the daemon wrote carry no session id.
fn hook_state(line: &str) -> Option<(String, String, String)> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let [at, session_id, rest @ ..] = fields.as_slice() else {
        return None;
    };
    if *session_id == "-" {
        return None;
    }
    let (_duration, outcome) = rest.split_last()?;
    let state = outcome.join(" ").split_once("messaging:")?.1.to_string();
    Some((session_id.to_string(), at.to_string(), state))
}

fn hook_states(log: &Path) -> HashMap<String, (String, String)> {
    let Ok(text) = std::fs::read_to_string(log) else {
        return HashMap::new();
    };
    let mut latest = HashMap::new();
    for line in text.lines() {
        if let Some((session_id, at, state)) = hook_state(line) {
            latest.insert(session_id, (at, state));
        }
    }
    latest
}

/// Every session the hooks log still remembers, newest first, each with the reason the hook gave
/// for registering it or passing it over. Sessions holding a live registration are folded in, so a
/// registration that outlived its log line is still reported.
pub fn status(dir: &Path, log: &Path) -> Vec<Status> {
    let mut live: HashMap<String, Live> = registered(dir)
        .into_iter()
        .map(|entry| {
            (
                entry.session_id,
                Live {
                    pid: entry.session.pid,
                    cwd: entry.session.cwd,
                },
            )
        })
        .collect();
    let mut sessions: Vec<Status> = hook_states(log)
        .into_iter()
        .map(|(session_id, (at, state))| {
            let registration = live.remove(&session_id);
            Status {
                session_id,
                at,
                reason: reason(&state, registration.as_ref()),
                state,
                registration,
            }
        })
        .collect();
    for (session_id, registration) in live {
        sessions.push(Status {
            session_id,
            at: "-".to_string(),
            state: "registered".to_string(),
            reason: reason("registered", Some(&registration)),
            registration: Some(registration),
        });
    }
    sessions.sort_by(|left, right| {
        right
            .at
            .cmp(&left.at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    sessions
}

fn frames(registered: &Registered, body: &str) -> String {
    let auth = serde_json::json!({ "type": "auth", "token": registered.session.token });
    let user = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": body },
        "session_id": registered.session_id,
    });
    format!("{auth}\n{user}\n")
}

async fn send(registered: &Registered, body: &str) -> Result<()> {
    let socket = &registered.session.socket;
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
                registered.session.socket.display(),
                DELIVER_TIMEOUT.as_secs()
            )
        })?
}

/// Delivers a message body to every live session, once per inbox socket: a child session shares
/// its parent's socket, and the newest registration on a socket names the session Claude accepts.
/// A socket that refuses the write loses its registration; the message is acked either way,
/// because the mailbox has no better host to hand it to.
pub async fn fanout(dir: &Path, body: &str) -> Fanout {
    let mut sockets = HashSet::new();
    let mut fanout = Fanout::default();
    for registered in registered(dir) {
        if !sockets.insert(registered.session.socket.clone()) {
            continue;
        }
        match write_frames(&registered, body).await {
            Ok(()) => fanout.delivered += 1,
            Err(_) => {
                let _ = std::fs::remove_file(&registered.path);
                fanout.pruned += 1;
            }
        }
    }
    fanout
}

/// Resolves once the registry has held no live session for `idle`, which is the daemon's cue to
/// let go of the lock. A SessionStart hook brings it straight back with `recall listen --ensure`.
pub async fn idle_exit(dir: &Path, check: Duration, idle: Duration) {
    let mut tick = tokio::time::interval(check);
    let mut empty_since: Option<Instant> = None;
    loop {
        tick.tick().await;
        if !registered(dir).is_empty() {
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

        fn register(&self, session_id: &str, socket: &Path, pid: i32) {
            let session = Session {
                socket: socket.to_path_buf(),
                token: "t-inbox".to_string(),
                pid,
                cwd: self.dir.clone(),
            };
            std::fs::write(
                self.sessions().join(format!("{session_id}.json")),
                serde_json::to_string(&session).unwrap(),
            )
            .unwrap();
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
    fn every_outcome_the_hook_records_comes_back_as_a_reason() {
        let sandbox = Sandbox::new("status");
        let socket = sandbox.dir.join("inbox.sock");
        std::fs::write(&socket, "").unwrap();
        let mine = std::process::id() as i32;
        sandbox.register("s-live", &socket, mine);
        sandbox.register("s-pruned", &sandbox.dir.join("gone.sock"), mine);
        let log = sandbox.dir.join("hooks.log");
        std::fs::write(
            &log,
            concat!(
                "2026-11-02T09:00:00.000Z - listen:connected 0ms\n",
                "2026-11-02T09:00:30.000Z s-live crib:hook:repo:messaging:off 11ms\n",
                "2026-11-02T09:01:00.000Z s-off crib:hook:repo:messaging:off 12ms\n",
                "2026-11-02T09:02:00.000Z s-no-inbox crib:tools:global:messaging:no-inbox 9ms\n",
                "2026-11-02T09:03:00.000Z s-no-session crib:hook:repo:messaging:no-session 7ms\n",
                "2026-11-02T09:04:00.000Z s-failed crib:hook:repo:messaging:failed:EACCES, permission denied 8ms\n",
                "2026-11-02T09:05:00.000Z s-ended messaging:unregistered 2ms\n",
                "2026-11-02T09:06:00.000Z s-pruned crib:hook:repo:messaging:registered 11ms\n",
                "2026-11-02T09:07:00.000Z s-live crib:hook:repo:messaging:registered 10ms\n",
            ),
        )
        .unwrap();

        let statuses = status(&sandbox.sessions(), &log);
        let by_id: HashMap<&str, &Status> = statuses
            .iter()
            .map(|status| (status.session_id.as_str(), status))
            .collect();

        assert_eq!(statuses.len(), 7, "{statuses:?}");
        assert_eq!(statuses[0].session_id, "s-live", "newest first");
        assert_eq!(by_id["s-off"].state, "off");
        assert_eq!(by_id["s-off"].reason, MESSAGING_OFF);
        assert_eq!(by_id["s-no-inbox"].reason, NO_INBOX);
        assert_eq!(by_id["s-no-session"].reason, "Claude reported no session id");
        assert_eq!(
            by_id["s-failed"].reason,
            "writing the registration failed: EACCES, permission denied"
        );
        assert_eq!(by_id["s-ended"].reason, "the session ended");
        assert_eq!(
            by_id["s-pruned"].reason,
            "registered, then dropped because the session or its socket is gone"
        );
        assert_eq!(
            by_id["s-live"].registration,
            Some(Live {
                pid: mine,
                cwd: sandbox.dir.clone()
            })
        );
        assert_eq!(
            by_id["s-live"].reason,
            format!("registered, pid {mine} in {}", sandbox.dir.display())
        );
    }

    #[tokio::test]
    async fn the_daemon_gives_up_the_lock_once_no_session_is_left() {
        let sandbox = Sandbox::new("idle");
        let check = Duration::from_millis(5);
        let idle = Duration::from_millis(40);

        let socket = sandbox.dir.join("inbox.sock");
        std::fs::write(&socket, "").unwrap();
        sandbox.register("s-live", &socket, std::process::id() as i32);
        let busy = tokio::time::timeout(Duration::from_millis(120), idle_exit(&sandbox.sessions(), check, idle)).await;
        assert!(busy.is_err(), "a registered session must hold the daemon open");

        std::fs::remove_file(sandbox.sessions().join("s-live.json")).unwrap();
        tokio::time::timeout(Duration::from_millis(500), idle_exit(&sandbox.sessions(), check, idle))
            .await
            .expect("an empty registry must let the daemon exit");
    }
}
