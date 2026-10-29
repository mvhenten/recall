use crate::api::{Hit, Memory};
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
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
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
                while let Some(item) = lines.peek().and_then(|next| next.trim().strip_prefix("- "))
                {
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
    Some(
        date.to_zoned(TimeZone::UTC)
            .ok()?
            .timestamp()
            .as_millisecond(),
    )
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

#[cfg(test)]
mod tests {
    use super::*;

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
