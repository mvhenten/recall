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

    /// Whether this daemon or an earlier one already handled the message.
    pub fn contains(&self, message_id: &str) -> bool {
        self.ids.contains(message_id)
    }

    /// Records a message id, which only happens once it has been delivered. Recording ahead of
    /// delivery would turn an interrupted handover into a lost message: the id would survive the
    /// restart, the redelivery would short-circuit, and the ack would drop the row unread.
    pub fn record(&mut self, message_id: &str) {
        if !self.ids.insert(message_id.to_string()) {
            return;
        }
        self.order.push_back(message_id.to_string());
        while self.order.len() > MAX_SEEN {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
        self.save();
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
        assert!(!seen.contains("m-1"));
        seen.record("m-1");
        assert!(seen.contains("m-1"));
        seen.record("m-2");

        let mut restarted = Seen::load(&path);
        assert!(restarted.contains("m-1"));
        assert!(restarted.contains("m-2"));
        assert!(!restarted.contains("m-3"));

        for index in 0..MAX_SEEN {
            restarted.record(&format!("m-fill-{index}"));
        }
        let wrapped = Seen::load(&path);
        assert_eq!(wrapped.order.len(), MAX_SEEN);
        assert!(!wrapped.contains("m-1"), "the oldest ids fall off once the set is full");
        assert!(wrapped.contains("m-fill-999"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
