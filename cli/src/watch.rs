use anyhow::{Context, Result};
use notify::{RecursiveMode, Watcher as _};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// How far under a directory a watch reaches. A session's transcript sits in a directory the whole
/// project shares, so that one is watched by itself; the directory holding its subagent turns and
/// its persisted tool outputs is its own and is watched all the way down, since the directories
/// under it appear only once the session delegates or persists something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    Here,
    Below,
}

impl From<Depth> for RecursiveMode {
    fn from(depth: Depth) -> RecursiveMode {
        match depth {
            Depth::Here => RecursiveMode::NonRecursive,
            Depth::Below => RecursiveMode::Recursive,
        }
    }
}

/// A directory no watch could be established on, named the once. The beat is what carries it.
#[derive(Debug)]
pub struct Unwatched {
    pub dir: PathBuf,
    pub error: String,
}

/// Wakes the daemon when a session writes. Every event says the same thing — something under a
/// watched directory moved — because the pass that follows reads all of the live sessions anyway
/// and sends only what grew. A send into a closed channel is dropped: the daemon is on its way out
/// and the beat is still there behind it.
pub struct Watch {
    watcher: notify::RecommendedWatcher,
    watching: BTreeMap<PathBuf, Depth>,
    refused: Vec<PathBuf>,
}

pub fn wake() -> (UnboundedSender<()>, UnboundedReceiver<()>) {
    unbounded_channel()
}

impl Watch {
    /// A watcher on whatever this platform has. Every filesystem notification backend can refuse
    /// to start, and a daemon with no watcher at all still archives on its beat.
    pub fn new(wake: UnboundedSender<()>) -> Result<Watch> {
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event.is_ok() {
                let _ = wake.send(());
            }
        })
        .context("watching the transcripts")?;
        Ok(Watch {
            watcher,
            watching: BTreeMap::new(),
            refused: Vec::new(),
        })
    }

    /// The watches the live sessions want, established, and the ones no live session wants any
    /// more, dropped. A directory the platform refuses is answered for once and then left alone:
    /// a watch that cannot be had on one pass cannot be had on the next either, and saying so
    /// every beat would fill the log for as long as the session runs.
    pub fn sync(&mut self, wanted: &BTreeMap<PathBuf, Depth>) -> Vec<Unwatched> {
        let gone: Vec<PathBuf> = self
            .watching
            .keys()
            .filter(|dir| !wanted.contains_key(*dir))
            .cloned()
            .collect();
        for dir in gone {
            let _ = self.watcher.unwatch(&dir);
            self.watching.remove(&dir);
        }
        self.refused.retain(|dir| wanted.contains_key(dir));
        let mut unwatched = Vec::new();
        for (dir, depth) in wanted {
            if self.watching.get(dir) == Some(depth) {
                continue;
            }
            match self.watcher.watch(dir, RecursiveMode::from(*depth)) {
                Ok(()) => {
                    self.watching.insert(dir.clone(), *depth);
                    self.refused.retain(|refused| refused != dir);
                }
                Err(error) => {
                    if self.refused.iter().any(|refused| refused == dir) {
                        continue;
                    }
                    self.refused.push(dir.clone());
                    unwatched.push(Unwatched {
                        dir: dir.clone(),
                        error: format!("{error}"),
                    });
                }
            }
        }
        unwatched
    }

    #[cfg(test)]
    pub fn established(&self) -> Vec<&std::path::Path> {
        self.watching.keys().map(PathBuf::as_path).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Duration;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("recall-watch-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wanted(dirs: &[(&Path, Depth)]) -> BTreeMap<PathBuf, Depth> {
        dirs.iter().map(|(dir, depth)| (dir.to_path_buf(), *depth)).collect()
    }

    /// A session's set of files grows while it runs, so the watch is on the directories and never
    /// on the files: a subagent turn and a persisted tool output both land under a directory that
    /// did not exist when the session started.
    #[tokio::test]
    async fn a_file_written_after_the_watch_was_established_wakes_the_daemon() {
        let dir = sandbox("fresh");
        let beside = dir.join("s-live");
        std::fs::create_dir_all(beside.join("subagents")).unwrap();
        let (sender, mut woken) = wake();
        let mut watch = Watch::new(sender).unwrap();

        assert!(
            watch
                .sync(&wanted(&[
                    (dir.as_path(), Depth::Here),
                    (beside.as_path(), Depth::Below)
                ]))
                .is_empty()
        );
        std::fs::write(beside.join("subagents").join("agent-7f21.jsonl"), b"{}\n").unwrap();

        tokio::time::timeout(Duration::from_secs(10), woken.recv())
            .await
            .expect("a file created under a watched directory must wake the daemon")
            .expect("the watch holds the sender for as long as it lives");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_directory_no_watch_can_be_had_on_is_named_once_and_then_left_to_the_beat() {
        let dir = sandbox("refused");
        let missing = dir.join("never-written");
        let (sender, _woken) = wake();
        let mut watch = Watch::new(sender).unwrap();
        let asked = wanted(&[(dir.as_path(), Depth::Here), (missing.as_path(), Depth::Below)]);

        let first = watch.sync(&asked);
        assert_eq!(
            first.iter().map(|unwatched| &unwatched.dir).collect::<Vec<_>>(),
            vec![&missing]
        );
        assert!(!first[0].error.is_empty());
        assert_eq!(watch.established(), vec![dir.as_path()]);

        assert!(
            watch.sync(&asked).is_empty(),
            "the same refusal every beat would say nothing the first did not"
        );

        std::fs::create_dir_all(&missing).unwrap();
        assert!(watch.sync(&asked).is_empty());
        assert_eq!(watch.established(), vec![dir.as_path(), missing.as_path()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_session_that_ended_gives_up_its_watches() {
        let dir = sandbox("retired");
        let beside = dir.join("s-ended");
        std::fs::create_dir_all(&beside).unwrap();
        let (sender, _woken) = wake();
        let mut watch = Watch::new(sender).unwrap();

        watch.sync(&wanted(&[
            (dir.as_path(), Depth::Here),
            (beside.as_path(), Depth::Below),
        ]));
        watch.sync(&wanted(&[(dir.as_path(), Depth::Here)]));

        assert_eq!(watch.established(), vec![dir.as_path()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
