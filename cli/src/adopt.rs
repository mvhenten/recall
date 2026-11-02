//! The sessions the hooks never registered. Hooks load when a session starts, so a plugin update
//! leaves every session that was already running without a record: it never syncs, and the
//! dashboard shows nothing of it until it restarts. What its hooks would have written is read back
//! out of /proc and the session's own transcript instead — the Claude processes running now, the
//! transcript each is writing, and the prompts in it.
//!
//! A session that already has a record is left alone, whatever state it is in: the hooks own what
//! they wrote, and adoption only fills an absence. The record it writes carries `state: adopted`,
//! which is both what `recall listen --status` reports and the mark that says this pass may move
//! the record on; the hooks' own next write takes it over.
//!
//! The transcript is read line by line, as hooks/usage.mjs reads it: one JSON document a line, a
//! line that does not parse skipped, and `message.content` either a string or a list of blocks.
//! The usage reader counts what the models answered; this one reads what the user typed, and the
//! two never read the same entries. It lives here rather than in the hooks because the daemon tick
//! that keeps an adopted session fresh is this binary's, and the hooks are installed as a plugin
//! this binary cannot find.

use crate::config;
use crate::listen;
use crate::repo;
use crate::sessions::Focus;
use anyhow::{Context, Result};
use jiff::Timestamp;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Mirrors FOCUS_PART_CHARS in hooks/messaging.mjs.
const FOCUS_PART_CHARS: usize = 72;
const CLAUDE: &str = "claude";
const TRANSCRIPT: &str = "jsonl";

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
        let claude = config::claude_dir()
            .context("neither CLAUDE_CONFIG_DIR nor HOME is set, so there are no transcripts to read")?;
        Ok(Scope {
            procfs: PathBuf::from("/proc"),
            projects: claude.join("projects"),
            sessions: listen::sessions_dir(),
            host: crate::host_name(),
        })
    }
}

/// One running Claude process. `named` is the session an open file descriptor gives away, which is
/// the only reading that settles two sessions sharing a directory outright, and `started` is when
/// the process began, which bounds how old its transcript can be.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Process {
    pid: i32,
    cwd: PathBuf,
    mode: String,
    named: Option<String>,
    started: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Transcript {
    session_id: String,
    path: PathBuf,
    modified: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Claim {
    process: Process,
    transcript: Transcript,
}

/// A record this pass wrote: `adopted` for a session that had none, `refreshed` for one whose
/// transcript has moved since the last pass. Either way the service has not been told yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adoption {
    pub session_id: String,
    pub outcome: &'static str,
}

fn millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or_default()
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

/// The session id an open descriptor names. Claude Code holds a transcript open only while it is
/// writing one, so this is usually nothing: the session's own transcript is
/// `<slug>/<session-id>.jsonl` and a subagent's sits under `<slug>/<session-id>/`.
fn named(procfs: &Path, pid: i32, projects: &Path) -> Option<String> {
    let entries = std::fs::read_dir(procfs.join(pid.to_string()).join("fd")).ok()?;
    for entry in entries.flatten() {
        let Ok(target) = std::fs::read_link(entry.path()) else {
            continue;
        };
        let Ok(rest) = target.strip_prefix(projects) else {
            continue;
        };
        let mut parts = rest.components().filter_map(|part| match part {
            Component::Normal(name) => name.to_str(),
            _ => None,
        });
        let (Some(_slug), Some(second)) = (parts.next(), parts.next()) else {
            continue;
        };
        let session = second.strip_suffix(".jsonl").unwrap_or(second);
        if !session.is_empty() {
            return Some(session.to_string());
        }
    }
    None
}

/// When the process began: procfs stamps the pid's own directory with it.
fn started(procfs: &Path, pid: i32) -> SystemTime {
    std::fs::metadata(procfs.join(pid.to_string()))
        .and_then(|metadata| metadata.modified())
        .unwrap_or(UNIX_EPOCH)
}

/// Every Claude process this host is running, oldest pid first.
fn running(scope: &Scope) -> Vec<Process> {
    let Ok(entries) = std::fs::read_dir(&scope.procfs) else {
        return Vec::new();
    };
    let mut found: Vec<Process> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter_map(|pid| {
            let argv = argv(&scope.procfs, pid);
            if !is_claude(&scope.procfs, pid, &argv) {
                return None;
            }
            let cwd = std::fs::read_link(scope.procfs.join(pid.to_string()).join("cwd")).ok()?;
            Some(Process {
                pid,
                cwd,
                mode: mode(&argv),
                named: named(&scope.procfs, pid, &scope.projects),
                started: started(&scope.procfs, pid),
            })
        })
        .collect();
    found.sort_by_key(|process| process.pid);
    found
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

/// The transcripts of one directory, newest write first. A session's transcript sits directly
/// under the project directory; a subagent's sits a level down and belongs to no session of its
/// own.
fn transcripts(projects: &Path, cwd: &Path) -> Vec<Transcript> {
    let Ok(entries) = std::fs::read_dir(projects.join(slug(cwd))) else {
        return Vec::new();
    };
    let mut found: Vec<Transcript> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension() != Some(OsStr::new(TRANSCRIPT)) {
                return None;
            }
            Some(Transcript {
                session_id: path.file_stem()?.to_str()?.to_string(),
                modified: entry.metadata().ok()?.modified().ok()?,
                path,
            })
        })
        .collect();
    found.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    found
}

fn take_named(available: &mut Vec<Transcript>, session_id: &str) -> Option<Transcript> {
    let found = available.iter().position(|entry| entry.session_id == session_id)?;
    Some(available.remove(found))
}

/// Which transcript each running session is writing. A descriptor Claude still holds open settles
/// it outright. The rest of a directory's transcripts are handed out newest first, one per
/// process, oldest process to oldest transcript: a directory running two sessions must not adopt
/// one transcript twice, and the transcripts of sessions that have ended are left where they are.
/// A transcript last written before its process began is one of those: a session that has just
/// started, or one resumed and not yet prompted, takes nothing until it writes something of its
/// own.
fn claims(scope: &Scope) -> Vec<Claim> {
    let mut by_directory: BTreeMap<PathBuf, Vec<Process>> = BTreeMap::new();
    for process in running(scope) {
        by_directory.entry(process.cwd.clone()).or_default().push(process);
    }
    let mut claimed = Vec::new();
    for (cwd, processes) in by_directory {
        let mut available = transcripts(&scope.projects, &cwd);
        let mut waiting = Vec::new();
        for process in processes {
            match process.named.as_deref().and_then(|id| take_named(&mut available, id)) {
                Some(transcript) => claimed.push(Claim { process, transcript }),
                None => waiting.push(process),
            }
        }
        available.truncate(waiting.len());
        available.reverse();
        for (process, transcript) in waiting.into_iter().zip(available) {
            if transcript.modified >= process.started {
                claimed.push(Claim { process, transcript });
            }
        }
    }
    claimed.sort_by_key(|claim| claim.process.pid);
    claimed
}

/// What the transcript says about its session: when it opened, the prompts the user typed, and the
/// permission mode the last of them carried.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Transcribed {
    started_at: i64,
    prompts: i64,
    focus: Focus,
    permission_mode: String,
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
/// summary and the tagged envelopes the harness writes are none of them prompts.
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
        None if text.starts_with('<') => None,
        None => Some(text),
    }
}

fn timestamp(entry: &Value) -> Option<i64> {
    entry["timestamp"]
        .as_str()?
        .parse::<Timestamp>()
        .ok()
        .map(|time| time.as_millisecond())
}

/// Reads the whole transcript: the prompt count is every prompt the file holds, which is what the
/// file supports and not what a record counted from zero would say about a session resumed into
/// it.
fn transcribe(path: &Path, fallback: i64) -> Transcribed {
    let Ok(file) = std::fs::File::open(path) else {
        return Transcribed {
            started_at: fallback,
            ..Transcribed::default()
        };
    };
    let mut told = Transcribed::default();
    for line in BufReader::new(file).lines().map_while(std::result::Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if told.started_at == 0 {
            told.started_at = timestamp(&entry).unwrap_or_default();
        }
        let Some(prompt) = typed(&entry) else {
            continue;
        };
        let latest = truncate(&prompt);
        if told.focus.first.is_empty() {
            told.focus.first = latest.clone();
        }
        told.focus.latest = latest;
        told.prompts += 1;
        told.permission_mode = entry["permissionMode"].as_str().unwrap_or_default().to_string();
    }
    if told.started_at == 0 {
        told.started_at = fallback;
    }
    told
}

/// The record shape hooks/messaging.mjs writes, so a session the hooks never saw reads back the
/// same as one they did. The usage marks start at the end of the transcript: nothing has counted
/// the tokens spent before this pass, and a hook that takes the record over must not count them
/// twice.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document<'a> {
    state: &'static str,
    pid: i32,
    cwd: &'a Path,
    session_id: &'a str,
    host: &'a str,
    repo: String,
    branch: String,
    commit: String,
    started_at: i64,
    last_activity_at: i64,
    sync_started_at: i64,
    prompts: i64,
    focus: Focus,
    mode: &'a str,
    permission_mode: String,
    transcript_path: &'a Path,
    usage_offset: u64,
    usage_high_water: i64,
    usage_prompts: i64,
    usage_message_id: String,
}

fn stored(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn number(document: &Value, field: &str) -> i64 {
    document[field].as_i64().unwrap_or_default()
}

fn write(path: &Path, document: &Document) -> Result<()> {
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

/// Writes the record every running session is missing, and moves an adopted record on when its
/// transcript has grown. Last activity is the transcript's own last write, so a session whose
/// transcript has not moved since the last pass has nothing new to say and is passed over; the
/// sessions that come back are the ones the caller syncs.
pub fn adopt(scope: &Scope) -> Vec<Adoption> {
    let mut adopted = Vec::new();
    for claim in claims(scope) {
        let session_id = &claim.transcript.session_id;
        let path = scope.sessions.join(format!("{session_id}.json"));
        let held = stored(&path);
        if let Some(document) = held.as_ref()
            && document["state"] != "adopted"
        {
            continue;
        }
        let last_activity_at = millis(claim.transcript.modified);
        if held
            .as_ref()
            .is_some_and(|document| number(document, "lastActivityAt") == last_activity_at)
        {
            continue;
        }
        let birth = std::fs::metadata(&claim.transcript.path)
            .and_then(|metadata| metadata.created())
            .map(millis)
            .unwrap_or(last_activity_at);
        let told = transcribe(&claim.transcript.path, birth);
        let head = repo::head(&claim.process.cwd);
        let outcome = match held.as_ref() {
            Some(_) => "refreshed",
            None => "adopted",
        };
        let document = Document {
            state: "adopted",
            pid: claim.process.pid,
            cwd: &claim.process.cwd,
            session_id,
            host: &scope.host,
            repo: repo::repo_tag(&claim.process.cwd).unwrap_or_default(),
            branch: head.branch,
            commit: head.commit,
            started_at: match held.as_ref() {
                Some(document) => number(document, "startedAt"),
                None => told.started_at,
            },
            last_activity_at,
            sync_started_at: held
                .as_ref()
                .map(|document| number(document, "syncStartedAt"))
                .unwrap_or(0),
            prompts: told.prompts,
            focus: told.focus,
            mode: &claim.process.mode,
            permission_mode: told.permission_mode,
            transcript_path: &claim.transcript.path,
            usage_offset: match held.as_ref() {
                Some(document) => document["usageOffset"].as_u64().unwrap_or_default(),
                None => std::fs::metadata(&claim.transcript.path)
                    .map(|metadata| metadata.len())
                    .unwrap_or_default(),
            },
            usage_high_water: held
                .as_ref()
                .map(|document| number(document, "usageHighWater"))
                .unwrap_or(0),
            usage_prompts: held
                .as_ref()
                .map(|document| number(document, "usagePrompts"))
                .unwrap_or(0),
            usage_message_id: held
                .as_ref()
                .and_then(|document| document["usageMessageId"].as_str().map(str::to_string))
                .unwrap_or_default(),
        };
        if write(&path, &document).is_err() {
            continue;
        }
        adopted.push(Adoption {
            session_id: session_id.clone(),
            outcome,
        });
    }
    adopted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// When every process in a sandbox began, and when its transcripts were last written: procfs
    /// stamps a pid directory with the one, and a transcript carries the other.
    const STARTED: u64 = 1_761_000_000;
    const WROTE: u64 = STARTED + 60;

    fn stamp(path: &Path, seconds: u64) {
        let when = UNIX_EPOCH + std::time::Duration::from_secs(seconds);
        std::fs::File::options()
            .read(true)
            .open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(when))
            .unwrap();
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

        fn claude(&self, pid: i32, cwd: &Path, argv: &[&str]) {
            let dir = self.scope.procfs.join(pid.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("comm"), "claude\n").unwrap();
            std::fs::write(dir.join("cmdline"), argv.join("\0")).unwrap();
            symlink(cwd, dir.join("cwd")).unwrap();
            stamp(&dir, STARTED);
        }

        fn holds(&self, pid: i32, transcript: &Path) {
            let fd = self.scope.procfs.join(pid.to_string()).join("fd");
            std::fs::create_dir_all(&fd).unwrap();
            symlink(transcript, fd.join("12")).unwrap();
        }

        fn transcript(&self, cwd: &Path, session_id: &str, lines: &[String]) -> PathBuf {
            self.wrote(cwd, session_id, lines, WROTE)
        }

        fn wrote(&self, cwd: &Path, session_id: &str, lines: &[String], seconds: u64) -> PathBuf {
            let dir = self.scope.projects.join(slug(cwd));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("{session_id}.jsonl"));
            std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
            stamp(&path, seconds);
            path
        }

        fn record(&self, session_id: &str) -> Option<Value> {
            stored(&self.scope.sessions.join(format!("{session_id}.json")))
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn human(at: &str, text: &str) -> String {
        serde_json::json!({
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
        serde_json::json!({
            "type": "user",
            "timestamp": at,
            "promptSource": "system",
            "origin": { "kind": "task-notification" },
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        })
        .to_string()
    }

    fn tool_result(at: &str) -> String {
        serde_json::json!({
            "type": "user",
            "timestamp": at,
            "toolUseResult": { "stdout": "ok" },
            "message": { "role": "user", "content": [{ "type": "tool_result", "content": "ok" }] },
        })
        .to_string()
    }

    fn answer(at: &str) -> String {
        serde_json::json!({
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
        sandbox.transcript(&cwd, "s-live", &session("2026-11-02T10:00:00.000Z"));
        sandbox.claude(4242, &cwd, &["claude"]);

        let adopted = adopt(&sandbox.scope);

        assert_eq!(
            adopted,
            vec![Adoption {
                session_id: "s-live".to_string(),
                outcome: "adopted",
            }]
        );
        let record = sandbox.record("s-live").expect("the record is written");
        assert_eq!(record["state"], "adopted");
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
            serde_json::json!({ "first": "list every host's sessions", "latest": "why is the worker test red" })
        );
        let transcript = sandbox.scope.projects.join(slug(&cwd)).join("s-live.jsonl");
        assert_eq!(record["transcriptPath"], transcript.to_string_lossy().as_ref());
        assert_eq!(
            record["usageOffset"],
            std::fs::metadata(&transcript).unwrap().len(),
            "nothing counted the tokens spent before this pass, so none of them are counted now"
        );
        assert_eq!(
            record["lastActivityAt"],
            (WROTE * 1000) as i64,
            "the transcript's own last write"
        );
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
    fn a_session_the_hooks_registered_is_left_alone() {
        let sandbox = Sandbox::new("registered");
        let cwd = sandbox.work("recall");
        sandbox.transcript(&cwd, "s-hooked", &session("2026-11-02T10:00:00.000Z"));
        sandbox.claude(4242, &cwd, &["claude"]);
        let path = sandbox.scope.sessions.join("s-hooked.json");
        let written = r#"{"state":"no-inbox","pid":4242,"cwd":"/elsewhere","sessionId":"s-hooked","prompts":9}"#;
        std::fs::write(&path, written).unwrap();

        assert_eq!(adopt(&sandbox.scope), Vec::new());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            written,
            "the hooks own the record they wrote, whatever state it is in"
        );
    }

    #[test]
    fn a_session_whose_process_is_gone_is_never_adopted() {
        let sandbox = Sandbox::new("dead");
        let cwd = sandbox.work("recall");
        sandbox.transcript(&cwd, "s-ended", &session("2026-11-02T10:00:00.000Z"));

        assert_eq!(adopt(&sandbox.scope), Vec::new());
        assert!(sandbox.record("s-ended").is_none());

        sandbox.claude(4242, &sandbox.work("other"), &["claude", "-p", "ship it"]);
        assert_eq!(
            adopt(&sandbox.scope),
            Vec::new(),
            "a process in another directory adopts nothing of this one"
        );
    }

    #[test]
    fn an_adopted_record_follows_its_transcript_until_the_session_ends() {
        let sandbox = Sandbox::new("refresh");
        let cwd = sandbox.work("recall");
        let path = sandbox.transcript(&cwd, "s-live", &session("2026-11-02T10:00:00.000Z"));
        sandbox.claude(4242, &cwd, &["claude"]);

        adopt(&sandbox.scope);
        let first = sandbox.record("s-live").unwrap();

        assert_eq!(
            adopt(&sandbox.scope),
            Vec::new(),
            "a transcript that has not moved has nothing to send"
        );

        let mut grown = session("2026-11-02T10:00:00.000Z");
        grown.push(human("2026-11-02T10:30:00.000Z", "and now the dashboard"));
        std::fs::write(&path, format!("{}\n", grown.join("\n"))).unwrap();
        stamp(&path, WROTE + 300);

        assert_eq!(
            adopt(&sandbox.scope),
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
        assert_eq!(second["prompts"], 3);
        assert_eq!(second["focus"]["latest"], "and now the dashboard");
        assert!(
            second["lastActivityAt"].as_i64() > first["lastActivityAt"].as_i64(),
            "{second}"
        );
    }

    #[test]
    fn only_the_prompts_the_user_typed_are_counted() {
        let sandbox = Sandbox::new("prompts");
        let cwd = sandbox.work("recall");
        let old_style = |text: &str| {
            serde_json::json!({
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
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-11-02T10:03:00.000Z",
                "isMeta": true,
                "message": { "role": "user", "content": "<local-command-caveat>…</local-command-caveat>" },
            })
            .to_string(),
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-11-02T10:04:00.000Z",
                "interruptedMessageId": "msg-9",
                "message": { "role": "user", "content": [{ "type": "text", "text": "[Request interrupted by user]" }] },
            })
            .to_string(),
            old_style("/compact"),
            old_style("<command-name>/exit</command-name>"),
            "{ not json at all".to_string(),
            human("2026-11-02T10:20:00.000Z", &"word ".repeat(30)),
        ];
        sandbox.transcript(&cwd, "s-live", &lines);
        sandbox.claude(4242, &cwd, &["claude"]);

        adopt(&sandbox.scope);

        let record = sandbox.record("s-live").unwrap();
        assert_eq!(record["prompts"], 3, "two typed prompts and one slash command");
        assert_eq!(
            record["focus"]["first"], "adopt the running sessions",
            "a prompt is collapsed to one line"
        );
        let latest = record["focus"]["latest"].as_str().unwrap();
        assert_eq!(latest.chars().count(), FOCUS_PART_CHARS);
        assert!(latest.ends_with('…'), "{latest}");
    }

    #[test]
    fn two_sessions_in_one_directory_take_one_transcript_each() {
        let sandbox = Sandbox::new("shared-cwd");
        let cwd = sandbox.work("recall");
        for (session_id, wrote) in [("s-oldest", WROTE), ("s-older", WROTE + 100), ("s-newest", WROTE + 200)] {
            sandbox.wrote(&cwd, session_id, &session("2026-11-02T10:00:00.000Z"), wrote);
        }
        sandbox.claude(4242, &cwd, &["claude"]);
        sandbox.claude(4300, &cwd, &["claude"]);

        let adopted: Vec<String> = adopt(&sandbox.scope)
            .into_iter()
            .map(|adoption| adoption.session_id)
            .collect();

        assert_eq!(
            adopted,
            vec!["s-older".to_string(), "s-newest".to_string()],
            "the newest transcript per running session, and the one a session that ended left behind is skipped"
        );
        assert_eq!(sandbox.record("s-older").unwrap()["pid"], 4242);
        assert_eq!(sandbox.record("s-newest").unwrap()["pid"], 4300);
        assert!(sandbox.record("s-oldest").is_none());
    }

    #[test]
    fn an_open_transcript_names_the_session_whatever_the_times_say() {
        let sandbox = Sandbox::new("open-fd");
        let cwd = sandbox.work("recall");
        let lines = session("2026-11-02T10:00:00.000Z");
        sandbox.wrote(&cwd, "s-older", &lines, STARTED - 300);
        sandbox.transcript(&cwd, "s-newest", &lines);
        sandbox.claude(4242, &cwd, &["claude"]);
        sandbox.holds(
            4242,
            &sandbox
                .scope
                .projects
                .join(slug(&cwd))
                .join("s-older/subagents/a.jsonl"),
        );

        adopt(&sandbox.scope);

        assert_eq!(sandbox.record("s-older").unwrap()["pid"], 4242);
        assert!(
            sandbox.record("s-newest").is_none(),
            "the descriptor settles which transcript the session is writing"
        );
    }

    #[test]
    fn a_transcript_last_written_before_its_session_began_belongs_to_another() {
        let sandbox = Sandbox::new("stale");
        let cwd = sandbox.work("recall");
        sandbox.wrote(&cwd, "s-ended", &session("2026-11-02T10:00:00.000Z"), STARTED - 3600);
        sandbox.claude(4242, &cwd, &["claude"]);

        assert_eq!(
            adopt(&sandbox.scope),
            Vec::new(),
            "a session that has just started must not take on the transcript of one that ended here"
        );
        assert!(sandbox.record("s-ended").is_none());
    }

    #[test]
    fn a_project_directory_is_named_after_the_path_it_holds() {
        assert_eq!(slug(Path::new("/home/you/recall")), "-home-you-recall");
        assert_eq!(slug(Path::new("/home/you/.dotfiles")), "-home-you--dotfiles");
        assert_eq!(slug(Path::new("/home/you/my_repo")), "-home-you-my-repo");
    }
}
