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
//! The service has no append, so a file is sent as a run of stretches, each one named by where it
//! begins in the file and where it ends there. The service takes a stretch wherever it is offered
//! and answers how far into the file the archive reaches once that stretch is in it, so this host
//! carries one position per file and asks the service only about a session it has no position for
//! — a daemon's first pass over one, and never again while that daemon runs. The answer is counted
//! off the stored objects, the only reading that cannot lag; everything else the service holds
//! about a file is derived behind it.
//!
//! Every stretch is redacted on its way out, so a secret a session printed is never sent at all. A
//! placeholder is not the length of what it stands in, so a stretch runs to a different length
//! than the bytes it was read from — but every position either side names a place in the file on
//! disk, so there is nothing to map and nothing to read the file twice for.
//!
//! That holds only of a key that names both ends. v0.15.0 and v0.16.0 redacted and still stored a
//! stretch under one offset, which there is a place in the archive, so a reach read off one of
//! those keys is no place in the file and reading the file at it would leave the bytes between in
//! no object at all. The service says which keys a reach rests on and a pass weighs the unproven
//! kind against the file before it reads anything at it, so that reach stops the pass rather than
//! moving it. Those two releases must never be installed on a host: a host goes from 0.14.0 or
//! earlier straight to the release that keys both ends.
//!
//! A stretch of a file of turns is cut back to the last complete line it holds, the way
//! `hooks/usage.mjs` cuts the same files, so a record half written is never sent as the half of it
//! this host can see and a secret half written is never sent as the half of itself that is not one
//! yet. That holds for the pass that ends a session too: the archive of a file of turns always
//! ends on a record boundary, so a session resumed on the same file carries on from the start of a
//! record and no secret is ever completed by the stretch that follows the one it began in. A tool
//! output has no records and no lines to keep whole, so a stretch of one is every byte read.
//! Whether a file ends for good where it ends now is the caller's to say and nothing this reader
//! can work out: only a session that has ended writes nothing more.
//!
//! A stretch goes up gzipped, and the compression runs after the redaction and never before: the
//! scanner reads bytes, and nothing of a compressed stretch reads as the secret it holds. The
//! member is stored as it stands, so what a restore inflates is the bytes this host read, to the
//! byte. A transcript is prose and JSON, so under a third of them go over the wire.
//!
//! The position is kept apart from the mark the usage counter keeps in the session record, so
//! moving either can neither skip nor replay the other.

use crate::redact;
use anyhow::{Context, Result, bail};
use flate2::{Compression, write::GzEncoder};
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

/// The largest stretch one call carries; mirrors MAX_STRETCH_BYTES in src/transcripts.ts. A
/// transcript of any size goes up as a run of these rather than in one body.
pub const MAX_STRETCH: usize = 1_048_576;

const NEWLINE: u8 = b'\n';

/// What a file of a session holds. A file of turns is what the usage readers parse; a tool output
/// is bytes a turn pointed at, which they never read and which no token was ever spent on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holds {
    Turns,
    Output,
}

/// Whether this pass is the last one over a session's files. Only a caller that knows the session
/// has ended can say so, and nothing else may: a file that merely ends where this host has read to
/// is one a session is still writing, and the bytes that would finish the record — or the secret —
/// at the end of it are the next thing it writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    /// A session still running, or one this host cannot say has stopped.
    Open,
    /// A session that writes nothing more, so the end of each of its files is the end for good.
    Final,
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

/// The names the service takes open with a letter or a digit and hold at most 101 bytes of
/// letters, digits and `. _ -`; mirrors TRANSCRIPT_FILE in src/model.ts. It is the name this host
/// sends under that has to pass, not the stem it was built from.
fn nameable(file: &str) -> bool {
    let mut bytes = file.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        && file.len() <= 101
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// What one file of a session is sent under, and nothing for a name this host cannot send: one the
/// service would refuse, and one a delegated turn would land under in another file's place —
/// `tool-results.x.jsonl` would restore as the tool output `tool-results/x.txt`, and a turn named
/// `main` as the session's own transcript.
fn named(stem: &str, holds: Holds) -> Option<String> {
    let file = match holds {
        Holds::Turns => stem.to_string(),
        Holds::Output => format!("{TOOL_RESULT}{stem}"),
    };
    if !nameable(&file) {
        return None;
    }
    if holds == Holds::Turns && (file == MAIN || file.starts_with(TOOL_RESULT)) {
        return None;
    }
    Some(file)
}

/// The files one session wrote, and the ones among them this host can send nothing of.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sources {
    /// The session's own transcript first, then the delegated turns, then the tool outputs it
    /// persisted, each set in name order.
    pub found: Vec<Source>,
    /// Files named what the service would refuse, or what another of this session's files is held
    /// under. Nothing this host could send them as would restore to the path the turns pointing at
    /// them read, so the caller is told which they are rather than left with a session archived
    /// without them and nothing saying so.
    pub unsendable: Vec<PathBuf>,
}

/// The files of one kind one session wrote. A session that delegated nothing and one that
/// persisted no output have no directory for either, which is the common case and no error. A
/// directory that is there and cannot be read is one: it is exactly the undercount this reader
/// exists to end, and answering with the session's own transcript alone would hide it.
fn under(dir: &Path, extension: &str, holds: Holds, into: &mut Sources) -> Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("reading {}", dir.display())),
    };
    let mut found = Vec::new();
    for entry in entries {
        let path = entry.with_context(|| format!("reading {}", dir.display()))?.path();
        if path.extension() != Some(OsStr::new(extension)) {
            continue;
        }
        // A name that is not UTF-8 and one the service would refuse are the same thing here:
        // nothing this host can hold the file by.
        let sendable = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| named(stem, holds));
        let Some(file) = sendable else {
            into.unsendable.push(path);
            continue;
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
    into.found.extend(found);
    Ok(())
}

/// Every file one session writes, and whichever of them this host has no name for.
pub fn sources(transcript: &Path) -> Result<Sources> {
    let mut found = Sources {
        found: vec![Source {
            file: MAIN.to_string(),
            path: transcript.to_path_buf(),
            size: size_of(transcript),
            holds: Holds::Turns,
        }],
        unsendable: Vec::new(),
    };
    let Some(dir) = beside(transcript) else {
        return Ok(found);
    };
    under(&dir.join("subagents"), "jsonl", Holds::Turns, &mut found)?;
    under(&dir.join("tool-results"), "txt", Holds::Output, &mut found)?;
    Ok(found)
}

/// How far into one file on disk the archive reaches, and whether every key behind that number
/// names both ends of the span of the file it holds.
///
/// A key of one segment names one number, and only a host that did not redact meant a place in the
/// file by it: v0.15.0 and v0.16.0 redacted and still wrote one, and there the number is a place in
/// the archive over a body of another length than the span it accounts for. So a reach `named` is
/// false for is one nothing proves is a place in the file, and a pass told one the file on disk
/// disagrees with bails rather than reading the file at it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reach {
    pub through: i64,
    pub named: bool,
}

/// What the service says about one session's transcript files: how far into each one the archive
/// reaches, and which of them have had their tokens counted. The two move apart — a running
/// session's lines are archived on a beat of their own, with no counting pass behind them — so
/// neither ever stands in for the other.
#[derive(Debug, Default)]
pub struct Held {
    pub reach: HashMap<String, Reach>,
    pub counted: HashSet<String>,
}

/// What an append answers: how far into the file the archive reaches afterwards, and whether these
/// bytes are what put it there. A stretch beaten to its place is refused, and the archive then
/// reaches where the writer that got there first left it — which is still where the next stretch
/// begins, on the same terms the reach a pass opened with came on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appended {
    Written(i64),
    Refused(Reach),
}

/// What the service answers about one session's files, and what it takes. A stretch is offered as
/// the span of the file it accounts for — `from` to `through` — and the bytes that span redacts to.
pub trait Store {
    fn held(&self, session_id: &str) -> Result<Held>;
    fn append(&self, session_id: &str, file: &str, from: i64, through: i64, bytes: &[u8]) -> Result<Appended>;
}

/// The bytes of one file past `offset`, at most `MAX_STRETCH` and cut back to the last complete line
/// they hold. A line longer than the whole stretch is read as it stands: the archive is a
/// concatenation of byte ranges, so a line split across two stretches still reads whole.
struct Bytes {
    /// The byte of the file in front of the stretch, and nothing where the stretch starts at the
    /// file's first byte. It is what says whether a marker at the head of the stretch opens a
    /// word of its own.
    before: Option<u8>,
    read: Vec<u8>,
    /// Whether these bytes are the last bytes of the file, and no byte will ever follow them. A
    /// file that merely ends where this read reached is one a session may still be writing, so
    /// only a final pass can say so; a read cut back to the last record it holds has the rest of
    /// that record still to come, whatever the pass.
    whole: bool,
    /// Whether the read filled a whole stretch. One that did and still carries no record this
    /// host can send is a file no further reading moves, which is a fault and not a wait.
    full: bool,
}

/// One stretch of a file. A file of records is cut the way `hooks/usage.mjs` cuts the same files:
/// back to the last complete line, so a record still being written is never sent as the half of it
/// this host can see. An unterminated tail is not a record, and holding it back costs nothing: the
/// pass after this one takes it whole, and a session that never writes the rest of it leaves a
/// fragment no reader could have parsed anyway.
///
/// The final pass cuts it too, which is what keeps the archive of a file of turns ending on a
/// record boundary. A session resumed on that file then carries on from the start of a record, so
/// a secret the session was half way through writing is never completed by the stretch that
/// follows the one holding the front of it.
///
/// A tool output holds no records, so there is no half of one to hold back and every byte read of
/// it is a byte to send. One that never ends in a line break would otherwise wait for the final
/// pass, and the beat that exists to carry a long turn's bytes up while it runs would never reach
/// it at all.
fn read_at(path: &Path, offset: i64, pass: Pass, holds: Holds) -> Result<Bytes> {
    let mut file = std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut before = None;
    if offset > 0 {
        file.seek(SeekFrom::Start((offset - 1) as u64))
            .with_context(|| format!("reading {} from {offset}", path.display()))?;
        let mut lead = [0_u8; 1];
        if file
            .read(&mut lead)
            .with_context(|| format!("reading {}", path.display()))?
            == 1
        {
            before = Some(lead[0]);
        }
    }
    file.seek(SeekFrom::Start(offset as u64))
        .with_context(|| format!("reading {} from {offset}", path.display()))?;
    let mut read = Vec::new();
    file.by_ref()
        .take(MAX_STRETCH as u64)
        .read_to_end(&mut read)
        .with_context(|| format!("reading {}", path.display()))?;
    let full = read.len() == MAX_STRETCH;
    // A line longer than a whole stretch is read as it stands; one shorter than that is a record
    // the session is still writing, and what is held back of it is what says the bytes in hand are
    // not the last of the file.
    let mut cut = false;
    if holds == Holds::Turns && !full {
        let keep = match read.iter().rposition(|byte| *byte == NEWLINE) {
            Some(last) => last + 1,
            None => 0,
        };
        cut = keep < read.len();
        read.truncate(keep);
    }
    let whole = !full && !cut && pass == Pass::Final;
    Ok(Bytes {
        before,
        read,
        whole,
        full,
    })
}

/// One stretch as it goes up: the bytes, and how much of the file they account for. A stretch that
/// accounts for nothing is one this pass cannot send: either the file holds no complete record
/// past the offset yet, or a whole stretch of it reads as one unfinished secret.
enum Stretch {
    Holding(Vec<u8>, i64),
    /// The file holds nothing past the offset that this pass can send, and the next pass may.
    Waiting,
}

/// One stretch as the service takes it: a body of at most `MAX_STRETCH` bytes. The source is read to
/// that and no further, but a placeholder is longer than most of what it stands in, so the stretch
/// is written out to the length the service accepts and accounts for however much of the file that
/// came to. Offering a longer body is a 413 the pass cannot act on and a stretch no later pass can
/// get past either.
fn stretch(path: &Path, offset: i64, pass: Pass, holds: Holds) -> Result<Stretch> {
    let read = read_at(path, offset, pass, holds)?;
    let redacted = redact::within(&read.read, read.before, read.whole, MAX_STRETCH);
    if redacted.source > 0 {
        return Ok(Stretch::Holding(redacted.bytes, redacted.source as i64));
    }
    // A whole stretch that redacts to nothing is a secret longer than one stretch, and no reading
    // of this file ever gets past it: the next pass reads the same bytes and holds them back
    // again. Every other empty answer is a record still being written.
    if read.full {
        bail!(
            "{} holds a secret longer than a stretch at {offset}, so nothing of it past there can be archived",
            path.display()
        );
    }
    Ok(Stretch::Waiting)
}

/// One stretch's bytes as they go up: one gzip member of the redacted bytes. The member is what the
/// archive stores and what a restore inflates, so this is the only place a transcript's bytes are
/// turned into anything, and it runs over what the scanner has already been through.
pub fn packed(bytes: &[u8]) -> Result<Vec<u8>> {
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).context("gzipping a transcript stretch")?;
    encoder.finish().context("gzipping a transcript stretch")
}

/// How far into one file the archive reaches now, and how much of that this pass put there.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reached {
    pub reach: Reach,
    pub bytes: i64,
}

/// Sends what is left of one file from the place in it the archive already reaches, so nothing is
/// read to find that place again. A file the service is already level with costs nothing, and one
/// keyed by both ends that the archive has moved past is left alone: another host archived more of
/// the same session, and this one has nothing of it left to send.
///
/// A reach no key proves is a place in the file is weighed against the file itself before anything
/// is read at it. One past the end of the file is the answer a host that redacted and still wrote
/// one offset leaves behind, and acting on it would read the file at a byte that is not where the
/// archive stopped: the bytes between would go into no object and the archive would concatenate
/// across the gap without a word. So it stops the pass and says so.
pub fn send_from(store: &impl Store, session_id: &str, source: &Source, from: Reach, pass: Pass) -> Result<Reached> {
    let mut reach = from;
    let mut bytes = 0;
    loop {
        if !reach.named && reach.through > source.size {
            bail!(
                "the archive of {} of session {session_id} reaches {} bytes into a file this host holds {} of, under a key of one offset that no reading can place in the file; nothing more of it is sent",
                source.file,
                reach.through,
                source.size
            );
        }
        if reach.through >= source.size {
            break;
        }
        let at = reach.through;
        let Stretch::Holding(sent, span) = stretch(&source.path, at, pass, source.holds)? else {
            break;
        };
        match store.append(session_id, &source.file, at, at + span, &sent)? {
            Appended::Written(through) => {
                bytes += sent.len() as i64;
                reach = Reach { through, named: true };
            }
            Appended::Refused(refused) => {
                // The writer that reached the place first says how far the archive reaches now,
                // and a refusal answering with a place this pass is already at or past says
                // nothing the pass can act on: it would offer the same stretch again.
                if refused.through <= at {
                    bail!(
                        "the archive refused a stretch of {} of session {session_id} at {at} and answered that it reaches {}",
                        source.file,
                        refused.through
                    );
                }
                reach = refused;
            }
        }
    }
    Ok(Reached { reach, bytes })
}

/// A run of passes over the sessions on this host. It carries how far into each file the archive
/// reaches, which is what every append answers, so a pass over a session that has not written
/// since the one before costs no call at all and a pass that has something to send costs only the
/// writes. The service is asked about a session this run has never seen, and about no other: it
/// is the one thing this run cannot work out for itself, and the listing behind the answer is far
/// too dear to pay for on every beat.
#[derive(Debug, Default)]
pub struct Archive {
    seen: HashMap<String, HashMap<String, Reach>>,
}

impl Archive {
    /// Every file of one session, caught up with the service. The session's own transcript is what
    /// names the set, so a session whose record carries none sends nothing.
    ///
    /// A file this host has no name for is named to the caller once this run, after the rest of
    /// the session has gone up. The name is nothing a later pass changes, so answering on every
    /// beat would say the same thing for as long as the session runs and hold back the files the
    /// session is still writing for exactly as long.
    pub fn send(&mut self, store: &impl Store, session_id: &str, transcript: &Path, pass: Pass) -> Result<i64> {
        if transcript.as_os_str().is_empty() {
            return Ok(0);
        }
        let sources = sources(transcript)?;
        // How far into each of this session's files the service says the archive reaches. It is
        // the one call a run pays for, and only for a session it has never seen.
        let held = match self.seen.get(session_id) {
            Some(known) => {
                if sources.found.iter().all(|source| {
                    known
                        .get(&source.file)
                        .is_some_and(|reach| reach.through >= source.size)
                }) {
                    return Ok(0);
                }
                known.clone()
            }
            None => store.held(session_id)?.reach,
        };
        let first = !self.seen.contains_key(session_id);
        let mut sent = 0;
        let mut ends = HashMap::new();
        for source in &sources.found {
            let from = held.get(&source.file).copied().unwrap_or(Reach {
                through: 0,
                named: true,
            });
            let reached = send_from(store, session_id, source, from, pass)?;
            ends.insert(source.file.clone(), reached.reach);
            sent += reached.bytes;
        }
        self.seen.insert(session_id.to_string(), ends);
        if first && !sources.unsendable.is_empty() {
            let named: Vec<String> = sources
                .unsendable
                .iter()
                .map(|path| path.display().to_string())
                .collect();
            bail!(
                "session {session_id} holds files named what this host cannot send a transcript file under, so no part of them is archived: {}",
                named.join(", ")
            );
        }
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
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let dir = crate::scratch(&format!("transcripts-{name}"));
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

    /// The service as a host can see it: one object per stretch, keyed by the span of the file the
    /// stretch accounts for, which is what the store really holds. A stretch is taken only where
    /// the archive reaches exactly the place in the file it begins at, and every other one is
    /// refused with that reach — the way the service weighs an append against its own listing.
    #[derive(Debug, Default)]
    struct Fake {
        objects: RefCell<HashMap<(String, i64, i64), Vec<u8>>>,
        asked: RefCell<usize>,
        offered: RefCell<usize>,
    }

    impl Fake {
        /// The stretches of one file in the order the file puts them.
        fn laid_out(&self, file: &str) -> Vec<(i64, i64, Vec<u8>)> {
            let objects = self.objects.borrow();
            let mut stretches: Vec<(i64, i64, Vec<u8>)> = objects
                .iter()
                .filter(|((held, _, _), _)| held == file)
                .map(|((_, from, through), body)| (*from, *through, body.clone()))
                .collect();
            stretches.sort_by_key(|(from, through, _)| (*from, *through));
            stretches
        }

        fn body(&self, file: &str) -> String {
            String::from_utf8(self.laid_out(file).into_iter().flat_map(|(_, _, body)| body).collect()).unwrap()
        }

        fn reach(&self, file: &str) -> i64 {
            self.laid_out(file).last().map(|(_, through, _)| *through).unwrap_or(0)
        }

        /// Every key this store holds names both ends of its span, so every reach it answers with
        /// is one a host can read as a place in the file.
        fn ends(&self) -> HashMap<String, Reach> {
            let files: HashSet<String> = self.objects.borrow().keys().map(|(file, _, _)| file.clone()).collect();
            files
                .into_iter()
                .map(|file| {
                    let through = self.reach(&file);
                    (file, Reach { through, named: true })
                })
                .collect()
        }

        /// Whether the stretches of one file account for every byte of it the archive reaches. A
        /// pass that skipped one leaves a span of the file in no object at all, and reading the
        /// file back concatenates across that span without a word, so this is the one thing the
        /// concatenation cannot say for itself.
        fn whole(&self, file: &str) -> bool {
            let mut at = 0;
            for (from, through, _) in self.laid_out(file) {
                if from != at {
                    return false;
                }
                at = through;
            }
            true
        }
    }

    impl Store for Fake {
        fn held(&self, _session_id: &str) -> Result<Held> {
            *self.asked.borrow_mut() += 1;
            Ok(Held {
                reach: self.ends(),
                counted: HashSet::new(),
            })
        }

        fn append(&self, _session_id: &str, file: &str, from: i64, through: i64, bytes: &[u8]) -> Result<Appended> {
            // A body past MAX_STRETCH_BYTES is a 413 the service answers with nothing a pass can
            // place, so every test here is a test that no stretch is offered as one.
            if bytes.len() > MAX_STRETCH {
                bail!(
                    "a body of {} bytes is more than the {MAX_STRETCH} a stretch may hold",
                    bytes.len()
                );
            }
            *self.offered.borrow_mut() += 1;
            let reach = self.reach(file);
            if reach != from {
                return Ok(Appended::Refused(Reach {
                    through: reach,
                    named: true,
                }));
            }
            self.objects
                .borrow_mut()
                .insert((file.to_string(), from, through), bytes.to_vec());
            Ok(Appended::Written(through))
        }
    }

    /// A transcript shaped the way one is: one JSON record a line, the same keys over and over and
    /// prose in between.
    fn turns(count: usize, tag: &str) -> Vec<u8> {
        let mut text = String::new();
        for index in 0..count {
            text.push_str(&format!(
                "{{\"type\":\"user\",\"timestamp\":\"2026-11-07T12:0{}:00Z\",\"message\":{{\"content\":\"{tag} {index}: the archive holds every byte of this line as it stands.\"}}}}\n",
                index % 10
            ));
        }
        text.into_bytes()
    }

    /// The whole reason gzip was chosen over distilling the records: what the archive stores is the
    /// member, so a restore inflates back to the bytes this host read and the file written to disk
    /// is the file that was archived, byte for byte. A restore reads a file back as every member of
    /// it laid end to end, which is one gzip stream, and that is what the HTTP client inflates.
    #[test]
    fn a_stretch_inflates_to_the_bytes_it_was_read_from() {
        let first = turns(40, "first");
        let second = turns(30, "second");
        let member = packed(&first).unwrap();

        assert!(
            member.len() * 2 < first.len(),
            "a transcript is prose and JSON, so a stretch of it goes up far smaller than it was read: {} of {}",
            member.len(),
            first.len()
        );

        let mut read = Vec::new();
        flate2::read::MultiGzDecoder::new(&member[..])
            .read_to_end(&mut read)
            .unwrap();
        assert_eq!(read, first, "one member inflates to the stretch, byte for byte");

        let mut stream = member.clone();
        stream.extend_from_slice(&packed(&second).unwrap());
        let mut whole = Vec::new();
        flate2::read::MultiGzDecoder::new(&stream[..])
            .read_to_end(&mut whole)
            .unwrap();
        let mut file = first.clone();
        file.extend_from_slice(&second);
        assert_eq!(whole, file, "and the members of a file inflate to the file");
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
            .found
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

        assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 11);
        std::fs::write(&transcript, "one\ntwo\nthree\n").unwrap();
        assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 6);

        assert_eq!(service.body("main"), "one\ntwo\nthree\n");
        assert_eq!(service.body("agent-a"), "ay\n");
        assert_eq!(
            archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(),
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

        archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();
        let asked = *service.asked.borrow();
        for _ in 0..20 {
            assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 0);
        }

        assert_eq!(
            *service.asked.borrow(),
            asked,
            "a short beat over quiet sessions is free, so only a session writing costs anything"
        );
        std::fs::write(&transcript, "one\ntwo\n").unwrap();
        assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 4);
        assert_eq!(
            *service.asked.borrow(),
            asked,
            "a session this run already placed is never asked about again, however much it writes"
        );

        archive.retain(&HashSet::new());
        archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();
        assert_eq!(
            *service.asked.borrow(),
            asked + 1,
            "a session forgotten is asked about once, and that is the only call the listing pays for"
        );
    }

    /// Where a pass picks a file up, as a reach every key behind it names both ends of.
    fn opens(through: i64) -> Reach {
        Reach { through, named: true }
    }

    fn reached(through: i64, bytes: i64) -> Reached {
        Reached {
            reach: opens(through),
            bytes,
        }
    }

    /// A store whose keys name one offset each, which is what a host that redacted and still wrote
    /// one leaves behind. The reach it answers with is a place in the archive, so nothing can read
    /// it as a place in the file.
    #[derive(Debug)]
    struct Unplaced {
        through: i64,
    }

    impl Store for Unplaced {
        fn held(&self, _session_id: &str) -> Result<Held> {
            Ok(Held {
                reach: HashMap::from([(
                    MAIN.to_string(),
                    Reach {
                        through: self.through,
                        named: false,
                    },
                )]),
                counted: HashSet::new(),
            })
        }

        fn append(&self, _session_id: &str, _file: &str, _from: i64, _through: i64, _bytes: &[u8]) -> Result<Appended> {
            panic!("a reach nothing can place in the file must offer no stretch at all");
        }
    }

    /// The reach of a file keyed by one offset each is a count of redacted bytes, and a transcript
    /// full of secrets reads to a longer archive than itself. Reading the file at that number would
    /// open it past its own end: the bytes between would go into no object and the archive would
    /// concatenate across the gap without a word. So the pass stops there.
    #[test]
    fn a_reach_past_the_file_under_a_key_of_one_offset_stops_the_pass() {
        let sandbox = Sandbox::new("unplaced");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        let mut archive = Archive::default();
        let stopped = archive
            .send(&Unplaced { through: 16 }, "s-1", &transcript, Pass::Open)
            .unwrap_err()
            .to_string();

        assert!(
            stopped.contains("reaches 16 bytes into a file this host holds 8 of"),
            "the pass says which two numbers disagree: {stopped}"
        );
        assert!(
            archive
                .send(&Unplaced { through: 8 }, "s-1", &transcript, Pass::Open)
                .is_ok(),
            "a reach that is a place in the file is read on its own terms, whatever keyed it"
        );
    }

    #[test]
    fn a_stretch_sent_again_is_refused_with_where_the_file_reaches() {
        let sandbox = Sandbox::new("replayed");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        let service = Fake::default();
        let source = sources(&transcript).unwrap().found.remove(0);

        assert_eq!(
            send_from(&service, "s-1", &source, opens(0), Pass::Open).unwrap(),
            reached(8, 8),
            "the archive reaches where the stretch ends in the file, which the append answers without a read"
        );
        // A host that lost its place and read the file from nothing again. The stretch is refused
        // with how far the archive reaches, which is where this pass ends up without writing
        // anything.
        assert_eq!(
            send_from(&service, "s-1", &source, opens(0), Pass::Open).unwrap(),
            reached(8, 0),
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
        archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();

        std::fs::write(&transcript, "other\n").unwrap();

        assert_eq!(
            archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(),
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
            sources(&transcript).unwrap().found.len(),
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

        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

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
        let head = "x".repeat(MAX_STRETCH - 9);
        let text = format!("{head} {TOKEN} tail\n");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        let body = service.body("main");
        assert!(!body.contains("ghp_"), "no part of the token is in the archive");
        assert_eq!(body, format!("{head} {PLACEHOLDER} tail\n"));
        assert_eq!(sent, body.len() as i64, "a pass counts the bytes it put there");
    }

    #[test]
    fn a_pass_that_lost_its_place_takes_it_from_the_archive_in_a_file_redaction_shortened() {
        let sandbox = Sandbox::new("placed");
        let text = format!("one {TOKEN}\ntwo\n");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();
        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();
        let held = service.body("main");
        assert_ne!(
            held.len(),
            text.len(),
            "the archive of this one runs to another length than the file, which is the whole of the trap"
        );

        std::fs::write(&transcript, format!("{text}three\n")).unwrap();
        // A daemon restarted: it has no place of its own and takes the service's, which is a place
        // in the file and nothing to do with how many bytes the archive holds.
        let offered = *service.offered.borrow();
        let sent = Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert_eq!(sent, 6, "only the line the session added since goes up");
        assert_eq!(
            *service.offered.borrow(),
            offered + 1,
            "the pass opens the file where the archive reaches into it, so it offers the one stretch that is left"
        );
        assert_eq!(service.body("main"), format!("{held}three\n"), "and it goes up once");
        assert!(service.whole("main"));
    }

    #[test]
    fn a_long_transcript_goes_up_a_stretch_at_a_time_and_reads_back_whole() {
        let sandbox = Sandbox::new("chunks");
        let line = format!("{}\n", "x".repeat(999));
        let text = line.repeat(3000);
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert_eq!(sent, text.len() as i64);
        assert_eq!(service.body("main"), text, "the stretches concatenate to the file");
    }

    #[test]
    fn a_transcript_read_while_it_is_still_being_written_sends_no_part_of_a_secret_and_skips_none_of_itself() {
        let full = format!("one\n{{\"text\":\"export {TOKEN}\"}}\n");
        let archived = format!("one\n{{\"text\":\"export {PLACEHOLDER}\"}}\n");
        for cut in 1..full.len() {
            let sandbox = Sandbox::new(&format!("growing-{cut}"));
            let transcript = sandbox.transcript("s-1", &full[..cut]);
            let service = Fake::default();
            let mut archive = Archive::default();

            archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();
            assert!(
                !service.body("main").contains("ghp_"),
                "a beat over a file the session had written {cut} bytes of sends no part of the token"
            );

            std::fs::write(&transcript, &full).unwrap();
            archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();

            assert!(
                service.whole("main"),
                "and the beat after it leaves no hole, after a beat at {cut}"
            );
            assert_eq!(
                service.body("main"),
                archived,
                "and the whole of the file is there, after a beat at {cut}"
            );
        }
    }

    #[test]
    fn a_record_still_being_written_is_never_archived_as_the_half_of_it_on_disk() {
        let sandbox = Sandbox::new("unfinished");
        let half = "one\n{\"text\":\"half";
        let transcript = sandbox.transcript("s-1", half);
        let service = Fake::default();
        let mut archive = Archive::default();

        assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 4);
        assert_eq!(
            service.body("main"),
            "one\n",
            "the line the session is still writing is not sent as the half of it on disk"
        );
        assert_eq!(
            archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(),
            0,
            "and the beat after it finds nothing it can send either"
        );

        assert_eq!(
            Archive::default()
                .send(&service, "s-1", &transcript, Pass::Final)
                .unwrap(),
            0,
            "nor does the pass that knows the session has ended: a fragment of a record is no record"
        );
        assert_eq!(service.body("main"), "one\n");

        std::fs::write(&transcript, format!("{half}\"}}\n")).unwrap();
        assert_eq!(
            Archive::default()
                .send(&service, "s-1", &transcript, Pass::Final)
                .unwrap(),
            16,
            "and a session resumed on the file archives the record once it is whole"
        );
        assert_eq!(service.body("main"), format!("{half}\"}}\n"));
        assert!(service.whole("main"));
    }

    #[test]
    fn a_file_no_pass_can_get_past_says_so_rather_than_reading_the_same_stretch_for_ever() {
        let sandbox = Sandbox::new("stuck");
        // A private key block longer than one stretch: every pass reads the same megabyte, holds
        // the whole of it back, and has nothing to show for it.
        let text = format!("-----BEGIN RSA PRIVATE KEY-----\n{}\n", "Zm".repeat(MAX_STRETCH));
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let refused = Archive::default().send(&service, "s-1", &transcript, Pass::Open);

        let error = format!(
            "{:#}",
            refused.expect_err("a pass that can carry nothing is not a pass that sent nothing")
        );
        assert!(error.contains("secret longer than a stretch"), "{error}");
        assert_eq!(service.body("main"), "", "and no part of the key is in the archive");
    }

    #[test]
    fn a_file_named_what_this_host_cannot_send_under_is_named_rather_than_passed_over() {
        let sandbox = Sandbox::new("named");
        let transcript = sandbox.transcript("s-1", "one\n");
        sandbox.delegated("s-1", "tool-results.x", "ay\n");
        sandbox.persisted("s-1", &"a".repeat(101), "output\n");
        // A name that is not UTF-8 at all, which the service has nothing to take either.
        let dir = sandbox.dir.join("project").join("s-1").join("tool-results");
        std::fs::write(dir.join(OsStr::from_bytes(b"bad\xff.txt")), "more\n").unwrap();

        let found = sources(&transcript).unwrap();

        assert_eq!(
            found
                .found
                .iter()
                .map(|source| source.file.as_str())
                .collect::<Vec<_>>(),
            vec![MAIN],
            "a delegated turn may not take the name of a persisted output, an output may not run past what the service takes, and neither may hide behind the other"
        );
        assert_eq!(found.unsendable.len(), 3, "{:?}", found.unsendable);
    }

    #[test]
    fn a_session_holding_a_file_this_host_cannot_name_sends_the_rest_of_itself_and_says_so_once() {
        let sandbox = Sandbox::new("unnameable");
        let transcript = sandbox.transcript("s-1", "one\n");
        sandbox.delegated("s-1", "agent-a", "ay\n");
        sandbox.persisted("s-1", &"a".repeat(101), "output\n");
        let service = Fake::default();
        let mut archive = Archive::default();

        let refused = archive.send(&service, "s-1", &transcript, Pass::Open);

        let error = format!(
            "{:#}",
            refused.expect_err("an output named past what the service takes is one #84 would quietly drop")
        );
        assert!(error.contains("tool-results"), "{error}");
        assert_eq!(
            service.body("main"),
            "one\n",
            "and the files it could name went up rather than waiting on the one it could not"
        );
        assert_eq!(service.body("agent-a"), "ay\n");

        std::fs::write(&transcript, "one\ntwo\n").unwrap();
        assert_eq!(
            archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(),
            4,
            "a name is nothing a later pass changes, so the beats after the first carry on"
        );
        assert_eq!(service.body("main"), "one\ntwo\n");
    }

    #[test]
    fn a_stretch_whose_placeholders_run_past_what_the_service_takes_goes_up_cut_to_fit() {
        let sandbox = Sandbox::new("expanded");
        // Every line gives up sixteen bytes of header value for a twenty-three byte placeholder,
        // so a megabyte of them read off the file offers a body of 1,198,344 — a 413 the pass
        // cannot place, and the same stretch read again on every beat after it.
        let line = "{\"out\":\"Authorization: Bearer abcdefghijklmnop\"}\n";
        let shown = "{\"out\":\"Authorization: Bearer [redacted:bearer-token]\"}\n";
        let lines = 1_100_000 / line.len();
        let transcript = sandbox.transcript("s-1", &line.repeat(lines));
        let service = Fake::default();

        let sent = Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert_eq!(sent, shown.repeat(lines).len() as i64);
        assert_eq!(
            service.body("main"),
            shown.repeat(lines),
            "the whole of the file is in the archive, redacted, over as many stretches as that takes"
        );
        assert!(service.whole("main"), "and the stretches leave no hole between them");
    }

    #[test]
    fn a_marker_at_the_head_of_a_stretch_goes_up_read_against_the_byte_in_front_of_it_in_the_file() {
        // A key sitting exactly where a stretch is cut. The byte in front of it is out in the
        // file rather than in the stretch, and is what says whether the key opens a word of its
        // own, so the padding runs to a stretch less one byte and the cut lands on the marker.
        const KEY: &str = "sk-FAKE0000000000000000000000000000000000fake";
        for (sep, redacted) in [('x', false), (' ', true)] {
            let sandbox = Sandbox::new(&format!("head-{}", sep as u32));
            let head = format!("{}{sep}", "x".repeat(MAX_STRETCH - 1));
            let transcript = sandbox.transcript("s-1", &format!("{head}{KEY}\n"));
            let service = Fake::default();

            Archive::default()
                .send(&service, "s-1", &transcript, Pass::Open)
                .unwrap();

            let want = match redacted {
                true => format!("{head}[redacted:openai-api-key]\n"),
                false => format!("{head}{KEY}\n"),
            };
            assert_eq!(
                service.body("main"),
                want,
                "a key behind {sep:?} at the head of a stretch, which the byte in front of it decides"
            );
            assert!(service.whole("main"));
        }
    }

    #[test]
    fn a_session_resumed_after_a_half_written_secret_sends_the_whole_record_and_redacts_it() {
        let sandbox = Sandbox::new("resumed");
        // The session ended part way into a token — too little of it to read as one. The record it
        // sits in is not whole, so the pass that ended the session archived none of it, and the
        // archive reaches the end of the line in front of it.
        let half = format!("one\n{{\"text\":\"export {}", &TOKEN[..12]);
        let transcript = sandbox.transcript("s-1", &half);
        let service = Fake::default();
        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Final)
            .unwrap();
        assert_eq!(
            service.body("main"),
            "one\n",
            "the record the token is half of is held back, so the archive ends on a record boundary"
        );

        // `claude --resume` on the same file: the token completes, and the pass that picks the
        // file up opens on the record rather than part way into the secret it holds.
        std::fs::write(&transcript, format!("one\n{{\"text\":\"export {TOKEN}\"}}\nthree\n")).unwrap();
        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert_eq!(
            service.body("main"),
            format!("one\n{{\"text\":\"export {PLACEHOLDER}\"}}\nthree\n"),
            "the record goes up whole, with the token written out as what it was"
        );
        assert!(
            !service.body("main").contains("ghp_"),
            "no part of the token is in the archive"
        );
        assert!(service.whole("main"));
    }

    #[test]
    fn a_persisted_output_that_never_ends_in_a_line_break_goes_up_on_the_beat_rather_than_waiting() {
        let sandbox = Sandbox::new("unlined");
        let transcript = sandbox.transcript("s-1", "one\n");
        sandbox.persisted("s-1", "b374nf1qv", "a tool wrote this and no line break");
        let service = Fake::default();

        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert_eq!(
            service.body("tool-results.b374nf1qv"),
            "a tool wrote this and no line break",
            "an output holds no records, so there is no half of one to wait for"
        );
    }

    /// A long file full of secrets, which the archive runs to a quite different length than. Every
    /// place either side is a place in the file regardless, so the stretches account for the file
    /// up to its last whole record and leave no span of it in no object.
    #[test]
    fn a_file_the_archive_runs_to_another_length_than_is_accounted_for_record_by_record() {
        let sandbox = Sandbox::new("length");
        let line = format!("{{\"text\":\"{TOKEN} {}\"}}\n", "x".repeat(900));
        let text = format!("{}{{\"text\":\"half", line.repeat(2400));
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();
        let mut archive = Archive::default();
        archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();

        assert!(
            text.len() as i64 > 2 * MAX_STRETCH as i64,
            "the file runs over three stretches"
        );
        assert_ne!(
            service.body("main").len() as i64,
            text.len() as i64,
            "the archive runs to another length than the file, because a placeholder is not the length of the secret"
        );
        assert_eq!(
            service.reach("main"),
            line.repeat(2400).len() as i64,
            "and it reaches the end of the last whole record of the file, in places in the file"
        );
        assert!(service.whole("main"));
        assert_eq!(
            archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(),
            0,
            "a beat over the same file sends nothing, so no stretch is offered twice"
        );
    }
}
