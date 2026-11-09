//! The files one Claude Code session writes, and the records of them this host has not sent.
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
//! A file is sent as a run of records, and a record is one line of it. The service holds a record
//! under the ordinal it has in the file and nothing else, so a position in a file is a count of
//! records and never a count of bytes: redaction rewrites a line to another length, and no reading
//! of the archive could then say which byte of the file it had reached. An ordinal is a place
//! redaction cannot move, which is why there is one number here and not two.
//!
//! Every record is redacted on its way out, so a secret a session printed is never sent at all. A
//! run of records is redacted as the stretch of the file it is — one reading, not one per line —
//! because a private key block runs across the lines it is written on and no reading of a single
//! line could see it. Such a block stands out as one placeholder for each line it stood on, so the
//! file keeps the lines it had: a redaction that swallowed a break would leave fewer records than
//! the file holds lines, and every ordinal past it would name another line than it did.
//!
//! A record crosses as a JSON string, and a persisted tool output holds whatever a command
//! printed, so a line that is not valid UTF-8 carries its own bytes in base64 behind a marker the
//! service decodes before it stores them. Nothing is sent lossily and nothing is refused for the
//! bytes it holds.
//!
//! A line the session is still writing is no record: the archive of a file of turns always ends on
//! a line break, so a session resumed on the same file carries on from the start of a record and no
//! secret is ever completed by the record that follows the one it began in. A tool output has no
//! records of its own, so the pass that knows the session has ended sends its last line whether or
//! not a break closes it.
//!
//! A line that holds nothing is no record either. It belongs to the record that follows it, which
//! carries it as the break in front of its own text, so a tool output full of blank lines reads
//! back as the file it was: the records of a file laid out with one break between them are the
//! file, to the byte its last break takes.
//!
//! The position is kept apart from the mark the usage counter keeps in the session record, so
//! moving either can neither skip nor replay the other.

use crate::redact;
use crate::watch::Depth;
use anyhow::{Context, Result, bail};
use base64::Engine;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// The name a session's own transcript is sent under. A delegated turn goes under its own file
/// name, which Claude Code writes as `agent-<id>.jsonl`.
pub const MAIN: &str = "main";

/// What the name of a persisted tool output opens with. The rest of the name is the one Claude
/// Code gave the file, which is what the turn pointing at it holds, so a restore can put it back
/// under the path that turn reads.
pub const TOOL_RESULT: &str = "tool-results.";

/// How many records one append carries, and how many bytes the body of one may hold. Both are the
/// ceiling the service answers 413 against.
pub const MAX_RECORDS: usize = 1_000;
pub const MAX_APPEND_BYTES: usize = 5_242_880;

const NEWLINE: u8 = b'\n';

/// What a record that is not valid UTF-8 opens with, and what the bytes behind it are written in.
/// The service holds the same marker, and `schemas/transcript-entry.json` is where the two read it
/// from so neither can move it alone.
pub const BINARY_RECORD: &str = "\0base64:";

const BASE64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

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

/// The directories one session writes in, for the watch that wakes the daemon when it does: the
/// one its own transcript sits in, shared with every other session of the project, and the one its
/// subagent turns and persisted tool outputs sit under, which is the session's alone. A directory
/// that is not there yet is left out rather than watched and refused: the one above it is watched,
/// so its appearing is itself an event, and the pass that follows is what asks for it.
pub fn dirs(transcript: &Path) -> BTreeMap<PathBuf, Depth> {
    if transcript.as_os_str().is_empty() {
        return BTreeMap::new();
    }
    let mut dirs = BTreeMap::new();
    if let Some(parent) = transcript.parent() {
        dirs.insert(parent.to_path_buf(), Depth::Here);
    }
    if let Some(own) = beside(transcript) {
        dirs.insert(own, Depth::Below);
    }
    dirs.retain(|dir, _| dir.is_dir());
    dirs
}

/// How long a name the service takes, and which characters beyond letters and digits it holds.
pub(crate) const NAME_MAX_BYTES: usize = 101;
pub(crate) const NAME_EXTRA_CHARS: &str = "._-";

/// The names the service takes open with a letter or a digit. It is the name this host sends under
/// that has to pass, not the stem it was built from.
fn nameable(file: &str) -> bool {
    let mut bytes = file.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        && file.len() <= NAME_MAX_BYTES
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || NAME_EXTRA_CHARS.as_bytes().contains(&byte))
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

/// What one file of a session holds, read off the name the archive gave it. It is how a restore
/// tells a transcript from a tool output when all it has is the archive's listing.
pub fn holds_of(file: &str) -> Holds {
    if file.starts_with(TOOL_RESULT) {
        Holds::Output
    } else {
        Holds::Turns
    }
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

/// What an append answers: the ordinal the file is waiting for once it is in. A writer beaten to
/// its place is refused with that same number, which is where it sends from next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appended {
    Written(i64),
    Refused(i64),
}

/// What the service takes: a run of redacted records under the ordinal the first of them holds,
/// and whether a line break closes the last of them. That break is the one byte no ordinal
/// accounts for — a file is its records laid out with one between them — so an archive told
/// nothing of it reads back a byte short of the file it holds.
pub trait Store {
    fn append(&self, session_id: &str, file: &str, from: i64, records: &[String], closed: bool) -> Result<Appended>;
}

/// Where a pass picks a file up. `proven` is false for a place this run worked out for itself
/// rather than one the service answered with, and the first append it sends carries a single
/// record: a file the service is already past refuses it, and the refusal names the real place
/// without a megabyte of prose having been offered for nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place {
    pub next: i64,
    pub proven: bool,
}

impl Place {
    pub fn nothing() -> Place {
        Place { next: 0, proven: false }
    }

    fn reached(next: i64) -> Place {
        Place { next, proven: true }
    }
}

/// What one pass over one file did: where the file is waiting now, how many records it put there,
/// how many lines it read that no record could carry, and whether it stopped with records still
/// to send.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sent {
    pub next: i64,
    pub records: i64,
    pub dropped: i64,
    pub more: bool,
}

/// One line of a file as it was read: its bytes without the break, and whether a break closed it.
#[derive(Debug, Clone)]
struct Line {
    bytes: Vec<u8>,
    closed: bool,
}

/// One file read as the records it holds. A record is one line, carrying the lines in front of it
/// that held nothing, so the records of a file joined by a break are the file.
///
/// It reads forward and never back. A pass walks a file once, and a refusal naming a place behind
/// where the reader stands is one no reading of this file could have led to.
pub struct Reader<R: BufRead> {
    source: R,
    holds: Holds,
    pass: Pass,
    /// The byte of the file in front of the next record, and nothing where it opens the file. It
    /// is what says whether a marker at the head of a record opens a word of its own.
    before: Option<u8>,
    at: i64,
    /// Lines read and not sent, which the batch that read more of them than it could send puts
    /// back for the one after it.
    held: VecDeque<Line>,
    spent: bool,
}

/// One batch as it goes up: the records, whether a line break closes the last of them, and the
/// lines of the file they were read from, which go back on the queue where the service refuses
/// them.
struct Batch {
    records: Vec<String>,
    closed: bool,
    lines: Vec<Line>,
}

impl<R: BufRead> Reader<R> {
    pub fn new(source: R, holds: Holds, pass: Pass) -> Reader<R> {
        Reader {
            source,
            holds,
            pass,
            before: None,
            at: 0,
            held: VecDeque::new(),
            spent: false,
        }
    }

    /// The lines read that no record carries, which is the run at the end of the file this pass
    /// cannot close: a line the session is still writing, and the blank lines in front of it.
    pub fn dropped(&self) -> i64 {
        self.held.len() as i64
    }

    fn line(&mut self) -> Result<Option<Line>> {
        if let Some(line) = self.held.pop_front() {
            return Ok(Some(line));
        }
        if self.spent {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        if self
            .source
            .read_until(NEWLINE, &mut bytes)
            .context("reading a record")?
            == 0
        {
            self.spent = true;
            return Ok(None);
        }
        let closed = bytes.last() == Some(&NEWLINE);
        if closed {
            bytes.pop();
        }
        Ok(Some(Line { bytes, closed }))
    }

    /// Whether this pass may send a line no break closed. A file of turns holds records, and the
    /// half of one on disk is no record whatever the pass; a tool output holds none, so the pass
    /// that knows the session has ended sends its last line as the last line it is.
    fn takes_open_tail(&self) -> bool {
        self.holds == Holds::Output && self.pass == Pass::Final
    }

    /// The lines of the next record, and nothing where the file holds none this pass can close.
    fn record(&mut self) -> Result<Option<Vec<Line>>> {
        let mut lines: Vec<Line> = Vec::new();
        loop {
            let Some(line) = self.line()? else {
                for line in lines.into_iter().rev() {
                    self.held.push_front(line);
                }
                return Ok(None);
            };
            if !line.closed && !self.takes_open_tail() {
                self.held.push_front(line);
                for line in lines.into_iter().rev() {
                    self.held.push_front(line);
                }
                return Ok(None);
            }
            let ends = !line.bytes.is_empty() || !line.closed;
            lines.push(line);
            if ends {
                return Ok(Some(lines));
            }
        }
    }

    /// Past the records before `ordinal`, reading none of them for anything. A file holding fewer
    /// records than the archive runs out here, which is a session rewritten and nothing to send.
    pub fn skip_to(&mut self, ordinal: i64) -> Result<()> {
        if ordinal < self.at {
            bail!(
                "the archive waits at record {ordinal}, which is behind the {} this pass has read to",
                self.at
            );
        }
        while self.at < ordinal {
            if self.record()?.is_none() {
                return Ok(());
            }
            self.at += 1;
            self.before = Some(NEWLINE);
        }
        Ok(())
    }

    /// One batch of records, redacted, or nothing where the file holds none this pass can send.
    /// `limit` is how many of them go up: a pass that has still to learn where the file waits
    /// sends one, and the rest go back on the queue for the append after it.
    ///
    /// The whole stretch goes through the redactor at once and the records are cut out of what
    /// comes back, so a secret written across two lines is read as the one secret it is. The
    /// redactor keeps the breaks it wrote over, which is what lets the records be cut out at all;
    /// a batch that came back with fewer breaks than it went in with would have every ordinal past
    /// the secret naming a line it does not, so it stops the file rather than sending one.
    fn batch(&mut self, file: &str, limit: usize) -> Result<Option<Batch>> {
        let mut lines: Vec<Line> = Vec::new();
        let mut groups: Vec<usize> = Vec::new();
        let mut bytes = 0;
        while groups.len() < MAX_RECORDS && bytes < MAX_APPEND_BYTES {
            let Some(read) = self.record()? else {
                break;
            };
            bytes += read.iter().map(|line| line.bytes.len() + 1).sum::<usize>();
            groups.push(read.len());
            lines.extend(read);
        }
        let Some(first) = groups.first().copied() else {
            return Ok(None);
        };
        // The stretch of the file the batch is written on, break for break: the break that closes
        // its last line is part of it, so a secret running to the end of that line is finished
        // there and not held back for bytes that are already in hand.
        let closed = lines.last().is_some_and(|line| line.closed);
        let stretch = spread(&lines);
        // Nothing of the file follows the stretch only where the reader has read all of it and put
        // nothing back, and only the pass that knows the session has ended can say the file holds
        // no more. Anything else leaves a match at the end of the stretch unfinished.
        let whole = self.spent && self.held.is_empty() && self.pass == Pass::Final;
        let red = redact::within(&stretch, self.before, whole);
        let used = &stretch[..red.source];
        if breaks(&red.bytes) != breaks(used) {
            bail!(
                "{file} holds a secret written across the records at {}, so nothing of it past there can be archived",
                self.at
            );
        }
        let complete = breaks(used) + usize::from(!closed && red.source == stretch.len());
        let shown: Vec<&[u8]> = red.bytes.split(|byte| *byte == NEWLINE).take(complete).collect();
        let mut records: Vec<String> = Vec::new();
        let mut taken = 0;
        for group in &groups {
            if taken + group > shown.len() {
                break;
            }
            records.push(written(&shown[taken..taken + group].join(&NEWLINE)));
            taken += group;
        }
        let held_back = complete < first;
        records.truncate(fitting(file, self.at, &records).min(limit));
        if records.is_empty() {
            // Nothing of the batch can go up. Either the redactor held the first record back, and
            // only the bytes that finish the secret let it through — which a batch at its ceiling
            // is never going to be given — or the record is longer than one append may carry and
            // no later pass reads it any shorter. Both stop the file rather than reading it for
            // ever with nothing to show.
            if held_back {
                if bytes >= MAX_APPEND_BYTES || groups.len() >= MAX_RECORDS {
                    bail!(
                        "{file} holds a secret longer than one append at {}, so nothing of it past there can be archived",
                        self.at
                    );
                }
                self.restore_lines(lines);
                return Ok(None);
            }
            bail!(
                "{file} holds a record at {} that no append can carry, so nothing of it past there can be archived",
                self.at
            );
        }
        let read: usize = groups[..records.len()].iter().sum();
        let rest = lines.split_off(read);
        self.restore_lines(rest);
        // The break that closed the last line this batch carries, which is every line of a file of
        // turns and every line of a tool output but the one a session stopped part way through.
        let ends = lines.last().is_some_and(|line| line.closed);
        self.at += records.len() as i64;
        self.before = Some(NEWLINE);
        Ok(Some(Batch {
            records,
            closed: ends,
            lines,
        }))
    }

    fn restore_lines(&mut self, lines: Vec<Line>) {
        for line in lines.into_iter().rev() {
            self.held.push_front(line);
        }
    }

    /// A batch the service refused, back where it was read from. The writer that reached the file
    /// first says where it waits now, and these records are offered again from there.
    fn restore(&mut self, batch: Batch) {
        self.at -= batch.records.len() as i64;
        self.restore_lines(batch.lines);
        self.before = if self.at == 0 { None } else { Some(NEWLINE) };
    }
}

/// The lines of a batch as the file holds them, each closed by the break that closed it there.
fn spread(lines: &[Line]) -> Vec<u8> {
    let mut stretch = Vec::new();
    for line in lines {
        stretch.extend_from_slice(&line.bytes);
        if line.closed {
            stretch.push(NEWLINE);
        }
    }
    stretch
}

fn breaks(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == NEWLINE).count()
}

/// One record written out for the wire. A record crosses as a JSON string, and a persisted tool
/// output holds whatever a command printed, so a line that is not valid UTF-8 would go up as the
/// replacement character over and over and the archive would hold bytes the host never read. Such
/// a line carries its own bytes in base64 behind the marker, which the service decodes back before
/// it stores them; a line that is valid UTF-8 and opens with the marker goes the same way, so
/// reading one back is never a guess.
fn written(record: &[u8]) -> String {
    match std::str::from_utf8(record) {
        Ok(text) if !text.starts_with(BINARY_RECORD) => text.to_string(),
        _ => format!("{BINARY_RECORD}{}", BASE64.encode(record)),
    }
}

/// How many of a batch's records fit the body one append may hold. The ceiling is on the body the
/// service is offered, so it is weighed against the body `crate::api::append_body` writes and
/// never against the bytes the records were read from: a line of JSON goes up quoted, and every
/// quote in it is a byte the escaping adds. The envelope is weighed with the longer of the two
/// words `closed` crosses as, which is the one a batch cut short of the file's end sends.
fn fitting(file: &str, from: i64, records: &[String]) -> usize {
    let envelope = crate::api::append_body(file, from, &[], false).len();
    let Some(mut room) = MAX_APPEND_BYTES.checked_sub(envelope) else {
        return 0;
    };
    for (index, record) in records.iter().enumerate() {
        let written = serde_json::to_string(record)
            .map(|json| json.len() + 1)
            .unwrap_or(usize::MAX);
        if written > room {
            return index;
        }
        room -= written;
    }
    records.len()
}

/// How many appends one pass over one file offers before it leaves the rest to the pass behind it.
/// The daemon archives every live session on one beat, so a host returning from a gap with
/// hundreds of megabytes of transcript would hold that beat — and every other session's lines —
/// for as long as its backlog took. The place a pass reaches is proven and kept, so the pass after
/// it opens where this one stopped and the backlog drains a beat at a time.
pub const MAX_APPENDS_PER_PASS: usize = 32;

/// Sends what is left of one file from the record the archive is waiting for. A place this run
/// worked out for itself costs one append of a single record, which the service refuses with the
/// place the file really waits at; from there every append carries all it may.
///
/// `appends` is how many it offers before it stops and says the file holds more.
pub fn send_from(
    store: &impl Store,
    session_id: &str,
    file: &str,
    reader: &mut Reader<impl BufRead>,
    from: Place,
    appends: usize,
) -> Result<Sent> {
    let mut place = from;
    let mut records = 0;
    let mut offered = 0;
    let mut more = false;
    reader.skip_to(place.next)?;
    loop {
        if offered == appends {
            more = true;
            break;
        }
        let limit = if place.proven { MAX_RECORDS } else { 1 };
        let Some(batch) = reader.batch(file, limit)? else {
            break;
        };
        offered += 1;
        match store.append(session_id, file, place.next, &batch.records, batch.closed)? {
            Appended::Written(next) => {
                records += batch.records.len() as i64;
                place = Place::reached(next);
            }
            Appended::Refused(next) => {
                if next <= place.next {
                    bail!(
                        "the archive refused {file} of session {session_id} at record {} and answered that it waits at {next}",
                        place.next
                    );
                }
                reader.restore(batch);
                place = Place::reached(next);
                reader.skip_to(next)?;
            }
        }
    }
    Ok(Sent {
        next: place.next,
        records,
        dropped: reader.dropped(),
        more,
    })
}

/// One file of one session on disk, read as the records it holds.
pub fn open(source: &Source, pass: Pass) -> Result<Reader<BufReader<std::fs::File>>> {
    let file = std::fs::File::open(&source.path).with_context(|| format!("reading {}", source.path.display()))?;
    Ok(Reader::new(BufReader::new(file), source.holds, pass))
}

/// How many records one file on disk holds. A restore weighs a file it already has against the
/// archive in records rather than in bytes, because redaction leaves a record at another length
/// than the line it was read from and no count of the archive's bytes is a place in the local
/// file. Counting as the final pass would counts the line a session is still writing, which is the
/// reading that leaves a live transcript alone.
pub fn records_held(path: &Path, holds: Holds) -> Result<i64> {
    let file = std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut reader = Reader::new(BufReader::new(file), holds, Pass::Final);
    let mut held = 0;
    while reader.record()?.is_some() {
        held += 1;
    }
    Ok(held)
}

/// A run of passes over the sessions on this host. It carries where each file is waiting and how
/// long this host held it when it last looked, so a pass over a session that has not written since
/// the one before opens no file and sends no call. The place is this run's own: a session it has
/// never seen opens at nothing and the first append it offers is the one record that asks the
/// service where the file really waits.
#[derive(Debug)]
pub struct Archive {
    seen: HashMap<String, HashMap<String, Seen>>,
    appends: usize,
}

impl Default for Archive {
    fn default() -> Archive {
        Archive {
            seen: HashMap::new(),
            appends: MAX_APPENDS_PER_PASS,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Seen {
    place: Place,
    size: i64,
    /// Whether the pass that reached this place stopped with records still to send. A file that
    /// holds more is read again on the next beat whatever its size says, since a pass cut short
    /// leaves a backlog behind that no later write announces.
    more: bool,
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
        let first = !self.seen.contains_key(session_id);
        let known = self.seen.get(session_id).cloned().unwrap_or_default();
        if !first
            && pass == Pass::Open
            && sources.found.iter().all(|source| {
                known
                    .get(&source.file)
                    .is_some_and(|seen| seen.size == source.size && !seen.more)
            })
        {
            return Ok(0);
        }
        let mut sent = 0;
        let mut ends: HashMap<String, Seen> = HashMap::new();
        for source in &sources.found {
            let from = known
                .get(&source.file)
                .map(|seen| seen.place)
                .unwrap_or(Place::nothing());
            let mut reader = open(source, pass)?;
            let reached = send_from(store, session_id, &source.file, &mut reader, from, self.appends)?;
            ends.insert(
                source.file.clone(),
                Seen {
                    place: Place::reached(reached.next),
                    size: source.size,
                    more: reached.more,
                },
            );
            sent += reached.records;
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
    use std::cell::{Cell, RefCell};
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

    /// The service as a host can see it: the records of each file under the ordinals they hold. An
    /// append lands only where the file is waiting, and every other one is refused with the
    /// ordinal it really waits at, which is how the records endpoint weighs one.
    #[derive(Debug, Default)]
    struct Fake {
        files: RefCell<HashMap<String, Vec<Held>>>,
        offered: RefCell<usize>,
    }

    /// One append as the archive keeps it: the records, and whether a line break closed the last
    /// of them. The service stores the two together because nothing else says where the file ends.
    #[derive(Debug, Clone)]
    struct Held {
        records: Vec<String>,
        closed: bool,
    }

    impl Fake {
        /// One file as it reads back: every append laid out as its records with a break between
        /// two, closed by the break that closed its last record. It is the file the host sent, to
        /// the byte.
        fn raw(&self, file: &str) -> Vec<u8> {
            let mut bytes = Vec::new();
            for held in self.files.borrow().get(file).cloned().unwrap_or_default() {
                for (index, record) in held.records.iter().enumerate() {
                    if index > 0 {
                        bytes.push(NEWLINE);
                    }
                    bytes.extend_from_slice(&read(record));
                }
                if held.closed {
                    bytes.push(NEWLINE);
                }
            }
            bytes
        }

        fn body(&self, file: &str) -> String {
            String::from_utf8(self.raw(file)).unwrap()
        }

        fn records(&self, file: &str) -> Vec<String> {
            self.files
                .borrow()
                .get(file)
                .map(|held| held.iter().flat_map(|one| one.records.clone()).collect())
                .unwrap_or_default()
        }

        fn next(&self, file: &str) -> i64 {
            self.records(file).len() as i64
        }

        /// How many records each append carried, in the order they were offered.
        fn appends(&self, file: &str) -> Vec<usize> {
            self.files
                .borrow()
                .get(file)
                .map(|held| held.iter().map(|one| one.records.len()).collect())
                .unwrap_or_default()
        }
    }

    /// A second host that reaches the same file between two of this one's appends, which is what
    /// the service answers 409 for. It writes its own run at `when` and then hands the offer on,
    /// so the append that follows is refused with the ordinal the file really waits at.
    struct Raced<'a> {
        archive: &'a Fake,
        offered: Cell<usize>,
        when: usize,
        extra: Vec<String>,
    }

    impl Store for Raced<'_> {
        fn append(
            &self,
            session_id: &str,
            file: &str,
            from: i64,
            records: &[String],
            closed: bool,
        ) -> Result<Appended> {
            let offered = self.offered.get();
            self.offered.set(offered + 1);
            if offered == self.when {
                let reach = self.archive.next(file);
                self.archive.append(session_id, file, reach, &self.extra, true)?;
            }
            self.archive.append(session_id, file, from, records, closed)
        }
    }

    /// A record as the service stores it, which is the bytes the host read: a marked one carries
    /// them in base64 and is decoded back.
    fn read(record: &str) -> Vec<u8> {
        match record.strip_prefix(BINARY_RECORD) {
            Some(encoded) => BASE64.decode(encoded).unwrap(),
            None => record.as_bytes().to_vec(),
        }
    }

    impl Store for Fake {
        fn append(
            &self,
            _session_id: &str,
            file: &str,
            from: i64,
            records: &[String],
            closed: bool,
        ) -> Result<Appended> {
            assert!(records.len() <= MAX_RECORDS, "an append carries at most {MAX_RECORDS}");
            assert!(!records.is_empty(), "an append carries at least one record");
            assert!(
                records.iter().all(|record| !record.is_empty()),
                "a record holds at least one character"
            );
            // Weighed as the body the transport writes, so a sender that fits its records to one
            // shape and sends them in another is caught here rather than by the service.
            let body = crate::api::append_body(file, from, records, closed);
            assert!(
                body.len() <= MAX_APPEND_BYTES,
                "a body of {} bytes is more than the {MAX_APPEND_BYTES} an append may hold",
                body.len()
            );
            *self.offered.borrow_mut() += 1;
            let mut held = self.files.borrow_mut();
            let file = held.entry(file.to_string()).or_default();
            let reach = file.iter().map(|one| one.records.len()).sum::<usize>() as i64;
            if from != reach {
                return Ok(Appended::Refused(reach));
            }
            file.push(Held {
                records: records.to_vec(),
                closed,
            });
            Ok(Appended::Written(reach + records.len() as i64))
        }
    }

    /// A transcript shaped the way one is: one JSON record a line, the same keys over and over and
    /// prose in between.
    fn turns(count: usize, tag: &str) -> String {
        (0..count)
            .map(|index| {
                format!(
                    "{{\"type\":\"user\",\"timestamp\":\"2026-11-07T12:0{}:00Z\",\"message\":{{\"content\":\"{tag} {index}: the archive holds every line of this as it stands.\"}}}}\n",
                    index % 10
                )
            })
            .collect()
    }

    /// A transcript whose records are large enough that the byte ceiling, and not the record
    /// ceiling, is what cuts one append from the next.
    fn heavy(count: usize, bytes: usize) -> String {
        const FILLER: &str = "the archive holds every line of this as it stands and reads it back the same. ";
        (0..count)
            .map(|index| {
                let mut prose = FILLER.repeat(bytes / FILLER.len() + 1);
                prose.truncate(bytes);
                format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{index}: {prose}\"}}}}\n")
            })
            .collect()
    }

    fn records_of(text: &str, holds: Holds, pass: Pass) -> Vec<String> {
        let mut reader = Reader::new(text.as_bytes(), holds, pass);
        let mut found = Vec::new();
        while let Some(batch) = reader.batch("main", MAX_RECORDS).unwrap() {
            found.extend(batch.records);
        }
        found
    }

    #[test]
    fn a_record_is_one_line_and_a_reader_never_cuts_inside_one() {
        let text = turns(3, "line");
        let read = records_of(&text, Holds::Turns, Pass::Open);

        assert_eq!(read.len(), 3, "one record a line");
        assert_eq!(read.join("\n"), text.trim_end_matches('\n'), "and they are the file");
        assert!(
            read.iter().all(|record| !record.contains('\n')),
            "no record carries a break of its own"
        );
    }

    #[test]
    fn a_line_still_being_written_is_no_record_and_the_blank_in_front_of_one_rides_with_it() {
        assert_eq!(
            records_of("one\ntwo", Holds::Turns, Pass::Open),
            vec!["one".to_string()],
            "the line no break closed waits for the pass that holds the whole of it"
        );
        assert_eq!(
            records_of("one\ntwo", Holds::Turns, Pass::Final),
            vec!["one".to_string()],
            "and a fragment of a record is no record whatever the pass"
        );
        assert_eq!(
            records_of("one\n\n\ntwo\n", Holds::Output, Pass::Open),
            vec!["one".to_string(), "\n\ntwo".to_string()],
            "a line that holds nothing belongs to the record that follows it"
        );
        assert_eq!(
            records_of("one\n\n\ntwo\n", Holds::Output, Pass::Open).join("\n"),
            "one\n\n\ntwo",
            "so the records of a file joined by a break are the file"
        );
        assert_eq!(
            records_of("out", Holds::Output, Pass::Final),
            vec!["out".to_string()],
            "an output holds no records, so the last pass sends its last line unclosed"
        );
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
    fn a_pass_sends_only_the_records_the_service_does_not_hold() {
        let sandbox = Sandbox::new("resume");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        sandbox.delegated("s-1", "agent-a", "ay\n");
        let service = Fake::default();
        let mut archive = Archive::default();

        assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 3);
        std::fs::write(&transcript, "one\ntwo\nthree\n").unwrap();
        assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 1);

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
    fn a_pass_over_a_session_that_has_not_written_offers_no_append() {
        let sandbox = Sandbox::new("quiet");
        let transcript = sandbox.transcript("s-1", "one\n");
        let service = Fake::default();
        let mut archive = Archive::default();

        archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();
        let offered = *service.offered.borrow();
        for _ in 0..20 {
            assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 0);
        }

        assert_eq!(
            *service.offered.borrow(),
            offered,
            "a short beat over quiet sessions is free, so only a session writing costs anything"
        );
        std::fs::write(&transcript, "one\ntwo\n").unwrap();
        assert_eq!(archive.send(&service, "s-1", &transcript, Pass::Open).unwrap(), 1);
        assert_eq!(
            *service.offered.borrow(),
            offered + 1,
            "and a session this run already placed sends the one append it owes and nothing else"
        );
    }

    #[test]
    fn a_pass_that_lost_its_place_takes_it_from_the_refusal_and_sends_the_rest() {
        let sandbox = Sandbox::new("replayed");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        let service = Fake::default();

        assert_eq!(
            Archive::default()
                .send(&service, "s-1", &transcript, Pass::Open)
                .unwrap(),
            2
        );
        std::fs::write(&transcript, "one\ntwo\nthree\n").unwrap();
        let offered = *service.offered.borrow();

        // A daemon restarted: it has no place of its own, so its first append carries the one
        // record that asks where the file waits.
        assert_eq!(
            Archive::default()
                .send(&service, "s-1", &transcript, Pass::Open)
                .unwrap(),
            1,
            "only the line the session added since goes up"
        );

        assert_eq!(
            *service.offered.borrow(),
            offered + 2,
            "the probe that was refused, and the append it placed"
        );
        assert_eq!(service.body("main"), "one\ntwo\nthree\n", "and no record goes up twice");
        assert_eq!(service.next("main"), 3);
    }

    #[test]
    fn a_refusal_resumes_at_exactly_the_record_the_service_named() {
        let sandbox = Sandbox::new("conflict");
        let text = turns(40, "line");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();
        let source = sources(&transcript).unwrap().found.remove(0);

        // Another host archived the first twenty-five records of the same session.
        let ahead: Vec<String> = text.lines().take(25).map(str::to_string).collect();
        service.append("s-1", MAIN, 0, &ahead, true).unwrap();

        let mut reader = open(&source, Pass::Final).unwrap();
        let sent = send_from(&service, "s-1", MAIN, &mut reader, Place::nothing(), usize::MAX).unwrap();

        assert_eq!(sent.next, 40);
        assert_eq!(sent.records, 15, "the fifteen the other host had not reached");
        assert_eq!(
            service.body("main"),
            text,
            "and the file is whole, to the break that ends it"
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
    fn a_secret_written_across_a_record_boundary_is_redacted_and_the_file_still_sends() {
        let sandbox = Sandbox::new("boundary");
        // A private key block, which is written across the lines it takes. Nothing reading one line
        // at a time could see it, so the records of a batch are read as the stretch of the file
        // they are written on; and the block stands out as one placeholder per line it stood on,
        // so the file keeps as many records as it has lines.
        let key = format!(
            "-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----\n",
            "Zm9vYmFy".repeat(8)
        );
        let output = format!("the key was:\n{key}and that was it\n");
        sandbox.persisted("s-1", "b374nf1qv", &output);
        let transcript = sandbox.transcript("s-1", "one\n");
        let service = Fake::default();

        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        let archived = service.body("tool-results.b374nf1qv");
        assert!(
            !archived.contains("PRIVATE KEY") && !archived.contains("Zm9vYmFy"),
            "no part of the key is in the archive: {archived}"
        );
        assert_eq!(
            archived,
            "the key was:\n[redacted:private-key]\n[redacted:private-key]\n[redacted:private-key]\nand that was it\n",
            "the block stands out line for line, so the file goes up whole"
        );
        assert_eq!(
            archived.matches('\n').count(),
            output.matches('\n').count(),
            "and the archive holds as many records as the file has lines"
        );
        assert_eq!(service.next("tool-results.b374nf1qv"), 5);
        assert_eq!(
            service.body("main"),
            "one\n",
            "the session's own file went up beside it"
        );
    }

    #[test]
    fn a_secret_at_the_end_of_a_file_a_session_is_still_writing_waits_for_the_whole_of_it() {
        let sandbox = Sandbox::new("growing");
        let full = format!("one\n{{\"text\":\"export {TOKEN}\"}}\n");
        let archived = format!("one\n{{\"text\":\"export {PLACEHOLDER}\"}}\n");
        for cut in 1..full.len() {
            let transcript = sandbox.transcript(&format!("s-{cut}"), &full[..cut]);
            let service = Fake::default();
            let mut archive = Archive::default();

            archive
                .send(&service, &format!("s-{cut}"), &transcript, Pass::Open)
                .unwrap();
            assert!(
                !service.body("main").contains("ghp_"),
                "a beat over a file the session had written {cut} bytes of sends no part of the token"
            );

            std::fs::write(&transcript, &full).unwrap();
            archive
                .send(&service, &format!("s-{cut}"), &transcript, Pass::Open)
                .unwrap();

            assert_eq!(
                service.body("main"),
                archived,
                "and the whole of the file is there, after a beat at {cut}"
            );
        }
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
            1,
            "a name is nothing a later pass changes, so the beats after the first carry on"
        );
        assert_eq!(service.body("main"), "one\ntwo\n");
    }

    #[test]
    fn a_long_transcript_goes_up_an_append_at_a_time_and_reads_back_whole() {
        let sandbox = Sandbox::new("chunks");
        let text = turns(4_000, "long");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert_eq!(sent, 4_000);
        assert!(*service.offered.borrow() >= 4, "a thousand records at a time, at most");
        assert_eq!(
            service.body("main"),
            text,
            "and the appends lay back out as the file, to its final break"
        );
    }

    #[test]
    fn a_record_longer_than_an_append_stops_the_file_rather_than_being_read_for_ever() {
        let sandbox = Sandbox::new("stuck");
        let transcript = sandbox.transcript("s-1", &format!("one\n{}\ntwo\n", "x".repeat(MAX_APPEND_BYTES)));
        let service = Fake::default();

        let refused = Archive::default().send(&service, "s-1", &transcript, Pass::Open);

        let error = format!(
            "{:#}",
            refused.expect_err("a record no append can carry is not a record a later pass carries either")
        );
        assert!(error.contains("no append can carry"), "{error}");
        assert_eq!(service.body("main"), "one\n", "and the records in front of it went up");
    }

    #[test]
    fn a_backlog_several_times_the_byte_ceiling_goes_up_as_the_appends_it_takes() {
        let sandbox = Sandbox::new("backlog");
        let text = heavy(40, MAX_APPEND_BYTES / 10);
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert!(text.len() > 3 * MAX_APPEND_BYTES, "a backlog several times the ceiling");
        assert_eq!(sent, 40, "every record of it went up");
        assert!(
            *service.offered.borrow() > 3,
            "as the appends it takes and not one the service would refuse"
        );
        assert_eq!(service.next("main"), 40, "the archive waits past the last record");
        assert_eq!(service.body("main"), text, "and the appends lay back out as the file");
    }

    #[test]
    fn a_backlog_that_crosses_the_record_ceiling_first_splits_on_the_count() {
        let sandbox = Sandbox::new("thousands");
        let text = turns(2_400, "line");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        assert!(
            text.len() < MAX_APPEND_BYTES,
            "no append of it is near the byte ceiling"
        );
        assert_eq!(sent, 2_400);
        assert_eq!(
            service.appends("main"),
            vec![1, MAX_RECORDS, MAX_RECORDS, 399],
            "the record this pass proved its place with, then every append filled to the ceiling"
        );
        assert_eq!(service.body("main"), text);
    }

    #[test]
    fn a_refusal_part_way_through_a_backlog_resumes_where_the_archive_says_and_still_finishes() {
        let sandbox = Sandbox::new("raced");
        let text = turns(2_400, "line");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();
        let raced = Raced {
            archive: &service,
            offered: Cell::new(0),
            when: 1,
            extra: text.lines().skip(1).take(600).map(str::to_string).collect(),
        };
        let source = sources(&transcript).unwrap().found.remove(0);

        let mut reader = open(&source, Pass::Final).unwrap();
        let sent = send_from(&raced, "s-1", MAIN, &mut reader, Place::nothing(), usize::MAX).unwrap();

        assert_eq!(sent.next, 2_400, "the pass carried on from the record it was handed");
        assert_eq!(sent.records, 1_800, "and sent every record the other host had not");
        assert_eq!(
            service.body("main"),
            text,
            "the file is whole, to the break that ends it"
        );
    }

    #[test]
    fn a_pass_sends_what_it_may_and_the_pass_behind_it_opens_where_that_one_stopped() {
        let sandbox = Sandbox::new("bounded");
        let text = turns(2_400, "line");
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();
        let mut archive = Archive {
            appends: 2,
            ..Archive::default()
        };

        let first = archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();
        let second = archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();
        let third = archive.send(&service, "s-1", &transcript, Pass::Open).unwrap();

        assert_eq!(first, 1_001, "the record that proved the place, then one full append");
        assert_eq!(
            second, 1_399,
            "and the pass behind it reads the file again though nothing was written since"
        );
        assert_eq!(third, 0, "a file the archive is level with sends nothing");
        assert_eq!(service.body("main"), text, "and the backlog reached the archive whole");
    }

    /// A whole file sent in one pass, which is what a backfill does. It goes through the very
    /// reader the live sender uses, so the only thing that can be proved here is the thing that
    /// matters: where the pass stops is a function of the file and nothing else.
    fn whole_file(service: &Fake, file: &str, text: &str) -> Sent {
        let mut reader = Reader::new(text.as_bytes(), holds_of(file), Pass::Final);
        send_from(service, "s-1", file, &mut reader, Place::nothing(), usize::MAX).unwrap()
    }

    #[test]
    fn a_whole_file_reaches_the_same_record_whether_it_opens_at_nothing_or_part_way_through() {
        let text = turns(2_500, "resent");
        let whole = Fake::default();
        let resumed = Fake::default();
        let halfway: Vec<String> = text.lines().take(1_200).map(str::to_string).collect();
        resumed.append("s-1", MAIN, 0, &halfway[..1_000], true).unwrap();
        resumed.append("s-1", MAIN, 1_000, &halfway[1_000..], true).unwrap();

        let first = whole_file(&whole, MAIN, &text);
        let rest = whole_file(&resumed, MAIN, &text);

        assert_eq!(first.next, 2_500);
        assert_eq!(rest.next, first.next, "a pass resumed mid-way reaches the same record");
        assert_eq!(rest.records, 1_300, "and sends only the records the archive had not");
        assert_eq!(
            whole.body(MAIN),
            resumed.body(MAIN),
            "and the two files read back alike"
        );

        let again = whole_file(&whole, MAIN, &text);
        assert_eq!(again.records, 0, "a second pass over the same file sends nothing");
        assert_eq!(again.next, 2_500);
        assert_eq!(whole.body(MAIN), text);
    }

    #[test]
    fn a_persisted_output_reads_back_as_the_file_it_was() {
        let service = Fake::default();
        let text = "first\n\n\nthe blank lines belong to the record that follows them\n\nlast";

        let sent = whole_file(&service, "tool-results.b374nf1qv", text);

        assert_eq!(service.body("tool-results.b374nf1qv"), text);
        assert_eq!(sent.records, 3);
        assert_eq!(
            whole_file(&service, "tool-results.b374nf1qv", text).records,
            0,
            "and a second pass over it sends nothing"
        );
    }

    /// A tool output holds whatever a command printed, which is not always text. A record crosses
    /// as a JSON string, so the bytes of a line no encoding reads go up in base64 behind the
    /// marker and come back out of the archive as themselves.
    #[test]
    fn a_tool_output_that_is_not_text_goes_up_as_the_bytes_it_is() {
        let sandbox = Sandbox::new("binary");
        let mut output = b"readable\n".to_vec();
        output.extend_from_slice(&[0xff, 0x00, 0xfe, 0x80, b'a']);
        output.push(NEWLINE);
        output.extend_from_slice(b"and readable again\n");
        let dir = sandbox.dir.join("project").join("s-1").join("tool-results");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b374nf1qv.txt"), &output).unwrap();
        let transcript = sandbox.transcript("s-1", "one\n");
        let service = Fake::default();

        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Final)
            .unwrap();

        let records = service.records("tool-results.b374nf1qv");
        assert_eq!(records.len(), 3, "a record a line, as for any other file");
        assert!(
            records[1].starts_with(BINARY_RECORD),
            "the line that is not text carries its bytes behind the marker: {:?}",
            records[1]
        );
        assert_eq!(
            service.raw("tool-results.b374nf1qv"),
            output,
            "and the archive holds the file byte for byte"
        );
    }

    /// The marker is what says a record carries bytes rather than text, so a line that is text and
    /// opens with it is sent the same way. Reading one back is then never a guess.
    #[test]
    fn a_line_that_opens_with_the_marker_is_sent_as_bytes_rather_than_read_as_one() {
        let service = Fake::default();
        let text = format!("{BINARY_RECORD}not really base64\nplain\n");

        whole_file(&service, "tool-results.b374nf1qv", &text);

        let records = service.records("tool-results.b374nf1qv");
        assert_eq!(records.len(), 2);
        assert_ne!(
            records[0],
            text.lines().next().unwrap(),
            "it does not go up as it stands"
        );
        assert_eq!(service.body("tool-results.b374nf1qv"), text, "and reads back as itself");
    }

    #[test]
    fn a_transcript_rewritten_shorter_is_left_where_it_is() {
        let sandbox = Sandbox::new("truncated");
        let transcript = sandbox.transcript("s-1", "one\ntwo\nthree\n");
        let service = Fake::default();
        Archive::default()
            .send(&service, "s-1", &transcript, Pass::Open)
            .unwrap();

        std::fs::write(&transcript, "other\n").unwrap();

        assert_eq!(
            Archive::default()
                .send(&service, "s-1", &transcript, Pass::Open)
                .unwrap(),
            0,
            "a file holding fewer records than the archive is another file"
        );
        assert_eq!(
            service.body("main"),
            "one\ntwo\nthree\n",
            "the records already written are left alone"
        );
    }
}
