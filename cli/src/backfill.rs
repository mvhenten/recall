//! The sessions that ran before the hooks did, read back out of the transcripts
//! `~/.claude/projects/` keeps and sent as the sessions they were. The record comes from the reader
//! `recall sessions --adopt` uses and the tokens are read as hooks/usage.mjs reads them, so a
//! session read back long after it ended says what one read mid-flight says. README's "Live
//! sessions" carries the rest.

use crate::adopt::{self, Reading};
use crate::api::SessionBody;
use crate::repo;
use crate::sessions::Focus;
use crate::transcripts::{self, MAIN, Source};
use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// Mirrors PROVIDER in hooks/usage.mjs.
const PROVIDER: &str = "claude";

const DAY_MS: i64 = 86_400_000;

/// How many chunk numbers one transcript file's reading may spend. Each file is read into a block
/// of its own, so what one file's spans land on does not move when another file is read beside
/// it. A file would need a million model-and-day pairs to reach past its block.
const SPANS_PER_FILE: i64 = 1_000_000;

/// How far into a transcript the first entry naming a directory may sit.
const CWD_WITHIN_LINES: usize = 50;

/// One transcript file of one past session, and the block of chunk numbers its reading spends.
/// The session's own transcript is always block zero, so a reading sent before the delegated turns
/// were ever read lands on exactly the numbers the service already holds and is ignored. The
/// delegated turns take the blocks after it in name order, and a session that is over opens no
/// more of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub source: Source,
    pub block: i64,
}

impl Part {
    /// What the models answering this one file spent, numbered inside its block. It is read here
    /// rather than when the session was found, so a file the service is already level with costs
    /// nothing to pass over.
    pub fn events(&self, account: &str, prompts: i64) -> Result<Vec<Value>> {
        let text = std::fs::read_to_string(&self.source.path)
            .with_context(|| format!("reading {}", self.source.path.display()))?;
        Ok(events(&aggregate(&text), account, prompts, self.block))
    }
}

/// One past session, as its transcript gives it back. `mode` and the commit subject are left to the
/// API's empty readings: a transcript says neither whether the session was interactive nor which
/// commit its directory sat on, and inventing either would make the history row say more than the
/// host knows.
///
/// `on_record` says the service already holds the session. This run writes it no history row and
/// recounts nothing its own transcript spent, since the run that put it on record counted that;
/// the fields the row is built from are read only for a session the service has never seen.
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
    pub on_record: bool,
    pub parts: Vec<Part>,
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
/// hooks/usage.mjs. The whole file is one stretch, numbered inside the block it was read into, so
/// the session's own transcript starts where a first hook pass over it would have started and the
/// prompts it answers all ride on its first event.
fn events(spans: &[(String, Counted)], account: &str, prompts: i64, block: i64) -> Vec<Value> {
    spans
        .iter()
        .enumerate()
        .map(|(index, (model, spent))| {
            json!({
                "seq": block * SPANS_PER_FILE + index as i64,
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

/// The directory one session ran in, off the first entry that names one. It is all a session
/// already on record is read for: its row is written, and the repo tag is the only thing about it
/// that the usage this run still owes rides on.
fn first_cwd(path: &Path) -> String {
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .take(CWD_WITHIN_LINES)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .find_map(|entry| entry["cwd"].as_str().filter(|cwd| !cwd.is_empty()).map(str::to_string))
        .unwrap_or_default()
}

/// The transcript files one past session is made of, each in the block its reading is numbered in.
fn parts(transcript: &Path) -> Vec<Part> {
    transcripts::sources(transcript)
        .into_iter()
        .enumerate()
        .map(|(block, source)| Part {
            source,
            block: block as i64,
        })
        .collect()
}

/// One past session read out of its transcript, or nothing for a transcript that holds neither a
/// prompt nor an answer. A `claude -p` that failed to start and a session closed before its first
/// prompt both leave one of those behind, and sending it would put a row on the history with
/// nothing in it that no later pass ever revisits. A session already on record is past that test:
/// the row it would have written is there already.
///
/// The whole file is read once, for both readers: the record's reader counts what the user typed
/// and the usage reader what the models answered, and the two never read the same entries. A
/// transcript whose entries carry no time of their own leaves the file's own birth and last write
/// to say when the session ran.
fn synthesize(
    scope: &adopt::Scope,
    session_id: &str,
    path: &Path,
    on_record: bool,
    tags: &mut HashMap<PathBuf, String>,
) -> Result<Option<Past>> {
    let tagged = |cwd: &str, tags: &mut HashMap<PathBuf, String>| {
        let dir = PathBuf::from(cwd);
        match dir.as_os_str().is_empty() {
            true => String::new(),
            false => tags
                .entry(dir.clone())
                .or_insert_with(|| repo::repo_tag(&dir).unwrap_or_default())
                .clone(),
        }
    };
    if on_record {
        let cwd = first_cwd(path);
        return Ok(Some(Past {
            session_id: session_id.to_string(),
            host: scope.host.clone(),
            repo: tagged(&cwd, tags),
            cwd,
            branch: String::new(),
            started_at: 0,
            last_activity_at: 0,
            prompts: 0,
            focus: Focus::default(),
            permission_mode: String::new(),
            on_record: true,
            parts: parts(path),
        }));
    }
    let metadata = std::fs::metadata(path).with_context(|| format!("reading {}", path.display()))?;
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let reading = adopt::read_text(&text, Reading::default());
    if reading.prompts == 0 && aggregate(&text).is_empty() {
        return Ok(None);
    }
    Ok(Some(Past {
        session_id: session_id.to_string(),
        host: scope.host.clone(),
        repo: tagged(&reading.cwd, tags),
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
        on_record: false,
        parts: parts(path),
    }))
}

/// Every past session this host holds a transcript for, oldest first, whether or not the service
/// already has it: a session on record still owes the archive its files, and the delegated turns
/// of every session that ran before this reader existed were counted nowhere. A session the
/// registry still names is live and adoption's to take on, not this pass's.
pub fn past(scope: &adopt::Scope, on_record: &HashSet<String>) -> Result<Vec<Past>> {
    let found = transcripts(&scope.projects)?;
    let live = adopt::registry(&scope.sessions).sessions;
    let mut tags: HashMap<PathBuf, String> = HashMap::new();
    let mut sessions = Vec::new();
    for (session_id, path) in &found {
        if live.contains(session_id) {
            continue;
        }
        sessions.extend(synthesize(
            scope,
            session_id,
            path,
            on_record.contains(session_id),
            &mut tags,
        )?);
    }
    sessions.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(sessions)
}

/// What a run asks of the service for one past session.
pub trait Service: transcripts::Store {
    fn post_usage(&self, session_id: &str, host: &str, repo: &str, events: &[Value]) -> Result<usize>;
    fn sync(&self, session_id: &str, body: &SessionBody) -> Result<()>;
    fn end(&self, session_id: &str) -> Result<()>;
}

/// What one run did for one session.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sent {
    pub events: usize,
    pub bytes: i64,
}

/// Sends each past session, file by file: the tokens of a file first, then the file itself, and
/// for a session the service has never seen the record that writes the history row and then the
/// end. The order is what makes an interrupted run safe to repeat, and it is what a later run
/// reads the archive as.
///
/// A file the service holds any of is a file whose tokens were counted, because nothing writes a
/// byte of it before the events for it have landed. So a file it holds nothing of is counted now,
/// and every other file is only caught up on its bytes — which is what keeps a host that has
/// backfilled before from counting its own transcripts a second time, and still lets it count the
/// delegated turns no run before this one ever read. The session's own transcript of a session
/// already on record is never recounted at all: the run that put it on record counted it.
pub fn send(service: &impl Service, past: &[Past], account: &str, mut sent: impl FnMut(&str, Sent)) -> Result<()> {
    for session in past {
        let id = &session.session_id;
        let held = service.held(id)?;
        let mut done = Sent::default();
        for part in &session.parts {
            let have = held.get(&part.source.file).copied().unwrap_or(0);
            let counted = session.on_record && part.source.file == MAIN;
            if have == 0 && !counted {
                let prompts = if part.source.file == MAIN { session.prompts } else { 0 };
                let events = part.events(account, prompts)?;
                done.events += service.post_usage(id, &session.host, &session.repo, &events)?;
            }
            done.bytes += transcripts::send_file(service, id, &part.source, have)?;
        }
        if !session.on_record {
            service.sync(id, &session.body())?;
            service.end(id)?;
        }
        sent(id, done);
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

        /// A delegated turn's transcript, which Claude Code writes under the session's own
        /// directory and which is no session of its own.
        fn subagent(&self, project: &str, session_id: &str, file: &str, lines: &[String]) {
            self.transcript(&format!("{project}/{session_id}/subagents"), file, lines);
        }

        fn registered(&self, session_id: &str) {
            std::fs::write(
                self.scope.sessions.join(format!("{session_id}.json")),
                json!({ "state": "off", "sessionId": session_id, "pid": 4242 }).to_string(),
            )
            .unwrap();
        }

        fn found(&self, on_record: &HashSet<String>) -> Vec<Past> {
            past(&self.scope, on_record).unwrap()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The service as a run can see it: events kept by the first write for a chunk number, the
    /// rollup those events add into, the archive the stretches land in, the history rows a sync
    /// wrote, and the sessions ended. `fail_sync` is the session whose sync fails, which is where
    /// an interrupted run stops.
    ///
    /// The rollup accumulates, as `usage_daily` does, and only for a chunk number the service did
    /// not already hold; that is what a run repeating itself is measured against.
    #[derive(Debug, Default)]
    struct Fake {
        events: RefCell<HashMap<(String, i64), Value>>,
        daily: RefCell<HashMap<(i64, String), i64>>,
        archive: RefCell<HashMap<(String, String), Vec<u8>>>,
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

        fn rollup(&self) -> HashMap<(i64, String), i64> {
            self.daily.borrow().clone()
        }

        fn archived(&self, session_id: &str, file: &str) -> String {
            String::from_utf8(
                self.archive
                    .borrow()
                    .get(&(session_id.to_string(), file.to_string()))
                    .cloned()
                    .unwrap_or_default(),
            )
            .unwrap()
        }
    }

    impl transcripts::Store for Fake {
        fn held(&self, session_id: &str) -> Result<HashMap<String, i64>> {
            Ok(self
                .archive
                .borrow()
                .iter()
                .filter(|((held, _), _)| held == session_id)
                .map(|((_, file), body)| (file.clone(), body.len() as i64))
                .collect())
        }

        fn append(&self, session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<transcripts::Appended> {
            let mut archive = self.archive.borrow_mut();
            let body = archive.entry((session_id.to_string(), file.to_string())).or_default();
            if offset != body.len() as i64 {
                return Ok(transcripts::Appended::Behind(body.len() as i64));
            }
            body.extend_from_slice(bytes);
            Ok(transcripts::Appended::Wrote(body.len() as i64))
        }
    }

    impl Service for Fake {
        fn post_usage(&self, session_id: &str, host: &str, _repo: &str, events: &[Value]) -> Result<usize> {
            assert_eq!(host, "laptop", "a delta carries the host that spent the tokens");
            for event in events {
                let seq = event["seq"].as_i64().expect("every event carries a chunk number");
                let mut held = self.events.borrow_mut();
                if held.contains_key(&(session_id.to_string(), seq)) {
                    continue;
                }
                held.insert((session_id.to_string(), seq), event.clone());
                let key = (
                    day(event["at"].as_i64().unwrap_or_default()),
                    event["model"].as_str().unwrap_or_default().to_string(),
                );
                *self.daily.borrow_mut().entry(key).or_default() += event["inputTokens"].as_i64().unwrap_or_default();
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
            session.parts[0].events(ACCOUNT, session.prompts).unwrap(),
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

        let found = sandbox.found(&nothing()).remove(0);
        let events = found.parts[0].events(ACCOUNT, found.prompts).unwrap();

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

        let found = sandbox.found(&nothing()).remove(0);
        let events = found.parts[0].events(ACCOUNT, found.prompts).unwrap();

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
            send(&dying, &first, ACCOUNT, |_, _| {}).is_err(),
            "a sync the service refuses fails the run"
        );
        let posted = dying.events.borrow().clone();
        assert_eq!(posted.len(), 2, "the tokens went out ahead of the row");
        assert_eq!(dying.on_record(), nothing(), "and the row that stands for them did not");
        assert!(dying.ended.borrow().is_empty());

        let resumed = Fake::holding(posted.clone());
        let again = sandbox.found(&resumed.on_record());
        assert_eq!(again, first, "nothing is on record, so the same session is sent again");
        send(&resumed, &again, ACCOUNT, |_, _| {}).unwrap();

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
    fn a_delegated_turn_is_a_file_of_its_session_and_no_session_of_its_own() {
        let sandbox = Sandbox::new("subagent");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        sandbox.subagent("-home-you-recall", "s-old", "agent-7f21", &session());

        let found = sandbox.found(&nothing());

        assert_eq!(ids(&found), vec!["s-old".to_string()]);
        assert_eq!(
            found[0]
                .parts
                .iter()
                .map(|part| (part.source.file.as_str(), part.block))
                .collect::<Vec<_>>(),
            vec![("main", 0), ("agent-7f21", 1)],
            "the session's own transcript keeps block zero whatever joins it"
        );
        let delegated = found[0].parts[1].events(ACCOUNT, 0).unwrap();
        assert_eq!(
            delegated[0]["seq"], SPANS_PER_FILE,
            "and a delegated turn is numbered apart"
        );
        assert_eq!(delegated[0]["prompts"], 0, "no prompt is counted twice for it");
    }

    /// What one delegated turn of `session()` answered, in a model and on a day it already counted
    /// under, so a reading that counted the file twice would be invisible in the model and the day
    /// and show only in the total.
    fn delegated() -> Vec<String> {
        vec![answer("2026-10-01T10:05:00.000Z", "msg-a1", "claude-opus-4", 700, 70)]
    }

    fn spent(service: &Fake, model: &str) -> i64 {
        service
            .rollup()
            .get(&(day(1_790_850_605_000), model.to_string()))
            .copied()
            .unwrap_or_default()
    }

    #[test]
    fn a_run_repeated_adds_nothing_the_run_before_it_did_not() {
        let sandbox = Sandbox::new("twice");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        sandbox.subagent("-home-you-recall", "s-old", "agent-7f21", &delegated());
        let service = Fake::default();

        send(&service, &sandbox.found(&nothing()), ACCOUNT, |_, _| {}).unwrap();
        let once = service.rollup();
        send(&service, &sandbox.found(&service.on_record()), ACCOUNT, |_, _| {}).unwrap();

        assert_eq!(
            spent(&service, "claude-opus-4"),
            850,
            "the session and its delegated turn"
        );
        assert_eq!(service.rollup(), once, "and a run that repeats adds none of it again");
        assert_eq!(
            service.archived("s-old", "agent-7f21"),
            format!("{}\n", delegated().join("\n")),
            "the delegated turn's transcript is held once and whole"
        );
    }

    #[test]
    fn a_host_that_backfilled_before_counts_the_delegated_turns_and_its_own_transcripts_no_twice() {
        let sandbox = Sandbox::new("already");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        let service = Fake::default();
        send(&service, &sandbox.found(&nothing()), ACCOUNT, |_, _| {}).unwrap();
        assert_eq!(spent(&service, "claude-opus-4"), 150);

        // The run above is the one a host made before any of this existed: it archived nothing,
        // and the raw events it posted have since aged out of the window the rollup is deduped
        // against, so nothing but the reading itself can keep it from counting twice.
        service.archive.borrow_mut().clear();
        service.events.borrow_mut().clear();
        sandbox.subagent("-home-you-recall", "s-old", "agent-7f21", &delegated());

        send(&service, &sandbox.found(&service.on_record()), ACCOUNT, |_, _| {}).unwrap();

        assert_eq!(
            spent(&service, "claude-opus-4"),
            850,
            "the delegated turn is counted and the session's own transcript is not counted again"
        );
        assert_eq!(spent(&service, "claude-haiku-4"), 5);
        let caught_up = service.rollup();
        send(&service, &sandbox.found(&service.on_record()), ACCOUNT, |_, _| {}).unwrap();
        assert_eq!(service.rollup(), caught_up, "and the run after it adds nothing at all");
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
            past(&sandbox.scope, &nothing()).is_err(),
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
