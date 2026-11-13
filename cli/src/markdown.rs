use crate::api::{
    Artifact, Audience, BoardEntry, BoardMessage, HeldFile, Hit, Injected, Memory, PastSession, Peek, PeekState,
    ScopeCount, Session, SessionHit, Share,
};
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
        "---\nname: {}\ndescription: {}\ntype: {}\ntags: [{}]\ncreated: {}\nupdated: {}\nrecalled: {} times\n---\n\n{}\n",
        memory.name,
        memory.description,
        memory.kind,
        memory.tags.join(", "),
        iso(memory.created_at),
        iso(memory.updated_at),
        memory.recall_count,
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

/// A size of a megabyte or more reads in MB to one decimal, the way the dashboard and the artifact
/// pages print it, so one artifact never shows two different sizes.
pub fn size(bytes: i64) -> String {
    if bytes < 1_024 {
        return format!("{bytes} B");
    }
    if bytes < 1_048_576 {
        return format!("{} kB", (bytes as f64 / 1_024.0).round());
    }
    format!("{:.1} MB", bytes as f64 / 1_048_576.0)
}

fn shared(count: i64) -> String {
    match count {
        0 => String::new(),
        1 => " `1 share`".to_string(),
        many => format!(" `{many} shares`"),
    }
}

pub fn render_artifacts(artifacts: &[Artifact]) -> String {
    artifacts
        .iter()
        .map(|artifact| {
            format!(
                "- **{}** ({}) {} {} {} `r {} w {}`{}\n  {}\n",
                artifact.name,
                artifact.kind,
                artifact.title,
                size(artifact.bytes),
                iso(artifact.updated_at),
                artifact.read,
                artifact.write,
                shared(artifact.share_count),
                artifact.url
            )
        })
        .collect()
}

/// A share's mode and its recipient: one named address, or the whole of who a link share admits.
fn admits(share: &Share) -> (&'static str, &str) {
    match &share.audience {
        Audience::Link => ("link", "anyone with the link"),
        Audience::Email { address } => ("email", address),
    }
}

/// The fields one share row carries. `never opened` comes off the use count rather than off a
/// comparison of two timestamps.
pub fn render_shares(shares: &[Share]) -> String {
    shares
        .iter()
        .map(|share| {
            let opened = if share.uses == 0 {
                "never opened".to_string()
            } else {
                format!("{} opens, last {}", share.uses, iso(share.last_used_at))
            };
            let (mode, recipient) = admits(share);
            format!(
                "- **{}** ({}) created {} expires {} {}\n",
                recipient,
                mode,
                iso(share.created_at),
                iso(share.expires_at),
                opened
            )
        })
        .collect()
}

/// Every share the account holds, grouped per artifact. The grouping is the listing's own
/// ordering, so this prints what it was given and sorts nothing.
pub fn render_every_share(artifacts: &[Artifact]) -> String {
    artifacts
        .iter()
        .map(|artifact| format!("## {}\n\n{}\n", artifact.name, render_shares(&artifact.shares)))
        .collect()
}

/// One line per memory a search found, in the order it was ranked. A search answers with up to
/// twenty-five of them, so it prints a listing and not twenty-five bodies: `recall get <name>`
/// reads the one that looks right. A memory from outside the ambient scope says so, since that is
/// why it sorted below the rest.
pub fn render_hits(hits: &[Hit]) -> String {
    hits.iter()
        .map(|hit| {
            format!(
                "- **{}** ({}, score {:.3}){} {} `[{}]`\n",
                hit.memory.name,
                hit.memory.kind,
                hit.score,
                if hit.in_scope { "" } else { " elsewhere" },
                hit.memory.description,
                hit.memory.tags.join(", ")
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
                session_name(&session.agent_name, &session.name).to_string(),
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
/// `recall send` takes otherwise. A live session and a stored one are named the same way, so both
/// listings hand their two names here.
fn session_name<'a>(agent_name: &'a str, handle: &'a str) -> &'a str {
    if agent_name.is_empty() { handle } else { agent_name }
}

/// What the asker reads back off the peek it just asked for. A peek still pending is the ordinary
/// answer where the host is slow, so it names the command that prints it once the digest lands
/// rather than reading as a failure. That command is named by the session id and never by what the
/// caller typed: `--find` matches a name exactly, so a handle written in capitals answers for
/// nothing.
pub fn render_peek(peek: &Peek, session_id: &str) -> String {
    match peek.state {
        PeekState::Ready => format!("{}\n", peek.digest.trim()),
        PeekState::Pending => format!(
            "pending since {}; recall sessions --find {session_id} prints it once that host has written it\n",
            iso(peek.requested_at)
        ),
    }
}

/// The peeks of one session, newest first: when each was asked for, and either the digest its host
/// wrote or that it is still waiting for one.
pub fn render_peeks(peeks: &[Peek]) -> String {
    peeks
        .iter()
        .map(|peek| {
            let said = match peek.state {
                PeekState::Ready => peek.digest.trim().replace('\n', "\n  "),
                PeekState::Pending => "pending".to_string(),
            };
            format!("- {}\n  {said}\n", iso(peek.requested_at))
        })
        .collect()
}

/// One stored session: what it is called, where and when it ran, what it was about, what has been
/// asked of it, and what the archive holds of it.
pub fn render_session(session: &PastSession, files: &[HeldFile], peeks: &[Peek]) -> String {
    let held: String = files
        .iter()
        .map(|file| format!("- {} ({} bytes)\n", file.file(), file.bytes()))
        .collect();
    let asked = if peeks.is_empty() {
        String::new()
    } else {
        format!("\nPeeks:\n\n{}", render_peeks(peeks))
    };
    format!(
        "---\nname: {}\nhandle: {}\nsession: {}\nhost: {}\ncwd: {}\nwhere: {}\nstarted: {}\nlast active: {}\nprompts: {}\nstate: {}\n---\n\n{}\n{asked}\nTranscript:\n\n{}",
        session_name(&session.agent_name, &session.name),
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
                session_name(&hit.session.agent_name, &hit.session.name),
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

/// What the whole match set holds, under the page of it the search printed. A count past the page
/// is only useful beside the scopes the matches carry, which is what the next search narrows with.
pub fn render_scopes(count: u32, scopes: &[ScopeCount]) -> String {
    if scopes.is_empty() {
        return String::new();
    }
    let listed: Vec<String> = scopes
        .iter()
        .map(|entry| format!("{} ({})", entry.scope, entry.count))
        .collect();
    format!("{count} memories matched. Scopes: {}\n", listed.join(", "))
}

/// One line per memory the prompt hook was given, in the order it was ranked. A memory from
/// another scope reads as the scope it came from rather than being held back for a section of
/// its own.
pub fn render_injected(entries: &[Injected]) -> String {
    entries
        .iter()
        .map(|entry| {
            format!(
                "- **{}** ({}, score {:.3}){} {} `[{}]`\n",
                entry.name,
                entry.kind,
                entry.score,
                if entry.in_scope { "" } else { " elsewhere" },
                entry.description,
                entry.tags.join(", ")
            )
        })
        .collect()
}

/// Who posted a board message, as the one who reads it sees it: the host's label where it carries
/// one, then the handle of the session that posted it. A post that could name no session reads as
/// its host alone, and one from a service that named no sender reads as its device id.
fn poster(message: &BoardMessage) -> String {
    let from = if message.from_host.is_empty() {
        &message.from_device_id
    } else {
        &message.from_host
    };
    if message.from_name.is_empty() {
        return from.clone();
    }
    format!("{from}/{}", message.from_name)
}

fn board_address(message: &BoardMessage) -> String {
    if message.scope == "fleet" {
        return "the fleet".to_string();
    }
    format!("{} {}", message.scope, message.target)
}

/// What a pickup injects into the session that took it: one line of facts over each message, then
/// the message. The line says who posted it and how long it sat on the board, because a reader
/// acting on a week-old instruction has to know that is what it is doing.
pub fn render_pickup(messages: &[BoardMessage], now: i64) -> String {
    messages
        .iter()
        .map(|message| {
            format!(
                "[recall board, posted {} ago by {}]\n{}\n",
                sessions::age(message.created_at, now),
                poster(message),
                message.body.trim()
            )
        })
        .collect::<Vec<String>>()
        .join("\n")
}

/// The board, newest first: where each message is addressed, who posted it, how old it is, and
/// either that it is still waiting or the session that took it.
pub fn render_board(entries: &[BoardEntry], now: i64) -> String {
    entries
        .iter()
        .map(|entry| {
            let (message, state) = match entry {
                BoardEntry::Waiting { message } => (message, "waiting".to_string()),
                BoardEntry::Taken { message, taken_by } => (
                    message,
                    format!(
                        "taken {} ago by {}/{}",
                        sessions::age(taken_by.picked_up_at, now),
                        taken_by.host,
                        taken_by.session_id
                    ),
                ),
            };
            format!(
                "- **{}** from {} {} ago, {}\n  {}\n",
                board_address(message),
                poster(message),
                sessions::age(message.created_at, now),
                state,
                message.body.trim().replace('\n', "\n  ")
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link_share(name: &str, uses: i64) -> Share {
        Share {
            audience: Audience::Link,
            share_id: "sh_one".into(),
            name: name.into(),
            created_at: 1_762_000_000_000,
            expires_at: 1_764_592_000_000,
            last_used_at: 1_762_000_000_000,
            uses,
        }
    }

    fn email_share(name: &str, address: &str) -> Share {
        Share {
            audience: Audience::Email {
                address: address.into(),
            },
            share_id: "sh_two".into(),
            ..link_share(name, 0)
        }
    }

    #[test]
    fn names_a_link_share_without_an_address_and_a_fresh_share_as_never_opened() {
        let rendered = render_shares(&[
            link_share("release-notes", 0),
            email_share("release-notes", "jo@example.org"),
        ]);
        assert!(rendered.contains("**anyone with the link** (link)"));
        assert!(rendered.contains("**jo@example.org** (email)"));
        assert_eq!(rendered.matches("never opened").count(), 2);
        assert!(!rendered.contains("sh_one"));
    }

    #[test]
    fn counts_the_opens_of_a_share_somebody_has_read() {
        let read = render_shares(&[link_share("release-notes", 3)]);
        assert!(read.contains("3 opens, last 2025-11-01T12:26:40Z"));
        assert!(!read.contains("never opened"));
    }

    #[test]
    fn groups_every_share_under_the_artifact_that_holds_it() {
        let artifact = |name: &str, shares: Vec<Share>| Artifact {
            name: name.into(),
            url: format!("https://artifact.example.com/a/{name}"),
            kind: "document".into(),
            title: name.into(),
            description: String::new(),
            read: "private".into(),
            write: "owner".into(),
            file_count: 1,
            bytes: 10,
            created_at: 0,
            updated_at: 0,
            last_writer: "alice@example.com".into(),
            share_count: shares.len() as i64,
            shares,
        };
        let grouped = render_every_share(&[
            artifact("quarterly-plan", vec![email_share("quarterly-plan", "jo@example.org")]),
            artifact("release-notes", vec![link_share("release-notes", 0)]),
        ]);
        assert!(grouped.starts_with("## quarterly-plan\n"));
        assert!(grouped.contains("## release-notes\n"));
        assert!(grouped.find("jo@example.org") < grouped.find("anyone with the link"));
    }

    #[test]
    fn carries_the_share_count_on_an_artifact_row_and_nothing_where_none_is_held() {
        let row = |count: i64| Artifact {
            name: "release-notes".into(),
            url: "https://artifact.example.com/a/release-notes".into(),
            kind: "site".into(),
            title: "Release notes".into(),
            description: String::new(),
            read: "private".into(),
            write: "owner".into(),
            file_count: 1,
            bytes: 14,
            created_at: 0,
            updated_at: 0,
            last_writer: "alice@example.com".into(),
            share_count: count,
            shares: Vec::new(),
        };
        assert!(render_artifacts(&[row(0)]).contains("`r private w owner`\n"));
        assert!(render_artifacts(&[row(1)]).contains("`1 share`"));
        assert!(render_artifacts(&[row(4)]).contains("`4 shares`"));
    }

    #[test]
    fn marks_the_memories_that_came_from_elsewhere() {
        let entry = |name: &str, in_scope: bool| Injected {
            score: 0.5,
            name: name.into(),
            kind: "reference".into(),
            tags: vec!["repo:github.com/acme/other".into()],
            description: "deploy notes".into(),
            in_scope,
        };
        assert_eq!(
            render_injected(&[entry("here-deploy", true), entry("other-deploy", false)]),
            "- **here-deploy** (reference, score 0.500) deploy notes `[repo:github.com/acme/other]`\n\
             - **other-deploy** (reference, score 0.500) elsewhere deploy notes `[repo:github.com/acme/other]`\n"
        );
        assert_eq!(render_injected(&[]), "");
    }

    #[test]
    fn names_the_scopes_the_whole_match_set_holds() {
        let scopes = [
            ScopeCount {
                scope: "global".into(),
                count: 94,
            },
            ScopeCount {
                scope: "writing".into(),
                count: 7,
            },
        ];
        assert_eq!(
            render_scopes(101, &scopes),
            "101 memories matched. Scopes: global (94), writing (7)\n"
        );
        assert_eq!(render_scopes(0, &[]), "");
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

    fn peek(state: PeekState, digest: &str, at: i64) -> Peek {
        Peek {
            peek_id: "p-1".into(),
            state,
            digest: digest.into(),
            requested_at: at,
        }
    }

    /// The asker reads the digest and nothing around it. A peek the host has not answered yet is
    /// the ordinary case seconds after the ask, so it says when it was asked for and how to read
    /// it again rather than printing an empty line.
    #[test]
    fn a_peek_reads_as_the_digest_or_as_what_to_do_while_it_is_pending() {
        let ready = peek(PeekState::Ready, "  Reading the planner.\n", 1_762_000_000_000);
        assert_eq!(render_peek(&ready, "9f8a1b2c"), "Reading the planner.\n");

        let waiting = render_peek(&peek(PeekState::Pending, "", 1_762_000_000_000), "9f8a1b2c");
        assert_eq!(
            waiting,
            "pending since 2025-11-01T12:26:40Z; recall sessions --find 9f8a1b2c prints it once that host has written it\n"
        );
    }

    /// The history reads newest first, which is the order the service answers in, and a digest of
    /// several lines stays under the time it was asked at.
    #[test]
    fn a_peek_history_reads_in_the_order_the_service_gave_it() {
        let history = [
            peek(PeekState::Pending, "", 1_762_000_060_000),
            peek(
                PeekState::Ready,
                "Reading the planner.\nWaiting on CI.",
                1_762_000_000_000,
            ),
        ];
        assert_eq!(
            render_peeks(&history),
            "- 2025-11-01T12:27:40Z\n  pending\n\
             - 2025-11-01T12:26:40Z\n  Reading the planner.\n  Waiting on CI.\n"
        );
        assert_eq!(render_peeks(&[]), "");
    }

    /// A session carries its peeks over what the archive holds of it, and one that was never
    /// peeked prints exactly what it printed before there were peeks at all.
    #[test]
    fn a_session_shows_the_peeks_it_was_asked_for_and_nothing_where_it_has_none() {
        let session = PastSession {
            session_id: "9f8a1b2c".into(),
            name: "laptop-9f8a".into(),
            agent_name: String::new(),
            host: "laptop".into(),
            host_label: "laptop".into(),
            cwd: "/home/you/src/recall".into(),
            repo: "repo:github.com/mvhenten/recall".into(),
            branch: "work".into(),
            started_at: 1_762_000_000_000,
            last_activity_at: 1_762_000_060_000,
            prompts: 2,
            focus: sessions::Focus {
                first: "list the sessions".into(),
                latest: String::new(),
            },
            running: true,
        };
        let asked = render_session(
            &session,
            &[],
            &[peek(PeekState::Ready, "Reading the planner.", 1_762_000_000_000)],
        );

        assert!(
            asked.contains(
                "list the sessions\n\nPeeks:\n\n- 2025-11-01T12:26:40Z\n  Reading the planner.\n\nTranscript:"
            ),
            "{asked}"
        );
        assert!(
            render_session(&session, &[], &[]).contains("list the sessions\n\nTranscript:"),
            "a session that was never peeked carries no section at all"
        );
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
    fn prints_a_megabyte_or_more_in_mb_to_one_decimal() {
        assert_eq!(size(512), "512 B");
        assert_eq!(size(2_048), "2 kB");
        assert_eq!(size(1_048_576), "1.0 MB");
        assert_eq!(size(43_200_100), "41.2 MB");
    }

    #[test]
    fn prints_a_row_per_artifact_with_its_type_size_time_and_permissions() {
        let artifacts = [Artifact {
            name: "panel-episode-12".into(),
            url: "https://artifact.recall.test/a/panel-episode-12".into(),
            kind: "audio".into(),
            title: "Episode 12".into(),
            description: "the panel on rollout".into(),
            read: "account".into(),
            write: "owner".into(),
            file_count: 3,
            bytes: 43_200_100,
            created_at: 1_761_744_000_000,
            updated_at: 1_761_744_000_000,
            last_writer: "you@example.com".into(),
            share_count: 0,
            shares: Vec::new(),
        }];
        assert_eq!(
            render_artifacts(&artifacts),
            "- **panel-episode-12** (audio) Episode 12 41.2 MB 2025-10-29T13:20:00Z `r account w owner`\n  https://artifact.recall.test/a/panel-episode-12\n"
        );
        assert_eq!(render_artifacts(&[]), "");
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
