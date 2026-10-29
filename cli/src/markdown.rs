use crate::api::{Hit, Memory};

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

const DAYS_PER_ERA: i64 = 146_097;

pub fn iso(ms: i64) -> String {
    if ms == 0 {
        return "never".to_string();
    }
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(DAYS_PER_ERA);
    let doe = z - era * DAYS_PER_ERA;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        time % 3600 / 60,
        time % 60
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * DAYS_PER_ERA + doe - 719_468
}

pub fn parse_since(value: &str) -> Option<i64> {
    if let Ok(ms) = value.parse::<i64>() {
        return Some(ms);
    }
    let number = |range: std::ops::Range<usize>| value.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    if value.get(4..5)? != "-" || value.get(7..8)? != "-" {
        return None;
    }
    let mut seconds = days_from_civil(year, month, day) * 86_400;
    if value.len() == 10 {
        return Some(seconds * 1000);
    }
    let rest = value
        .get(10..)?
        .strip_prefix('T')
        .or_else(|| value.get(10..)?.strip_prefix(' '))?;
    let (clock, offset) = rest.split_at(rest.find(['Z', 'z', '+', '-'])?);
    let mut parts = clock.split(':');
    let hours: i64 = parts.next()?.parse().ok()?;
    let minutes: i64 = parts.next()?.parse().ok()?;
    let secs: f64 = parts.next().unwrap_or("0").parse().ok()?;
    seconds += hours * 3600 + minutes * 60 + secs.trunc() as i64;
    let offset_seconds = match offset {
        "Z" | "z" => 0,
        _ => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let (oh, om) = offset[1..]
                .split_once(':')
                .unwrap_or((offset.get(1..3)?, offset.get(3..5).unwrap_or("0")));
            sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60)
        }
    };
    Some((seconds - offset_seconds) * 1000)
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
