//! The sessions that ran before the hooks did, read back out of the transcripts
//! `~/.claude/projects/` keeps and sent as the sessions they were. The record comes from the reader
//! `recall sessions --adopt` uses and the tokens are read as hooks/usage.mjs reads them, so a
//! session read back long after it ended says what one read mid-flight says. README's "Live
//! sessions" carries the rest.

use crate::adopt::{self, Reading};
use crate::api::SessionBody;
use crate::repo;
use crate::sessions::Focus;
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Mirrors PROVIDER in hooks/usage.mjs.
const PROVIDER: &str = "claude";

const DAY_MS: i64 = 86_400_000;

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
    pub events: Vec<Value>,
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
pub fn account(claude_json: &Path) -> String {
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

/// The subscription this host is signed in as. The file sits in the home directory and not beside
/// the transcripts, as hooks/usage.mjs reads it: a host with `CLAUDE_CONFIG_DIR` set keeps its
/// transcripts elsewhere and its account here, and reading the wrong one refuses every run.
///
/// A host that names no account cannot have its tokens counted against anything, and the run says
/// so rather than sending events the service refuses.
pub fn account_here() -> Result<String> {
    let claude_json = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set, so this host names no account")?
        .join(".claude.json");
    let named = account(&claude_json);
    if named.is_empty() {
        bail!(
            "{} names no account, so the tokens these sessions spent have nothing to be counted against",
            claude_json.display()
        );
    }
    Ok(named)
}

/// Every transcript this host holds. A session's transcript sits directly under a project
/// directory; a subagent's sits a level down and is no session of its own. A directory that cannot
/// be read fails the pass: a host that could not look must not report a host with nothing to send.
fn transcripts(projects: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut found = Vec::new();
    for project in std::fs::read_dir(projects).with_context(|| format!("reading {}", projects.display()))? {
        let project = project.with_context(|| format!("reading {}", projects.display()))?;
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let dir = project.path();
        for entry in std::fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))? {
            let path = entry.with_context(|| format!("reading {}", dir.display()))?.path();
            if path.extension() != Some(OsStr::new(adopt::TRANSCRIPT)) {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string) else {
                continue;
            };
            found.push((session_id, path));
        }
    }
    found.sort();
    Ok(found)
}

/// What one model spent on one day, and when within it it last answered.
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

/// The UTC day an event falls in, as usageDay() in src/model.ts reads it off the same `at`.
fn day(at: i64) -> i64 {
    at.div_euclid(DAY_MS)
}

/// What the models answering one transcript spent, by model and by the day they spent it, in the
/// order each pair first answered; mirrors aggregate() in hooks/usage.mjs. One API response is
/// written as several transcript entries, one per content block, each carrying the same usage, so a
/// message counts once by its id.
///
/// The day is part of the key because a hook pass covers minutes while this one covers a whole
/// transcript: a session that ran past midnight, or was resumed over weeks, would otherwise land
/// every token it ever spent on the day of its last answer, and its months would read as one spike.
///
/// An answer carrying no time this can read is passed over rather than dated from the clock. The
/// day it falls in is part of the key the chunk numbers are handed out in order of, so a clock
/// standing in for a missing time would number the same transcript differently on a later run, and
/// the service keeps the first event it saw for a chunk number — the second reading would land
/// beside the first instead of being ignored. Claude Code stamps every entry, so what this skips is
/// an entry too corrupt to date.
fn aggregate(text: &str) -> Vec<(String, Counted)> {
    let mut spans: Vec<((String, i64), Counted)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry["type"] != "assistant" {
            continue;
        }
        let message = &entry["message"];
        if let Some(id) = message["id"].as_str().filter(|id| !id.is_empty())
            && !seen.insert(id.to_string())
        {
            continue;
        }
        let Some(model) = message["model"].as_str().filter(|model| !model.is_empty()) else {
            continue;
        };
        let usage = &message["usage"];
        let Some(at) = entry["timestamp"]
            .as_str()
            .and_then(|at| at.parse::<Timestamp>().ok())
            .map(|at| at.as_millisecond())
        else {
            continue;
        };
        let spent = Counted {
            at,
            input_tokens: counter(usage, "input_tokens"),
            output_tokens: counter(usage, "output_tokens"),
            cache_write_tokens: counter(usage, "cache_creation_input_tokens"),
            cache_read_tokens: counter(usage, "cache_read_input_tokens"),
        };
        if spent.spent() == 0 {
            continue;
        }
        let key = (model.to_string(), day(at));
        let found = match spans.iter_mut().find(|(named, _)| *named == key) {
            Some((_, found)) => found,
            None => {
                spans.push((key, Counted::default()));
                &mut spans.last_mut().expect("the span just pushed").1
            }
        };
        found.at = found.at.max(spent.at);
        found.input_tokens += spent.input_tokens;
        found.output_tokens += spent.output_tokens;
        found.cache_write_tokens += spent.cache_write_tokens;
        found.cache_read_tokens += spent.cache_read_tokens;
    }
    spans.into_iter().map(|((model, _), spent)| (model, spent)).collect()
}

/// One event per model and day, each with a chunk number of its own; mirrors events() in
/// hooks/usage.mjs. The whole transcript is one stretch, so the numbers start where a first hook
/// pass over it would have started and the prompts it answers all ride on the first event.
fn events(spans: &[(String, Counted)], account: &str, prompts: i64) -> Vec<Value> {
    spans
        .iter()
        .enumerate()
        .map(|(index, (model, spent))| {
            json!({
                "seq": index as i64,
                "provider": PROVIDER,
                "account": account,
                "model": model,
                "prompts": if index == 0 { prompts } else { 0 },
                "at": spent.at,
                "inputTokens": spent.input_tokens,
                "outputTokens": spent.output_tokens,
                "cacheWriteTokens": spent.cache_write_tokens,
                "cacheReadTokens": spent.cache_read_tokens,
            })
        })
        .collect()
}

/// One past session read out of its transcript, or nothing for a transcript that holds neither a
/// prompt nor an answer. A `claude -p` that failed to start and a session closed before its first
/// prompt both leave one of those behind, and sending it would put a row on the history with
/// nothing in it that no later pass ever revisits.
///
/// The whole file is read once, for both readers: the record's reader counts what the user typed
/// and the usage reader what the models answered, and the two never read the same entries. A
/// transcript whose entries carry no time of their own leaves the file's own birth and last write
/// to say when the session ran.
fn synthesize(
    scope: &adopt::Scope,
    session_id: &str,
    path: &Path,
    account: &str,
    tags: &mut HashMap<PathBuf, String>,
) -> Result<Option<Past>> {
    let metadata = std::fs::metadata(path).with_context(|| format!("reading {}", path.display()))?;
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let reading = adopt::read_text(&text, Reading::default());
    let spans = aggregate(&text);
    if reading.prompts == 0 && spans.is_empty() {
        return Ok(None);
    }
    let cwd = PathBuf::from(&reading.cwd);
    let repo = match cwd.as_os_str().is_empty() {
        true => String::new(),
        false => tags
            .entry(cwd.clone())
            .or_insert_with(|| repo::repo_tag(&cwd).unwrap_or_default())
            .clone(),
    };
    Ok(Some(Past {
        session_id: session_id.to_string(),
        host: scope.host.clone(),
        repo,
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
        events: events(&spans, account, reading.prompts),
    }))
}

/// Every past session this host holds a transcript for that the service does not already have,
/// oldest first. A session the registry still names is live and adoption's to take on, not this
/// pass's.
pub fn past(scope: &adopt::Scope, account: &str, on_record: &HashSet<String>) -> Result<Vec<Past>> {
    let found = transcripts(&scope.projects)?;
    let live = adopt::registry(&scope.sessions).sessions;
    let mut tags: HashMap<PathBuf, String> = HashMap::new();
    let mut sessions = Vec::new();
    for (session_id, path) in &found {
        if on_record.contains(session_id) || live.contains(session_id) {
            continue;
        }
        sessions.extend(synthesize(scope, session_id, path, account, &mut tags)?);
    }
    sessions.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(sessions)
}

/// What a run asks of the service for one past session.
pub trait Service {
    fn post_usage(&self, session_id: &str, host: &str, repo: &str, events: &[Value]) -> Result<usize>;
    fn sync(&self, session_id: &str, body: &SessionBody) -> Result<()>;
    fn end(&self, session_id: &str) -> Result<()>;
}

/// Sends each past session: the tokens first, then the record that writes the history row, then the
/// end. The order is what makes an interrupted run safe to repeat. The row is what the next run
/// reads as already sent, so it may not land ahead of the tokens it stands for — a run that dies
/// between the two leaves the session off the record and the next one sends it again, where every
/// event already posted is a chunk number the service holds and ignores.
pub fn send(service: &impl Service, past: &[Past], mut sent: impl FnMut(&str, usize)) -> Result<()> {
    for session in past {
        let id = &session.session_id;
        let events = service.post_usage(id, &session.host, &session.repo, &session.events)?;
        service.sync(id, &session.body())?;
        service.end(id)?;
        sent(id, events);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const ACCOUNT: &str = "you@example.com";

    /// A service holding no session on record, which is every host's first run.
    fn nothing() -> HashSet<String> {
        HashSet::new()
    }

    fn on_record(session_ids: &[&str]) -> HashSet<String> {
        session_ids.iter().map(|id| id.to_string()).collect()
    }

    fn ids(past: &[Past]) -> Vec<String> {
        past.iter().map(|session| session.session_id.clone()).collect()
    }

    struct Sandbox {
        dir: PathBuf,
        scope: adopt::Scope,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let dir = std::env::temp_dir().join(format!("recall-backfill-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            for part in ["proc", "projects", "sessions"] {
                std::fs::create_dir_all(dir.join(part)).unwrap();
            }
            Sandbox {
                scope: adopt::Scope {
                    procfs: dir.join("proc"),
                    projects: dir.join("projects"),
                    sessions: dir.join("sessions"),
                    host: "laptop".to_string(),
                },
                dir,
            }
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

        fn found(&self, on_record: &HashSet<String>) -> Vec<Past> {
            past(&self.scope, ACCOUNT, on_record).unwrap()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The service as a run can see it: events kept by the first write for a chunk number, the
    /// history rows a sync wrote, and the sessions ended. `fail_sync` is the session whose sync
    /// fails, which is where an interrupted run stops.
    #[derive(Debug, Default)]
    struct Fake {
        events: RefCell<HashMap<(String, i64), Value>>,
        history: RefCell<HashSet<String>>,
        ended: RefCell<Vec<String>>,
        fail_sync: String,
    }

    impl Fake {
        fn holding(events: HashMap<(String, i64), Value>) -> Fake {
            Fake {
                events: RefCell::new(events),
                ..Fake::default()
            }
        }

        fn on_record(&self) -> HashSet<String> {
            self.history.borrow().clone()
        }
    }

    impl Service for Fake {
        fn post_usage(&self, session_id: &str, host: &str, _repo: &str, events: &[Value]) -> Result<usize> {
            assert_eq!(host, "laptop", "a delta carries the host that spent the tokens");
            for event in events {
                let seq = event["seq"].as_i64().expect("every event carries a chunk number");
                self.events
                    .borrow_mut()
                    .entry((session_id.to_string(), seq))
                    .or_insert_with(|| event.clone());
            }
            Ok(events.len())
        }

        fn sync(&self, session_id: &str, _body: &SessionBody) -> Result<()> {
            if self.fail_sync == session_id {
                bail!("the recall service had an error");
            }
            self.history.borrow_mut().insert(session_id.to_string());
            Ok(())
        }

        fn end(&self, session_id: &str) -> Result<()> {
            self.ended.borrow_mut().push(session_id.to_string());
            Ok(())
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
        sandbox.transcript("-home-you-recall", "s-old", &session());

        let found = sandbox.found(&nothing());

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
            session.events,
            vec![
                json!({
                    "seq": 0,
                    "provider": "claude",
                    "account": ACCOUNT,
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
                    "account": ACCOUNT,
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
    }

    #[test]
    fn the_tokens_of_a_session_land_on_the_days_it_spent_them() {
        let sandbox = Sandbox::new("midnight");
        sandbox.transcript(
            "-home-you-recall",
            "s-long",
            &[
                human("2026-10-01T23:30:00.000Z", "start before midnight"),
                answer("2026-10-01T23:45:00.000Z", "msg-1", "claude-opus-4", 100, 10),
                answer("2026-10-02T00:15:00.000Z", "msg-2", "claude-opus-4", 200, 20),
                answer("2026-10-21T09:00:00.000Z", "msg-3", "claude-opus-4", 400, 40),
            ],
        );

        let events = sandbox.found(&nothing()).remove(0).events;

        let landed: Vec<(i64, &str, i64, i64)> = events
            .iter()
            .map(|event| {
                (
                    event["seq"].as_i64().unwrap(),
                    event["model"].as_str().unwrap(),
                    event["at"].as_i64().unwrap(),
                    event["inputTokens"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            landed,
            vec![
                (0, "claude-opus-4", 1_790_898_300_000, 100),
                (1, "claude-opus-4", 1_790_900_100_000, 200),
                (2, "claude-opus-4", 1_792_573_200_000, 400),
            ],
            "one event per day the session answered on, each dated inside its own day"
        );
        assert_eq!(events[0]["prompts"], 1, "the prompts ride on the first event alone");
        assert_eq!(events[1]["prompts"], 0);
    }

    #[test]
    fn a_second_run_sends_nothing_and_a_run_before_it_sends_the_same_events() {
        let sandbox = Sandbox::new("again");
        sandbox.transcript("-home-you-recall", "s-old", &session());

        let first = sandbox.found(&nothing());
        assert_eq!(
            sandbox.found(&nothing()),
            first,
            "the same transcript regenerates the same chunk numbers, whenever it is read"
        );

        assert_eq!(
            sandbox.found(&on_record(&["s-old"])),
            Vec::new(),
            "a session the service already holds on record is passed over"
        );
    }

    #[test]
    fn an_answer_that_cannot_be_dated_is_counted_on_no_day_at_all() {
        let sandbox = Sandbox::new("undatable");
        let undatable = json!({
            "type": "assistant",
            "cwd": "/home/you/recall",
            "message": {
                "id": "msg-undatable",
                "model": "claude-opus-4",
                "usage": { "input_tokens": 999_999, "output_tokens": 999_999 },
            },
        })
        .to_string();
        sandbox.transcript(
            "-home-you-recall",
            "s-mixed",
            &[
                human("2026-10-01T10:00:00.000Z", "count what you can date"),
                answer("2026-10-01T10:00:10.000Z", "msg-1", "claude-opus-4", 100, 20),
                undatable.clone(),
                json!({
                    "type": "assistant",
                    "timestamp": "not a time at all",
                    "message": { "id": "msg-2", "model": "claude-opus-4", "usage": { "input_tokens": 999_999 } },
                })
                .to_string(),
                answer("2026-10-02T10:00:10.000Z", "msg-3", "claude-opus-4", 200, 40),
            ],
        );

        let events = sandbox.found(&nothing()).remove(0).events;

        let landed: Vec<(i64, i64, i64)> = events
            .iter()
            .map(|event| {
                (
                    event["seq"].as_i64().unwrap(),
                    event["at"].as_i64().unwrap(),
                    event["inputTokens"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            landed,
            vec![(0, 1_790_848_810_000, 100), (1, 1_790_935_210_000, 200)],
            "an undated answer takes no chunk number, so the ones the dated answers take never move"
        );
    }

    #[test]
    fn a_run_that_dies_before_the_history_row_lands_repeats_it_without_counting_twice() {
        let sandbox = Sandbox::new("interrupted");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        let dying = Fake {
            fail_sync: "s-old".to_string(),
            ..Fake::default()
        };

        let first = sandbox.found(&dying.on_record());
        assert!(
            send(&dying, &first, |_, _| {}).is_err(),
            "a sync the service refuses fails the run"
        );
        let posted = dying.events.borrow().clone();
        assert_eq!(posted.len(), 2, "the tokens went out ahead of the row");
        assert_eq!(dying.on_record(), nothing(), "and the row that stands for them did not");
        assert!(dying.ended.borrow().is_empty());

        let resumed = Fake::holding(posted.clone());
        let again = sandbox.found(&resumed.on_record());
        assert_eq!(again, first, "nothing is on record, so the same session is sent again");
        send(&resumed, &again, |_, _| {}).unwrap();

        assert_eq!(
            *resumed.events.borrow(),
            posted,
            "every event it posted again is a chunk number the service already held"
        );
        assert_eq!(resumed.on_record(), on_record(&["s-old"]));
        assert_eq!(*resumed.ended.borrow(), vec!["s-old".to_string()]);
        assert_eq!(
            sandbox.found(&resumed.on_record()),
            Vec::new(),
            "and the run after it has nothing left to send"
        );
    }

    #[test]
    fn a_transcript_with_neither_a_prompt_nor_an_answer_is_not_a_session() {
        let sandbox = Sandbox::new("blank");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        sandbox.transcript(
            "-home-you-recall",
            "s-misfire",
            &[json!({ "type": "mode", "sessionId": "s-misfire" }).to_string()],
        );
        sandbox.transcript("-home-you-recall", "s-empty", &[]);

        assert_eq!(
            ids(&sandbox.found(&nothing())),
            vec!["s-old".to_string()],
            "a run that never started must leave no blank row behind"
        );
    }

    #[test]
    fn a_subagent_transcript_is_no_session_of_its_own() {
        let sandbox = Sandbox::new("subagent");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        sandbox.subagent("-home-you-recall", "s-subagent", &session());

        assert_eq!(ids(&sandbox.found(&nothing())), vec!["s-old".to_string()]);
    }

    #[test]
    fn a_session_the_registry_still_names_is_left_to_adoption() {
        let sandbox = Sandbox::new("live");
        sandbox.transcript("-home-you-recall", "s-live", &session());
        sandbox.transcript("-home-you--dotfiles", "s-old", &session());
        sandbox.registered("s-live");

        assert_eq!(ids(&sandbox.found(&nothing())), vec!["s-old".to_string()]);
    }

    #[test]
    fn a_host_whose_transcripts_cannot_be_read_fails_the_pass() {
        let sandbox = Sandbox::new("unreadable");
        std::fs::remove_dir_all(&sandbox.scope.projects).unwrap();
        std::fs::write(&sandbox.scope.projects, "not a directory").unwrap();

        assert!(
            past(&sandbox.scope, ACCOUNT, &nothing()).is_err(),
            "a host that could not look must not report a host with nothing to send"
        );
    }

    #[test]
    fn the_account_is_the_one_this_host_is_signed_in_as() {
        let dir = std::env::temp_dir().join(format!("recall-backfill-account-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".claude.json");

        std::fs::write(
            &path,
            json!({ "oauthAccount": { "emailAddress": ACCOUNT }, "userID": "u-1" }).to_string(),
        )
        .unwrap();
        assert_eq!(account(&path), ACCOUNT);

        std::fs::write(&path, json!({ "userID": "u-1" }).to_string()).unwrap();
        assert_eq!(
            account(&path),
            "u-1",
            "a host whose account was swapped out has only its user id"
        );

        std::fs::write(&path, "{}").unwrap();
        assert_eq!(account(&path), "");
        assert_eq!(account(&dir.join("missing.json")), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
