//! Putting an archived session back on a host, so `claude --resume <id>` picks it up.
//!
//! Claude Code resumes from the transcript alone: it looks for `<session id>.jsonl` under the
//! project directory of the working directory it was started in, and a transcript it finds there
//! is resumed and read back whole, whichever machine wrote it. There is no registry to join and no
//! metadata to mint, so a restore is a write of the files and nothing else.
//!
//! The project directory is the working directory with every character that is not a letter or a
//! digit written as a dash, which is how Claude Code names them: `/home/you/.dotfiles` is
//! `-home-you--dotfiles`. A session is restored under the directory it ran in unless the caller
//! names another, so the paths its transcript talks about still mean what they said.
//!
//! A turn that persisted a tool output points at it by absolute path, which Claude Code writes as
//! `<home>/.claude/projects/<project directory>/<session id>/tool-results/<name>.txt`. Every part
//! of that but the home directory is reproduced here — the project directory off the working
//! directory the session ran in, the session id off the session, the name off the archive — so a
//! turn's path opens the output it names on any host where this account's home is in the same
//! place. That is the trade `--cwd` already makes for every other path a transcript talks about:
//! restored under another directory, the outputs go where that directory's project is and the
//! turns go on naming the directory the session ran in.

use crate::api::{Client, HeldFile, PastSession};
use crate::transcripts::{MAIN, TOOL_RESULT};
use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};

/// Where Claude Code keeps the transcripts of one working directory.
pub fn project_dir(projects: &Path, cwd: &str) -> PathBuf {
    let named: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    projects.join(named)
}

/// Where one of a session's files goes: its own transcript beside the project directory, and every
/// delegated turn and persisted tool output under the directory named for the session, as Claude
/// Code writes them.
pub fn file_path(projects: &Path, cwd: &str, session_id: &str, file: &str) -> PathBuf {
    let dir = project_dir(projects, cwd);
    if file == MAIN {
        return dir.join(format!("{session_id}.jsonl"));
    }
    if let Some(name) = file.strip_prefix(TOOL_RESULT) {
        return dir.join(session_id).join("tool-results").join(format!("{name}.txt"));
    }
    dir.join(session_id).join("subagents").join(format!("{file}.jsonl"))
}

/// One file this run wrote, and how much of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub path: PathBuf,
    pub bytes: u64,
}

/// What a restore did: the files it wrote, and the ones it left where they were because this host
/// already holds at least as much of them as the archive does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Restored {
    pub written: Vec<Written>,
    pub kept: Vec<PathBuf>,
}

/// Whether a file already on disk may be written over. A transcript this host holds more of than
/// the archive reaches into is the live one, or one archived from a run that has not finished going
/// up, and overwriting it would throw lines away; one it holds less of is a part the archive has
/// the whole of.
///
/// Both numbers are places in the file on disk — the archive says how far into the file it reaches,
/// not how many bytes it holds — so the comparison is the whole of the reading. What the archive
/// holds is the file redacted and a placeholder is not the length of the secret it stands in, so
/// weighing the file against the size of the archive would read a complete transcript as a part and
/// write over it, on the host that ran the session and is still writing it.
fn stale(path: &Path, through: i64) -> Result<bool> {
    match std::fs::metadata(path) {
        Ok(found) => Ok((found.len() as i64) < through),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

/// One file, downloaded beside where it belongs and moved into place once it is whole. A download
/// that fails part way would otherwise leave a truncated transcript under the name Claude Code
/// resumes from, which reads as a session that lost its second half rather than as a failure.
fn download(client: &Client, session_id: &str, file: &str, path: &Path) -> Result<u64> {
    let dir = path.parent().context("a transcript path has no directory")?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let mut partial = path
        .file_name()
        .context("a transcript path has no name")?
        .to_os_string();
    partial.push(".part");
    let partial = path.with_file_name(partial);
    let bytes = {
        let mut into = std::fs::File::create(&partial).with_context(|| format!("writing {}", partial.display()))?;
        client.read_transcript(session_id, file, &mut into).inspect_err(|_| {
            let _ = std::fs::remove_file(&partial);
        })?
    };
    std::fs::rename(&partial, path).with_context(|| format!("moving {} into place", partial.display()))?;
    Ok(bytes)
}

/// Writes one session's transcript files where Claude Code looks for them. A file this host
/// already holds the whole of is left alone rather than fetched again, so restoring a session
/// twice costs nothing and a restore onto the host that ran it never truncates what is there.
pub fn restore(
    client: &Client,
    projects: &Path,
    session: &PastSession,
    files: &[HeldFile],
    cwd: Option<&str>,
) -> Result<Restored> {
    let cwd = cwd.unwrap_or(&session.cwd);
    if cwd.is_empty() {
        bail!(
            "session {} names no directory it ran in, so there is nowhere to restore it; pass --cwd",
            session.session_id
        );
    }
    if files.is_empty() {
        bail!(
            "the archive holds no transcript for session {}, so there is nothing to resume",
            session.session_id
        );
    }
    let mut done = Restored::default();
    for held in files {
        let path = file_path(projects, cwd, &session.session_id, &held.file);
        if !stale(&path, held.through)? {
            done.kept.push(path);
            continue;
        }
        let bytes = download(client, &session.session_id, &held.file, &path)?;
        done.written.push(Written { path, bytes });
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_directory_names_the_project_claude_code_keeps_it_under() {
        let projects = Path::new("/home/you/.claude/projects");

        assert_eq!(
            project_dir(projects, "/home/you/src/recall"),
            projects.join("-home-you-src-recall")
        );
        assert_eq!(
            project_dir(projects, "/home/you/.dotfiles"),
            projects.join("-home-you--dotfiles"),
            "every character that is not a letter or a digit is one dash, so a dot doubles it"
        );
        assert_eq!(
            file_path(projects, "/home/you/src/recall", "s-1", MAIN),
            projects.join("-home-you-src-recall").join("s-1.jsonl")
        );
        assert_eq!(
            file_path(projects, "/home/you/src/recall", "s-1", "agent-7f21"),
            projects
                .join("-home-you-src-recall")
                .join("s-1")
                .join("subagents")
                .join("agent-7f21.jsonl"),
            "a delegated turn goes where Claude Code writes it, under the session's own directory"
        );
        assert_eq!(
            file_path(projects, "/home/you/src/recall", "s-1", "tool-results.b374nf1qv"),
            projects
                .join("-home-you-src-recall")
                .join("s-1")
                .join("tool-results")
                .join("b374nf1qv.txt"),
            "and a persisted output goes under the path the turn pointing at it names"
        );
    }

    /// The archive answers in places in the file on disk, so the one thing a restore has to get
    /// right is which of the two holds more of the file. A transcript full of secrets reads to a
    /// far longer archive than itself — one access key id is twenty bytes on disk and twenty-eight
    /// redacted — and none of that enters the reading, which is why a complete transcript on the
    /// host still writing it is never written over.
    #[test]
    fn a_transcript_this_host_holds_the_whole_of_is_left_where_it_is() {
        let dir = crate::scratch("restore");
        let path = dir.join("s-1.jsonl");

        assert!(stale(&path, 10).unwrap(), "a file that is not there is written");
        std::fs::write(&path, "four\n").unwrap();
        assert!(stale(&path, 10).unwrap(), "a part of the archive is written over");
        assert!(
            !stale(&path, 5).unwrap(),
            "a file the archive is level with is left alone"
        );
        assert!(
            !stale(&path, 2).unwrap(),
            "and one holding more than the archive is the live transcript, which is never truncated"
        );

        let text = "{\"text\":\"AKIAZZ7EXAMPLE9QTVB2\"}\n";
        std::fs::write(&path, text).unwrap();
        assert!(
            !stale(&path, text.len() as i64).unwrap(),
            "a complete transcript is left alone, however long the archive of it runs"
        );
        assert!(
            stale(&path, text.len() as i64 + 1).unwrap(),
            "and one the archive reaches further into than this is a part"
        );

        // A part of a transcript whose last line is cut off part way. No pass archives that
        // record, so the archive reaches the end of the line in front of it and no further.
        std::fs::write(&path, format!("one\n{}", "x".repeat(27))).unwrap();
        assert!(
            stale(&path, 32).unwrap(),
            "a local part the archive reaches past is fetched"
        );
        assert!(
            !stale(&path, 31).unwrap(),
            "and one holding every byte the archive reaches is left alone"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
