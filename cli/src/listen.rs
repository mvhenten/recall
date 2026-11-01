use crate::api::Message;
use crate::config;
use crate::seen::Seen;
use crate::sessions;
use crate::settings::Settings;
use crate::ws::{self, Ended};
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

/// Appends the line shape hooks/lib.mjs writes, so the daemon and the hooks share one log.
fn log(outcome: &str, took: Duration) {
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
    if !seen.insert(&message.message_id) {
        log(&format!("message:replayed:{}", message.message_id), started.elapsed());
        return;
    }
    let fanout = sessions::fanout(sessions_dir, &message.body).await;
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

async fn serve() -> Result<()> {
    let config = config::load()?;
    let url = ws::listen_url(&config.endpoint)?;
    let sessions_dir = sessions_dir();
    let mut seen = Seen::load(&seen_path());
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).context("listening for SIGTERM")?;
    let work = reconnect_loop(&url, &config.token, &sessions_dir, &mut seen);
    tokio::pin!(work);
    tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = terminate.recv() => Ok(()),
        _ = sessions::idle_exit(&sessions_dir, IDLE_CHECK, IDLE_TIMEOUT) => Ok(()),
        result = &mut work => result,
    }
}

pub fn run(settings: &Settings, ensure_only: bool) -> Result<()> {
    if !settings.messaging_enabled() {
        eprintln!("recall: messaging is off; run recall config set messaging.enabled true to turn it on");
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
