//! The sessions the hooks never registered. Hooks load when a session starts, so a plugin update
//! leaves every session that was already running without a record: it never syncs, and the
//! dashboard shows nothing of it until it restarts. What its hooks would have written is read back
//! out of /proc and the session's own transcript instead — the Claude processes running now, the
//! transcript each one opened, and the prompts in it.
//!
//! A session the registry already names is left alone, whatever its record says and whether or not
//! that record even parses: the hooks own what they wrote, and adoption only fills an absence. The
//! record it writes carries `state: adopted`, which is both what `recall listen --status` reports
//! and the mark that says a later pass may move this record on. The first prompt a current hook
//! sees takes the record back, and adoption leaves it alone from then on.
//!
//! The transcript is read line by line and past a mark, as hooks/usage.mjs reads one: one JSON
//! document a line, a line that does not parse skipped, a stretch cut back to its last complete
//! line, and `message.content` either a string or a list of blocks. That reader counts what the
//! models answered; this one reads what the user typed, and the two never read the same entries.
//! It lives here rather than in the hooks because the daemon tick that keeps an adopted session
//! fresh is this binary's, and the hooks are installed as a plugin this binary cannot find.

use crate::config;
use crate::listen;
use crate::repo;
use crate::sessions::Focus;
use anyhow::{Context, Result};
use jiff::Timestamp;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Mirrors FOCUS_PART_CHARS in hooks/messaging.mjs.
const FOCUS_PART_CHARS: usize = 72;
const CLAUDE: &str = "claude";
pub const TRANSCRIPT: &str = "jsonl";
const HEAD: usize = 8192;
const ADOPTED: &str = "adopted";

/// How long after a session starts its transcript may be opened. Claude Code opens one seconds in,
/// so a wide allowance still holds, and it keeps a process whose own transcript is missing from
/// reaching forward to one a session that started much later opened.
const OPENED_WITHIN: std::time::Duration = std::time::Duration::from_secs(300);

/// The tagged envelopes Claude Code writes as a user turn. A transcript old enough to carry no
/// origin on its entries is read off these instead; a prompt that merely opens with a tag of its
/// own, a question about `<div>` for one, still counts.
const ENVELOPES: [&str; 7] = [
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<system-reminder>",
    "<task-notification>",
];

/// Where one pass looks: the procfs that names the running processes, the directory Claude Code
/// writes transcripts under, the registry the hooks write, and the host name a record carries.
#[derive(Debug, Clone)]
pub struct Scope {
    pub procfs: PathBuf,
    pub projects: PathBuf,
    pub sessions: PathBuf,
    pub host: String,
}

impl Scope {
    pub fn here() -> Result<Scope> {
        let claude =
            config::claude_dir().context("neither CLAUDE_CONFIG_DIR nor HOME is set, so there are no transcripts")?;
        Ok(Scope {
            procfs: PathBuf::from("/proc"),
            projects: claude.join("projects"),
            sessions: listen::sessions_dir(),
            host: crate::host_name(),
        })
    }
}

/// One running Claude process. `started` is when it began, and that is what says which transcript
/// is its own: Claude Code opens the session's transcript seconds after the process starts, so the
/// transcript born soonest after that is the one this session is writing.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Process {
    pid: i32,
    cwd: PathBuf,
    mode: String,
    started: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Transcript {
    session_id: String,
    path: PathBuf,
    born: SystemTime,
    modified: SystemTime,
    size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Claim {
    process: Process,
    transcript: Transcript,
}

/// A record this pass wrote: `adopted` for a session that had none, `refreshed` for one whose
/// transcript has been written to since the last pass. Either way the service has not been told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adoption {
    pub session_id: String,
    pub outcome: &'static str,
}

pub fn millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or_default()
}

fn number(document: &Value, field: &str) -> i64 {
    document[field].as_i64().unwrap_or_default()
}

fn text(document: &Value, field: &str) -> String {
    document[field].as_str().unwrap_or_default().to_string()
}

fn argv(procfs: &Path, pid: i32) -> Vec<String> {
    std::fs::read(procfs.join(pid.to_string()).join("cmdline"))
        .map(|bytes| {
            bytes
                .split(|byte| *byte == 0)
                .filter(|part| !part.is_empty())
                .map(|part| String::from_utf8_lossy(part).into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// `claude -p` runs headless; mirrors invocation() in hooks/messaging.mjs.
fn mode(argv: &[String]) -> String {
    let headless = argv.iter().any(|arg| arg == "-p" || arg == "--print");
    if headless { "headless" } else { "interactive" }.to_string()
}

/// The harness names its own process `claude`, whatever it was started through, so `comm` is the
/// reading to trust; a wrapper that leaves `comm` as the runtime's name is caught by argv.
fn is_claude(procfs: &Path, pid: i32, argv: &[String]) -> bool {
    let comm = std::fs::read_to_string(procfs.join(pid.to_string()).join("comm")).unwrap_or_default();
    if comm.trim() == CLAUDE {
        return true;
    }
    argv.first()
        .map(|arg| Path::new(arg).file_name() == Some(OsStr::new(CLAUDE)))
        .unwrap_or(false)
}

/// When the process began: procfs stamps the pid's own directory with it.
fn started(procfs: &Path, pid: i32) -> SystemTime {
    std::fs::metadata(procfs.join(pid.to_string()))
        .and_then(|metadata| metadata.modified())
        .unwrap_or(UNIX_EPOCH)
}

/// Every Claude process this host is running.
fn running(scope: &Scope) -> Vec<Process> {
    let Ok(entries) = std::fs::read_dir(&scope.procfs) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter_map(|pid| {
            let argv = argv(&scope.procfs, pid);
            if !is_claude(&scope.procfs, pid, &argv) {
                return None;
            }
            Some(Process {
                pid,
                cwd: std::fs::read_link(scope.procfs.join(pid.to_string()).join("cwd")).ok()?,
                mode: mode(&argv),
                started: started(&scope.procfs, pid),
            })
        })
        .collect()
}

/// Mirrors how Claude Code names a project directory: every character outside [A-Za-z0-9] becomes
/// a dash, so /home/you/.dotfiles is -home-you--dotfiles.
fn slug(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn timestamp(entry: &Value) -> Option<i64> {
    entry["timestamp"]
        .as_str()?
        .parse::<Timestamp>()
        .ok()
        .map(|time| time.as_millisecond())
}

/// The time the first entry of a transcript carries, read out of its opening bytes.
fn opened(path: &Path) -> Option<i64> {
    let file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    file.take(HEAD as u64).read_to_end(&mut head).ok()?;
    String::from_utf8_lossy(&head)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|entry| timestamp(&entry))
}

/// When the transcript was opened. The filesystem's own creation time is the reading to trust, and
/// a filesystem that keeps none leaves the time of the first entry. Nothing else will do: a last
/// write says when a session was busy and not when it began, and matching on that is what hands a
/// live session the id of one that ended. A transcript that can say neither is one no running
/// session is matched to at all.
pub fn birth(path: &Path, metadata: &std::fs::Metadata) -> Option<SystemTime> {
    if let Ok(created) = metadata.created() {
        return Some(created);
    }
    let at = opened(path).filter(|at| *at > 0)?;
    Some(UNIX_EPOCH + std::time::Duration::from_millis(at as u64))
}

/// The transcripts of one directory. A session's transcript sits directly under the project
/// directory; a subagent's sits a level down and is no session of its own.
fn transcripts(projects: &Path, cwd: &Path) -> Vec<Transcript> {
    let Ok(entries) = std::fs::read_dir(projects.join(slug(cwd))) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension() != Some(OsStr::new(TRANSCRIPT)) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some(Transcript {
                session_id: path.file_stem()?.to_str()?.to_string(),
                born: birth(&path, &metadata)?,
                modified: metadata.modified().ok()?,
                size: metadata.len(),
                path,
            })
        })
        .collect()
}

/// What the registry already holds: every session it names, the Claude processes those records
/// name, and the adopted records a pass may move on. A record counts as present from its file
/// alone, parsed or not — the hooks write one with a single write and no rename, so a record read
/// mid-write does not parse, and overwriting that session would throw away the inbox it carries.
#[derive(Debug, Default)]
struct Registry {
    sessions: HashSet<String>,
    pids: HashSet<i32>,
    adopted: Vec<(String, Value)>,
}

fn parsed(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn registry(dir: &Path) -> Registry {
    let mut registry = Registry::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return registry;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("json")) {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string) else {
            continue;
        };
        registry.sessions.insert(session_id.clone());
        let Some(document) = parsed(&path) else {
            continue;
        };
        if let Some(pid) = document["pid"].as_i64() {
            registry.pids.insert(pid as i32);
        }
        if document["state"] == ADOPTED {
            registry.adopted.push((session_id, document));
        }
    }
    registry.adopted.sort_by(|left, right| left.0.cmp(&right.0));
    registry
}

/// Which transcript each running session opened. A process the registry already names is passed
/// over, and so is a transcript it already names, so only what nothing describes is matched at
/// all. Of what is left, a process takes the transcript born soonest after it started: a session
/// that ended minutes ago leaves the directory's most recently written transcript behind, and
/// matching on that would hand a live session a dead one's id.
///
/// A session resumed into a transcript opened before it was is passed over rather than guessed at.
/// Nothing in a transcript says which process is writing it, and taking one that merely looks
/// recent is exactly how a live session ends up under a dead one's id; that session is listed
/// again when it next starts.
fn claims(scope: &Scope, registry: &Registry) -> Vec<Claim> {
    let mut by_directory: BTreeMap<PathBuf, Vec<Process>> = BTreeMap::new();
    for process in running(scope) {
        if registry.pids.contains(&process.pid) {
            continue;
        }
        by_directory.entry(process.cwd.clone()).or_default().push(process);
    }
    let mut claimed = Vec::new();
    for (cwd, mut processes) in by_directory {
        let mut available: Vec<Transcript> = transcripts(&scope.projects, &cwd)
            .into_iter()
            .filter(|transcript| !registry.sessions.contains(&transcript.session_id))
            .collect();
        processes.sort_by_key(|process| process.started);
        for process in processes {
            let found = available
                .iter()
                .enumerate()
                .filter(|(_, transcript)| {
                    transcript
                        .born
                        .duration_since(process.started)
                        .is_ok_and(|after| after <= OPENED_WITHIN)
                })
                .min_by_key(|(_, transcript)| transcript.born)
                .map(|(index, _)| index);
            let Some(index) = found else {
                continue;
            };
            claimed.push(Claim {
                transcript: available.remove(index),
                process,
            });
        }
    }
    claimed.sort_by_key(|claim| claim.process.pid);
    claimed
}

/// What a transcript says about its session, and how far into it this reading has reached. It goes
/// into the next pass as it stands, so a stretch with no prompt in it leaves the count and the
/// focus where they are.
///
/// `cwd` and `git_branch` are what the entries themselves carry, taken from the last one that
/// names either: a session that moved between directories or branches ended where it ended. A
/// running session has both from its own process and its own `git log` instead, so only a session
/// read back long after it ended has anything to take from here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reading {
    pub offset: u64,
    pub started_at: i64,
    pub last_at: i64,
    pub prompts: i64,
    pub focus: Focus,
    pub permission_mode: String,
    pub cwd: String,
    pub git_branch: String,
}

/// A prompt cut to what one terminal row holds, as hooks/messaging.mjs cuts it.
fn truncate(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= FOCUS_PART_CHARS {
        return line;
    }
    let kept: String = line.chars().take(FOCUS_PART_CHARS - 1).collect();
    format!("{}…", kept.trim_end())
}

fn content(message: &Value) -> String {
    match &message["content"] {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// What the user typed, for an entry that is a prompt they typed. Claude Code writes several kinds
/// of entry as a user turn — a tool result, a notification about a task, the expansion of a slash
/// command, the summary a compaction leaves behind — and counting those as prompts is what kept
/// the usage reader from taking its prompt count from the transcript at all. Current transcripts
/// say which is which outright: `origin.kind` is `human` for a prompt the user submitted and names
/// the machinery that wrote every other one. An older transcript carries no origin, and is read
/// off the marks it does have: a tool result, an interrupted turn, a meta entry, a compaction
/// summary and the envelopes above are none of them prompts.
fn typed(entry: &Value) -> Option<String> {
    if entry["type"] != "user" {
        return None;
    }
    if !entry["toolUseResult"].is_null() || !entry["interruptedMessageId"].is_null() {
        return None;
    }
    for mark in ["isMeta", "isSidechain", "isVisibleInTranscriptOnly", "isCompactSummary"] {
        if entry[mark] == true {
            return None;
        }
    }
    let text = content(&entry["message"]).trim().to_string();
    if text.is_empty() {
        return None;
    }
    match entry["origin"]["kind"].as_str() {
        Some("human") => Some(text),
        Some(_) => None,
        None if ENVELOPES.iter().any(|envelope| text.starts_with(envelope)) => None,
        None => Some(text),
    }
}

/// The stretch of transcript past the mark the last reading left, cut back to its last complete
/// line: an entry still being written is never half-read, and the next pass takes it whole. A file
/// shorter than the mark is a different transcript under the same name, and is read again from its
/// start.
pub fn read_on(path: &Path, carried: Reading) -> Reading {
    let Ok(mut file) = std::fs::File::open(path) else {
        return carried;
    };
    let size = file.metadata().map(|metadata| metadata.len()).unwrap_or_default();
    let restarted = size < carried.offset;
    let from = if restarted { 0 } else { carried.offset };
    let mut reading = if restarted { Reading::default() } else { carried.clone() };
    if file.seek(SeekFrom::Start(from)).is_err() {
        return carried;
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return carried;
    }
    let Some(cut) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        reading.offset = from;
        return reading;
    };
    reading.offset = from + cut as u64 + 1;
    read_text(&String::from_utf8_lossy(&bytes[..cut]), reading)
}

/// What a stretch of transcript says, for a caller that already holds it. A line that does not
/// parse is skipped, which is also what an entry still being written leaves behind.
pub fn read_text(stretch: &str, carried: Reading) -> Reading {
    let mut reading = carried;
    for line in stretch.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(at) = timestamp(&entry) {
            if reading.started_at == 0 {
                reading.started_at = at;
            }
            reading.last_at = at;
        }
        for (field, into) in [("cwd", &mut reading.cwd), ("gitBranch", &mut reading.git_branch)] {
            let found = text(&entry, field);
            if !found.is_empty() {
                *into = found;
            }
        }
        let Some(prompt) = typed(&entry) else {
            continue;
        };
        let latest = truncate(&prompt);
        if reading.focus.first.is_empty() {
            reading.focus.first = latest.clone();
        }
        reading.focus.latest = latest;
        reading.prompts += 1;
        reading.permission_mode = text(&entry, "permissionMode");
    }
    reading
}

fn record_path(scope: &Scope, session_id: &str) -> PathBuf {
    scope.sessions.join(format!("{session_id}.json"))
}

fn write(path: &Path, document: &Value) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("locking down {}", dir.display()))?;
    }
    std::fs::write(path, format!("{}\n", serde_json::to_string(document)?))
        .with_context(|| format!("writing {}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("locking down {}", path.display()))
}

/// The fields a transcript can move, written over the record the pass started from. The rest of
/// that record is left as it stands, so everything the hooks own — the inbox, the sync stamp, the
/// usage marks and a delta waiting to go out — survives a pass that only moves the focus on.
fn moved(document: &mut Value, reading: &Reading, head: &repo::Head, last_activity_at: i64) {
    let Some(fields) = document.as_object_mut() else {
        return;
    };
    for (field, value) in [
        ("lastActivityAt", Value::from(last_activity_at)),
        ("prompts", Value::from(reading.prompts)),
        ("focus", json!(reading.focus)),
        ("permissionMode", Value::from(reading.permission_mode.clone())),
        ("branch", Value::from(head.branch.clone())),
        ("commit", Value::from(head.commit.clone())),
        ("adoptedOffset", Value::from(reading.offset)),
    ] {
        fields.insert(field.to_string(), value);
    }
}

/// Moves an adopted record on when the transcript it names has been written to since the last
/// pass. Only the stretch past the mark the last pass left is read, so a tick costs the bytes the
/// session has written rather than the whole transcript.
fn refresh(scope: &Scope, session_id: &str, stored: &Value) -> Result<Option<Adoption>> {
    let path = PathBuf::from(text(stored, "transcriptPath"));
    let Ok(modified) = std::fs::metadata(&path).and_then(|metadata| metadata.modified()) else {
        return Ok(None);
    };
    let last_activity_at = millis(modified);
    if number(stored, "lastActivityAt") == last_activity_at {
        return Ok(None);
    }
    let reading = read_on(
        &path,
        Reading {
            offset: number(stored, "adoptedOffset").max(0) as u64,
            started_at: number(stored, "startedAt"),
            prompts: number(stored, "prompts"),
            focus: Focus {
                first: text(&stored["focus"], "first"),
                latest: text(&stored["focus"], "latest"),
            },
            permission_mode: text(stored, "permissionMode"),
            ..Reading::default()
        },
    );
    let mut document = stored.clone();
    moved(
        &mut document,
        &reading,
        &repo::head(Path::new(&text(stored, "cwd"))),
        last_activity_at,
    );
    write(&record_path(scope, session_id), &document)?;
    Ok(Some(Adoption {
        session_id: session_id.to_string(),
        outcome: "refreshed",
    }))
}

/// Writes the record one running session is missing. The usage marks start at the end of the
/// transcript: nothing has counted the tokens spent before this pass, and the hook that takes the
/// record over must not count them twice.
fn take_on(scope: &Scope, claim: &Claim) -> Result<Adoption> {
    let session_id = &claim.transcript.session_id;
    let reading = read_on(&claim.transcript.path, Reading::default());
    let head = repo::head(&claim.process.cwd);
    let document = json!({
        "state": ADOPTED,
        "pid": claim.process.pid,
        "cwd": claim.process.cwd,
        "sessionId": session_id,
        "host": scope.host,
        "repo": repo::repo_tag(&claim.process.cwd).unwrap_or_default(),
        "branch": head.branch,
        "commit": head.commit,
        "startedAt": match reading.started_at {
            0 => millis(claim.transcript.born),
            at => at,
        },
        "lastActivityAt": millis(claim.transcript.modified),
        "syncStartedAt": 0,
        "prompts": reading.prompts,
        "focus": reading.focus,
        "mode": claim.process.mode,
        "permissionMode": reading.permission_mode,
        "transcriptPath": claim.transcript.path,
        "adoptedOffset": reading.offset,
        "usageOffset": claim.transcript.size,
        "usageHighWater": 0,
        "usagePrompts": 0,
        "usageMessageId": "",
    });
    write(&record_path(scope, session_id), &document)?;
    Ok(Adoption {
        session_id: session_id.clone(),
        outcome: "adopted",
    })
}

/// One pass: every adopted record whose transcript has moved, then every running session no record
/// describes. The sessions that come back are the ones the caller syncs. A registry that cannot be
/// written fails the pass rather than reading as a host with nothing to adopt.
pub fn adopt(scope: &Scope) -> Result<Vec<Adoption>> {
    let registry = registry(&scope.sessions);
    let mut adopted = Vec::new();
    for (session_id, document) in &registry.adopted {
        adopted.extend(refresh(scope, session_id, document)?);
    }
    for claim in claims(scope, &registry) {
        adopted.push(take_on(scope, &claim)?);
    }
    Ok(adopted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::time::Duration;

    fn stamp(path: &Path, when: SystemTime) {
        std::fs::File::options()
            .read(true)
            .open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(when))
            .unwrap();
    }

    fn ago(seconds: u64) -> SystemTime {
        SystemTime::now() - Duration::from_secs(seconds)
    }

    struct Sandbox {
        dir: PathBuf,
        scope: Scope,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let dir = std::env::temp_dir().join(format!("recall-adopt-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            for part in ["proc", "projects", "sessions", "work"] {
                std::fs::create_dir_all(dir.join(part)).unwrap();
            }
            let scope = Scope {
                procfs: dir.join("proc"),
                projects: dir.join("projects"),
                sessions: dir.join("sessions"),
                host: "laptop".to_string(),
            };
            Sandbox { dir, scope }
        }

        fn work(&self, name: &str) -> PathBuf {
            let cwd = self.dir.join("work").join(name);
            std::fs::create_dir_all(&cwd).unwrap();
            cwd
        }

        /// A running Claude process, begun when procfs says its own directory was last written.
        fn claude(&self, pid: i32, cwd: &Path, argv: &[&str], started: SystemTime) {
            let dir = self.scope.procfs.join(pid.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("comm"), "claude\n").unwrap();
            std::fs::write(dir.join("cmdline"), argv.join("\0")).unwrap();
            symlink(cwd, dir.join("cwd")).unwrap();
            stamp(&dir, started);
        }

        fn transcript(&self, cwd: &Path, session_id: &str, lines: &[String]) -> PathBuf {
            let dir = self.scope.projects.join(slug(cwd));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("{session_id}.jsonl"));
            std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
            path
        }

        fn born(&self, path: &Path) -> SystemTime {
            birth(path, &std::fs::metadata(path).unwrap()).unwrap()
        }

        fn record(&self, session_id: &str) -> Option<Value> {
            parsed(&self.scope.sessions.join(format!("{session_id}.json")))
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn human(at: &str, text: &str) -> String {
        json!({
            "type": "user",
            "timestamp": at,
            "promptSource": "typed",
            "origin": { "kind": "human" },
            "permissionMode": "acceptEdits",
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn notification(at: &str, text: &str) -> String {
        json!({
            "type": "user",
            "timestamp": at,
            "promptSource": "system",
            "origin": { "kind": "task-notification" },
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        })
        .to_string()
    }

    fn tool_result(at: &str) -> String {
        json!({
            "type": "user",
            "timestamp": at,
            "toolUseResult": { "stdout": "ok" },
            "message": { "role": "user", "content": [{ "type": "tool_result", "content": "ok" }] },
        })
        .to_string()
    }

    fn answer(at: &str) -> String {
        json!({
            "type": "assistant",
            "timestamp": at,
            "message": { "id": "msg-1", "model": "claude-opus-4", "usage": { "input_tokens": 11 } },
        })
        .to_string()
    }

    fn session(at: &str) -> Vec<String> {
        vec![
            human(at, "list every host's sessions"),
            answer(at),
            tool_result(at),
            notification(at, "<task-notification>a subagent finished</task-notification>"),
            human("2026-11-02T10:05:00.000Z", "why is the worker test red"),
        ]
    }

    #[test]
    fn a_running_session_the_hooks_never_registered_is_adopted_from_its_transcript() {
        let sandbox = Sandbox::new("adopt");
        let cwd = sandbox.work("recall");
        let path = sandbox.transcript(&cwd, "s-live", &session("2026-11-02T10:00:00.000Z"));
        let wrote = ago(30);
        stamp(&path, wrote);
        sandbox.claude(4242, &cwd, &["claude"], ago(60));

        let adopted = adopt(&sandbox.scope).unwrap();

        assert_eq!(
            adopted,
            vec![Adoption {
                session_id: "s-live".to_string(),
                outcome: "adopted",
            }]
        );
        let record = sandbox.record("s-live").expect("the record is written");
        assert_eq!(record["state"], ADOPTED);
        assert_eq!(record["sessionId"], "s-live");
        assert_eq!(record["pid"], 4242);
        assert_eq!(record["cwd"], cwd.to_string_lossy().as_ref());
        assert_eq!(record["host"], "laptop");
        assert_eq!(record["mode"], "interactive");
        assert_eq!(record["permissionMode"], "acceptEdits");
        assert_eq!(record["startedAt"], 1_793_613_600_000_i64, "the first line's timestamp");
        assert_eq!(
            record["prompts"], 2,
            "a tool result and a notification are not prompts the user typed"
        );
        assert_eq!(
            record["focus"],
            json!({ "first": "list every host's sessions", "latest": "why is the worker test red" })
        );
        assert_eq!(record["transcriptPath"], path.to_string_lossy().as_ref());
        assert_eq!(
            record["lastActivityAt"],
            millis(wrote),
            "the transcript's own last write"
        );
        let size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(
            record["usageOffset"], size,
            "nothing counted the tokens spent before this pass, so none of them are counted now"
        );
        assert_eq!(record["adoptedOffset"], size, "the prompts read reach the file's end");
        assert_eq!(
            std::fs::metadata(sandbox.scope.sessions.join("s-live.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn a_session_the_registry_already_names_is_left_alone() {
        let sandbox = Sandbox::new("registered");
        let cwd = sandbox.work("recall");
        sandbox.transcript(&cwd, "s-hooked", &session("2026-11-02T10:00:00.000Z"));
        sandbox.claude(4242, &cwd, &["claude"], ago(60));
        let path = sandbox.scope.sessions.join("s-hooked.json");
        let written = r#"{"state":"registered","socket":"/run/inbox.sock","token":"t","pid":4242,"cwd":"/elsewhere","sessionId":"s-hooked","prompts":9}"#;
        std::fs::write(&path, written).unwrap();

        assert_eq!(adopt(&sandbox.scope).unwrap(), Vec::new());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            written,
            "the hooks own the record they wrote, whatever state it is in"
        );
    }

    #[test]
    fn a_record_caught_half_written_is_never_overwritten() {
        let sandbox = Sandbox::new("torn");
        let cwd = sandbox.work("recall");
        sandbox.transcript(&cwd, "s-hooked", &session("2026-11-02T10:00:00.000Z"));
        sandbox.claude(4242, &cwd, &["claude"], ago(60));
        let path = sandbox.scope.sessions.join("s-hooked.json");
        let torn = r#"{"state":"registered","socket":"/run/inbox.sock","to"#;
        std::fs::write(&path, torn).unwrap();

        assert_eq!(adopt(&sandbox.scope).unwrap(), Vec::new());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            torn,
            "a record that does not parse is one caught mid-write, and the inbox in it must survive"
        );
    }

    #[test]
    fn a_session_whose_process_is_gone_is_never_adopted() {
        let sandbox = Sandbox::new("dead");
        let cwd = sandbox.work("recall");
        sandbox.transcript(&cwd, "s-ended", &session("2026-11-02T10:00:00.000Z"));

        assert_eq!(adopt(&sandbox.scope).unwrap(), Vec::new());
        assert!(sandbox.record("s-ended").is_none());

        sandbox.claude(4242, &sandbox.work("other"), &["claude", "-p", "ship it"], ago(60));
        assert_eq!(
            adopt(&sandbox.scope).unwrap(),
            Vec::new(),
            "a process in another directory adopts nothing of this one"
        );
    }

    #[test]
    fn an_adopted_record_follows_its_transcript_until_the_session_ends() {
        let sandbox = Sandbox::new("refresh");
        let cwd = sandbox.work("recall");
        let path = sandbox.transcript(&cwd, "s-live", &session("2026-11-02T10:00:00.000Z"));
        stamp(&path, ago(300));
        sandbox.claude(4242, &cwd, &["claude"], ago(60));

        adopt(&sandbox.scope).unwrap();
        let first = sandbox.record("s-live").unwrap();
        let held = sandbox.scope.sessions.join("s-live.json");
        let mut owned = first.clone();
        owned["usagePending"] = json!({ "seq": 1200, "events": [{ "model": "claude-opus-4" }] });
        owned["syncStartedAt"] = json!(1_762_000_060_000_i64);
        std::fs::write(&held, serde_json::to_string(&owned).unwrap()).unwrap();

        assert_eq!(
            adopt(&sandbox.scope).unwrap(),
            Vec::new(),
            "a transcript that has not moved has nothing to send"
        );

        let mut grown = session("2026-11-02T10:00:00.000Z");
        grown.push(human("2026-11-02T10:30:00.000Z", "and now the dashboard"));
        std::fs::write(&path, format!("{}\n", grown.join("\n"))).unwrap();
        stamp(&path, ago(10));

        assert_eq!(
            adopt(&sandbox.scope).unwrap(),
            vec![Adoption {
                session_id: "s-live".to_string(),
                outcome: "refreshed",
            }]
        );
        let second = sandbox.record("s-live").unwrap();
        assert_eq!(
            second["startedAt"], first["startedAt"],
            "the session still started when it did"
        );
        assert_eq!(second["usageOffset"], first["usageOffset"], "the usage marks stay put");
        assert_eq!(
            second["usagePending"], owned["usagePending"],
            "a delta the hooks fixed is still waiting after the pass"
        );
        assert_eq!(second["syncStartedAt"], 1_762_000_060_000_i64);
        assert_eq!(second["prompts"], 3);
        assert_eq!(second["focus"]["latest"], "and now the dashboard");
        assert_eq!(
            second["focus"]["first"], first["focus"]["first"],
            "the prompt that opened the session is read once"
        );
        assert_eq!(
            second["adoptedOffset"],
            std::fs::metadata(&path).unwrap().len(),
            "only the stretch past the last mark is read, and the mark moves with it"
        );
        assert!(
            second["lastActivityAt"].as_i64() > first["lastActivityAt"].as_i64(),
            "{second}"
        );
    }

    #[test]
    fn a_transcript_rewritten_shorter_is_read_again_from_its_start() {
        let sandbox = Sandbox::new("rewritten");
        let cwd = sandbox.work("recall");
        let path = sandbox.transcript(&cwd, "s-live", &session("2026-11-02T10:00:00.000Z"));
        stamp(&path, ago(300));
        sandbox.claude(4242, &cwd, &["claude"], ago(60));
        adopt(&sandbox.scope).unwrap();

        std::fs::write(&path, format!("{}\n", human("2026-11-02T11:00:00.000Z", "start over"))).unwrap();
        stamp(&path, ago(10));

        adopt(&sandbox.scope).unwrap();

        let record = sandbox.record("s-live").unwrap();
        assert_eq!(record["prompts"], 1);
        assert_eq!(
            record["focus"],
            json!({ "first": "start over", "latest": "start over" })
        );
        assert_eq!(record["adoptedOffset"], std::fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn only_the_prompts_the_user_typed_are_counted() {
        let sandbox = Sandbox::new("prompts");
        let cwd = sandbox.work("recall");
        let old_style = |text: &str| {
            json!({
                "type": "user",
                "timestamp": "2026-11-02T10:10:00.000Z",
                "message": { "role": "user", "content": text },
            })
            .to_string()
        };
        let lines =
            vec![
            human("2026-11-02T10:00:00.000Z", "   adopt  the   running sessions\n"),
            notification("2026-11-02T10:01:00.000Z", "<task-notification>done</task-notification>"),
            tool_result("2026-11-02T10:02:00.000Z"),
            json!({
                "type": "user",
                "timestamp": "2026-11-02T10:03:00.000Z",
                "isMeta": true,
                "message": { "role": "user", "content": "<local-command-caveat>…</local-command-caveat>" },
            })
            .to_string(),
            json!({
                "type": "user",
                "timestamp": "2026-11-02T10:04:00.000Z",
                "interruptedMessageId": "msg-9",
                "message": { "role": "user", "content": [{ "type": "text", "text": "[Request interrupted by user]" }] },
            })
            .to_string(),
            old_style("/compact"),
            old_style("<command-name>/exit</command-name>"),
            old_style("<div> renders twice"),
            "{ not json at all".to_string(),
            human("2026-11-02T10:20:00.000Z", &"word ".repeat(30)),
        ];
        sandbox.transcript(&cwd, "s-live", &lines);
        sandbox.claude(4242, &cwd, &["claude"], ago(60));

        adopt(&sandbox.scope).unwrap();

        let record = sandbox.record("s-live").unwrap();
        assert_eq!(
            record["prompts"], 4,
            "two typed prompts, a slash command, and a prompt that opens with a tag of its own"
        );
        assert_eq!(
            record["focus"]["first"], "adopt the running sessions",
            "a prompt is collapsed to one line"
        );
        let latest = record["focus"]["latest"].as_str().unwrap();
        assert_eq!(latest.chars().count(), FOCUS_PART_CHARS);
        assert!(latest.ends_with('…'), "{latest}");
    }

    #[test]
    fn a_live_session_takes_the_transcript_born_when_it_started_and_not_the_newest() {
        let sandbox = Sandbox::new("newest-is-dead");
        let cwd = sandbox.work("recall");
        let lines = session("2026-11-02T10:00:00.000Z");
        let live = sandbox.transcript(&cwd, "s-live", &lines);
        std::thread::sleep(Duration::from_millis(5));
        let headless = sandbox.transcript(&cwd, "s-headless-run", &lines);
        stamp(&live, ago(600));
        stamp(&headless, ago(5));
        sandbox.claude(4242, &cwd, &["claude"], sandbox.born(&live) - Duration::from_secs(7));

        let adopted = adopt(&sandbox.scope).unwrap();

        assert_eq!(
            adopted,
            vec![Adoption {
                session_id: "s-live".to_string(),
                outcome: "adopted",
            }],
            "a claude -p run that just finished leaves the newest transcript behind, and it is not this session's"
        );
        assert!(sandbox.record("s-headless-run").is_none());
    }

    #[test]
    fn two_sessions_in_one_directory_take_one_transcript_each() {
        let sandbox = Sandbox::new("shared-cwd");
        let cwd = sandbox.work("recall");
        let lines = session("2026-11-02T10:00:00.000Z");
        let first = sandbox.transcript(&cwd, "s-first", &lines);
        std::thread::sleep(Duration::from_millis(5));
        let second = sandbox.transcript(&cwd, "s-second", &lines);
        let born_first = sandbox.born(&first);
        assert!(born_first < sandbox.born(&second), "the fixtures must be born in order");
        sandbox.claude(4242, &cwd, &["claude"], born_first - Duration::from_secs(7));
        sandbox.claude(4300, &cwd, &["claude"], born_first + Duration::from_millis(1));

        let adopted: Vec<String> = adopt(&sandbox.scope)
            .unwrap()
            .into_iter()
            .map(|adoption| adoption.session_id)
            .collect();

        assert_eq!(adopted, vec!["s-first".to_string(), "s-second".to_string()]);
        assert_eq!(sandbox.record("s-first").unwrap()["pid"], 4242);
        assert_eq!(sandbox.record("s-second").unwrap()["pid"], 4300);
    }

    #[test]
    fn a_session_that_has_opened_no_transcript_yet_adopts_nothing() {
        let sandbox = Sandbox::new("just-started");
        let cwd = sandbox.work("recall");
        let ended = sandbox.transcript(&cwd, "s-ended", &session("2026-11-02T10:00:00.000Z"));
        stamp(&ended, ago(5));
        sandbox.claude(4242, &cwd, &["claude"], SystemTime::now());

        assert_eq!(
            adopt(&sandbox.scope).unwrap(),
            Vec::new(),
            "a session whose transcript is not written yet must not take on one that ended here"
        );
        assert!(sandbox.record("s-ended").is_none());
    }

    #[test]
    fn a_registry_that_cannot_be_written_fails_the_pass() {
        let sandbox = Sandbox::new("unwritable");
        let cwd = sandbox.work("recall");
        sandbox.transcript(&cwd, "s-live", &session("2026-11-02T10:00:00.000Z"));
        sandbox.claude(4242, &cwd, &["claude"], ago(60));
        std::fs::remove_dir_all(&sandbox.scope.sessions).unwrap();
        std::fs::write(&sandbox.scope.sessions, "not a directory").unwrap();

        assert!(
            adopt(&sandbox.scope).is_err(),
            "a host that cannot keep a record must not read as a host with nothing to adopt"
        );
    }

    #[test]
    fn a_project_directory_is_named_after_the_path_it_holds() {
        assert_eq!(slug(Path::new("/home/you/recall")), "-home-you-recall");
        assert_eq!(slug(Path::new("/home/you/.dotfiles")), "-home-you--dotfiles");
        assert_eq!(slug(Path::new("/home/you/my_repo")), "-home-you-my-repo");
    }
}
