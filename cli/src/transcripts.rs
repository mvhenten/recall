//! The files one Claude Code session writes, and the stretches of them this host has not sent.
//!
//! A session's own transcript sits at `<project>/<session id>.jsonl`, and every delegated turn
//! gets a file of its own under `<project>/<session id>/subagents/`. Those carry most of what a
//! session spends, so the set, not the one file, is what both the archive and the usage counter
//! read; `hooks/usage.mjs` enumerates the same set for the counting it does.
//!
//! The service has no append, so a file is sent as a run of stretches, each one starting where the
//! file already ends there. Where it ends is the service's own answer, kept apart from the mark
//! the usage counter keeps in the session record, so moving either can neither skip nor replay the
//! other.

use anyhow::{Context, Result};
use std::collections::HashMap;
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
/// The order is what the chunk numbers of a whole-transcript reading are handed out in, so it may
/// not depend on which of the files happen to exist yet.
pub fn sources(transcript: &Path) -> Vec<Source> {
    let mut found = vec![Source {
        file: MAIN.to_string(),
        path: transcript.to_path_buf(),
        size: size_of(transcript),
    }];
    let Some(dir) = subagents(transcript) else {
        return found;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return found;
    };
    let mut delegated: Vec<Source> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension() == Some(OsStr::new("jsonl")))
        .filter_map(|path| {
            let file = path.file_stem()?.to_str()?.to_string();
            let size = size_of(&path);
            Some(Source { file, path, size })
        })
        .collect();
    delegated.sort_by(|left, right| left.file.cmp(&right.file));
    found.extend(delegated);
    found
}

/// What the service answers about one session's files, and what it takes.
pub trait Store {
    fn held(&self, session_id: &str) -> Result<HashMap<String, i64>>;
    fn append(&self, session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<Appended>;
}

/// `Behind` carries where the service says the file now ends: another writer got there first, and
/// the stretch this run read is no longer the one that fits. Nothing is retried here — the next
/// pass reads from the new end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appended {
    Wrote(i64),
    Behind(i64),
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

/// Sends what the service does not hold of one file, from where it says the file ends to where it
/// ends here. A file the service is already level with costs nothing.
pub fn send_file(store: &impl Store, session_id: &str, source: &Source, held: i64) -> Result<i64> {
    let mut at = held;
    let mut sent = 0;
    while at < source.size {
        let bytes = stretch(&source.path, at)?;
        if bytes.is_empty() {
            return Ok(sent);
        }
        match store.append(session_id, &source.file, at, &bytes)? {
            Appended::Wrote(end) => {
                sent += bytes.len() as i64;
                at = end;
            }
            Appended::Behind(_) => return Ok(sent),
        }
    }
    Ok(sent)
}

/// Every file of one live session, caught up with the service. The session's own transcript is
/// what names the set, so a session whose record carries none sends nothing.
pub fn send_session(store: &impl Store, session_id: &str, transcript: &Path) -> Result<i64> {
    if transcript.as_os_str().is_empty() {
        return Ok(0);
    }
    let held = store.held(session_id)?;
    let mut sent = 0;
    for source in sources(transcript) {
        sent += send_file(store, session_id, &source, held.get(&source.file).copied().unwrap_or(0))?;
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

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

    /// The service as a host can see it: one growing body per file, which is what a reader
    /// concatenating the stretches would get, and the appends refused for landing anywhere but the
    /// end of a file.
    #[derive(Debug, Default)]
    struct Fake {
        files: RefCell<HashMap<String, Vec<u8>>>,
        refused: RefCell<usize>,
    }

    impl Fake {
        fn body(&self, file: &str) -> String {
            String::from_utf8(self.files.borrow().get(file).cloned().unwrap_or_default()).unwrap()
        }
    }

    impl Store for Fake {
        fn held(&self, _session_id: &str) -> Result<HashMap<String, i64>> {
            Ok(self
                .files
                .borrow()
                .iter()
                .map(|(file, body)| (file.clone(), body.len() as i64))
                .collect())
        }

        fn append(&self, _session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<Appended> {
            let mut files = self.files.borrow_mut();
            let body = files.entry(file.to_string()).or_default();
            if offset != body.len() as i64 {
                *self.refused.borrow_mut() += 1;
                return Ok(Appended::Behind(body.len() as i64));
            }
            body.extend_from_slice(bytes);
            Ok(Appended::Wrote(body.len() as i64))
        }
    }

    #[test]
    fn a_session_sends_its_own_transcript_and_every_delegated_turn() {
        let sandbox = Sandbox::new("sources");
        let transcript = sandbox.transcript("s-1", "one\n");
        sandbox.delegated("s-1", "agent-b", "bee\n");
        sandbox.delegated("s-1", "agent-a", "ay\n");

        let named: Vec<String> = sources(&transcript).into_iter().map(|source| source.file).collect();

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

        assert_eq!(send_session(&service, "s-1", &transcript).unwrap(), 11);
        std::fs::write(&transcript, "one\ntwo\nthree\n").unwrap();
        assert_eq!(send_session(&service, "s-1", &transcript).unwrap(), 6);

        assert_eq!(service.body("main"), "one\ntwo\nthree\n");
        assert_eq!(service.body("agent-a"), "ay\n");
        assert_eq!(
            send_session(&service, "s-1", &transcript).unwrap(),
            0,
            "a pass over a transcript that has not grown sends nothing"
        );
        assert_eq!(service.body("main"), "one\ntwo\nthree\n", "no line is written twice");
    }

    #[test]
    fn a_stretch_the_service_has_already_taken_is_dropped_rather_than_duplicated() {
        let sandbox = Sandbox::new("behind");
        let transcript = sandbox.transcript("s-1", "one\ntwo\n");
        let service = Fake::default();
        service.files.borrow_mut().insert("main".to_string(), b"one\n".to_vec());

        // The pass reads from nothing, since that is what a host with no answer yet would do.
        assert_eq!(
            send_file(&service, "s-1", &sources(&transcript).remove(0), 0).unwrap(),
            0
        );

        assert_eq!(*service.refused.borrow(), 1);
        assert_eq!(service.body("main"), "one\n", "a stretch that would overlap is refused");
    }

    #[test]
    fn a_long_transcript_goes_up_a_stretch_at_a_time_and_reads_back_whole() {
        let sandbox = Sandbox::new("chunks");
        let line = format!("{}\n", "x".repeat(999));
        let text = line.repeat(3000);
        let transcript = sandbox.transcript("s-1", &text);
        let service = Fake::default();

        let sent = send_session(&service, "s-1", &transcript).unwrap();

        assert_eq!(sent, text.len() as i64);
        assert_eq!(service.body("main"), text, "the stretches concatenate to the file");
    }
}
