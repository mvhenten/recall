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
use crate::transcripts::{self, Holds, MAIN, TOOL_RESULT};
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
/// the archive does is the live one, or one archived from a run that has not finished going up,
/// and overwriting it would throw lines away; one it holds less of is a part the archive has the
/// whole of.
///
/// The two are weighed in the archive's own length and never the file's size on disk. What the
/// archive holds is the file redacted, and a placeholder is not the length of the secret it stands
/// in: one access key id is twenty bytes on disk and twenty-eight in the archive, so a complete
/// transcript weighed by its size reads as a part of the archive and is written over — on the host
/// that ran the session, over the transcript it is still writing.
fn stale(path: &Path, archived: i64, holds: Holds) -> Result<bool> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(transcripts::archived_len(path, holds)? < archived),
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
        if !stale(&path, held.bytes, transcripts::holds_of(&held.file))? {
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

    #[test]
    fn a_transcript_this_host_holds_the_whole_of_is_left_where_it_is() {
        let dir = crate::scratch("restore");
        let path = dir.join("s-1.jsonl");

        assert!(
            stale(&path, 10, Holds::Turns).unwrap(),
            "a file that is not there is written"
        );
        std::fs::write(&path, "four\n").unwrap();
        assert!(
            stale(&path, 10, Holds::Turns).unwrap(),
            "a part of the archive is written over"
        );
        assert!(
            !stale(&path, 5, Holds::Turns).unwrap(),
            "a file the archive is level with is left alone"
        );
        assert!(
            !stale(&path, 2, Holds::Turns).unwrap(),
            "and one holding more than the archive is the live transcript, which is never truncated"
        );

        // One access key id is twenty bytes on disk and twenty-eight in the archive, so this
        // complete transcript is the shorter of the two by size and the longer by what it holds.
        let text = "{\"text\":\"AKIAZZ7EXAMPLE9QTVB2\"}\n";
        std::fs::write(&path, text).unwrap();
        let archived = transcripts::archived_len(&path, Holds::Turns).unwrap();
        assert!(
            archived > text.len() as i64,
            "the archive of this one runs longer than the file"
        );
        assert!(
            !stale(&path, archived, Holds::Turns).unwrap(),
            "a complete transcript is left alone, however its size on disk compares"
        );
        assert!(
            stale(&path, archived + 1, Holds::Turns).unwrap(),
            "and one the archive holds more of than this is a part"
        );

        // A part of a transcript whose last line is cut off part way. The record it ends in the
        // middle of is not one a sender puts up, so it weighs nothing here: the file holds four
        // bytes of the archive and thirty-one bytes of itself.
        std::fs::write(&path, format!("one\n{}", "x".repeat(27))).unwrap();
        assert!(
            stale(&path, 8, Holds::Turns).unwrap(),
            "a local part ending part way into a line is fetched, whatever its size on disk"
        );
        assert!(
            !stale(&path, 4, Holds::Turns).unwrap(),
            "and the complete lines of it still weigh what the archive holds of them"
        );
        assert!(
            !stale(&path, 31, Holds::Output).unwrap(),
            "a tool output has no lines to finish, so all thirty-one bytes of this one are the archive's"
        );
        assert!(
            stale(&path, 32, Holds::Output).unwrap(),
            "and an archive holding more than that holds more of it than this host does"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
