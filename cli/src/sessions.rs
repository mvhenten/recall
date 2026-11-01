use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
