use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

pub const MAX_SEEN: usize = 1000;

/// The message ids already handled, kept beside the lockfile in `$XDG_RUNTIME_DIR/recall` so a
/// restarted daemon does not replay the backlog the mailbox pushes on every reconnect. Oldest
/// ids fall off once the set is full; the queue TTL is shorter than it takes to wrap around.
pub struct Seen {
    path: PathBuf,
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl Seen {
    pub fn load(path: &Path) -> Seen {
        let order: VecDeque<String> = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Seen {
            path: path.to_path_buf(),
            ids: order.iter().cloned().collect(),
            order,
        }
    }

    /// Records a message id, answering whether this daemon or an earlier one already had it.
    pub fn insert(&mut self, message_id: &str) -> bool {
        if !self.ids.insert(message_id.to_string()) {
            return false;
        }
        self.order.push_back(message_id.to_string());
        while self.order.len() > MAX_SEEN {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
        self.save();
        true
    }

    fn save(&self) {
        let Ok(text) = serde_json::to_string(&self.order) else {
            return;
        };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let staged = self.path.with_extension("tmp");
        if std::fs::write(&staged, text).is_ok() {
            let _ = std::fs::rename(&staged, &self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_restarted_daemon_still_knows_what_it_delivered() {
        let dir = std::env::temp_dir().join(format!("recall-seen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("seen.json");

        let mut seen = Seen::load(&path);
        assert!(seen.insert("m-1"));
        assert!(!seen.insert("m-1"));
        assert!(seen.insert("m-2"));

        let mut restarted = Seen::load(&path);
        assert!(!restarted.insert("m-1"));
        assert!(!restarted.insert("m-2"));
        assert!(restarted.insert("m-3"));

        for index in 0..MAX_SEEN {
            restarted.insert(&format!("m-fill-{index}"));
        }
        let mut wrapped = Seen::load(&path);
        assert_eq!(wrapped.order.len(), MAX_SEEN);
        assert!(wrapped.insert("m-1"), "the oldest ids fall off once the set is full");
        assert!(!wrapped.insert("m-fill-999"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
