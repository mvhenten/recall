//! The sessions that ran before the hooks did. A host keeps every past session's transcript under
//! `~/.claude/projects/`, while the dashboard's history and stats start the day its hooks shipped.
//! This pass reads those transcripts back and sends each one as the session it was: the record goes
//! out as a sync, which writes the history row, the row survives the end that follows it, and the
//! tokens the session spent go out as usage deltas of their own.
//!
//! The record comes from the same reader `recall sessions --adopt` uses, so a session read back
//! long after it ended says what one read mid-flight says. What a running session takes from its
//! own process — the pid, whether it was interactive, the commit its directory sat on — a past
//! session cannot have, and the API's own empty readings carry that.
//!
//! The tokens are read as hooks/usage.mjs reads them: one JSON document a line, an answer counted
//! once by its message id, summed by model, and one event per model. The whole transcript is one
//! stretch, so the chunk numbers are the ones a single hook pass over it from byte zero would have
//! spent, and the service keeps the first event it saw for a chunk number. A second run over the
//! same transcript therefore regenerates the same events and changes nothing.
//!
//! Attribution is the one thing a transcript cannot give back: it names no subscription, so every
//! event carries the account this host is signed in as now.

use crate::adopt::{self, Reading};
use crate::api::SessionBody;
use crate::config;
use crate::listen;
use crate::repo;
use crate::sessions::{Focus, UsagePending};
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// Mirrors PROVIDER in hooks/usage.mjs.
const PROVIDER: &str = "claude";

/// Where one pass looks: the directory Claude Code writes transcripts under, the registry the hooks
/// write, the ledger of what this host has already sent, and the file naming the subscription the
/// tokens are counted against.
#[derive(Debug, Clone)]
pub struct Scope {
    pub projects: PathBuf,
    pub sessions: PathBuf,
    pub ledger: PathBuf,
    pub claude_json: PathBuf,
    pub host: String,
}

impl Scope {
    pub fn here() -> Result<Scope> {
        let claude =
            config::claude_dir().context("neither CLAUDE_CONFIG_DIR nor HOME is set, so there are no transcripts")?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set, so this host names no account to count the tokens against")?;
        Ok(Scope {
            projects: claude.join("projects"),
            sessions: listen::sessions_dir(),
            ledger: listen::state_dir().join("backfilled"),
            claude_json: home.join(".claude.json"),
            host: crate::host_name(),
        })
    }
}

/// One past session, as its transcript gives it back. `mode` and the commit subject are left to the
/// API's empty readings: a transcript says neither whether the session was interactive nor which
/// commit its directory sat on, and inventing either would make the history row say more than the
/// host knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Past {
    pub session_id: String,
    pub host: String,
    pub cwd: String,
    pub repo: String,
    pub branch: String,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: Focus,
    pub permission_mode: String,
    pub usage: UsagePending,
}

impl Past {
    pub fn body(&self) -> SessionBody<'_> {
        SessionBody {
            host: &self.host,
            cwd: &self.cwd,
            repo: &self.repo,
            branch: &self.branch,
            commit: "",
            started_at: self.started_at,
            last_activity_at: self.last_activity_at,
            prompts: self.prompts,
            focus: &self.focus,
            mode: "",
            permission_mode: &self.permission_mode,
            pid: 0,
        }
    }
}

/// The subscription the tokens are spent on; mirrors account() in hooks/usage.mjs. A host whose
/// account was swapped out has no `oauthAccount` left, so the user id the harness always writes is
/// the identity to fall back on.
fn account(claude_json: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(claude_json) else {
        return String::new();
    };
    let Ok(settings) = serde_json::from_str::<Value>(&text) else {
        return String::new();
    };
    settings["oauthAccount"]["emailAddress"]
        .as_str()
        .or_else(|| settings["userID"].as_str())
        .unwrap_or_default()
        .to_string()
}

/// The ids this host has already backfilled. The file is appended to as each session lands, so an
/// interrupted run resumes where it stopped rather than sending the whole span again.
fn ledger(path: &Path) -> HashSet<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

/// Records one session as sent, which only happens once its row, its tokens and its end have all
/// landed. Recording ahead of that would drop a session from the next run with nothing on record.
pub fn note(path: &Path, session_id: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    file.write_all(format!("{session_id}\n").as_bytes())
        .with_context(|| format!("writing {}", path.display()))
}

/// Every session this pass leaves alone: the ones the registry names, which are this host's live
/// sessions and adoption's to take on, and the ones already sent.
fn skipped(scope: &Scope) -> HashSet<String> {
    let mut held = ledger(&scope.ledger);
    let Ok(entries) = std::fs::read_dir(&scope.sessions) else {
        return held;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("json")) {
            continue;
        }
        if let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()) {
            held.insert(session_id.to_string());
        }
    }
    held
}

/// Every transcript this host holds. A session's transcript sits directly under a project
/// directory; a subagent's sits a level down and is no session of its own.
fn transcripts(projects: &Path) -> Vec<(String, PathBuf)> {
    let Ok(projects) = std::fs::read_dir(projects) else {
        return Vec::new();
    };
    let mut found: Vec<(String, PathBuf)> = projects
        .flatten()
        .filter_map(|project| std::fs::read_dir(project.path()).ok())
        .flat_map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    if path.extension() != Some(OsStr::new(adopt::TRANSCRIPT)) {
                        return None;
                    }
                    Some((path.file_stem()?.to_str()?.to_string(), path))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    found.sort();
    found
}

/// What one model spent over a transcript, and when it last answered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Counted {
    at: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_write_tokens: i64,
    cache_read_tokens: i64,
}

impl Counted {
    fn spent(&self) -> i64 {
        self.input_tokens + self.output_tokens + self.cache_write_tokens + self.cache_read_tokens
    }
}

fn counter(usage: &Value, field: &str) -> i64 {
    usage[field].as_i64().filter(|count| *count > 0).unwrap_or_default()
}

/// What the models answering one transcript spent, in the order they first answered; mirrors
/// aggregate() in hooks/usage.mjs. One API response is written as several transcript entries, one
/// per content block, each carrying the same usage, so a message counts once by its id.
fn aggregate(text: &str) -> (Vec<(String, Counted)>, String) {
    let mut models: Vec<(String, Counted)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut message_id = String::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry["type"] != "assistant" {
            continue;
        }
        let message = &entry["message"];
        if let Some(id) = message["id"].as_str().filter(|id| !id.is_empty()) {
            if !seen.insert(id.to_string()) {
                continue;
            }
            message_id = id.to_string();
        }
        let Some(model) = message["model"].as_str().filter(|model| !model.is_empty()) else {
            continue;
        };
        let usage = &message["usage"];
        let spent = Counted {
            at: entry["timestamp"]
                .as_str()
                .and_then(|at| at.parse::<Timestamp>().ok())
                .map(|at| at.as_millisecond())
                .unwrap_or_default(),
            input_tokens: counter(usage, "input_tokens"),
            output_tokens: counter(usage, "output_tokens"),
            cache_write_tokens: counter(usage, "cache_creation_input_tokens"),
            cache_read_tokens: counter(usage, "cache_read_input_tokens"),
        };
        if spent.spent() == 0 {
            continue;
        }
        let found = match models.iter_mut().find(|(named, _)| named == model) {
            Some((_, found)) => found,
            None => {
                models.push((model.to_string(), Counted::default()));
                &mut models.last_mut().expect("the model just pushed").1
            }
        };
        found.at = found.at.max(spent.at);
        found.input_tokens += spent.input_tokens;
        found.output_tokens += spent.output_tokens;
        found.cache_write_tokens += spent.cache_write_tokens;
        found.cache_read_tokens += spent.cache_read_tokens;
    }
    (models, message_id)
}

/// One event per model, each with a chunk number of its own; mirrors events() in hooks/usage.mjs.
/// The whole transcript is one stretch, so the numbers start where a first hook pass over it would
/// have started and the prompts it answers all ride on the first event.
fn events(models: &[(String, Counted)], account: &str, prompts: i64, now: i64) -> Vec<Value> {
    models
        .iter()
        .enumerate()
        .map(|(index, (model, spent))| {
            json!({
                "seq": index as i64,
                "provider": PROVIDER,
                "account": account,
                "model": model,
                "prompts": if index == 0 { prompts } else { 0 },
                "at": if spent.at == 0 { now } else { spent.at },
                "inputTokens": spent.input_tokens,
                "outputTokens": spent.output_tokens,
                "cacheWriteTokens": spent.cache_write_tokens,
                "cacheReadTokens": spent.cache_read_tokens,
            })
        })
        .collect()
}

/// One past session read out of its transcript. The two readers take the whole file, which is read
/// once for both: the record's reader counts what the user typed and the usage reader what the
/// models answered, and the two never read the same entries. A transcript whose entries carry no
/// time of their own leaves the file's own birth and last write to say when the session ran.
fn synthesize(scope: &Scope, session_id: &str, path: &Path, account: &str, tags: &mut Repos, now: i64) -> Result<Past> {
    let metadata = std::fs::metadata(path).with_context(|| format!("reading {}", path.display()))?;
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let reading = adopt::read_text(&text, Reading::default());
    let (models, message_id) = aggregate(&text);
    let cwd = PathBuf::from(&reading.cwd);
    Ok(Past {
        session_id: session_id.to_string(),
        host: scope.host.clone(),
        repo: tags.of(&cwd),
        cwd: reading.cwd,
        branch: reading.git_branch,
        started_at: match reading.started_at {
            0 => adopt::birth(path, &metadata).map(adopt::millis).unwrap_or_default(),
            at => at,
        },
        last_activity_at: match reading.last_at {
            0 => metadata.modified().map(adopt::millis).unwrap_or_default(),
            at => at,
        },
        prompts: reading.prompts,
        focus: reading.focus,
        permission_mode: reading.permission_mode,
        usage: UsagePending {
            seq: 0,
            end: metadata.len() as i64,
            high_water: metadata.len() as i64,
            prompts: reading.prompts,
            message_id,
            events: events(&models, account, reading.prompts, now),
        },
    })
}

/// The repo tag of each directory a transcript names, asked for once. A past session's directory is
/// often gone, and one that is still there answers for every session that ran in it.
#[derive(Debug, Default)]
struct Repos(HashMap<PathBuf, String>);

impl Repos {
    fn of(&mut self, cwd: &Path) -> String {
        if cwd.as_os_str().is_empty() {
            return String::new();
        }
        self.0
            .entry(cwd.to_path_buf())
            .or_insert_with(|| repo::repo_tag(cwd).unwrap_or_default())
            .clone()
    }
}

/// Every past session this host holds a transcript for and has not sent, oldest first. A session
/// the registry still names is live and adoption's to take on, not this pass's.
pub fn past(scope: &Scope, now: i64) -> Result<Vec<Past>> {
    let held = skipped(scope);
    let found: Vec<(String, PathBuf)> = transcripts(&scope.projects)
        .into_iter()
        .filter(|(session_id, _)| !held.contains(session_id))
        .collect();
    if found.is_empty() {
        return Ok(Vec::new());
    }
    let account = account(&scope.claude_json);
    if account.is_empty() {
        bail!(
            "{} names no account, so the tokens these sessions spent have nothing to be counted against",
            scope.claude_json.display()
        );
    }
    let mut tags = Repos::default();
    let mut sessions = Vec::new();
    for (session_id, path) in &found {
        sessions.push(synthesize(scope, session_id, path, &account, &mut tags, now)?);
    }
    sessions.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_700_000_000;

    struct Sandbox {
        dir: PathBuf,
        scope: Scope,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let dir = std::env::temp_dir().join(format!("recall-backfill-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            for part in ["projects", "sessions", "state"] {
                std::fs::create_dir_all(dir.join(part)).unwrap();
            }
            let scope = Scope {
                projects: dir.join("projects"),
                sessions: dir.join("sessions"),
                ledger: dir.join("state").join("backfilled"),
                claude_json: dir.join(".claude.json"),
                host: "laptop".to_string(),
            };
            std::fs::write(
                &scope.claude_json,
                json!({ "oauthAccount": { "emailAddress": "you@example.com" }, "userID": "u-1" }).to_string(),
            )
            .unwrap();
            Sandbox { dir, scope }
        }

        fn transcript(&self, project: &str, session_id: &str, lines: &[String]) -> PathBuf {
            let dir = self.scope.projects.join(project);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("{session_id}.jsonl"));
            std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
            path
        }

        /// A subagent's transcript, which sits a level below the project directory.
        fn subagent(&self, project: &str, session_id: &str, lines: &[String]) {
            self.transcript(&format!("{project}/subagents"), session_id, lines);
        }

        fn registered(&self, session_id: &str) {
            std::fs::write(
                self.scope.sessions.join(format!("{session_id}.json")),
                json!({ "state": "off", "sessionId": session_id, "pid": 4242 }).to_string(),
            )
            .unwrap();
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
            "cwd": "/home/you/recall",
            "gitBranch": "feat/backfill",
            "origin": { "kind": "human" },
            "permissionMode": "acceptEdits",
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn answer(at: &str, id: &str, model: &str, input: i64, output: i64) -> String {
        json!({
            "type": "assistant",
            "timestamp": at,
            "cwd": "/home/you/recall",
            "gitBranch": "feat/backfill",
            "message": {
                "id": id,
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 7,
                },
            },
        })
        .to_string()
    }

    fn session() -> Vec<String> {
        vec![
            json!({ "type": "mode", "sessionId": "s-old" }).to_string(),
            human("2026-10-01T10:00:00.000Z", "backfill the old sessions"),
            answer("2026-10-01T10:00:10.000Z", "msg-1", "claude-opus-4", 100, 20),
            answer("2026-10-01T10:00:11.000Z", "msg-1", "claude-opus-4", 100, 20),
            answer("2026-10-01T10:00:12.000Z", "msg-2", "claude-haiku-4", 5, 1),
            human("2026-10-01T10:30:00.000Z", "and the usage too"),
            answer("2026-10-01T10:30:05.000Z", "msg-3", "claude-opus-4", 50, 10),
        ]
    }

    #[test]
    fn a_past_session_is_sent_as_its_transcript_gives_it_back() {
        let sandbox = Sandbox::new("one");
        let path = sandbox.transcript("-home-you-recall", "s-old", &session());

        let found = past(&sandbox.scope, NOW).unwrap();

        assert_eq!(found.len(), 1, "{found:?}");
        let session = &found[0];
        assert_eq!(session.session_id, "s-old");
        assert_eq!(session.host, "laptop");
        assert_eq!(session.cwd, "/home/you/recall");
        assert_eq!(session.branch, "feat/backfill");
        assert_eq!(session.prompts, 2);
        assert_eq!(
            session.focus,
            Focus {
                first: "backfill the old sessions".to_string(),
                latest: "and the usage too".to_string(),
            }
        );
        assert_eq!(session.permission_mode, "acceptEdits");
        assert_eq!(
            session.started_at, 1_790_848_800_000_i64,
            "the first entry that carries a time"
        );
        assert_eq!(session.last_activity_at, 1_790_850_605_000_i64, "the last one");
        let body = session.body();
        assert_eq!(body.commit, "", "a transcript says no commit subject");
        assert_eq!(body.mode, "", "and cannot tell interactive from headless");
        assert_eq!(body.pid, 0);
        assert_eq!(
            session.usage.events,
            vec![
                json!({
                    "seq": 0,
                    "provider": "claude",
                    "account": "you@example.com",
                    "model": "claude-opus-4",
                    "prompts": 2,
                    "at": 1_790_850_605_000_i64,
                    "inputTokens": 150,
                    "outputTokens": 30,
                    "cacheWriteTokens": 0,
                    "cacheReadTokens": 14,
                }),
                json!({
                    "seq": 1,
                    "provider": "claude",
                    "account": "you@example.com",
                    "model": "claude-haiku-4",
                    "prompts": 0,
                    "at": 1_790_848_812_000_i64,
                    "inputTokens": 5,
                    "outputTokens": 1,
                    "cacheWriteTokens": 0,
                    "cacheReadTokens": 7,
                }),
            ],
            "one answer written twice counts once, and every model takes a chunk number of its own"
        );
        assert_eq!(session.usage.end, std::fs::metadata(&path).unwrap().len() as i64);
        assert_eq!(session.usage.message_id, "msg-3");
    }

    #[test]
    fn a_second_run_sends_nothing_and_a_run_before_it_sends_the_same_events() {
        let sandbox = Sandbox::new("again");
        sandbox.transcript("-home-you-recall", "s-old", &session());

        let first = past(&sandbox.scope, NOW).unwrap();
        assert_eq!(
            past(&sandbox.scope, NOW + 60_000).unwrap(),
            first,
            "the same transcript regenerates the same chunk numbers, whenever it is read"
        );

        note(&sandbox.scope.ledger, "s-old").unwrap();

        assert_eq!(
            past(&sandbox.scope, NOW).unwrap(),
            Vec::new(),
            "a session already sent is passed over"
        );
    }

    #[test]
    fn a_subagent_transcript_is_no_session_of_its_own() {
        let sandbox = Sandbox::new("subagent");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        sandbox.subagent("-home-you-recall", "s-subagent", &session());

        let ids: Vec<String> = past(&sandbox.scope, NOW)
            .unwrap()
            .into_iter()
            .map(|session| session.session_id)
            .collect();

        assert_eq!(ids, vec!["s-old".to_string()]);
    }

    #[test]
    fn a_session_the_registry_still_names_is_left_to_adoption() {
        let sandbox = Sandbox::new("live");
        sandbox.transcript("-home-you-recall", "s-live", &session());
        sandbox.transcript("-home-you--dotfiles", "s-old", &session());
        sandbox.registered("s-live");

        let ids: Vec<String> = past(&sandbox.scope, NOW)
            .unwrap()
            .into_iter()
            .map(|session| session.session_id)
            .collect();

        assert_eq!(ids, vec!["s-old".to_string()]);
    }

    #[test]
    fn a_host_that_names_no_account_sends_nothing() {
        let sandbox = Sandbox::new("accountless");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        std::fs::write(&sandbox.scope.claude_json, "{}").unwrap();

        let error = past(&sandbox.scope, NOW).unwrap_err().to_string();
        assert!(error.contains("names no account"), "{error}");

        std::fs::write(&sandbox.scope.claude_json, json!({ "userID": "u-1" }).to_string()).unwrap();
        assert_eq!(past(&sandbox.scope, NOW).unwrap()[0].usage.events[0]["account"], "u-1");
    }

    #[test]
    fn a_host_with_no_transcripts_has_nothing_to_send() {
        let sandbox = Sandbox::new("empty");
        std::fs::remove_file(&sandbox.scope.claude_json).unwrap();
        assert_eq!(past(&sandbox.scope, NOW).unwrap(), Vec::new());
    }
}
