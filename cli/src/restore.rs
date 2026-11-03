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

use crate::api::{Client, HeldFile, PastSession};
use crate::transcripts::MAIN;
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

/// Where one of a session's transcript files goes: its own beside the project directory, and every
/// delegated turn under the directory named for the session, as Claude Code writes them.
pub fn file_path(projects: &Path, cwd: &str, session_id: &str, file: &str) -> PathBuf {
    let dir = project_dir(projects, cwd);
    if file == MAIN {
        return dir.join(format!("{session_id}.jsonl"));
    }
    dir.join(session_id).join("subagents").join(format!("{file}.jsonl"))
}

/// One file this run wrote, and how much of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub path: PathBuf,
    pub bytes: u64,
}

/// Whether a file already on disk may be written over. A transcript this host holds more of than
/// the archive does is the live one, or one archived from a run that has not finished going up,
/// and overwriting it would throw lines away; one it holds less of is a part the archive has the
/// whole of.
fn stale(path: &Path, archived: i64) -> Result<bool> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok((metadata.len() as i64) < archived),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
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
) -> Result<Vec<Written>> {
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
    let mut written = Vec::new();
    for held in files {
        let path = file_path(projects, cwd, &session.session_id, &held.file);
        if !stale(&path, held.bytes)? {
            continue;
        }
        let dir = path.parent().context("a transcript path has no directory")?;
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let mut file = std::fs::File::create(&path).with_context(|| format!("writing {}", path.display()))?;
        let bytes = client.read_transcript(&session.session_id, &held.file, &mut file)?;
        written.push(Written { path, bytes });
    }
    Ok(written)
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
    }

    #[test]
    fn a_transcript_this_host_holds_the_whole_of_is_left_where_it_is() {
        let dir = std::env::temp_dir().join(format!("recall-restore-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s-1.jsonl");

        assert!(stale(&path, 10).unwrap(), "a file that is not there is written");
        std::fs::write(&path, "four").unwrap();
        assert!(stale(&path, 10).unwrap(), "a part of the archive is written over");
        assert!(
            !stale(&path, 4).unwrap(),
            "a file the archive is level with is left alone"
        );
        assert!(
            !stale(&path, 2).unwrap(),
            "and one holding more than the archive is the live transcript, which is never truncated"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
