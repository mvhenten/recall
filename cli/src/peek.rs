//! The summariser the daemon starts detached when this host takes a peek: the end of one
//! session's transcript, read on the host that session runs on, put through Haiku and written
//! back as the peek's digest.
//!
//! It is a process of its own and reaches no session's inbox, so the session it describes carries
//! none of this in its context. Every step is final: a session with no record here, a transcript
//! that cannot be read, a Claude Code that is not installed or answers nothing, and a service that
//! had an error each end the run with the reason on stderr and in the hooks log. The peek is left
//! pending, which is what the asker reads back and what the session's history shows, and nothing
//! tries it again.

use crate::api::{Client, Wrote};
use crate::config;
use crate::listen::{log, runtime_dir, sessions_dir};
use crate::sessions;
use crate::transcripts::{self, Appended, Holds, MAIN, Pass, Place, Reader, Store};
use anyhow::{Context, Result, anyhow, bail};
use std::cell::RefCell;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Claude Code itself, which every host running a session is already signed in to. The digest is
/// read under that login, so this host keeps no key of its own for it.
const CLAUDE: &str = "claude";

const MODEL: &str = "haiku";

/// How many records of the transcript's end the digest is read from. A peek asks what a session is
/// doing now, which its last turns say, and twenty of them reach back past the tool calls of the
/// current turn to the prompt that started it.
const TAIL_RECORDS: usize = 20;

/// How much of those records goes to the model. One record is one line, and a turn that holds a
/// file runs to hundreds of kilobytes, so a tail cut to a window of bytes alone holds no whole
/// line at all on such a session and the peek never answers. The records are found first and the
/// end of them is what goes up.
const TAIL_BYTES: usize = 64 * 1024;

/// What the model is asked. The tail follows it, since Claude Code puts the prompt it is given
/// first and whatever arrived on stdin after it.
const PROMPT: &str = "The lines below are the tail of a Claude Code session's transcript, as JSON. \
Say in 2 or 3 sentences what this session is working on and what it is waiting on or stuck on. \
Write plain sentences for someone reading a list of sessions: no markdown, no lists, no code, no \
preamble, and nothing about the transcript itself.";

/// How long a digest the service takes, counted in UTF-16 code units, which is how its schema
/// counts a string. `PeekDigest` in `typespec/generated/openapi.json` is where that number lives,
/// and the test below is what holds this one to it.
const MAX_DIGEST: usize = 2000;

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

/// Where the last `records` records of a file begin: the byte after the break closing the record
/// in front of them, and the file's first byte where it holds fewer. The walk back stops at the
/// first record boundary past `bytes`, so a session whose last turn runs to megabytes is read from
/// the start of that turn and no further back.
fn opens_at(file: &mut File, held: u64, records: usize, bytes: u64) -> Result<u64> {
    let mut at = held;
    let mut found = 0;
    let mut read = [0u8; 8192];
    while at > 0 {
        let step = (read.len() as u64).min(at) as usize;
        at -= step as u64;
        file.seek(SeekFrom::Start(at))
            .context("reading back through a transcript")?;
        file.read_exact(&mut read[..step])
            .context("reading back through a transcript")?;
        for (index, byte) in read[..step].iter().enumerate().rev() {
            if *byte != b'\n' {
                continue;
            }
            let opens = at + index as u64 + 1;
            // The break that closes the file ends the last record rather than opening one.
            if opens == held {
                continue;
            }
            found += 1;
            if found == records || held - opens >= bytes {
                return Ok(opens);
            }
        }
    }
    Ok(0)
}

/// The end of one transcript, redacted, as the records it holds. It is an open pass: the session
/// is still writing, so the line at the end that no break closed is not a record yet.
fn tail(session_id: &str, path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let held = file
        .metadata()
        .with_context(|| format!("reading {}", path.display()))?
        .len();
    let opens = opens_at(&mut file, held, TAIL_RECORDS, TAIL_BYTES as u64)
        .with_context(|| format!("reading the end of {}", path.display()))?;
    file.seek(SeekFrom::Start(opens))
        .with_context(|| format!("reading the end of {}", path.display()))?;
    let read = Collected::default();
    let mut reader = Reader::new(BufReader::new(file), Holds::Turns, Pass::Open);
    transcripts::send_from(&read, session_id, MAIN, &mut reader, &mut Place::nothing(), usize::MAX)?;
    let records = read.records.into_inner();
    if records.is_empty() {
        bail!(
            "{} holds no turn this host can read, so there is nothing to summarise",
            path.display()
        );
    }
    Ok(ending(&records.join("\n"), TAIL_BYTES).to_string())
}

/// The end of the tail, where the records found hold more than goes up. The cut lands on a
/// character, and it is made after the redactor has read the records, so nothing of a secret can
/// be left behind by it.
fn ending(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut from = text.len() - bytes;
    while !text.is_char_boundary(from) {
        from += 1;
    }
    &text[from..]
}

/// The headless run: print mode on Haiku, with every customisation of this host off. A summariser
/// answers out of the tail it is handed and nothing else, and safe mode is what keeps the hooks,
/// the plugins, the skills, the MCP servers and the instruction files of whoever runs Claude Code
/// here out of it — recall's own hooks included, which would otherwise register the summariser as
/// a session of this host and hand it the user's memories. It runs in recall's own runtime
/// directory, which this user owns, rather than a world-writable one. This host's credentials are
/// taken out of the environment it inherits, so a run that reads a transcript holds no way of its
/// own to send one anywhere.
fn summariser() -> Command {
    let dir = runtime_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut command = Command::new(CLAUDE);
    command
        .arg("-p")
        .arg(PROMPT)
        .arg("--model")
        .arg(MODEL)
        .arg("--output-format")
        .arg("text")
        .arg("--safe-mode")
        .arg("--no-session-persistence")
        .arg("--tools")
        .arg("")
        .current_dir(dir);
    for key in config::AUTH_KEYS {
        command.env_remove(key);
    }
    command
}

/// The answer as the service takes it. A model that wrote more than the schema holds is cut, since
/// two sentences of a three sentence answer still say what the session is doing; one that wrote
/// nothing has answered nothing, and the peek keeps the empty digest it already had.
fn digest(answer: &str) -> Result<String> {
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
fn waited(child: &mut Child, within: Duration) -> Result<ExitStatus> {
    let deadline = Instant::now() + within;
    loop {
        if let Some(status) = child.try_wait().with_context(|| format!("waiting for {CLAUDE}"))? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{CLAUDE} took longer than {} seconds over the transcript tail",
                within.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Hands the tail to the model and reads the one answer back. Each pipe is worked on a thread of
/// its own: a tail runs to tens of kilobytes and an answer to whatever the model wrote, and either
/// of them past what a pipe holds would have this process blocked on one pipe while the run it is
/// waiting on blocks on the other. Whatever the run put on stderr goes where this process's own
/// stderr goes, which is the terminal of whoever ran the command by hand and nothing at all for
/// the daemon's detached start.
fn summarise(mut command: Command, tail: String, within: Duration) -> Result<String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting {CLAUDE}; a host that answers a peek runs Claude Code"))?;
    let mut answered = child.stdout.take().expect("the summariser's output is a pipe");
    let reading = std::thread::spawn(move || {
        let mut answer = String::new();
        answered.read_to_string(&mut answer).map(|_| answer)
    });
    let mut handed = child.stdin.take().expect("the summariser's input is a pipe");
    // A run that stopped reading its input closes the pipe, which is where the rest of the tail
    // goes. It is the end of the handover and not a fault: that run has already decided the
    // outcome, and its exit status is what says which one.
    let writing = std::thread::spawn(move || match handed.write_all(tail.as_bytes()) {
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        handed => handed,
    });
    let status = waited(&mut child, within)?;
    if !status.success() {
        bail!("{CLAUDE} exited with {status} and wrote no digest");
    }
    writing
        .join()
        .map_err(|_| anyhow!("handing the transcript tail to {CLAUDE} failed"))?
        .with_context(|| format!("handing the transcript tail to {CLAUDE}"))?;
    let answer = reading
        .join()
        .map_err(|_| anyhow!("reading what {CLAUDE} answered failed"))?
        .with_context(|| format!("reading what {CLAUDE} answered"))?;
    digest(&answer)
}

/// The login is read before the model is asked anything, so a host that is signed out finds that
/// out without spending a model call first.
fn summarised(session_id: &str, peek_id: &str) -> Result<String> {
    let client = Client::new(config::load()?);
    let record = sessions::record(&sessions_dir(), session_id)
        .ok_or_else(|| anyhow!("this host runs no session {session_id}, so it holds no transcript to summarise"))?;
    if record.transcript_path.as_os_str().is_empty() {
        bail!("this host's record of session {session_id} names no transcript");
    }
    let read = tail(session_id, &record.transcript_path)?;
    let digest = summarise(summariser(), read, TIMEOUT)?;
    Ok(match client.write_peek(session_id, peek_id, &digest)? {
        Wrote::Digest => format!("wrote:{}", digest.len()),
        Wrote::Held => "answered-already".to_string(),
        Wrote::Gone => "gone".to_string(),
    })
}

/// Summarises one session of this host and puts the digest on the peek that asked for it. The
/// daemon starts this detached and reads nothing back but the exit status, so the outcome is
/// written to the log the hooks and the daemon share.
pub fn run(session_id: &str, peek_id: &str) -> Result<()> {
    let started = Instant::now();
    match summarised(session_id, peek_id) {
        Ok(outcome) => {
            log(&format!("peek:{peek_id}:{session_id}:{outcome}"), started.elapsed());
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
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// One turn as a session writes it, long enough that a few hundred of them run past the window
    /// the tail is cut to.
    fn turn(at: usize) -> String {
        let text = "x".repeat(200);
        format!(r#"{{"type":"user","message":{{"role":"user","content":"turn:{at} {text}"}}}}"#)
    }

    fn written(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        path
    }

    /// A Claude Code that answers what the test tells it to, and none of the real one. What is
    /// proved through it is everything around the model call: a tail larger than a pipe holds, an
    /// answer larger than a pipe holds, a run that fails, and a run that never answers.
    fn stub(dir: &Path, name: &str, body: &str) -> Command {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        Command::new(path)
    }

    /// Nothing of this host reaches the run: it prints one answer from Haiku, holds no tool and
    /// takes this host's hooks, plugins, skills, MCP servers and instruction files out of the way,
    /// which is also what keeps a summariser from registering as a session of its own. The
    /// credentials it would otherwise inherit are taken out of its environment, so a run that
    /// reads a transcript cannot send one anywhere.
    #[test]
    fn the_summariser_asks_haiku_for_the_one_answer_with_this_host_out_of_the_way() {
        let command = summariser();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();

        assert_eq!(command.get_program(), OsStr::new(CLAUDE));
        assert_eq!(&args[..2], &["-p", PROMPT], "the prompt is the whole of what is asked");
        for pair in [["--model", MODEL], ["--output-format", "text"], ["--tools", ""]] {
            assert!(args.windows(2).any(|read| read == pair), "{pair:?} in {args:?}");
        }
        assert!(args.contains(&"--safe-mode"), "{args:?}");
        assert!(args.contains(&"--no-session-persistence"), "{args:?}");
        assert_eq!(command.get_current_dir(), Some(runtime_dir().as_path()));
        for key in config::AUTH_KEYS {
            assert!(
                command
                    .get_envs()
                    .any(|(name, value)| name == OsStr::new(key) && value.is_none()),
                "{key} is taken out of what the run inherits"
            );
        }
    }

    /// The whole of the tail reaches the run and the whole of the answer comes back, neither held
    /// to what a pipe carries.
    #[test]
    fn the_tail_is_handed_over_whole_and_the_answer_read_back_whole() {
        let dir = crate::scratch("peek-summarise");
        let handed = dir.join("handed");
        let mut answering = stub(&dir, "answers", r#"cat > "$HANDED"; printf '  Reading the planner.\n'"#);
        answering.env("HANDED", &handed);
        let read = "x".repeat(200 * 1024);

        let answer = summarise(answering, read.clone(), Duration::from_secs(30)).unwrap();

        assert_eq!(answer, "Reading the planner.");
        assert_eq!(
            std::fs::read_to_string(&handed).unwrap(),
            read,
            "the tail reached it whole"
        );

        let shouting = stub(&dir, "shouts", r#"head -c 200000 /dev/zero | tr '\0' 'x'"#);
        let long = summarise(shouting, "turns".to_string(), Duration::from_secs(30)).unwrap();
        assert_eq!(long.len(), MAX_DIGEST, "an answer past the cap is cut, not refused");
    }

    /// A run that fails, a run that hangs and a Claude Code that is not installed all leave the
    /// peek pending, and each says which it was. The failing one is handed more than a pipe
    /// carries and reads none of it, so the handover ends on a closed pipe: what this host reports
    /// is the status that run exited with and never the pipe that closed under it.
    #[test]
    fn a_summariser_that_fails_or_hangs_writes_no_digest() {
        let dir = crate::scratch("peek-failing");

        let failed = summarise(
            stub(&dir, "fails", "printf 'no model\\n' >&2; exit 3"),
            "x".repeat(200 * 1024),
            Duration::from_secs(30),
        )
        .unwrap_err();
        assert!(format!("{failed:#}").contains("exit status: 3"), "{failed:#}");

        let hung = summarise(
            stub(&dir, "hangs", "sleep 30"),
            "turns".to_string(),
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(format!("{hung:#}").contains("took longer than"), "{hung:#}");

        let missing = summarise(
            Command::new(dir.join("no-claude-here")),
            "turns".to_string(),
            Duration::from_secs(30),
        )
        .unwrap_err();
        assert!(format!("{missing:#}").contains("runs Claude Code"), "{missing:#}");
    }

    /// The service refuses a digest longer than its schema holds, and a model asked for three
    /// sentences writes four often enough that cutting it is the answer. A length is counted the
    /// way the service counts one, so an answer written in characters that cross as two code units
    /// each is cut at half as many of them.
    #[test]
    fn a_digest_is_what_the_model_wrote_cut_to_what_the_service_takes() {
        assert_eq!(digest("  Reading the planner.  ").unwrap(), "Reading the planner.");

        let long = digest(&"x".repeat(MAX_DIGEST + 500)).unwrap();
        assert_eq!(long.len(), MAX_DIGEST);

        let wide = digest(&"🙂".repeat(MAX_DIGEST)).unwrap();
        assert_eq!(wide.chars().count(), MAX_DIGEST / 2, "two code units each");

        assert!(digest(" \n ").is_err(), "an empty answer is no digest");
    }

    /// The cap is the service's, and a digest cut to a length it still refuses is a peek that
    /// never answers. The generated document the service is built from is where that number is
    /// read, so neither side can move it alone.
    #[test]
    fn the_cut_is_the_length_the_service_declares() {
        let api: serde_json::Value = serde_json::from_str(include_str!("../../typespec/generated/openapi.json"))
            .expect("typespec/generated/openapi.json parses as JSON");
        let declared = api["components"]["schemas"]["PeekDigest"]["maxLength"]
            .as_u64()
            .expect("PeekDigest declares how long a digest may be");

        assert_eq!(declared, MAX_DIGEST as u64);
    }

    /// The tail is the end of the transcript and not the whole of it, and it leaves the host
    /// redacted: a key a session pasted into a turn is a secret wherever it is read, and this
    /// stretch goes to a model like every other stretch goes to the service.
    #[test]
    fn the_tail_is_the_last_turns_of_the_transcript_with_their_secrets_taken_out() {
        let dir = crate::scratch("peek-tail");
        let mut lines: Vec<String> = (0..200).map(turn).collect();
        lines
            .push(r#"{"type":"user","message":{"role":"user","content":"key AKIAZZ7EXAMPLE9QTVB2 here"}}"#.to_string());
        lines.push(turn(900));
        let path = written(&dir, "s-9f8a.jsonl", &lines);

        let read = tail("s-9f8a", &path).unwrap();

        assert_eq!(read.lines().count(), TAIL_RECORDS);
        assert!(read.contains("turn:900"), "the last turn is in the tail");
        assert!(
            !read.contains("turn:181 "),
            "and the turns before the last twenty are not"
        );
        assert!(read.contains("[redacted:aws-access-key-id]"), "{read}");
        assert!(!read.contains("AKIAZZ7EXAMPLE9QTVB2"), "the key never leaves this host");
    }

    /// A turn that holds a file runs past anything a window of bytes would carry. Counting the
    /// records back is what finds it at all: such a window, read backwards, holds no whole line of
    /// a transcript like this and the peek never answers. The end of that turn is what goes up.
    #[test]
    fn a_turn_longer_than_the_window_is_still_read_and_still_cut_to_it() {
        let dir = crate::scratch("peek-heavy");
        let heavy = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}}}}"#,
            "y".repeat(400 * 1024)
        );
        let path = written(&dir, "s-heavy.jsonl", &[turn(1), heavy]);

        let read = tail("s-heavy", &path).unwrap();

        assert_eq!(read.len(), TAIL_BYTES);
        assert!(read.ends_with(r#"y"}}"#), "the end of the turn is what goes up");
        assert!(!read.contains("turn:1 "), "{}", read.len());
    }
}
