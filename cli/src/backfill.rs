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
use std::path::{Path, PathBuf};

/// Mirrors PROVIDER in hooks/usage.mjs.
const PROVIDER: &str = "claude";

const DAY_MS: i64 = 86_400_000;

/// Where the chunk numbers of a whole-file reading start, clear of the ones a running session's
/// hooks hand out. Those climb from nothing, one per model per delta, so a reading that landed on
/// one of them would be taken for a delta that had already arrived and dropped.
const BACKFILL_BASE: i64 = 1 << 40;

/// How many chunk numbers one file's reading may spend. A file would need sixty-five thousand
/// model-and-day pairs to reach past its block.
const SPANS_PER_FILE: i64 = 1 << 16;

/// How many blocks there are to hash a file name into, which is what is left of the whole numbers
/// a chunk number may be once the base and the span are taken out.
const BLOCKS: i64 = ((1_i64 << 53) - BACKFILL_BASE) / SPANS_PER_FILE;

/// The block one file's reading is numbered in, from its name and nothing else. Numbering by
/// position would move every later file's block the moment a delegated turn with an earlier name
/// joined the set, and those numbers would land on ones another file had already spent. The
/// session's own transcript takes block zero, so the files that come and go never touch it.
///
/// Two delegated turns of one session hashing to the same block would have the second one's
/// events land on chunk numbers the first already holds, which the insert ignores: that turn's
/// tokens are dropped, quietly and for good. With a block space of 2^37 that needs around fifty
/// thousand files in a single session before it is as likely as not, against a few dozen in a
/// heavy one, so nothing here guards against it.
fn block(file: &str) -> i64 {
    if file == MAIN {
        return 0;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in file.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    1 + (hash % (BLOCKS as u64 - 1)) as i64
}

/// One transcript file of one past session, and the block of chunk numbers its reading spends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub source: Source,
}

impl Part {
    /// What the models answering this one file spent, numbered inside the block its name gives
    /// it. It is read here rather than when the session was found, so a run reads a file only
    /// when it is about to send it.
    pub fn events(&self, account: &str, prompts: i64) -> Result<Vec<Value>> {
        let text = std::fs::read_to_string(&self.source.path)
            .with_context(|| format!("reading {}", self.source.path.display()))?;
        Ok(events(&aggregate(&text), account, prompts, block(&self.source.file)))
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
    /// Whether the service already holds the session. Its own transcript was counted by whatever
    /// put it there and is never read again; its delegated turns are another matter, since no run
    /// before this one ever counted one at all.
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
/// hooks/usage.mjs. The whole file is one stretch, numbered inside the block its name gives it,
/// and the prompts it answers all ride on its first event.
///
/// `durable` is what makes a repeat free: the same file read again yields the same chunk numbers,
/// and the service keeps those rows rather than sweeping them at two weeks, so the second reading
/// lands on rows it already holds and adds nothing to the rollup however long after the first it
/// arrives.
fn events(spans: &[(String, Counted)], account: &str, prompts: i64, block: i64) -> Vec<Value> {
    spans
        .iter()
        .enumerate()
        .map(|(index, (model, spent))| {
            json!({
                "seq": BACKFILL_BASE + block * SPANS_PER_FILE + index as i64,
                "durable": true,
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

/// The transcript files one past session is made of.
fn parts(transcript: &Path) -> Result<Vec<Part>> {
    Ok(transcripts::sources(transcript)?
        .into_iter()
        .map(|source| Part { source })
        .collect())
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
        on_record,
        parts: parts(path)?,
    }))
}

/// Every past session this host holds a transcript for, oldest first, whether or not the service
/// already has it: a session on record still owes it every delegated turn, which no run before
/// this one ever counted. A session the registry still names is live and adoption's to take on,
/// not this pass's.
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
    fn post_usage(&self, session_id: &str, host: &str, repo: &str, files: &[String], events: &[Value])
    -> Result<usize>;
    fn sync(&self, session_id: &str, body: &SessionBody) -> Result<()>;
    fn end(&self, session_id: &str) -> Result<()>;
}

/// What one run did for one session.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sent {
    pub events: usize,
    pub bytes: i64,
}

/// Which of one session's files this run still owes tokens for.
///
/// A session the service has never seen owes all of them, and is not asked about: the route that
/// would answer only knows a session already on record, and nothing it could say would change the
/// answer. A session it has owes only the delegated turns it has not counted. Its own transcript
/// is never read again, whatever the service says — the hooks counted that one as the session
/// ran, or a run before this did, and a transcript cannot say which.
fn owed<'a>(service: &impl Service, session: &'a Past) -> Result<(Vec<&'a Part>, transcripts::Held)> {
    if !session.on_record {
        return Ok((session.parts.iter().collect(), transcripts::Held::default()));
    }
    let held = service.held(&session.session_id)?;
    let owed = session
        .parts
        .iter()
        .filter(|part| part.source.file != MAIN && !held.counted.contains(&part.source.file))
        .collect();
    Ok((owed, held))
}

/// Sends each past session: the tokens it still owes, then for a session the service has never
/// seen the record that writes the history row and the end that leaves it standing, then the
/// files themselves.
///
/// A reading that arrives twice costs nothing either way. The chunk numbers come from the
/// transcript, so the same file read again yields the same ones, and the rows a run writes are
/// kept rather than swept at two weeks — so the rollup counts each of them exactly once, however
/// long after the first a second reading lands.
///
/// The order is what makes an interrupted run safe to repeat. The history row is what the next
/// run reads as already sent, so it may not land ahead of the tokens it stands for; the archive
/// goes last because the route that takes it answers only for a session on record, and the end
/// is what puts a new one there.
pub fn send(service: &impl Service, past: &[Past], account: &str, mut sent: impl FnMut(&str, Sent)) -> Result<()> {
    for session in past {
        let id = &session.session_id;
        let (owed, mut held) = owed(service, session)?;
        let mut done = Sent::default();
        for part in owed {
            let prompts = if part.source.file == MAIN { session.prompts } else { 0 };
            let events = part.events(account, prompts)?;
            let files = [part.source.file.clone()];
            done.events += service.post_usage(id, &session.host, &session.repo, &files, &events)?;
        }
        if !session.on_record {
            service.sync(id, &session.body())?;
            service.end(id)?;
            held = service.held(id)?;
        }
        // The files this session was found to have, and not whatever is on disk by now: the set
        // the archive writes is then the set the tokens were decided over, and the two cannot
        // drift apart under a run.
        for part in &session.parts {
            let at = held.bytes.get(&part.source.file).copied().unwrap_or(0);
            done.bytes += transcripts::send_file(service, id, &part.source, at)?.bytes;
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
        counted: RefCell<HashSet<(String, String)>>,
        archive: RefCell<HashMap<(String, String), Vec<u8>>>,
        history: RefCell<HashSet<String>>,
        ended: RefCell<Vec<String>>,
        fail_sync: String,
    }

    impl Fake {
        /// The same service a run died against, carrying everything that run left on it. Only the
        /// history row is missing, which is what the sync never wrote.
        fn resuming(dying: &Fake) -> Fake {
            Fake {
                events: dying.events.clone(),
                daily: dying.daily.clone(),
                counted: dying.counted.clone(),
                archive: dying.archive.clone(),
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
        fn held(&self, session_id: &str) -> Result<transcripts::Held> {
            Ok(transcripts::Held {
                bytes: self
                    .archive
                    .borrow()
                    .iter()
                    .filter(|((held, _), _)| held == session_id)
                    .map(|((_, file), body)| (file.clone(), body.len() as i64))
                    .collect(),
                counted: self
                    .counted
                    .borrow()
                    .iter()
                    .filter(|(held, _)| held == session_id)
                    .map(|(_, file)| file.clone())
                    .collect(),
            })
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
        fn post_usage(
            &self,
            session_id: &str,
            host: &str,
            _repo: &str,
            files: &[String],
            events: &[Value],
        ) -> Result<usize> {
            assert_eq!(host, "laptop", "a delta carries the host that spent the tokens");
            for file in files {
                self.counted.borrow_mut().insert((session_id.to_string(), file.clone()));
            }
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
                    "seq": BACKFILL_BASE,
                    "durable": true,
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
                    "seq": BACKFILL_BASE + 1,
                    "durable": true,
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
                (BACKFILL_BASE, "claude-opus-4", 1_790_898_300_000, 100),
                (BACKFILL_BASE + 1, "claude-opus-4", 1_790_900_100_000, 200),
                (BACKFILL_BASE + 2, "claude-opus-4", 1_792_573_200_000, 400),
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
        let service = Fake::default();

        let first = sandbox.found(&nothing());
        assert_eq!(
            sandbox.found(&nothing()),
            first,
            "the same transcript regenerates the same chunk numbers, whenever it is read"
        );
        send(&service, &first, ACCOUNT, |_, _| {}).unwrap();
        let once = service.rollup();

        let again = sandbox.found(&service.on_record());
        send(&service, &again, ACCOUNT, |session_id, sent| {
            assert_eq!(sent.events, 0, "{session_id} had tokens left to send")
        })
        .unwrap();

        assert_eq!(service.rollup(), once, "a second run adds nothing to the rollup");
        assert_eq!(
            *service.ended.borrow(),
            vec!["s-old".to_string()],
            "and writes no history row a second time"
        );
    }

    #[test]
    fn a_session_on_record_owes_the_delegated_turns_nothing_ever_counted_and_nothing_else() {
        let sandbox = Sandbox::new("recovered");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        let service = Fake::default();
        // The run a host made before a delegated turn was ever read: its own transcript counted,
        // and the service left holding the session on record.
        send(&service, &sandbox.found(&nothing()), ACCOUNT, |_, _| {}).unwrap();
        assert_eq!(spent(&service, "claude-opus-4"), 150);
        sandbox.subagent("-home-you-recall", "s-old", "agent-7f21", &delegated());

        send(&service, &sandbox.found(&service.on_record()), ACCOUNT, |_, _| {}).unwrap();

        assert_eq!(
            spent(&service, "claude-opus-4"),
            850,
            "the delegated turn is counted and the session's own transcript is not counted again"
        );
        let recovered = service.rollup();
        send(
            &service,
            &sandbox.found(&service.on_record()),
            ACCOUNT,
            |session_id, sent| assert_eq!(sent.events, 0, "{session_id} had tokens left to send"),
        )
        .unwrap();
        assert_eq!(service.rollup(), recovered, "and the run after it owes nothing at all");
    }

    #[test]
    fn a_delegated_turn_the_hooks_counted_as_it_ran_is_never_counted_again() {
        let sandbox = Sandbox::new("livecounted");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        sandbox.subagent("-home-you-recall", "s-old", "agent-7f21", &delegated());
        let service = Fake::default();
        // A session that ran under hooks that read every file: the service holds the session and
        // both of its files counted, at chunk numbers of the hooks' own.
        service.history.borrow_mut().insert("s-old".to_string());
        for file in ["main", "agent-7f21"] {
            service
                .counted
                .borrow_mut()
                .insert(("s-old".to_string(), file.to_string()));
        }
        *service
            .daily
            .borrow_mut()
            .entry((day(1_790_850_605_000), "claude-opus-4".to_string()))
            .or_default() += 850;
        let counted = service.rollup();

        send(
            &service,
            &sandbox.found(&service.on_record()),
            ACCOUNT,
            |session_id, sent| assert_eq!(sent.events, 0, "{session_id} had tokens left to send"),
        )
        .unwrap();

        assert_eq!(
            service.rollup(),
            counted,
            "a file the hooks counted is one this run owes nothing for, whatever numbers they used"
        );
    }

    #[test]
    fn a_reading_that_arrives_twice_lands_on_the_rows_the_service_already_holds() {
        let sandbox = Sandbox::new("replay");
        sandbox.transcript("-home-you-recall", "s-old", &session());
        sandbox.subagent("-home-you-recall", "s-old", "agent-7f21", &delegated());
        let service = Fake::default();
        let found = sandbox.found(&nothing());

        send(&service, &found, ACCOUNT, |_, _| {}).unwrap();
        let once = service.rollup();
        // A run that died before the history row landed sends the same session again.
        send(&service, &found, ACCOUNT, |_, _| {}).unwrap();

        assert_eq!(
            spent(&service, "claude-opus-4"),
            850,
            "the session and its delegated turn"
        );
        assert_eq!(
            service.rollup(),
            once,
            "and the second reading is every chunk number the first one spent"
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
            vec![
                (BACKFILL_BASE, 1_790_848_810_000, 100),
                (BACKFILL_BASE + 1, 1_790_935_210_000, 200)
            ],
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

        let resumed = Fake::resuming(&dying);
        let again = sandbox.found(&resumed.on_record());
        assert_eq!(again, first, "nothing is on record, so the same session is sent again");
        send(&resumed, &again, ACCOUNT, |_, _| {}).unwrap();

        assert_eq!(
            *resumed.events.borrow(),
            posted,
            "the service holds bytes of that file, so its tokens were counted and are not posted again"
        );
        assert_eq!(resumed.on_record(), on_record(&["s-old"]));
        assert_eq!(*resumed.ended.borrow(), vec!["s-old".to_string()]);

        let caught_up = resumed.rollup();
        let after = sandbox.found(&resumed.on_record());
        send(&resumed, &after, ACCOUNT, |session_id, sent| {
            assert_eq!(sent, Sent::default(), "{session_id} had something left to send");
        })
        .unwrap();
        assert_eq!(
            resumed.rollup(),
            caught_up,
            "and the run after it has nothing left to send"
        );
        assert_eq!(*resumed.ended.borrow(), vec!["s-old".to_string()]);
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
                .map(|part| part.source.file.as_str())
                .collect::<Vec<_>>(),
            vec!["main", "agent-7f21"]
        );
        let own = found[0].parts[0].events(ACCOUNT, 2).unwrap();
        let delegated = found[0].parts[1].events(ACCOUNT, 0).unwrap();
        assert_eq!(
            own[0]["seq"], BACKFILL_BASE,
            "the session's own transcript takes the first block"
        );
        assert!(
            delegated[0]["seq"].as_i64().unwrap() >= BACKFILL_BASE + SPANS_PER_FILE,
            "and a delegated turn is numbered in a block of its own: {}",
            delegated[0]["seq"]
        );
        assert_eq!(delegated[0]["prompts"], 0, "no prompt is counted twice for it");
    }

    #[test]
    fn the_block_a_file_is_numbered_in_comes_from_its_name_and_never_moves() {
        let early = block("agent-0000");
        let late = block("agent-zzzz");

        assert_eq!(
            block("main"),
            0,
            "the session's own transcript is always the first block"
        );
        assert_eq!(
            block("agent-zzzz"),
            late,
            "a name gives the same block every time it is read"
        );
        assert_ne!(early, late);
        assert!(
            [early, late].iter().all(|block| *block > 0 && *block < BLOCKS),
            "every block fits the numbers a chunk number may take: {early}, {late}"
        );
        assert_eq!(
            block("agent-zzzz"),
            late,
            "and a file that joins the set later moves no block but its own"
        );
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
