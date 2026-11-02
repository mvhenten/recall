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

/// `socket` and `token` are `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` as
/// the hook inherited them.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Inbox {
    pub socket: PathBuf,
    pub token: String,
}

/// Holds the inbox token back, so no log line or error can carry the credential that writes into
/// a session.
impl std::fmt::Debug for Inbox {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Inbox")
            .field("socket", &self.socket)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// How `hooks/session-start.mjs` left one Claude Code session. It writes
/// `$XDG_RUNTIME_DIR/recall/sessions/<session-id>.json` at mode 600 for every session, registered
/// or not, and `hooks/session-end.mjs` removes it; the daemon only ever reads the directory.
///
/// ```json
/// { "state": "registered", "socket": "/run/user/1000/cc-socks/4242.sock",
///   "token": "<CLAUDE_CODE_MESSAGING_TOKEN>", "pid": 4242, "cwd": "/home/you/src/recall" }
/// { "state": "no-inbox", "pid": 4242, "cwd": "/home/you/src/recall" }
/// ```
///
/// `pid` is the Claude process that owns the session, whatever the state, so a record outliving a
/// session that never reached session end is removed on the next pass.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Record {
    pub cwd: PathBuf,
    pub pid: i32,
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

/// Every session still running, newest first. A record whose Claude process is gone, or whose
/// socket has been removed, is unlinked on the way past, so a session that never reached session
/// end leaves nothing behind; a record that cannot be parsed is left alone, because a half-written
/// file becomes readable on the next pass.
pub fn status(dir: &Path) -> Vec<(PathBuf, Status)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut live: Vec<(SystemTime, PathBuf, Status)> = Vec::new();
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
        if !alive(status.record.pid) || socketless {
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
    live.into_iter().map(|(_, path, status)| (path, status)).collect()
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

/// Delivers a message body to every live session, once per inbox socket: a child session shares
/// its parent's socket, and the newest registration on a socket names the session Claude accepts.
/// A socket that refuses the write loses its registration; the message is acked either way,
/// because the mailbox has no better host to hand it to.
pub async fn fanout(dir: &Path, body: &str) -> Fanout {
    let mut sockets = HashSet::new();
    let mut fanout = Fanout::default();
    for registered in registered(dir) {
        if !sockets.insert(registered.inbox.socket.clone()) {
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

        fn record(&self, session_id: &str, pid: i32, state: State) {
            let record = Record {
                cwd: self.dir.clone(),
                pid,
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
                    token: "t-inbox".to_string(),
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
                        token: "t-inbox".to_string(),
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
        let registered: Record = serde_json::from_str(
            r#"{"state":"registered","socket":"/run/user/1000/cc-socks/4242.sock","token":"t","pid":4242,"cwd":"/src"}"#,
        )
        .unwrap();
        assert_eq!(
            registered.state,
            State::Registered(Inbox {
                socket: PathBuf::from("/run/user/1000/cc-socks/4242.sock"),
                token: "t".to_string(),
            })
        );
        assert_eq!(registered.pid, 4242);
        assert_eq!(registered.cwd, PathBuf::from("/src"));
        assert!(format!("{registered:?}").contains("<redacted>"), "{registered:?}");

        let skipped: Record = serde_json::from_str(r#"{"state":"no-inbox","pid":4242,"cwd":"/src"}"#).unwrap();
        assert_eq!(skipped.state, State::NoInbox);
        assert_eq!(skipped.pid, 4242);

        let failed: Record =
            serde_json::from_str(r#"{"state":"failed","error":"EACCES","pid":4242,"cwd":"/src"}"#).unwrap();
        assert_eq!(
            failed.state,
            State::Failed {
                error: "EACCES".to_string()
            }
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
