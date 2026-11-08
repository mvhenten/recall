use crate::adopt;
use crate::api::{Client, Kind, Message};
use crate::config;
use crate::seen::Seen;
use crate::sessions;
use crate::settings::Settings;
use crate::transcripts;
use crate::watch;
use crate::ws::{self, Ended, Reply};
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedReceiver;

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

/// The device id a message typed into the dashboard carries. Every real device id is a UUID the
/// service minted, so no device can claim this one; a host's label can read as anything and is
/// never tested here.
pub(crate) const DASHBOARD_DEVICE: &str = "dashboard";

/// The line a delivered message arrives under. A session reading one otherwise sees a bare user
/// turn with nothing saying where it came from, and Claude Code's own cross-session tools reach
/// only sessions on the same machine, so the route back has to be spelled out. The handle answers
/// the one session that asked; a sender that named none is answered on its device id, which is
/// unique and unchanging, where its label is neither and only ever reads as prose. A message
/// queued before a send named its sender has no host to read as, and says the device id instead.
///
/// Nobody typed a dashboard message at a session, so `recall_send` has nothing to answer: the
/// address would be the signed-in email, which resolves to no device, name, label or handle. The
/// line says where it came from and stops, rather than printing a reply route that always fails.
pub fn header(message: &Message) -> String {
    if message.from_device_id == DASHBOARD_DEVICE {
        if message.from_name.is_empty() {
            return "[recall from the dashboard; it has no reply address, so answer in this session]".to_string();
        }
        return format!(
            "[recall from the dashboard, signed in as {}; it has no reply address, so answer in this session]",
            message.from_name
        );
    }
    let from = if message.from_host.is_empty() {
        &message.from_device_id
    } else {
        &message.from_host
    };
    if message.from_name.is_empty() {
        return format!(
            "[recall from {from}; reply with recall_send to \"{}\"]",
            message.from_device_id
        );
    }
    format!(
        "[recall from {from}/{}; reply with recall_send to \"{}\"]",
        message.from_name, message.from_name
    )
}

fn delivered_body(message: &Message) -> String {
    format!("{}\n{}", header(message), message.body)
}

/// News is written into the sessions that were listening and answered with nothing; only an order
/// writes a receipt back, naming the session that took it. A message can only arrive twice where
/// it went to every socket the host has open, which is news, so that is where the duplicate is
/// dropped before it reaches a session.
async fn deliver(message: &Message, sessions_dir: &Path, seen: &mut Seen) -> Option<Reply> {
    let started = Instant::now();
    let body = delivered_body(message);
    match message.kind {
        Kind::Order => Some(order(message, sessions_dir, &body, started).await),
        Kind::News => {
            if seen.contains(&message.message_id) {
                log(&format!("message:replayed:{}", message.message_id), started.elapsed());
                return None;
            }
            news(message, sessions_dir, seen, &body, started).await;
            None
        }
    }
}

async fn news(message: &Message, sessions_dir: &Path, seen: &mut Seen, body: &str, started: Instant) {
    let (target, fanout) = if message.to_session_id.is_empty() {
        ("host".to_string(), sessions::to_host(sessions_dir, body).await)
    } else {
        (
            format!("session:{}", message.to_session_id),
            sessions::to_session(sessions_dir, &message.to_session_id, body).await,
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

async fn order(message: &Message, sessions_dir: &Path, body: &str, started: Instant) -> Reply {
    let placed = if message.to_session_id.is_empty() {
        sessions::to_one(sessions_dir, body).await
    } else {
        sessions::to_one_session(sessions_dir, &message.to_session_id, body).await
    };
    let id = &message.message_id;
    let (outcome, reply) = match placed {
        sessions::Placed::Taken(session_id) => (format!("taken:{session_id}"), Reply::Took(session_id)),
        sessions::Placed::Retired => ("retired".to_string(), Reply::NoTaker),
    };
    log(
        &format!("order:{}:{id}:{outcome}", message.from_device_id),
        started.elapsed(),
    );
    reply
}

async fn session(url: &str, token: &str, sessions_dir: &Path, seen: &mut Seen) -> Result<Ended> {
    let mut socket = ws::connect(url, token).await?;
    log("listen:connected", Duration::ZERO);
    ws::pump(&mut socket, async |message: Message| {
        deliver(&message, sessions_dir, seen).await
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
fn report_ended(client: &Arc<Client>, places: &Arc<Mutex<transcripts::Archive>>, ended: Vec<sessions::Ended>) {
    if ended.is_empty() {
        return;
    }
    let client = Arc::clone(client);
    let held_at = Arc::clone(places);
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
            // The run's own place in every file, so a session ending costs the writes it owes and
            // not a listing and a reading of the whole transcript to find where it had got to.
            // This is the last pass over these files, so the record at the end of each goes up
            // whether or not the line it sits on was finished.
            archive(
                &mut held(&held_at),
                &client,
                id,
                &session.transcript_path,
                transcripts::Pass::Final,
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

/// Where this run has got to in every file of every session it has archived. One place is shared
/// by the beat and the session ends, so neither pays for the reading the other already did. A
/// place left behind by a pass that panicked is still a place, so a poisoned lock is taken as it
/// stands rather than taking the daemon down with it.
fn held(archive: &Arc<Mutex<transcripts::Archive>>) -> std::sync::MutexGuard<'_, transcripts::Archive> {
    archive.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One session's transcript files, caught up with the service. A failure is reported and the pass
/// carries on: what is not sent now is sent by the next pass, or by `recall backfill` long after.
fn archive(
    archive: &mut transcripts::Archive,
    client: &Client,
    session_id: &str,
    transcript: &Path,
    pass: transcripts::Pass,
) {
    let started = Instant::now();
    match archive.send(client, session_id, transcript, pass) {
        Ok(0) => {}
        Ok(records) => log(&format!("sessions:archived:{session_id}:{records}"), started.elapsed()),
        Err(error) => log(
            &format!("sessions:archive-failed:{session_id}:{error:#}"),
            started.elapsed(),
        ),
    }
}

/// The floor the debounce never drops below, whatever the archive interval scales it down to.
pub const MIN_DEBOUNCE: Duration = Duration::from_millis(500);

/// How long a write waits for the writes behind it. A turn lands as a run of lines and a persisted
/// tool output as a run of blocks, so a pass per event would send one file a dozen times over
/// where a single pass carries all of it. Scaled off the archive interval rather than fixed, so a
/// host that set a short interval because it wants its lines up sooner is not undercut by a
/// debounce that outlasts the interval it configured.
pub fn debounce(every: Duration) -> Duration {
    MIN_DEBOUNCE.max(every / 4)
}

/// What a pass over the live transcripts runs on.
enum Woken {
    Beat,
    Written,
    Deaf,
}

/// Runs a pass whenever a session writes, and on the beat besides. The watch is what the daemon
/// normally wakes on; the beat is the backstop, for the filesystems inotify does not reach, the
/// watch that could not be established, and the write no event arrived for. A burst of writes is
/// one pass: the first event opens a window, everything that lands in it is drained, and the pass
/// runs once the window is out. The beat is reset behind a pass the watch asked for, so a session
/// writing steadily costs the passes its writing earns and not those plus the beat's.
///
/// One pass runs at a time, and the first runs before anything is waited on: it is what
/// establishes the watches, and a daemon that came up under a session already running owes it the
/// lines written while there was nothing watching.
async fn wake_loop(every: Duration, debounce: Duration, wake: &mut UnboundedReceiver<()>, mut pass: impl AsyncFnMut()) {
    pass().await;
    let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut watching = true;
    loop {
        let woken = tokio::select! {
            _ = beat.tick() => Woken::Beat,
            event = wake.recv(), if watching => match event {
                Some(()) => Woken::Written,
                None => Woken::Deaf,
            },
        };
        match woken {
            Woken::Beat => {}
            Woken::Written => {
                tokio::time::sleep(debounce).await;
                while wake.try_recv().is_ok() {}
                beat.reset();
            }
            Woken::Deaf => {
                watching = false;
                continue;
            }
        }
        pass().await;
    }
}

/// The directories the live sessions are writing in. A session whose record carries no transcript
/// names none, and neither does one whose directories are not there to be watched.
fn watched(live: &[(String, PathBuf)]) -> BTreeMap<PathBuf, watch::Depth> {
    live.iter().flat_map(|(_, path)| transcripts::dirs(path)).collect()
}

/// The transcripts of the sessions still running. A session works for minutes between prompts and
/// writes the whole time, while the hook that would carry its lines up only fires on a prompt, so
/// without this a long turn reaches the archive only once it is over.
///
/// The beat is `archive.interval.seconds` and not the registry sweep's: the sweep ends dead
/// sessions and runs adoption, which a host wanting its newest lines sooner has no reason to
/// hurry. The registry is read and never swept here, since a second sweeper would unlink the dead
/// records before the tick that owes the service their notice had seen them.
async fn archive_loop(
    client: Arc<Client>,
    held_at: Arc<Mutex<transcripts::Archive>>,
    sessions_dir: PathBuf,
    every: Duration,
    mut watch: Option<watch::Watch>,
    mut wake: UnboundedReceiver<()>,
) {
    wake_loop(every, debounce(every), &mut wake, async || {
        let live = sessions::transcript_paths(&sessions_dir);
        if let Some(watch) = watch.as_mut() {
            for unwatched in watch.sync(&watched(&live)) {
                log(
                    &format!("sessions:unwatched:{}:{}", unwatched.dir.display(), unwatched.error),
                    Duration::ZERO,
                );
            }
        }
        let client = Arc::clone(&client);
        let held_at = Arc::clone(&held_at);
        let beaten = tokio::task::spawn_blocking(move || {
            let mut pass = held(&held_at);
            pass.retain(&live.iter().map(|(session_id, _)| session_id.as_str()).collect());
            for (session_id, path) in &live {
                // Every session here is still running, so a record half written at the end of one
                // of its files waits for the pass that holds the whole of it.
                archive(&mut pass, &client, session_id, path, transcripts::Pass::Open);
            }
        })
        .await;
        if let Err(error) = beaten {
            log(&format!("sessions:archive-failed:{error}"), Duration::ZERO);
        }
    })
    .await;
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
    let held_at = Arc::new(Mutex::new(transcripts::Archive::default()));
    let (wake, woken) = watch::wake();
    let watching = match watch::Watch::new(wake) {
        Ok(watch) => Some(watch),
        Err(error) => {
            log(&format!("sessions:watch-failed:{error:#}"), Duration::ZERO);
            None
        }
    };
    let mut seen = Seen::load(&seen_path());
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).context("listening for SIGTERM")?;
    let work = reconnect_loop(&url, &config.token, &sessions_dir, &mut seen);
    tokio::pin!(work);
    tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = terminate.recv() => Ok(()),
        _ = archive_loop(Arc::clone(&client), Arc::clone(&held_at), sessions_dir.clone(), archive_every, watching, woken) => Ok(()),
        _ = sessions::idle_exit(&sessions_dir, IDLE_CHECK, IDLE_TIMEOUT, |ended| {
            report_ended(&client, &held_at, ended);
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
    use std::sync::atomic::AtomicUsize;

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
    fn the_header_answers_on_the_handle_and_falls_back_to_the_device_id() {
        let sent = |from_device_id: &str, from_host: &str, from_name: &str| Message {
            message_id: "m-1".to_string(),
            kind: Kind::News,
            to_device_id: "d-2".to_string(),
            to_session_id: String::new(),
            from_device_id: from_device_id.to_string(),
            from_host: from_host.to_string(),
            from_name: from_name.to_string(),
            body: "ship it".to_string(),
            created_at: 1_762_000_000_000,
        };
        let message = |from_host: &str, from_name: &str| sent("d-1", from_host, from_name);

        assert_eq!(
            header(&message("core", "ip-10-0-7-31-9f8a")),
            "[recall from core/ip-10-0-7-31-9f8a; reply with recall_send to \"ip-10-0-7-31-9f8a\"]"
        );
        assert_eq!(
            header(&message("core", "")),
            "[recall from core; reply with recall_send to \"d-1\"]"
        );
        assert_eq!(
            header(&message("", "")),
            "[recall from d-1; reply with recall_send to \"d-1\"]"
        );
        assert_eq!(delivered_body(&message("core", "")).lines().last().unwrap(), "ship it");
    }

    /// A browser types into the dashboard and no device sends it, so the one thing the line must
    /// not do is print an address `recall_send` cannot resolve. A host labelled with the owner's
    /// own email changes nothing: the dashboard is told apart by the device id the service sets,
    /// which no device can hold.
    #[test]
    fn the_header_gives_a_dashboard_message_no_reply_address() {
        let sent = |from_device_id: &str, from_host: &str| Message {
            message_id: "m-2".to_string(),
            kind: Kind::News,
            to_device_id: "d-2".to_string(),
            to_session_id: "s-9".to_string(),
            from_device_id: from_device_id.to_string(),
            from_host: from_host.to_string(),
            from_name: "owner@example.com".to_string(),
            body: "ship it".to_string(),
            created_at: 1_762_000_000_000,
        };

        let line = header(&sent("dashboard", "dashboard"));

        assert_eq!(
            line,
            "[recall from the dashboard, signed in as owner@example.com; it has no reply address, so answer in this session]"
        );
        assert!(!line.contains("recall_send"), "{line}");
        // A host labelled with the owner's own email is still a device, and still gets the reply
        // route its handle resolves on.
        assert_eq!(
            header(&sent("9f8a1b2c-0d1e-4f20-8a3b-5c6d7e8f9a0b", "owner@example.com")),
            "[recall from owner@example.com/owner@example.com; reply with recall_send to \"owner@example.com\"]"
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

    /// The clock is paused, so every wait here is the runtime jumping to the next deadline and
    /// nothing is actually slept through: what the burst proves is the count of passes, not how
    /// long they took.
    fn passes() -> (Arc<AtomicUsize>, impl AsyncFnMut()) {
        let ran = Arc::new(AtomicUsize::new(0));
        let counting = Arc::clone(&ran);
        (ran, async move || {
            counting.fetch_add(1, Ordering::Release);
        })
    }

    /// The whole point of the debounce. A turn lands as a run of writes, and every one of them is
    /// an event; left undebounced each would be its own pass over the same files.
    #[tokio::test(start_paused = true)]
    async fn a_burst_of_writes_is_one_pass_and_not_one_per_write() {
        let every = Duration::from_secs(10);
        let (ran, pass) = passes();
        let (wake, mut woken) = watch::wake();
        for _ in 0..12 {
            wake.send(()).unwrap();
        }

        let _ = tokio::time::timeout(every / 2, wake_loop(every, debounce(every), &mut woken, pass)).await;

        assert_eq!(
            ran.load(Ordering::Acquire),
            2,
            "the pass that establishes the watches, and one for the whole burst"
        );
    }

    /// A watch that was never established, a filesystem inotify does not reach, and a write no
    /// event arrived for all come out here: the beat runs the pass with nothing waking it.
    #[tokio::test(start_paused = true)]
    async fn the_beat_still_runs_a_pass_when_no_write_is_ever_announced() {
        let every = Duration::from_secs(10);
        let (ran, pass) = passes();
        let (_wake, mut woken) = watch::wake();

        let _ = tokio::time::timeout(
            every * 3 + every / 2,
            wake_loop(every, debounce(every), &mut woken, pass),
        )
        .await;

        assert_eq!(
            ran.load(Ordering::Acquire),
            4,
            "the first pass and one on each of three beats"
        );
    }

    /// A beat behind a pass the watch asked for would send over files the pass just read. The
    /// window is a fraction of the beat here, so a write early in a beat still leaves most of one
    /// behind it, and nothing but the reset keeps the beat from firing into it.
    #[tokio::test(start_paused = true)]
    async fn a_write_pushes_the_beat_out_rather_than_adding_a_pass_to_it() {
        let every = Duration::from_secs(10);
        let debounce = debounce(every);
        let (ran, pass) = passes();
        let (wake, mut woken) = watch::wake();
        tokio::spawn(async move {
            tokio::time::sleep(every - debounce * 2).await;
            wake.send(()).unwrap();
            std::future::pending::<()>().await;
        });

        let _ = tokio::time::timeout(every + every / 2, wake_loop(every, debounce, &mut woken, pass)).await;

        assert_eq!(
            ran.load(Ordering::Acquire),
            2,
            "the first pass and the written one; the beat it displaced is still ahead"
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
