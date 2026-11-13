//! The summariser the daemon starts detached when this host takes a peek: the end of one
//! session's transcript, read on the host that session runs on, put through Haiku and written
//! back as the peek's digest.
//!
//! It is a process of its own and reaches no session's inbox, so the session it describes carries
//! none of this in its context. Every step is final: a session with no record here, a transcript
//! that cannot be read, a Claude Code that is not installed or answers nothing, and a service that
//! refuses the digest each end the run with the reason on stderr and in the hooks log. The peek is
//! left pending, which is what the asker reads back and what the session's history shows, and
//! nothing tries it again.

use crate::api::Client;
use crate::config;
use crate::listen::{log, sessions_dir};
use crate::sessions;
use crate::transcripts::{self, Appended, Holds, MAIN, Pass, Place, Reader, Store};
use anyhow::{Context, Result, anyhow, bail};
use std::cell::RefCell;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Claude Code itself, which every host that runs a session is already signed in to. The digest is
/// read by that login and no key is kept here for it.
const CLAUDE: &str = "claude";

pub const MODEL: &str = "haiku";

/// How much of the transcript's end the digest is read from. A turn is one line of JSON and a peek
/// asks what the session is doing now, which the last few of them say; a transcript runs to
/// megabytes, and offering the whole of one would cost a model call out of all proportion to the
/// two sentences it answers with.
pub const TAIL_BYTES: u64 = 32 * 1024;

/// What the model is asked. The tail arrives on stdin in front of it.
pub const PROMPT: &str = "The lines above are the tail of a Claude Code session's transcript, as JSON. \
Say in 2 or 3 sentences what this session is working on and what it is waiting on or stuck on. \
Write plain sentences for someone reading a list of sessions: no markdown, no lists, no code, no \
preamble, and nothing about the transcript itself.";

/// No MCP server at all, which is what `--strict-mcp-config` holds the run to. A summariser needs
/// no tool, and the servers this host configures include recall's own.
const NO_MCP: &str = r#"{"mcpServers":{}}"#;

/// What the summariser's own Claude run carries, which `hooks/session-start.mjs` reads to leave it
/// alone. Without it the run registers as a session of this host, syncs itself to the service and
/// turns up in the listing beside the session it was started to describe.
pub const PEEK_ENV: &str = "RECALL_PEEK";

/// How long a digest the service takes, counted in UTF-16 code units, which is how its schema
/// counts a string.
pub const MAX_DIGEST: usize = 2000;

/// Haiku answers a tail this size in seconds. The ceiling is for a run that is not answering at
/// all: a model call that hangs would otherwise hold a process on this host for as long as the
/// daemon runs.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Where the records of the tail land. The reader sends them through a store, the same way a pass
/// over a file sends them to the service, so the tail is redacted by exactly the code that redacts
/// every record this host archives.
#[derive(Debug, Default)]
struct Collected {
    records: RefCell<Vec<String>>,
}

impl Store for Collected {
    fn append(&self, _session_id: &str, _file: &str, from: i64, records: &[String], _closed: bool) -> Result<Appended> {
        self.records.borrow_mut().extend(records.iter().cloned());
        Ok(Appended::Written(from + records.len() as i64))
    }
}

/// The end of one transcript, redacted, as the records it holds. The read opens `bytes` from the
/// end of the file and drops whatever line that lands inside, since half a line of JSON says
/// nothing and the record it belongs to is in the stretch this tail leaves behind. It is an open
/// pass: the session is still writing, so the line at the end that no break closed is not a record
/// yet.
pub fn tail(session_id: &str, path: &Path, bytes: u64) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let held = file
        .metadata()
        .with_context(|| format!("reading {}", path.display()))?
        .len();
    let from = held.saturating_sub(bytes);
    file.seek(SeekFrom::Start(from))
        .with_context(|| format!("reading the end of {}", path.display()))?;
    let mut source = BufReader::new(file);
    if from > 0 {
        source
            .read_until(b'\n', &mut Vec::new())
            .with_context(|| format!("reading the end of {}", path.display()))?;
    }
    let read = Collected::default();
    let mut reader = Reader::new(source, Holds::Turns, Pass::Open);
    transcripts::send_from(&read, session_id, MAIN, &mut reader, Place::nothing(), usize::MAX)?;
    let records = read.records.into_inner();
    if records.is_empty() {
        bail!(
            "{} holds no turn this host can read, so there is nothing to summarise",
            path.display()
        );
    }
    Ok(records.join("\n"))
}

/// The headless run: print mode on Haiku, nothing kept on disk, no MCP server and no tool, so it
/// reads the tail it is handed and answers in one pass. It runs in the temporary directory rather
/// than the session's own, since a repository's instructions have no place in a status line about
/// another session.
pub fn summariser() -> Command {
    let mut command = Command::new(CLAUDE);
    command
        .arg("-p")
        .arg(PROMPT)
        .arg("--model")
        .arg(MODEL)
        .arg("--output-format")
        .arg("text")
        .arg("--no-session-persistence")
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg(NO_MCP)
        .arg("--tools")
        .arg("")
        .env(PEEK_ENV, "1")
        .current_dir(std::env::temp_dir());
    command
}

/// The answer as the service takes it. A model that wrote more than the schema holds is cut, since
/// two sentences of a three sentence answer still say what the session is doing; one that wrote
/// nothing has answered nothing, and the peek keeps the empty digest it already had.
pub fn digest(answer: &str) -> Result<String> {
    let written = answer.trim();
    if written.is_empty() {
        bail!("{CLAUDE} answered nothing, so this peek keeps no digest");
    }
    Ok(cut(written, MAX_DIGEST))
}

fn cut(text: &str, units: usize) -> String {
    let mut taken = 0;
    for (at, character) in text.char_indices() {
        if taken + character.len_utf16() > units {
            return text[..at].to_string();
        }
        taken += character.len_utf16();
    }
    text.to_string()
}

/// The run's exit status, or the end of it where it stopped answering. A kill is the only way out
/// of a model call that hangs, and the peek it was started for stays pending.
fn waited(child: &mut Child) -> Result<ExitStatus> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().with_context(|| format!("waiting for {CLAUDE}"))? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{CLAUDE} took longer than {} seconds over the transcript tail",
                TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Hands the tail to the model and reads the one answer back. The output is read on a thread of
/// its own, so a run that writes more than a pipe holds is never waited on while it blocks on the
/// write. Whatever it put on stderr goes where this process's own stderr goes, which is the
/// terminal of whoever ran the command by hand and nothing at all for the daemon's detached start.
pub fn summarise(tail: &str) -> Result<String> {
    let mut child = summariser()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting {CLAUDE}; a host that summarises a peek runs Claude Code"))?;
    let mut answered = child.stdout.take().expect("the summariser's output is a pipe");
    let reading = std::thread::spawn(move || {
        let mut answer = String::new();
        answered.read_to_string(&mut answer).map(|_| answer)
    });
    child
        .stdin
        .take()
        .expect("the summariser's input is a pipe")
        .write_all(tail.as_bytes())
        .with_context(|| format!("handing the transcript tail to {CLAUDE}"))?;
    let status = waited(&mut child)?;
    let answer = reading
        .join()
        .map_err(|_| anyhow!("reading what {CLAUDE} answered failed"))?
        .with_context(|| format!("reading what {CLAUDE} answered"))?;
    if !status.success() {
        bail!("{CLAUDE} exited with {status} and wrote no digest");
    }
    digest(&answer)
}

fn summarised(session_id: &str, peek_id: &str) -> Result<usize> {
    let record = sessions::record(&sessions_dir(), session_id)
        .ok_or_else(|| anyhow!("this host runs no session {session_id}, so it holds no transcript to summarise"))?;
    if record.transcript_path.as_os_str().is_empty() {
        bail!("this host's record of session {session_id} names no transcript");
    }
    let read = tail(session_id, &record.transcript_path, TAIL_BYTES)?;
    let digest = summarise(&read)?;
    Client::new(config::load()?).write_peek(session_id, peek_id, &digest)?;
    Ok(digest.len())
}

/// Summarises one session of this host and puts the digest on the peek that asked for it. The
/// daemon starts this detached and reads nothing back but the exit status, so the outcome is
/// written to the log the hooks and the daemon share.
pub fn run(session_id: &str, peek_id: &str) -> Result<()> {
    let started = Instant::now();
    match summarised(session_id, peek_id) {
        Ok(bytes) => {
            log(&format!("peek:{peek_id}:{session_id}:wrote:{bytes}"), started.elapsed());
            Ok(())
        }
        Err(error) => {
            log(
                &format!("peek:{peek_id}:{session_id}:failed:{error:#}"),
                started.elapsed(),
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    /// One turn as a session writes it, long enough that a few hundred of them run past the window
    /// the tail is read from.
    fn turn(at: usize) -> String {
        let text = "x".repeat(200);
        format!(r#"{{"type":"user","message":{{"role":"user","content":"turn:{at} {text}"}}}}"#)
    }

    /// Nothing of the host or the session reaches the run: it prints one answer from Haiku, keeps
    /// no session on disk, loads no MCP server and holds no tool. It also names itself to the
    /// hooks, which is what keeps a summariser out of the session listing it is summarising for.
    #[test]
    fn the_summariser_asks_haiku_for_the_one_answer_and_registers_no_session() {
        let command = summariser();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();

        assert_eq!(command.get_program(), OsStr::new(CLAUDE));
        assert_eq!(&args[..2], &["-p", PROMPT], "the prompt is the whole of what is asked");
        for pair in [
            ["--model", MODEL],
            ["--output-format", "text"],
            ["--mcp-config", NO_MCP],
            ["--tools", ""],
        ] {
            assert!(args.windows(2).any(|read| read == pair), "{pair:?} in {args:?}");
        }
        assert!(args.contains(&"--no-session-persistence"), "{args:?}");
        assert!(args.contains(&"--strict-mcp-config"), "{args:?}");
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == OsStr::new(PEEK_ENV) && value == Some(OsStr::new("1"))),
            "the run says it is a summariser, so the session start hook skips it"
        );
        assert!(
            PROMPT.contains("2 or 3 sentences") && PROMPT.contains("no markdown"),
            "{PROMPT}"
        );
    }

    /// The service refuses a digest longer than its schema holds, and a model asked for three
    /// sentences writes four often enough that cutting it is the answer. A length is counted the
    /// way the service counts one, so an answer written in characters that cross as two code units
    /// each is cut at half as many of them.
    #[test]
    fn a_digest_is_what_the_model_wrote_cut_to_what_the_service_takes() {
        assert_eq!(digest("  Reading the planner.  ").unwrap(), "Reading the planner.");

        let written = digest(&"x".repeat(MAX_DIGEST + 500)).unwrap();
        assert_eq!(written.len(), MAX_DIGEST);

        let wide = digest(&"🙂".repeat(MAX_DIGEST)).unwrap();
        assert_eq!(wide.chars().count(), MAX_DIGEST / 2, "two code units each");

        assert!(digest(" \n ").is_err(), "an empty answer is no digest");
    }

    /// The tail is the end of the transcript and not the whole of it, and it leaves the host
    /// redacted: a key a session pasted into a turn is a secret wherever it is read, and this
    /// stretch goes to a model like every other stretch goes to the service.
    #[test]
    fn the_tail_is_the_end_of_the_transcript_with_its_secrets_taken_out() {
        let dir = crate::scratch("peek-tail");
        let path = dir.join("s-9f8a.jsonl");
        let mut written: Vec<String> = (0..200).map(turn).collect();
        written
            .push(r#"{"type":"user","message":{"role":"user","content":"key AKIAZZ7EXAMPLE9QTVB2 here"}}"#.to_string());
        written.push(turn(999));
        std::fs::write(&path, format!("{}\n", written.join("\n"))).unwrap();

        let read = tail("s-9f8a", &path, TAIL_BYTES).unwrap();

        assert!(read.contains("turn:999"), "the last turn is in the tail");
        assert!(!read.contains("turn:0 "), "and the first is not: {}", read.len());
        assert!(read.contains("[redacted:aws-access-key-id]"), "{read}");
        assert!(!read.contains("AKIAZZ7EXAMPLE9QTVB2"), "the key never leaves this host");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
