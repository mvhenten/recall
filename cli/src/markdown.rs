use crate::api::{Elsewhere, HeldFile, Hit, Memory, PastSession, Session, SessionHit};
use crate::sessions;
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

#[derive(Debug, Default, PartialEq)]
pub struct Document {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub tags: Vec<String>,
    pub body: String,
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        .unwrap_or(value)
}

fn parse_tags(value: &str) -> Vec<String> {
    let value = value.trim();
    let inner = value
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(value);
    inner
        .split(',')
        .map(unquote)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn parse(text: &str) -> Document {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return Document {
            body: text.to_string(),
            ..Document::default()
        };
    };
    let Some(end) = rest.find("\n---") else {
        return Document {
            body: text.to_string(),
            ..Document::default()
        };
    };
    let header = &rest[..end];
    let after = &rest[end + 4..];
    let body = after
        .strip_prefix("\r\n")
        .or_else(|| after.strip_prefix('\n'))
        .unwrap_or(after);
    let mut document = Document {
        body: body.trim_start_matches('\n').to_string(),
        ..Document::default()
    };
    let mut lines = header.lines().peekable();
    while let Some(line) = lines.next() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "name" => document.name = unquote(value).to_string(),
            "description" => document.description = unquote(value).to_string(),
            "type" => document.kind = unquote(value).to_string(),
            "tags" if value.trim().is_empty() => {
                while let Some(item) = lines.peek().and_then(|next| next.trim().strip_prefix("- ")) {
                    document.tags.push(unquote(item).to_string());
                    lines.next();
                }
            }
            "tags" => document.tags = parse_tags(value),
            _ => {}
        }
    }
    document
}

pub fn iso(ms: i64) -> String {
    if ms == 0 {
        return "never".to_string();
    }
    match Timestamp::from_millisecond(ms) {
        Ok(timestamp) => timestamp.strftime("%Y-%m-%dT%H:%M:%SZ").to_string(),
        Err(_) => format!("{ms} ms"),
    }
}

pub fn parse_since(value: &str) -> Option<i64> {
    if let Ok(ms) = value.parse::<i64>() {
        return Some(ms);
    }
    if let Ok(timestamp) = value.parse::<Timestamp>() {
        return Some(timestamp.as_millisecond());
    }
    let date = value.parse::<Date>().ok()?;
    Some(date.to_zoned(TimeZone::UTC).ok()?.timestamp().as_millisecond())
}

pub fn render(memory: &Memory) -> String {
    format!(
        "---\nname: {}\ndescription: {}\ntype: {}\ntags: [{}]\ncreated: {}\nupdated: {}\nrecalled: {} times, last {}\n---\n\n{}\n",
        memory.name,
        memory.description,
        memory.kind,
        memory.tags.join(", "),
        iso(memory.created_at),
        iso(memory.updated_at),
        memory.recall_count,
        iso(memory.last_recalled_at),
        memory.body.trim_end()
    )
}

pub fn render_list(memories: &[Memory]) -> String {
    memories
        .iter()
        .map(|memory| {
            format!(
                "- **{}** ({}) {} `[{}]` {}\n",
                memory.name,
                memory.kind,
                memory.description,
                memory.tags.join(", "),
                iso(memory.created_at)
            )
        })
        .collect()
}

pub fn render_hits(hits: &[Hit]) -> String {
    hits.iter()
        .map(|hit| {
            format!(
                "## {} ({}, score {:.3})\n\n_{}_ `[{}]`\n\n{}\n\n",
                hit.memory.name,
                hit.memory.kind,
                hit.score,
                hit.memory.description,
                hit.memory.tags.join(", "),
                hit.memory.body.trim_end()
            )
        })
        .collect()
}

pub fn repo_at_branch(repo: &str, branch: &str) -> String {
    match (repo.is_empty(), branch.is_empty()) {
        (true, _) => "global".to_string(),
        (false, true) => repo.to_string(),
        (false, false) => format!("{repo}@{branch}"),
    }
}

pub fn host_column(label: &str, host: &str) -> String {
    if label.is_empty() || label == host {
        return host.to_string();
    }
    format!("{label} ({host})")
}

/// One line per session: host, the handle `recall send` takes to reach that session, repo@branch,
/// age, state and what the session is working on. Every column but the last is padded to its
/// widest value, so the focus lines start together.
pub fn render_sessions(sessions: &[Session], now: i64) -> String {
    let rows: Vec<Vec<String>> = sessions
        .iter()
        .map(|session| {
            vec![
                host_column(&session.host_label, &session.host),
                session.name.clone(),
                repo_at_branch(&session.repo, &session.branch),
                sessions::age(session.started_at, now),
                sessions::state(session.last_activity_at, now).to_string(),
                sessions::focus_line(&session.focus),
            ]
        })
        .collect();
    let columns = rows.first().map_or(0, Vec::len);
    let widths: Vec<usize> = (0..columns.saturating_sub(1))
        .map(|column| {
            rows.iter()
                .filter_map(|row| row.get(column))
                .map(|cell| cell.chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    rows.iter()
        .map(|row| {
            let mut line: String = widths
                .iter()
                .enumerate()
                .map(|(column, size)| format!("{:width$}", row[column], width = size))
                .collect::<Vec<String>>()
                .join("  ");
            let focus = row.last().map_or("", String::as_str);
            if !focus.is_empty() {
                line.push_str("  ");
                line.push_str(focus);
            }
            format!("{line}\n")
        })
        .collect()
}

/// The name a session answers to: the one Claude Code gave it where there is one, and the handle
/// `recall send` takes otherwise.
fn session_name(session: &PastSession) -> &str {
    if session.agent_name.is_empty() {
        &session.name
    } else {
        &session.agent_name
    }
}

/// One stored session: what it is called, where and when it ran, what it was about, and what the
/// archive holds of it.
pub fn render_session(session: &PastSession, files: &[HeldFile]) -> String {
    let held: String = files
        .iter()
        .map(|file| format!("- {} ({} bytes)\n", file.file, file.bytes))
        .collect();
    format!(
        "---\nname: {}\nhandle: {}\nsession: {}\nhost: {}\ncwd: {}\nwhere: {}\nstarted: {}\nlast active: {}\nprompts: {}\nstate: {}\n---\n\n{}\n\nTranscript:\n\n{}",
        session_name(session),
        session.name,
        session.session_id,
        host_column(&session.host_label, &session.host),
        session.cwd,
        repo_at_branch(&session.repo, &session.branch),
        iso(session.started_at),
        iso(session.last_activity_at),
        session.prompts,
        if session.running { "running" } else { "over" },
        sessions::focus_line(&session.focus),
        if held.is_empty() {
            "- nothing archived\n".to_string()
        } else {
            held
        }
    )
}

/// One block per session a search found, newest match first within the ranking the service gave:
/// the session's name and where it ran, then the stretch of its transcript that answered.
pub fn render_session_hits(hits: &[SessionHit]) -> String {
    hits.iter()
        .map(|hit| {
            format!(
                "## {} ({}, score {:.3})\n\n_{} · {} · {}_\n\n> {}\n\n",
                session_name(&hit.session),
                hit.session.session_id,
                hit.score,
                host_column(&hit.session.host_label, &hit.session.host),
                repo_at_branch(&hit.session.repo, &hit.session.branch),
                iso(hit.session.last_activity_at),
                hit.excerpt.text.trim().replace('\n', "\n> ")
            )
        })
        .collect()
}

pub fn render_elsewhere(entries: &[Elsewhere]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let lines: String = entries
        .iter()
        .map(|entry| {
            format!(
                "- **{}** ({}, score {:.3}) {} `[{}]`\n",
                entry.name,
                entry.kind,
                entry.score,
                entry.description,
                entry.tags.join(", ")
            )
        })
        .collect();
    format!("Also in other scopes:\n\n{lines}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_other_scopes_after_the_hits() {
        let entries = [Elsewhere {
            score: 0.5,
            name: "other-deploy".into(),
            kind: "reference".into(),
            tags: vec!["repo:github.com/acme/other".into()],
            description: "deploy notes".into(),
        }];
        assert_eq!(
            render_elsewhere(&entries),
            "Also in other scopes:\n\n- **other-deploy** (reference, score 0.500) deploy notes `[repo:github.com/acme/other]`\n"
        );
        assert_eq!(render_elsewhere(&[]), "");
    }

    #[test]
    fn one_line_per_session_lines_the_focus_up() {
        let now = 1_762_000_000_000;
        let session = |host: &str, repo: &str, branch: &str, started: i64, active: i64, focus: [&str; 2]| Session {
            session_id: format!("s-{host}"),
            name: format!("{host}-2"),
            agent_name: String::new(),
            device_id: format!("d-{host}"),
            host: host.to_string(),
            host_label: String::new(),
            cwd: format!("/home/you/src/{host}"),
            repo: repo.to_string(),
            branch: branch.to_string(),
            commit: "feat(sessions): list every host's sessions".to_string(),
            started_at: started,
            last_activity_at: active,
            prompts: 3,
            focus: sessions::Focus {
                first: focus[0].to_string(),
                latest: focus[1].to_string(),
            },
            mode: "interactive".to_string(),
            permission_mode: "default".to_string(),
            pid: 4242,
            current: false,
        };
        let listed = [
            session(
                "laptop",
                "repo:github.com/mvhenten/recall",
                "feat/sessions-list",
                now - 720_000,
                now - 60_000,
                ["list the sessions", "why is the worker test red"],
            ),
            session(
                "tower",
                "",
                "",
                now - 10_800_000,
                now - 3_600_000,
                ["draft the release notes", ""],
            ),
        ];

        assert_eq!(
            render_sessions(&listed, now),
            "laptop  laptop-2  repo:github.com/mvhenten/recall@feat/sessions-list  12m  busy  list the sessions → why is the worker test red\n\
             tower   tower-2   global                                              3h   idle  draft the release notes\n"
        );
        assert_eq!(
            render_sessions(&listed[1..], now),
            "tower  tower-2  global  3h  idle  draft the release notes\n"
        );
        assert_eq!(render_sessions(&[], now), "");
    }

    #[test]
    fn reads_frontmatter_and_body() {
        let document = parse(
            "---\nname: build-cache\ndescription: \"how: the cache works\"\ntype: project\ntags: [ci, global]\n---\n\nBody line\n",
        );
        assert_eq!(
            document,
            Document {
                name: "build-cache".into(),
                description: "how: the cache works".into(),
                kind: "project".into(),
                tags: vec!["ci".into(), "global".into()],
                body: "Body line\n".into(),
            }
        );
    }

    #[test]
    fn round_trips_timestamps() {
        let ms = 1_761_744_000_000;
        assert_eq!(iso(ms), "2025-10-29T13:20:00Z");
        assert_eq!(parse_since("2025-10-29T15:20:00+02:00"), Some(ms));
        assert_eq!(parse_since("2025-10-29T13:20:00Z"), Some(ms));
        assert_eq!(parse_since("2025-10-29"), Some(1_761_696_000_000));
    }
}
