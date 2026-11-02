use crate::api::{Client, Message};
use crate::config;
use crate::seen::Seen;
use crate::sessions;
use crate::settings::Settings;
use crate::ws::{self, Ended};
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const BASE_DELAY: Duration = Duration::from_secs(1);
pub const MAX_DELAY: Duration = Duration::from_secs(60);
pub const MAX_JITTER: f64 = 0.25;
pub const IDLE_CHECK: Duration = Duration::from_secs(30);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

pub fn backoff(attempt: u32) -> Duration {
    BASE_DELAY
        .saturating_mul(2u32.saturating_pow(attempt.min(31)))
        .min(MAX_DELAY)
}

pub fn with_jitter(delay: Duration, fraction: f64) -> Duration {
    delay + delay.mul_f64(fraction.clamp(0.0, 1.0) * MAX_JITTER)
}

fn jitter_fraction() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    f64::from(nanos) / 1e9
}

pub fn runtime_dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(dir) => PathBuf::from(dir).join("recall"),
        None => std::env::temp_dir().join(format!("recall-{}", unsafe { libc::getuid() })),
    }
}

pub fn lock_path() -> PathBuf {
    runtime_dir().join("listen.lock")
}

pub fn sessions_dir() -> PathBuf {
    runtime_dir().join("sessions")
}

pub fn seen_path() -> PathBuf {
    runtime_dir().join("seen.json")
}

/// An exclusive flock held for the daemon's lifetime. It is both the mutual exclusion and the
/// liveness check, so a lockfile a killed daemon left behind needs no staleness handling.
pub struct Lock {
    file: File,
    path: PathBuf,
}

impl Lock {
    pub fn acquire(path: &Path) -> Result<Option<Lock>> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .with_context(|| format!("locking down {}", dir.display()))?;
        }
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(Lock {
                file,
                path: path.to_path_buf(),
            }));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Ok(None);
        }
        Err(error).with_context(|| format!("locking {}", path.display()))
    }

    pub fn release(self) -> Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("removing {}", self.path.display())),
        }
        drop(self.file);
        Ok(())
    }
}

pub fn ensure(path: &Path, spawn: impl FnOnce() -> Result<()>) -> Result<bool> {
    let Some(probe) = Lock::acquire(path)? else {
        return Ok(false);
    };
    drop(probe);
    spawn()?;
    Ok(true)
}

fn spawn_daemon() -> Result<()> {
    let exe = std::env::current_exe().context("finding the recall binary")?;
    let mut command = Command::new(&exe);
    command
        .arg("listen")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| match libc::setsid() {
            -1 => Err(std::io::Error::last_os_error()),
            _ => Ok(()),
        });
    }
    command
        .spawn()
        .with_context(|| format!("starting {} listen", exe.display()))?;
    Ok(())
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state")))
        .unwrap_or_default()
        .join("recall")
}

fn now_iso() -> String {
    Timestamp::now().strftime("%Y-%m-%dT%H:%M:%S.%3fZ").to_string()
}

/// Appends the line shape hooks/lib.mjs writes, so the daemon, the hooks and the commands the
/// hooks start detached all share one log. A detached command has nowhere else to report.
pub fn log(outcome: &str, took: Duration) {
    let dir = state_dir();
    let line = format!("{} - {outcome} {}ms\n", now_iso(), took.as_millis());
    let _ = std::fs::create_dir_all(&dir);
    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("hooks.log"))
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

async fn deliver(message: &Message, sessions_dir: &Path, seen: &mut Seen) {
    let started = Instant::now();
    if seen.contains(&message.message_id) {
        log(&format!("message:replayed:{}", message.message_id), started.elapsed());
        return;
    }
    let fanout = sessions::fanout(sessions_dir, &message.body).await;
    seen.record(&message.message_id);
    log(
        &format!(
            "message:{}:{}:{}/{}",
            message.from_device_id, message.message_id, fanout.delivered, fanout.pruned
        ),
        started.elapsed(),
    );
}

async fn session(url: &str, token: &str, sessions_dir: &Path, seen: &mut Seen) -> Result<Ended> {
    let mut socket = ws::connect(url, token).await?;
    log("listen:connected", Duration::ZERO);
    ws::pump(&mut socket, async |message: Message| {
        deliver(&message, sessions_dir, seen).await;
    })
    .await
}

async fn reconnect_loop(url: &str, token: &str, sessions_dir: &Path, seen: &mut Seen) -> Result<()> {
    let mut attempt = 0u32;
    loop {
        let started = Instant::now();
        match session(url, token, sessions_dir, seen).await {
            Ok(Ended::Revoked) => {
                log("listen:revoked", started.elapsed());
                bail!("this host is no longer signed in to recall; run recall login");
            }
            Ok(Ended::Closed) => log("listen:closed", started.elapsed()),
            Err(error) => log(&format!("listen:error:{error:#}"), started.elapsed()),
        }
        if started.elapsed() >= MAX_DELAY {
            attempt = 0;
        }
        tokio::time::sleep(with_jitter(backoff(attempt), jitter_fraction())).await;
        attempt = attempt.saturating_add(1);
    }
}

/// A session whose Claude process died never ran its SessionEnd hook, so its row would sit on the
/// service reading idle until it expired a day later, indistinguishable from a session that is
/// merely quiet. The tick that unlinks the record tells the service too, on a blocking thread so
/// the call cannot stall message delivery.
fn report_ended(client: &Arc<Client>, ended: Vec<String>) {
    let client = Arc::clone(client);
    tokio::task::spawn_blocking(move || {
        for session_id in ended {
            let started = Instant::now();
            let outcome = match client.end_session(&session_id) {
                Ok(true) => format!("sessions:ended:{session_id}"),
                Ok(false) => format!("sessions:already-gone:{session_id}"),
                Err(error) => format!("sessions:end-failed:{session_id}:{error:#}"),
            };
            log(&outcome, started.elapsed());
        }
    });
}

async fn serve() -> Result<()> {
    let config = config::load()?;
    let url = ws::listen_url(&config.endpoint)?;
    let sessions_dir = sessions_dir();
    let client = Arc::new(Client::new(config.clone()));
    let mut seen = Seen::load(&seen_path());
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).context("listening for SIGTERM")?;
    let work = reconnect_loop(&url, &config.token, &sessions_dir, &mut seen);
    tokio::pin!(work);
    tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = terminate.recv() => Ok(()),
        _ = sessions::idle_exit(&sessions_dir, IDLE_CHECK, IDLE_TIMEOUT, |ended| report_ended(&client, ended)) => Ok(()),
        result = &mut work => result,
    }
}

pub const MESSAGING_OFF: &str = "messaging is off; run recall config set messaging.enabled true to turn it on";
pub const NO_INBOX: &str =
    "Claude set no CLAUDE_CODE_MESSAGING_SOCKET or CLAUDE_CODE_MESSAGING_TOKEN, so this session has no inbox";

/// What `--status` reports for one session. The registry record carries the inbox token, so it
/// never leaves this module: only the session id, its directory, the Claude pid and the state
/// reach the report.
#[derive(Debug, Serialize)]
pub struct Session {
    pub session_id: String,
    pub cwd: PathBuf,
    pub pid: i32,
    #[serde(flatten)]
    pub state: Reported,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Reported {
    Registered,
    Off,
    NoInbox,
    Failed { error: String },
}

impl From<sessions::Status> for Session {
    fn from(status: sessions::Status) -> Session {
        Session {
            session_id: status.session_id,
            cwd: status.record.cwd,
            pid: status.record.pid,
            state: match status.record.state {
                sessions::State::Registered(_) => Reported::Registered,
                sessions::State::Off => Reported::Off,
                sessions::State::NoInbox => Reported::NoInbox,
                sessions::State::Failed { error } => Reported::Failed { error },
            },
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub messaging_enabled: bool,
    pub listener_running: bool,
    pub sessions: Vec<Session>,
}

fn reason(session: &Session) -> String {
    match &session.state {
        Reported::Registered => format!("registered, pid {}", session.pid),
        Reported::Off => MESSAGING_OFF.to_string(),
        Reported::NoInbox => NO_INBOX.to_string(),
        Reported::Failed { error } => format!("writing the registration failed: {error}"),
    }
}

impl Report {
    pub fn lines(&self) -> Vec<String> {
        let mut lines = vec![
            if self.messaging_enabled {
                "messaging is on".to_string()
            } else {
                MESSAGING_OFF.to_string()
            },
            if self.listener_running {
                "a listener is running on this host".to_string()
            } else {
                "no listener is running on this host".to_string()
            },
        ];
        if self.sessions.is_empty() {
            lines.push("no session is running on this host".to_string());
            return lines;
        }
        for session in &self.sessions {
            lines.push(format!(
                "{}  {}  {}",
                session.session_id,
                session.cwd.display(),
                reason(session)
            ));
        }
        lines
    }
}

pub fn status(settings: &Settings) -> Result<Report> {
    Ok(Report {
        messaging_enabled: settings.messaging_enabled(),
        listener_running: Lock::acquire(&lock_path())?.is_none(),
        sessions: sessions::status(&sessions_dir())
            .into_iter()
            .map(|(_, status)| Session::from(status))
            .collect(),
    })
}

pub fn run(settings: &Settings, ensure_only: bool) -> Result<()> {
    if !settings.messaging_enabled() {
        eprintln!("recall: {MESSAGING_OFF}");
        return Ok(());
    }
    let path = lock_path();
    if ensure_only {
        if ensure(&path, spawn_daemon)? {
            eprintln!("recall: started the listener");
        }
        return Ok(());
    }
    let Some(lock) = Lock::acquire(&path)? else {
        eprintln!("recall: a listener is already running on this host");
        return Ok(());
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let outcome = runtime.block_on(serve());
    log(
        &match &outcome {
            Ok(()) => "listen:stopped".to_string(),
            Err(error) => format!("listen:failed:{error:#}"),
        },
        Duration::ZERO,
    );
    lock.release()?;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("recall-listen-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_backoff_doubles_from_a_second_up_to_a_minute() {
        let schedule: Vec<u64> = (0..9).map(|attempt| backoff(attempt).as_secs()).collect();
        assert_eq!(schedule, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(backoff(u32::MAX), MAX_DELAY);
    }

    #[test]
    fn jitter_only_ever_delays_and_never_by_more_than_a_quarter() {
        let delay = Duration::from_secs(8);
        assert_eq!(with_jitter(delay, 0.0), delay);
        assert_eq!(with_jitter(delay, 1.0), Duration::from_secs(10));
        assert_eq!(with_jitter(delay, -3.0), delay);
        for step in 0..=10 {
            let jittered = with_jitter(delay, f64::from(step) / 10.0);
            assert!(jittered >= delay && jittered <= Duration::from_secs(10), "{jittered:?}");
        }
    }

    fn status(session_id: &str, cwd: &str, state: sessions::State) -> sessions::Status {
        sessions::Status {
            session_id: session_id.to_string(),
            record: sessions::Record {
                cwd: PathBuf::from(cwd),
                pid: 42,
                session_id: session_id.to_string(),
                host: "laptop".to_string(),
                repo: "repo:github.com/mvhenten/recall".to_string(),
                branch: "work".to_string(),
                commit: "feat(sessions): list every host's sessions".to_string(),
                started_at: 1_762_000_000_000,
                last_activity_at: 1_762_000_060_000,
                prompts: 2,
                focus: sessions::Focus::default(),
                mode: "interactive".to_string(),
                permission_mode: "default".to_string(),
                state,
            },
        }
    }

    #[test]
    fn each_running_session_prints_the_reason_the_hook_gave() {
        let report = Report {
            messaging_enabled: true,
            listener_running: false,
            sessions: vec![
                status(
                    "s-live",
                    "/src/recall",
                    sessions::State::Registered(sessions::Inbox {
                        socket: PathBuf::from("/run/user/1000/cc-socks/42.sock"),
                        token: sessions::Token("t-inbox".to_string()),
                    }),
                ),
                status("s-off", "/src/other", sessions::State::Off),
                status("s-no-inbox", "/src/third", sessions::State::NoInbox),
                status(
                    "s-failed",
                    "/src/fourth",
                    sessions::State::Failed {
                        error: "EACCES, permission denied".to_string(),
                    },
                ),
            ]
            .into_iter()
            .map(Session::from)
            .collect(),
        };

        assert_eq!(
            report.lines(),
            vec![
                "messaging is on".to_string(),
                "no listener is running on this host".to_string(),
                "s-live  /src/recall  registered, pid 42".to_string(),
                format!("s-off  /src/other  {MESSAGING_OFF}"),
                format!("s-no-inbox  /src/third  {NO_INBOX}"),
                "s-failed  /src/fourth  writing the registration failed: EACCES, permission denied".to_string(),
            ]
        );
    }

    #[test]
    fn the_report_never_carries_the_inbox_token_or_socket() {
        let report = Report {
            messaging_enabled: true,
            listener_running: true,
            sessions: vec![status(
                "s-live",
                "/src/recall",
                sessions::State::Registered(sessions::Inbox {
                    socket: PathBuf::from("/run/user/1000/cc-socks/42.sock"),
                    token: sessions::Token("t-inbox".to_string()),
                }),
            )]
            .into_iter()
            .map(Session::from)
            .collect(),
        };

        let json = serde_json::to_string(&report).unwrap();

        assert!(!json.contains("t-inbox"), "{json}");
        assert!(!json.contains("cc-socks"), "{json}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap()["sessions"][0],
            serde_json::json!({
                "session_id": "s-live",
                "cwd": "/src/recall",
                "pid": 42,
                "state": "registered",
            })
        );
    }

    #[test]
    fn an_empty_registry_says_no_session_is_running() {
        let report = Report {
            messaging_enabled: false,
            listener_running: true,
            sessions: Vec::new(),
        };
        assert_eq!(
            report.lines(),
            vec![
                MESSAGING_OFF.to_string(),
                "a listener is running on this host".to_string(),
                "no session is running on this host".to_string(),
            ]
        );
    }

    #[test]
    fn a_second_ensure_is_a_no_op_while_the_lock_is_held() {
        let dir = sandbox("flock");
        let path = dir.join("listen.lock");
        let held = Lock::acquire(&path).unwrap().unwrap();
        assert!(Lock::acquire(&path).unwrap().is_none());

        let mut spawned = 0;
        assert!(
            !ensure(&path, || {
                spawned += 1;
                Ok(())
            })
            .unwrap()
        );
        assert_eq!(spawned, 0);

        held.release().unwrap();
        assert!(!path.exists());

        assert!(
            ensure(&path, || {
                spawned += 1;
                Ok(())
            })
            .unwrap()
        );
        assert_eq!(spawned, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
