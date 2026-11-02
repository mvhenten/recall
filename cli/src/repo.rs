use std::path::Path;
use std::process::Command;

pub const GLOBAL_TAG: &str = "global";

pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let (host, path) = match url.split_once("://") {
        Some((_, rest)) => {
            let (authority, path) = rest.split_once('/')?;
            (authority, path)
        }
        None => {
            let (authority, path) = url.split_once(':')?;
            if authority.contains('/') {
                return None;
            }
            (authority, path)
        }
    };
    let host = host.rsplit('@').next()?;
    let host = host.split(':').next()?;
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}").to_lowercase())
}

pub fn repo_tag_for_remote(url: &str) -> Option<String> {
    normalize_remote(url).map(|key| format!("repo:{key}"))
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub fn remote_url(dir: &Path) -> Option<String> {
    git(dir, &["remote", "get-url", "origin"]).or_else(|| {
        let remotes = git(dir, &["remote"])?;
        let first = remotes.lines().next()?;
        git(dir, &["remote", "get-url", first])
    })
}

pub fn repo_tag(dir: &Path) -> Option<String> {
    repo_tag_for_remote(&remote_url(dir)?)
}

/// What a session's record says about the work: the subject of the last commit and the branch the
/// tip points at, from the one git call hooks/messaging.mjs makes for the same two fields. %D
/// decorates the tip with "HEAD -> " and the branch it points at; the subject is asked for first
/// here, because this reader trims the output and an empty decoration ahead of it would be read as
/// the subject. A detached head, a repo with no commits and no repo at all each give nothing.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Head {
    pub branch: String,
    pub commit: String,
}

pub fn head(dir: &Path) -> Head {
    let Some(shown) = git(dir, &["log", "-1", "--no-color", "--format=%s%n%D"]) else {
        return Head::default();
    };
    let mut lines = shown.lines();
    let commit = lines.next().unwrap_or_default().trim().to_string();
    let branch = lines
        .next()
        .unwrap_or_default()
        .split(", ")
        .find_map(|reference| reference.strip_prefix("HEAD -> "))
        .unwrap_or_default()
        .to_string();
    Head { branch, commit }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_and_https_forms_share_one_tag() {
        let expected = Some("repo:github.com/acme/widget".to_string());
        for url in [
            "git@github.com:acme/widget.git",
            "git@github.com:acme/widget",
            "ssh://git@github.com/acme/widget.git",
            "ssh://git@github.com:22/acme/widget.git",
            "https://github.com/acme/widget.git",
            "https://github.com/acme/widget/",
            "https://token@github.com/Acme/Widget.git",
            "  https://GitHub.com/acme/widget  ",
        ] {
            assert_eq!(repo_tag_for_remote(url), expected, "{url}");
        }
    }

    #[test]
    fn keeps_nested_group_paths() {
        assert_eq!(
            repo_tag_for_remote("git@gitlab.com:group/sub/project.git"),
            Some("repo:gitlab.com/group/sub/project".to_string())
        );
    }

    #[test]
    fn local_paths_are_not_remotes() {
        assert_eq!(repo_tag_for_remote("/srv/git/recall.git"), None);
        assert_eq!(repo_tag_for_remote("./recall"), None);
    }

    #[test]
    fn worktrees_resolve_to_their_repository_tag() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-repos")
            .join(format!("repo-tag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let main = root.join("main");
        let worktree = root.join("worktree");
        std::fs::create_dir_all(&main).unwrap();
        let run = |dir: &Path, args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        run(&main, &["init", "-q"]);
        run(&main, &["remote", "add", "origin", "git@github.com:Acme/Widget.git"]);
        run(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        run(&main, &["worktree", "add", "-q", worktree.to_str().unwrap()]);
        std::fs::create_dir_all(worktree.join("nested/dir")).unwrap();

        let expected = Some("repo:github.com/acme/widget".to_string());
        assert_eq!(repo_tag(&main), expected);
        assert_eq!(repo_tag(&worktree.join("nested/dir")), expected);
        let head = head(&main);
        assert_eq!(head.commit, "init");
        assert!(!head.branch.is_empty(), "a checked-out branch is named: {head:?}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_remote_means_no_repo_tag() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-repos")
            .join(format!("no-remote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert_eq!(repo_tag(&root), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
