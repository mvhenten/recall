//! The files one Claude Code session writes, and the stretches of them this host has not sent.
//!
//! A session's own transcript sits at `<project>/<session id>.jsonl`, and every delegated turn
//! gets a file of its own under `<project>/<session id>/subagents/`. Those carry most of what a
//! session spends, so the set, not the one file, is what both the archive and the usage counter
//! read; `hooks/usage.mjs` enumerates the same set for the counting it does.
//!
//! The service has no append, so a file is sent as a run of stretches, each one starting where the
//! file already ends there. The service takes a stretch wherever it is offered and answers where
//! the file reaches once that stretch is in it, so this host carries its own position and asks the
//! service only about a session it has no position for — a daemon's first pass over one, and never
//! again while that daemon runs. The answer is counted off the stored objects, the only reading
//! that cannot lag; everything else the service holds about a file is derived behind it.
//!
//! The position is kept apart from the mark the usage counter keeps in the session record, so
//! moving either can neither skip nor replay the other.

use anyhow::{Context, Result};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The name a session's own transcript is sent under. A delegated turn goes under its own file
/// name, which Claude Code writes as `agent-<id>.jsonl`.
pub const MAIN: &str = "main";

/// The largest stretch one call carries; mirrors MAX_CHUNK_BYTES in src/transcripts.ts. A
/// transcript of any size goes up as a run of these rather than in one body.
pub const MAX_CHUNK: usize = 1_048_576;

const NEWLINE: u8 = b'\n';

/// One file of one session, under the name the service holds it by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub file: String,
    pub path: PathBuf,
    pub size: i64,
}

fn size_of(path: &Path) -> i64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0)
}

/// Where a session's delegated turns are written, beside the transcript and named for it.
fn subagents(transcript: &Path) -> Option<PathBuf> {
    let stem = transcript.file_stem()?;
    Some(transcript.parent()?.join(stem).join("subagents"))
}

/// Every file one session writes, its own first and the delegated turns after it in name order.
///
/// A session that delegated nothing has no directory for them, which is the common case and no
/// error. A directory that is there and cannot be read is one: it is exactly the undercount this
/// reader exists to end, and answering with the session's own transcript alone would hide it.
pub fn sources(transcript: &Path) -> Result<Vec<Source>> {
    let mut found = vec![Source {
        file: MAIN.to_string(),
        path: transcript.to_path_buf(),
        size: size_of(transcript),
    }];
    let Some(dir) = subagents(transcript) else {
        return Ok(found);
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(found),
        Err(error) => return Err(error).with_context(|| format!("reading {}", dir.display())),
    };
    let mut delegated = Vec::new();
    for entry in entries {
        let path = entry.with_context(|| format!("reading {}", dir.display()))?.path();
        if path.extension() != Some(OsStr::new("jsonl")) {
            continue;
        }
        let Some(file) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string) else {
            continue;
        };
        let size = size_of(&path);
        delegated.push(Source { file, path, size });
    }
    delegated.sort_by(|left, right| left.file.cmp(&right.file));
    found.extend(delegated);
    Ok(found)
}

/// What the service says about one session's transcript files: how far into each one it has been
/// written, and which of them have had their tokens counted. The two move apart — a running
/// session's lines are archived on a beat of their own, with no counting pass behind them — so
/// neither ever stands in for the other.
#[derive(Debug, Default)]
pub struct Held {
    pub bytes: HashMap<String, i64>,
    pub counted: HashSet<String>,
}

/// What the service answers about one session's files, and what it takes. `append` answers where
/// the file reaches once the stretch is in it.
pub trait Store {
    fn held(&self, session_id: &str) -> Result<Held>;
    fn append(&self, session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<i64>;
}

/// The stretch of one file past `offset`, at most `MAX_CHUNK` and cut back to the last complete
/// line it holds. A line longer than the whole stretch is sent as it was read: the archive is a
/// concatenation of byte ranges, so a line split across two stretches still reads whole.
fn stretch(path: &Path, offset: i64) -> Result<Vec<u8>> {
    let mut file = std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    file.seek(SeekFrom::Start(offset as u64))
        .with_context(|| format!("reading {} from {offset}", path.display()))?;
    let mut read = Vec::new();
    file.take(MAX_CHUNK as u64)
        .read_to_end(&mut read)
        .with_context(|| format!("reading {}", path.display()))?;
    if read.len() < MAX_CHUNK {
        return Ok(read);
    }
    match read.iter().rposition(|byte| *byte == NEWLINE) {
        Some(last) => Ok(read[..=last].to_vec()),
        None => Ok(read),
    }
}

/// Where one file now ends on the service, and how much of that this pass put there.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reached {
    pub end: i64,
    pub bytes: i64,
}

/// Sends what the service does not hold of one file, from where it says the file ends to where it
/// ends here. A file the service is already level with costs nothing.
///
/// A file shorter than where the service says it ends is not that file any more: a transcript
/// rewritten or truncated under the archive. The stretches already written stay as they are and
/// nothing is spliced onto them, since the offsets they are keyed by no longer describe anything
/// in the new file and a splice would read as lines the session never wrote. `hooks/usage.mjs`
/// reads the same shape the same way, counting the new file from its end rather than counting the
/// old one over again.
pub fn send_file(store: &impl Store, session_id: &str, source: &Source, held: i64) -> Result<Reached> {
    if source.size < held {
        return Ok(Reached { end: held, bytes: 0 });
    }
    let mut at = held;
    let mut bytes = 0;
    while at < source.size {
        let stretch = stretch(&source.path, at)?;
        if stretch.is_empty() {
            break;
        }
        at = store.append(session_id, &source.file, at, &stretch)?;
        bytes += stretch.len() as i64;
    }
    Ok(Reached { end: at, bytes })
}

/// A run of passes over the sessions on this host. It carries where each file now ends on the
/// service, which is what every append answers, so a pass over a session that has not written
/// since the one before costs no call at all and a pass that has something to send costs only the
/// writes. The service is asked about a session this run has never seen, and about no other: it
/// is the one thing this run cannot work out for itself, and the listing behind the answer is far
/// too dear to pay for on every beat.
#[derive(Debug, Default)]
pub struct Archive {
    seen: HashMap<String, HashMap<String, i64>>,
}

impl Archive {
    /// Every file of one session, caught up with the service. The session's own transcript is what
    /// names the set, so a session whose record carries none sends nothing.
    pub fn send(&mut self, store: &impl Store, session_id: &str, transcript: &Path) -> Result<i64> {
        if transcript.as_os_str().is_empty() {
            return Ok(0);
        }
        let sources = sources(transcript)?;
        let held = match self.seen.get(session_id) {
            Some(known) => {
                if sources
                    .iter()
                    .all(|source| known.get(&source.file).is_some_and(|end| *end >= source.size))
                {
                    return Ok(0);
                }
                known.clone()
            }
            None => store.held(session_id)?.bytes,
        };
        let mut sent = 0;
        let mut ends = HashMap::new();
        for source in &sources {
            let reached = send_file(store, session_id, source, held.get(&source.file).copied().unwrap_or(0))?;
            ends.insert(source.file.clone(), reached.end);
            sent += reached.bytes;
        }
        self.seen.insert(session_id.to_string(), ends);
        Ok(sent)
    }

    /// Forgets the sessions this host no longer holds, so a daemon that runs for weeks does not
    /// carry every session it ever archived.
    pub fn retain(&mut self, live: &HashSet<&str>) {
        self.seen.retain(|session_id, _| live.contains(session_id.as_str()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;

    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let dir = std::env::temp_dir().join(format!("recall-transcripts-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("project")).unwrap();
            Sandbox { dir }
        }

        fn transcript(&self, session_id: &str, text: &str) -> PathBuf {
            let path = self.dir.join("project").join(format!("{session_id}.jsonl"));
            std::fs::write(&path, text).unwrap();
            path
        }

        fn delegated(&self, session_id: &str, file: &str, text: &str) {
            let dir = self.dir.join("project").join(session_id).join("subagents");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{file}.jsonl")), text).unwrap();
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The service as a host can see it: one object per stretch, keyed by where the stretch
    /// starts, which is what the store really holds. A stretch offered where one already sits
    /// overwrites it rather than landing beside it, and how far a file reaches is counted off
    /// those objects, the way a listing counts it.
    #[derive(Debug, Default)]
    struct Fake {
        objects: RefCell<HashMap<(String, i64), Vec<u8>>>,
        asked: RefCell<usize>,
    }

    impl Fake {
        fn body(&self, file: &str) -> String {
            let objects = self.objects.borrow();
            let mut stretches: Vec<_> = objects.iter().filter(|((held, _), _)| held == file).collect();
            stretches.sort_by_key(|((_, offset), _)| *offset);
            String::from_utf8(stretches.into_iter().flat_map(|(_, body)| body.clone()).collect()).unwrap()
        }

        fn ends(&self) -> HashMap<String, i64> {
            let mut ends = HashMap::new();
            for ((file, offset), body) in self.objects.borrow().iter() {
                let end = offset + body.len() as i64;
                ends.entry(file.clone())
                    .and_modify(|held| *held = end.max(*held))
                    .or_insert(end);
            }
            ends
        }
    }

    impl Store for Fake {
        fn held(&self, _session_id: &str) -> Result<Held> {
            *self.asked.borrow_mut() += 1;
            Ok(Held {
                bytes: self.ends(),
                counted: HashSet::new(),
            })
        }

        fn append(&self, _session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<i64> {
            self.objects
                .borrow_mut()
                .insert((file.to_string(), offset), bytes.to_vec());
            Ok(offset + bytes.len() as i64)
        }
    }

    #[test]
    fn a_session_sends_its_own_transcript_and_every_delegated_turn() {
        let sandbox = Sandbox::new("sources");
        let transcript = sandbox.transcript("s-1", "one\n");
        sandbox.delegated("s-1", "agent-b", "bee\n");
        sandbox.delegated("s-1", "agent-a", "ay\n");

        let named: Vec<String> = sources(&transcript)
            .unwrap()
            .into_iter()
            .map(|source| source.file)
            .collect();

        assert_eq!(
            named,
            vec!["main", "agent-a", "agent-b"],
            "the session's own file comes first and the delegated turns in name order"
        );
    }

    #[test]
    fn a_pass_sends_only_what_the_service_does_not_hold() {
        let sandbox = Sandbox::new("resume");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        sandbox.delegated("s-1", "agent-a", "ay\n");
        let service = Fake::default();
        let mut archive = Archive::default();

        assert_eq!(archive.send(&service, "s-1", &transcript).unwrap(), 11);
        std::fs::write(&transcript, "one\ntwo\nthree\n").unwrap();
        assert_eq!(archive.send(&service, "s-1", &transcript).unwrap(), 6);

        assert_eq!(service.body("main"), "one\ntwo\nthree\n");
        assert_eq!(service.body("agent-a"), "ay\n");
        assert_eq!(
            archive.send(&service, "s-1", &transcript).unwrap(),
            0,
            "a pass over a transcript that has not grown sends nothing"
        );
        assert_eq!(service.body("main"), "one\ntwo\nthree\n", "no line is written twice");
    }

    #[test]
    fn a_pass_over_a_session_that_has_not_written_costs_no_call() {
        let sandbox = Sandbox::new("quiet");
        let transcript = sandbox.transcript("s-1", "one\n");
        let service = Fake::default();
        let mut archive = Archive::default();

        archive.send(&service, "s-1", &transcript).unwrap();
        let asked = *service.asked.borrow();
        for _ in 0..20 {
            assert_eq!(archive.send(&service, "s-1", &transcript).unwrap(), 0);
        }

        assert_eq!(
            *service.asked.borrow(),
            asked,
            "a short beat over quiet sessions is free, so only a session writing costs anything"
        );
        std::fs::write(&transcript, "one\ntwo\n").unwrap();
        assert_eq!(archive.send(&service, "s-1", &transcript).unwrap(), 4);
        assert_eq!(
            *service.asked.borrow(),
            asked,
            "a session this run already placed is never asked about again, however much it writes"
        );

        archive.retain(&HashSet::new());
        archive.send(&service, "s-1", &transcript).unwrap();
        assert_eq!(
            *service.asked.borrow(),
            asked + 1,
            "a session forgotten is asked about once, and that is the only call the listing pays for"
        );
    }

    #[test]
    fn a_stretch_sent_again_lands_on_itself_rather_than_beside_itself() {
        let sandbox = Sandbox::new("replayed");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        let service = Fake::default();
        let source = sources(&transcript).unwrap().remove(0);

        assert_eq!(
            send_file(&service, "s-1", &source, 0).unwrap(),
            Reached { end: 8, bytes: 8 },
            "the file reaches where the stretch ends, which the append answers without a read"
        );
        // A host that lost its place and read the file from nothing again, which is the whole of
        // what a replay looks like now that no offset is claimed.
        send_file(&service, "s-1", &source, 0).unwrap();

        assert_eq!(service.body("main"), "one\ntwo\n", "no line is written twice");
    }

    #[test]
    fn a_transcript_rewritten_shorter_is_left_where_it_is_rather_than_spliced() {
        let sandbox = Sandbox::new("truncated");
        let transcript = sandbox.transcript("s-1", "one\ntwo\nthree\n");
        let service = Fake::default();
        let mut archive = Archive::default();
        archive.send(&service, "s-1", &transcript).unwrap();

        std::fs::write(&transcript, "other\n").unwrap();

        assert_eq!(
            archive.send(&service, "s-1", &transcript).unwrap(),
            0,
            "a file shorter than where the service says it ends is another file"
        );
        assert_eq!(
            service.body("main"),
            "one\ntwo\nthree\n",
            "the stretches already written are left alone, never spliced onto at an offset the new file has no line at"
        );
    }

    #[test]
    fn a_directory_of_delegated_turns_that_cannot_be_read_fails_rather_than_counting_none() {
        let sandbox = Sandbox::new("unreadable");
        let transcript = sandbox.transcript("s-1", "one\n");
        sandbox.delegated("s-1", "agent-a", "ay\n");
        let dir = sandbox.dir.join("project").join("s-1").join("subagents");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();

        let refused = sources(&transcript);

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = format!(
            "{:#}",
            refused.expect_err("an unreadable directory is not an empty one")
        );
        assert!(error.contains("subagents"), "{error}");
        assert_eq!(
            sources(&transcript).unwrap().len(),
            2,
            "and a directory that can be read again names its files"
        );
    }

    #[test]
    fn a_long_transcript_goes_up_a_stretch_at_a_time_and_reads_back_whole() {
        let sandbox = Sandbox::new("chunks");
        let line = format!("{}\n", "x".repeat(999));
        let text = line.repeat(3000);
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = Archive::default().send(&service, "s-1", &transcript).unwrap();

        assert_eq!(sent, text.len() as i64);
        assert_eq!(service.body("main"), text, "the stretches concatenate to the file");
    }
}
