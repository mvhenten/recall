use crate::adopt;
use crate::api::{Client, Message};
use crate::config;
use crate::seen::Seen;
use crate::sessions;
use crate::settings::Settings;
use crate::transcripts;
use crate::ws::{self, Ended};
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::Serialize;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// The daemon holding the lock names itself here, so an update can end the one it replaced. The
/// lock is still what says a daemon is running; this only says which process to signal.
pub fn pid_path() -> PathBuf {
    runtime_dir().join("listen.pid")
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

/// The line a delivered message arrives under. A session reading one otherwise sees a bare user
/// turn with nothing saying where it came from, and Claude Code's own cross-session tools reach
/// only sessions on the same machine, so the route back has to be spelled out. The handle is
/// preferred because it reaches the one session that asked; a sender that named no session is
/// answered on its host, which `recall send` takes by label as readily as by name.
pub fn header(message: &Message) -> String {
    let from = if message.from_host.is_empty() {
        &message.from_device_id
    } else {
        &message.from_host
    };
    let reply = if message.from_name.is_empty() {
        from
    } else {
        &message.from_name
    };
    let origin = if message.from_name.is_empty() {
        from.clone()
    } else {
        format!("{from}/{}", message.from_name)
    };
    format!("[recall from {origin}; reply with recall_send to \"{reply}\"]")
}

fn delivered_body(message: &Message) -> String {
    format!("{}\n{}", header(message), message.body)
}

async fn deliver(message: &Message, sessions_dir: &Path, seen: &mut Seen) {
    let started = Instant::now();
    if seen.contains(&message.message_id) {
        log(&format!("message:replayed:{}", message.message_id), started.elapsed());
        return;
    }
    let body = delivered_body(message);
    let (target, fanout) = if message.to_session_id.is_empty() {
        let now = Timestamp::now().as_millisecond();
        let Some(fanout) = sessions::to_host(sessions_dir, &body, message.created_at, now).await else {
            seen.record(&message.message_id);
            log(&format!("message:retired:{}", message.message_id), started.elapsed());
            return;
        };
        ("host".to_string(), fanout)
    } else {
        (
            format!("session:{}", message.to_session_id),
            sessions::to_session(sessions_dir, &message.to_session_id, &body).await,
        )
    };
    seen.record(&message.message_id);
    log(
        &format!(
            "message:{}:{}:{target}:{}/{}",
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
/// merely quiet, and the delta its record still carried would go with the record. The tick that
/// unlinks it sends both, on a blocking thread so the calls cannot stall message delivery; a delta
/// the service refuses is reported and dropped, since the record it came from is already gone.
fn report_ended(client: &Arc<Client>, ended: Vec<sessions::Ended>) {
    if ended.is_empty() {
        return;
    }
    let client = Arc::clone(client);
    tokio::task::spawn_blocking(move || {
        for session in ended {
            let id = &session.session_id;
            if let Some(pending) = session.usage_pending.as_ref() {
                let started = Instant::now();
                let files: Vec<String> = pending.files.keys().cloned().collect();
                let outcome = match client.post_usage(id, &session.host, &session.repo, &files, &pending.events) {
                    Ok(sent) => format!("sessions:usage:{id}:{sent}"),
                    Err(error) => format!("sessions:usage-failed:{id}:{error:#}"),
                };
                log(&outcome, started.elapsed());
            }
            archive(
                &mut transcripts::Archive::default(),
                &client,
                id,
                &session.transcript_path,
            );
            let started = Instant::now();
            let outcome = match client.end_session(id) {
                Ok(true) => format!("sessions:ended:{id}"),
                Ok(false) => format!("sessions:already-gone:{id}"),
                Err(error) => format!("sessions:end-failed:{id}:{error:#}"),
            };
            log(&outcome, started.elapsed());
        }
    });
}

/// One session's transcript files, caught up with the service. A failure is reported and the pass
/// carries on: what is not sent now is sent by the next pass, or by `recall backfill` long after.
fn archive(archive: &mut transcripts::Archive, client: &Client, session_id: &str, transcript: &Path) {
    let started = Instant::now();
    match archive.send(client, session_id, transcript) {
        Ok(0) => {}
        Ok(bytes) => log(&format!("sessions:archived:{session_id}:{bytes}"), started.elapsed()),
        Err(error) => log(
            &format!("sessions:archive-failed:{session_id}:{error:#}"),
            started.elapsed(),
        ),
    }
}

/// The transcripts of the sessions still running, on a beat of its own. A session works for
/// minutes between prompts and writes the whole time, while the hook that would carry its lines up
/// only fires on a prompt, so without this a long turn reaches the archive only once it is over.
///
/// The beat is `archive.interval.seconds` and not the registry sweep's: the sweep ends dead
/// sessions and runs adoption, which a host wanting its newest lines sooner has no reason to
/// hurry. The registry is read and never swept here, since a second sweeper would unlink the dead
/// records before the tick that owes the service their notice had seen them. One pass runs at a
/// time: the next beat waits on the one before it rather than piling up behind it.
async fn archive_loop(client: Arc<Client>, sessions_dir: PathBuf, every: Duration) {
    let mut beat = tokio::time::interval(every);
    beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut pass = transcripts::Archive::default();
    loop {
        beat.tick().await;
        let live = sessions::transcript_paths(&sessions_dir);
        let client = Arc::clone(&client);
        pass = tokio::task::spawn_blocking(move || {
            pass.retain(&live.iter().map(|(session_id, _)| session_id.as_str()).collect());
            for (session_id, path) in &live {
                archive(&mut pass, &client, session_id, path);
            }
            pass
        })
        .await
        .unwrap_or_default();
    }
}

/// One adoption pass at a time, whatever the tick does: a pass reads transcripts and then waits on
/// the service, so passes left to pile up behind each other would have two of them writing the
/// same records.
struct Pass(Arc<AtomicBool>);

impl Drop for Pass {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// The same adoption `recall sessions --adopt` runs, on the tick that already sweeps the registry:
/// a session the hooks never registered keeps its last activity up with its own transcript until
/// its process is gone, and the sweep above is what ends it then. The transcript is the only thing
/// that moves, so a session whose transcript stood still sends nothing. It runs on a blocking
/// thread, like the end reports, so neither the reading nor the calls can stall message delivery.
fn adopt_running(client: &Arc<Client>, scope: &Arc<adopt::Scope>, running: &Arc<AtomicBool>) {
    if running.swap(true, Ordering::AcqRel) {
        return;
    }
    let pass = Pass(Arc::clone(running));
    let client = Arc::clone(client);
    let scope = Arc::clone(scope);
    tokio::task::spawn_blocking(move || {
        let _pass = pass;
        let started = Instant::now();
        let adopted = match adopt::adopt(&scope) {
            Ok(adopted) => adopted,
            Err(error) => return log(&format!("sessions:adopt-failed:{error:#}"), started.elapsed()),
        };
        for session in adopted {
            let id = &session.session_id;
            let Some(record) = sessions::record(&scope.sessions, id) else {
                continue;
            };
            let started = Instant::now();
            let outcome = match client.sync_record(id, &record) {
                Ok(()) => format!("sessions:{}:{id}", session.outcome),
                Err(error) => format!("sessions:adopt-failed:{id}:{error:#}"),
            };
            log(&outcome, started.elapsed());
        }
    });
}

async fn serve(archive_every: Duration) -> Result<()> {
    let config = config::load()?;
    let url = ws::listen_url(&config.endpoint)?;
    let sessions_dir = sessions_dir();
    let client = Arc::new(Client::new(config.clone()));
    let scope = adopt::Scope::here().map(Arc::new);
    if let Err(error) = scope.as_ref() {
        log(&format!("sessions:adopt-failed:{error:#}"), Duration::ZERO);
    }
    let adopting = Arc::new(AtomicBool::new(false));
    let mut seen = Seen::load(&seen_path());
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).context("listening for SIGTERM")?;
    let work = reconnect_loop(&url, &config.token, &sessions_dir, &mut seen);
    tokio::pin!(work);
    tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = terminate.recv() => Ok(()),
        _ = archive_loop(Arc::clone(&client), sessions_dir.clone(), archive_every) => Ok(()),
        _ = sessions::idle_exit(&sessions_dir, IDLE_CHECK, IDLE_TIMEOUT, |ended| {
            report_ended(&client, ended);
            if let Ok(scope) = scope.as_ref() {
                adopt_running(&client, scope, &adopting);
            }
        }) => Ok(()),
        result = &mut work => result,
    }
}

pub const MESSAGING_OFF: &str = "messaging is off; run recall config set messaging.enabled true to turn it on";
pub const NO_INBOX: &str =
    "Claude set no CLAUDE_CODE_MESSAGING_SOCKET or CLAUDE_CODE_MESSAGING_TOKEN, so this session has no inbox";
pub const ADOPTED: &str = "adopted from its transcript: this session started before the hooks it would have registered with, so it takes no messages until it restarts";

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
    Adopted,
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
                sessions::State::Adopted => Reported::Adopted,
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
        Reported::Adopted => ADOPTED.to_string(),
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
    let _ = std::fs::write(pid_path(), format!("{}\n", std::process::id()));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let outcome = runtime.block_on(serve(settings.archive_interval()));
    log(
        &match &outcome {
            Ok(()) => "listen:stopped".to_string(),
            Err(error) => format!("listen:failed:{error:#}"),
        },
        Duration::ZERO,
    );
    let _ = std::fs::remove_file(pid_path());
    lock.release()?;
    outcome
}

pub const HANDOVER: Duration = Duration::from_secs(5);
const PROCFS: &str = "/proc";

/// Whether the pid file names this host's own daemon, and not whatever process now owns a pid a
/// daemon that was killed left behind: the runtime directory can outlive a reboot, so a stale pid
/// file is ordinary. A pid is only signalled when a daemon really does hold the lock and that pid
/// really is a recall process.
fn daemon(lock: &Path, pid_file: &Path, procfs: &Path) -> Option<i32> {
    let pid = std::fs::read_to_string(pid_file)
        .ok()?
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 1)?;
    if !matches!(Lock::acquire(lock), Ok(None)) {
        return None;
    }
    let argv = std::fs::read(procfs.join(pid.to_string()).join("cmdline")).ok()?;
    let first = argv.split(|byte| *byte == 0).next()?;
    let command = Path::new(OsStr::from_bytes(first)).file_name()?.to_str()?.to_string();
    (command == "recall").then_some(pid)
}

/// Ends this host's daemon and waits for it to let the lock go. A pid file that names no daemon
/// leaves everything alone, and the caller's own `ensure` is then what brings a listener up.
fn stop(lock: &Path, pid_file: &Path, procfs: &Path, limit: Duration) -> bool {
    let Some(pid) = daemon(lock, pid_file, procfs) else {
        return false;
    };
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return false;
    }
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if matches!(Lock::acquire(lock), Ok(Some(_))) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Hands the listener over to the binary now installed. An update replaces the binary under a
/// daemon that goes on running the code it started with: it holds the lock, so nothing newer can
/// take over, and its tick is what keeps every adopted session's last activity moving. Nothing
/// here may fail the update, so the hooks log is where it reports.
pub fn restart(settings: &Settings) {
    let started = Instant::now();
    let stopped = stop(&lock_path(), &pid_path(), Path::new(PROCFS), HANDOVER);
    if !settings.messaging_enabled() {
        log(&format!("listen:stopped-for-update:{stopped}"), started.elapsed());
        return;
    }
    let outcome = match ensure(&lock_path(), spawn_daemon) {
        Ok(true) => "listen:restarted".to_string(),
        Ok(false) => "listen:still-running".to_string(),
        Err(error) => format!("listen:restart-failed:{error:#}"),
    };
    log(&outcome, started.elapsed());
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
                transcript_path: PathBuf::new(),
                usage_pending: None,
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
                status("s-adopted", "/src/fourth", sessions::State::Adopted),
                status(
                    "s-failed",
                    "/src/fifth",
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
                format!("s-adopted  /src/fourth  {ADOPTED}"),
                "s-failed  /src/fifth  writing the registration failed: EACCES, permission denied".to_string(),
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
    fn the_header_names_the_handle_to_answer_on_and_falls_back_to_the_host() {
        let message = |from_host: &str, from_name: &str| Message {
            message_id: "m-1".to_string(),
            to_device_id: "d-2".to_string(),
            to_session_id: String::new(),
            from_device_id: "d-1".to_string(),
            from_host: from_host.to_string(),
            from_name: from_name.to_string(),
            body: "ship it".to_string(),
            created_at: 1_762_000_000_000,
            expires_at: 1_762_259_200_000,
        };

        assert_eq!(
            header(&message("core", "ip-10-0-7-31-9f8a")),
            "[recall from core/ip-10-0-7-31-9f8a; reply with recall_send to \"ip-10-0-7-31-9f8a\"]"
        );
        assert_eq!(
            header(&message("core", "")),
            "[recall from core; reply with recall_send to \"core\"]"
        );
        assert_eq!(
            header(&message("", "")),
            "[recall from d-1; reply with recall_send to \"d-1\"]"
        );
        assert_eq!(delivered_body(&message("core", "")).lines().last().unwrap(), "ship it");
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

    /// The pid file names this test's own process twice over, so a signal sent where none is due
    /// would take the test runner down with it: surviving the first two passes is the assertion.
    #[test]
    fn only_a_recall_daemon_that_holds_the_lock_is_ever_signalled() {
        let dir = sandbox("stop");
        let lock = dir.join("listen.lock");
        let pid_file = dir.join("listen.pid");
        let procfs = dir.join("proc");
        let named = |pid: u32, argv: &str| {
            let entry = procfs.join(pid.to_string());
            std::fs::create_dir_all(&entry).unwrap();
            std::fs::write(entry.join("cmdline"), argv.replace(' ', "\0")).unwrap();
            std::fs::write(&pid_file, format!("{pid}\n")).unwrap();
        };
        let limit = Duration::from_millis(100);

        named(std::process::id(), "node --test");
        assert!(
            !stop(&lock, &pid_file, &procfs, limit),
            "a pid now owned by something else is left alone"
        );

        named(std::process::id(), "/home/you/.cargo/bin/recall listen");
        assert!(
            !stop(&lock, &pid_file, &procfs, limit),
            "a pid file no daemon stands behind is a stale one, whatever it names"
        );

        let mut standing_in = Command::new("sleep").arg("60").spawn().unwrap();
        named(standing_in.id(), "recall listen");
        let held = Lock::acquire(&lock).unwrap().unwrap();
        assert!(
            !stop(&lock, &pid_file, &procfs, limit),
            "the lock stays held here, so the handover never completes"
        );
        assert!(
            !standing_in.wait().unwrap().success(),
            "the daemon holding the lock is the one that gets the signal"
        );

        held.release().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
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
