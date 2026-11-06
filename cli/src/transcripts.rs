//! The files one Claude Code session writes, and the stretches of them this host has not sent.
//!
//! A session's own transcript sits at `<project>/<session id>.jsonl`, and every delegated turn
//! gets a file of its own under `<project>/<session id>/subagents/`. Those carry most of what a
//! session spends, so the set, not the one file, is what both the archive and the usage counter
//! read; `hooks/usage.mjs` enumerates the same set for the counting it does.
//!
//! A tool output too large to sit in a turn is written to a file of its own under the session's
//! `tool-results/`, and the turn points at it by the path it has there. Those go up with the rest:
//! a session read back without them is one whose turns point at nothing.
//!
//! The service has no append, so a file is sent as a run of stretches, each one starting where the
//! file already ends there. The service takes a stretch wherever it is offered and answers where
//! the file reaches once that stretch is in it, so this host carries its own position and asks the
//! service only about a session it has no position for — a daemon's first pass over one, and never
//! again while that daemon runs. The answer is counted off the stored objects, the only reading
//! that cannot lag; everything else the service holds about a file is derived behind it.
//!
//! Every stretch is redacted on its way out, so a secret a session printed is never sent at all. A
//! placeholder is not the length of what it stands in, so where a file reaches on disk and where
//! its archive reaches are two numbers and a pass carries both. The service answers with the one
//! it keeps, and the file is what says where that falls in it — a reading of the file, which only
//! a pass that has lost its place pays for.
//!
//! The position is kept apart from the mark the usage counter keeps in the session record, so
//! moving either can neither skip nor replay the other.

use crate::redact;
use anyhow::{Context, Result};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The name a session's own transcript is sent under. A delegated turn goes under its own file
/// name, which Claude Code writes as `agent-<id>.jsonl`.
pub const MAIN: &str = "main";

/// What the name of a persisted tool output opens with. The rest of the name is the one Claude
/// Code gave the file, which is what the turn pointing at it holds, so a restore can put it back
/// under the path that turn reads.
pub const TOOL_RESULT: &str = "tool-results.";

/// The largest stretch one call carries; mirrors MAX_CHUNK_BYTES in src/transcripts.ts. A
/// transcript of any size goes up as a run of these rather than in one body.
pub const MAX_CHUNK: usize = 1_048_576;

const NEWLINE: u8 = b'\n';

/// What a file of a session holds. A file of turns is what the usage readers parse; a tool output
/// is bytes a turn pointed at, which they never read and which no token was ever spent on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holds {
    Turns,
    Output,
}

/// One file of one session, under the name the service holds it by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub file: String,
    pub path: PathBuf,
    pub size: i64,
    pub holds: Holds,
}

fn size_of(path: &Path) -> i64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0)
}

/// Where a session's own directory sits, beside its transcript and named for it.
fn beside(transcript: &Path) -> Option<PathBuf> {
    let stem = transcript.file_stem()?;
    Some(transcript.parent()?.join(stem))
}

/// The names the service takes hold at most 101 bytes of letters, digits and `. _ -`, and a tool
/// output Claude Code did not name within that is one this host cannot send under a name a restore
/// could read back.
fn nameable(stem: &str) -> bool {
    !stem.is_empty()
        && stem.len() + TOOL_RESULT.len() <= 101
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// The files of one kind one session wrote, in name order. A session that delegated nothing and
/// one that persisted no output have no directory for either, which is the common case and no
/// error. A directory that is there and cannot be read is one: it is exactly the undercount this
/// reader exists to end, and answering with the session's own transcript alone would hide it.
fn under(dir: &Path, extension: &str, holds: Holds) -> Result<Vec<Source>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("reading {}", dir.display())),
    };
    let mut found = Vec::new();
    for entry in entries {
        let path = entry.with_context(|| format!("reading {}", dir.display()))?.path();
        if path.extension() != Some(OsStr::new(extension)) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let file = match holds {
            Holds::Turns => stem.to_string(),
            Holds::Output if nameable(stem) => format!("{TOOL_RESULT}{stem}"),
            Holds::Output => continue,
        };
        let size = size_of(&path);
        found.push(Source {
            file,
            path,
            size,
            holds,
        });
    }
    found.sort_by(|left, right| left.file.cmp(&right.file));
    Ok(found)
}

/// Every file one session writes: its own first, then the delegated turns, then the tool outputs
/// it persisted, each set in name order.
pub fn sources(transcript: &Path) -> Result<Vec<Source>> {
    let mut found = vec![Source {
        file: MAIN.to_string(),
        path: transcript.to_path_buf(),
        size: size_of(transcript),
        holds: Holds::Turns,
    }];
    let Some(dir) = beside(transcript) else {
        return Ok(found);
    };
    found.extend(under(&dir.join("subagents"), "jsonl", Holds::Turns)?);
    found.extend(under(&dir.join("tool-results"), "txt", Holds::Output)?);
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

/// What an append answers: where the file reaches afterwards, and whether these bytes are what
/// put it there. A stretch beaten to its offset is refused, and the file then reaches where the
/// writer that got there first left it — which is still where the next stretch goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appended {
    Written(i64),
    Refused(i64),
}

/// What the service answers about one session's files, and what it takes.
pub trait Store {
    fn held(&self, session_id: &str) -> Result<Held>;
    fn append(&self, session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<Appended>;
}

/// The bytes of one file past `offset`, at most `MAX_CHUNK` and cut back to the last complete line
/// they hold, and whether the file ends inside them. A line longer than the whole stretch is read
/// as it stands: the archive is a concatenation of byte ranges, so a line split across two
/// stretches still reads whole.
struct Bytes {
    read: Vec<u8>,
    whole: bool,
}

fn read_at(path: &Path, offset: i64) -> Result<Bytes> {
    let mut file = std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    file.seek(SeekFrom::Start(offset as u64))
        .with_context(|| format!("reading {} from {offset}", path.display()))?;
    let mut read = Vec::new();
    file.take(MAX_CHUNK as u64)
        .read_to_end(&mut read)
        .with_context(|| format!("reading {}", path.display()))?;
    if read.len() < MAX_CHUNK {
        return Ok(Bytes { read, whole: true });
    }
    if let Some(last) = read.iter().rposition(|byte| *byte == NEWLINE) {
        read.truncate(last + 1);
    }
    Ok(Bytes { read, whole: false })
}

/// How far one file has been sent: where in the file on disk the bytes that went up end, and where
/// the archive of it ends once they are in it. Redaction writes a secret out as a placeholder of
/// another length, so the two part company and neither stands in for the other.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sent {
    pub source: i64,
    pub archive: i64,
}

/// One stretch as it goes up: the bytes, and how much of the file they account for.
struct Stretch {
    bytes: Vec<u8>,
    source: i64,
}

fn stretch(path: &Path, offset: i64) -> Result<Stretch> {
    let read = read_at(path, offset)?;
    let redacted = redact::redact(&read.read, read.whole);
    Ok(Stretch {
        bytes: redacted.bytes,
        source: redacted.source as i64,
    })
}

/// Where in the file the archive's end falls, read off the file itself. What the service holds is
/// the file redacted, so its end says nothing by itself about where to read from next; what it
/// does say is that the file redacts to exactly those bytes, and reading it again from nothing
/// finds the place that produced them. The end a refused stretch answers with was reached by a
/// writer that read the file at another instant, so it may fall inside a stretch this pass would
/// cut whole, and the piece it lands in is what places it.
///
/// A file that no longer redacts to what the archive holds is not that file any more: a transcript
/// rewritten or truncated under it. Nothing is spliced onto the stretches already written, since
/// the offsets they are keyed by no longer describe anything in the new file and a splice would
/// read as lines the session never wrote. `hooks/usage.mjs` reads the same shape the same way,
/// counting the new file from its end rather than counting the old one over again.
fn resume(path: &Path, archive: i64) -> Result<Option<Sent>> {
    let mut at = Sent::default();
    while at.archive < archive {
        let read = read_at(path, at.source)?;
        let redacted = redact::redact(&read.read, read.whole);
        if redacted.source == 0 {
            return Ok(None);
        }
        let end = at.archive + redacted.bytes.len() as i64;
        if end > archive {
            let into = (archive - at.archive) as usize;
            return Ok(redact::source_of(&read.read, read.whole, into).map(|found| Sent {
                source: at.source + found as i64,
                archive,
            }));
        }
        at = Sent {
            source: at.source + redacted.source as i64,
            archive: end,
        };
    }
    Ok((at.archive == archive).then_some(at))
}

/// Where one file now ends, on disk and on the service, and how much of that this pass put there.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reached {
    pub sent: Sent,
    pub bytes: i64,
}

/// Sends what the service does not hold of one file, from where it says the file ends to where it
/// ends here. A file the service is already level with costs nothing, and one it has moved past is
/// left alone: this host has nothing of it left to send.
pub fn send_file(store: &impl Store, session_id: &str, source: &Source, held: i64) -> Result<Reached> {
    let Some(from) = resume(&source.path, held)? else {
        return Ok(Reached {
            sent: Sent {
                source: source.size,
                archive: held,
            },
            bytes: 0,
        });
    };
    send_from(store, session_id, source, from)
}

/// Sends what is left of one file from a place this host already holds in both the file and the
/// archive of it, so nothing is read to find it again.
fn send_from(store: &impl Store, session_id: &str, source: &Source, from: Sent) -> Result<Reached> {
    let mut at = from;
    let mut bytes = 0;
    while at.source < source.size {
        let stretch = stretch(&source.path, at.source)?;
        if stretch.source == 0 {
            break;
        }
        match store.append(session_id, &source.file, at.archive, &stretch.bytes)? {
            Appended::Written(end) => {
                bytes += stretch.bytes.len() as i64;
                at = Sent {
                    source: at.source + stretch.source,
                    archive: end,
                };
            }
            Appended::Refused(end) => {
                if end <= at.archive {
                    break;
                }
                let Some(found) = resume(&source.path, end)? else {
                    return Ok(Reached {
                        sent: Sent {
                            source: source.size,
                            archive: end,
                        },
                        bytes,
                    });
                };
                at = found;
            }
        }
    }
    Ok(Reached { sent: at, bytes })
}

/// A run of passes over the sessions on this host. It carries where each file now ends on the
/// service, which is what every append answers, so a pass over a session that has not written
/// since the one before costs no call at all and a pass that has something to send costs only the
/// writes. The service is asked about a session this run has never seen, and about no other: it
/// is the one thing this run cannot work out for itself, and the listing behind the answer is far
/// too dear to pay for on every beat.
#[derive(Debug, Default)]
pub struct Archive {
    seen: HashMap<String, HashMap<String, Sent>>,
}

/// Where the service says each of one session's files ends, placed in the files on disk. It is the
/// one reading of them a run pays for, and only for a session it has never seen.
fn placed(store: &impl Store, session_id: &str, sources: &[Source]) -> Result<HashMap<String, Sent>> {
    let archived = store.held(session_id)?.bytes;
    let mut placed = HashMap::new();
    for source in sources {
        let archive = archived.get(&source.file).copied().unwrap_or(0);
        let from = match archive {
            0 => Some(Sent::default()),
            _ => resume(&source.path, archive)?,
        };
        placed.insert(
            source.file.clone(),
            from.unwrap_or(Sent {
                source: source.size,
                archive,
            }),
        );
    }
    Ok(placed)
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
                    .all(|source| known.get(&source.file).is_some_and(|sent| sent.source >= source.size))
                {
                    return Ok(0);
                }
                known.clone()
            }
            None => placed(store, session_id, &sources)?,
        };
        let mut sent = 0;
        let mut ends = HashMap::new();
        for source in &sources {
            let from = held.get(&source.file).copied().unwrap_or_default();
            let reached = send_from(store, session_id, source, from)?;
            ends.insert(source.file.clone(), reached.sent);
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

        fn persisted(&self, session_id: &str, name: &str, text: &str) {
            let dir = self.dir.join("project").join(session_id).join("tool-results");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{name}.txt")), text).unwrap();
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The service as a host can see it: one object per stretch, keyed by where the stretch
    /// starts, which is what the store really holds. A stretch offered where one already sits is
    /// refused with where the file reaches rather than written over it, and how far a file reaches
    /// is counted off those objects, the way a listing counts it.
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

        fn append(&self, _session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<Appended> {
            if self.objects.borrow().contains_key(&(file.to_string(), offset)) {
                return Ok(Appended::Refused(self.ends().get(file).copied().unwrap_or(offset)));
            }
            self.objects
                .borrow_mut()
                .insert((file.to_string(), offset), bytes.to_vec());
            Ok(Appended::Written(offset + bytes.len() as i64))
        }
    }

    #[test]
    fn a_session_sends_its_own_transcript_every_delegated_turn_and_every_persisted_output() {
        let sandbox = Sandbox::new("sources");
        let transcript = sandbox.transcript("s-1", "one\n");
        sandbox.delegated("s-1", "agent-b", "bee\n");
        sandbox.delegated("s-1", "agent-a", "ay\n");
        sandbox.persisted("s-1", "b374nf1qv", "output\n");
        sandbox.persisted("s-1", "a92kd0slx", "more\n");

        let named: Vec<String> = sources(&transcript)
            .unwrap()
            .into_iter()
            .map(|source| source.file)
            .collect();

        assert_eq!(
            named,
            vec![
                "main",
                "agent-a",
                "agent-b",
                "tool-results.a92kd0slx",
                "tool-results.b374nf1qv"
            ],
            "the session's own file comes first, then the delegated turns and the outputs in name order"
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
    fn a_stretch_sent_again_is_refused_with_where_the_file_reaches() {
        let sandbox = Sandbox::new("replayed");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        let service = Fake::default();
        let source = sources(&transcript).unwrap().remove(0);

        assert_eq!(
            send_file(&service, "s-1", &source, 0).unwrap(),
            Reached {
                sent: Sent { source: 8, archive: 8 },
                bytes: 8
            },
            "the file reaches where the stretch ends, which the append answers without a read"
        );
        // A host that lost its place and read the file from nothing again. The stretch is refused
        // with where the file reaches, which is where this pass ends up without writing anything.
        assert_eq!(
            send_file(&service, "s-1", &source, 0).unwrap(),
            Reached {
                sent: Sent { source: 8, archive: 8 },
                bytes: 0
            },
            "a refused stretch put nothing in the archive, so the pass counts none of it"
        );

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

    const TOKEN: &str = "ghp_3kQ9fakeTOKENvalue0000000000000000";
    const PLACEHOLDER: &str = "[redacted:github-token]";

    #[test]
    fn a_secret_a_session_printed_reaches_the_service_as_a_placeholder_and_never_as_itself() {
        let sandbox = Sandbox::new("redacted");
        let transcript = sandbox.transcript("s-1", &format!("{{\"text\":\"export {TOKEN}\"}}\n"));
        sandbox.persisted("s-1", "b374nf1qv", &format!("Authorization: Bearer {TOKEN}\n"));
        let service = Fake::default();

        Archive::default().send(&service, "s-1", &transcript).unwrap();

        assert_eq!(service.body("main"), format!("{{\"text\":\"export {PLACEHOLDER}\"}}\n"));
        assert_eq!(
            service.body("tool-results.b374nf1qv"),
            "Authorization: Bearer [redacted:bearer-token]\n",
            "a persisted output goes through the same reading as the transcript that points at it"
        );
    }

    #[test]
    fn a_secret_across_the_cut_between_two_stretches_goes_up_whole_or_not_at_all() {
        let sandbox = Sandbox::new("boundary");
        // One line longer than a stretch, cut eight bytes into a token that opens a word of its
        // own: a marker running on out of the padding is part of that word and no secret at all.
        let head = "x".repeat(MAX_CHUNK - 9);
        let text = format!("{head} {TOKEN} tail\n");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = Archive::default().send(&service, "s-1", &transcript).unwrap();

        let body = service.body("main");
        assert!(!body.contains("ghp_"), "no part of the token is in the archive");
        assert_eq!(body, format!("{head} {PLACEHOLDER} tail\n"));
        assert_eq!(sent, body.len() as i64, "a pass counts the bytes it put there");
    }

    #[test]
    fn a_pass_that_lost_its_place_finds_it_in_a_file_the_archive_runs_to_another_length_than() {
        let sandbox = Sandbox::new("placed");
        let text = format!("one {TOKEN}\ntwo\n");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();
        Archive::default().send(&service, "s-1", &transcript).unwrap();
        let held = service.body("main");

        std::fs::write(&transcript, format!("{text}three\n")).unwrap();
        // A daemon restarted: it has no place of its own and takes the service's, which counts the
        // redacted bytes and so is nowhere near where the file itself reaches.
        let sent = Archive::default().send(&service, "s-1", &transcript).unwrap();

        assert_eq!(sent, 6, "only the line the session added since goes up");
        assert_eq!(service.body("main"), format!("{held}three\n"), "and it goes up once");
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
