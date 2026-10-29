use anyhow::{Context, Result, bail};
use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub struct Config {
    pub endpoint: String,
    pub token: String,
}

const AUTH_KEYS: [&str; 4] = [
    "RECALL_ENDPOINT",
    "RECALL_TOKEN",
    "RECALL_CLIENT_ID",
    "RECALL_CLIENT_SECRET",
];

pub fn env_file() -> PathBuf {
    if let Some(path) = std::env::var_os("RECALL_ENV_FILE") {
        return PathBuf::from(path);
    }
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_default();
    config_home.join("recall").join("env")
}

fn env_key(line: &str) -> Option<&str> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, _) = line.strip_prefix("export ").unwrap_or(line).split_once('=')?;
    Some(key.trim())
}

pub fn parse_env(text: &str) -> HashMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.strip_prefix("export ").unwrap_or(line).split_once('='))
        .map(|(key, value)| {
            let value = value.trim();
            let unquoted = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            (key.trim().to_string(), unquoted.to_string())
        })
        .collect()
}

fn read_file(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

fn lookup(file: &HashMap<String, String>, key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| file.get(key).filter(|value| !value.is_empty()).cloned())
}

pub fn endpoint() -> Result<Option<String>> {
    let file = parse_env(&read_file(&env_file())?);
    Ok(lookup(&file, "RECALL_ENDPOINT").map(|value| value.trim_end_matches('/').to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Hook,
    Tools,
}

pub const MODE_KEY: &str = "RECALL_MODE";

pub const AUTO_MEMORY_OFF: &str = "Turn off Claude Code's built-in auto-memory: add \"autoMemoryEnabled\": false to ~/.claude/settings.json, or set CLAUDE_CODE_DISABLE_AUTO_MEMORY=1";

pub fn claude_settings_file() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .unwrap_or_default()
        .join("settings.json")
}

pub fn auto_memory_enabled(settings_file: &Path, disable_env: Option<&str>) -> bool {
    if disable_env.is_some_and(|value| matches!(value.trim(), "1" | "true")) {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(settings_file) else {
        return true;
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&text) else {
        return true;
    };
    settings.get("autoMemoryEnabled") != Some(&serde_json::Value::Bool(false))
}

impl Mode {
    pub fn parse(value: &str) -> Result<Mode> {
        match value.trim() {
            "hook" => Ok(Mode::Hook),
            "tools" => Ok(Mode::Tools),
            other => bail!("unknown mode {other:?}; use hook or tools"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Hook => "hook",
            Mode::Tools => "tools",
        }
    }
}

pub fn mode() -> Result<Mode> {
    let path = env_file();
    let file = parse_env(&read_file(&path)?);
    match lookup(&file, MODE_KEY) {
        None => Ok(Mode::Hook),
        Some(value) => Mode::parse(&value).with_context(|| {
            format!(
                "{MODE_KEY} in {} or the environment is invalid; run recall config set mode hook|tools",
                path.display()
            )
        }),
    }
}

pub fn set_mode(mode: Mode) -> Result<PathBuf> {
    let path = env_file();
    let kept = keep_lines(&read_file(&path)?, &[MODE_KEY]);
    write_private(&path, &format!("{kept}{MODE_KEY}={}\n", mode.as_str()))?;
    Ok(path)
}

pub fn load() -> Result<Config> {
    let path = env_file();
    let file = parse_env(&read_file(&path)?);
    let Some(endpoint) = lookup(&file, "RECALL_ENDPOINT") else {
        bail!(
            "RECALL_ENDPOINT is not set in {}; run recall login --endpoint https://<your recall host>",
            path.display()
        );
    };
    let Some(token) = lookup(&file, "RECALL_TOKEN") else {
        bail!("this host is not signed in to recall; run recall login");
    };
    Ok(Config {
        endpoint: endpoint.trim_end_matches('/').to_string(),
        token,
    })
}

fn keep_lines(text: &str, drop: &[&str]) -> String {
    text.lines()
        .filter(|line| !env_key(line).is_some_and(|key| drop.contains(&key)))
        .map(|line| format!("{line}\n"))
        .collect()
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let staged = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staged)
        .with_context(|| format!("writing {}", staged.display()))?;
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&staged, path).with_context(|| format!("writing {}", path.display()))
}

pub fn save_login(endpoint: &str, token: &str) -> Result<PathBuf> {
    let path = env_file();
    let kept = keep_lines(&read_file(&path)?, &AUTH_KEYS);
    write_private(
        &path,
        &format!("{kept}RECALL_ENDPOINT={endpoint}\nRECALL_TOKEN={token}\n"),
    )?;
    Ok(path)
}

pub fn remove_token() -> Result<PathBuf> {
    let path = env_file();
    let kept = keep_lines(&read_file(&path)?, &["RECALL_TOKEN"]);
    write_private(&path, &kept)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_parse_and_unknown_values_fail() {
        assert_eq!(Mode::parse("hook").unwrap(), Mode::Hook);
        assert_eq!(Mode::parse(" tools\n").unwrap(), Mode::Tools);
        assert!(Mode::parse("Tools").is_err());
        assert!(Mode::parse("").is_err());
    }

    #[test]
    fn login_replaces_every_credential_and_keeps_other_lines() {
        let text = "# recall\nRECALL_ENDPOINT=https://old\nexport RECALL_CLIENT_ID=a\nRECALL_CLIENT_SECRET=b\nRECALL_TOKEN=c\nOTHER=1\n";
        assert_eq!(keep_lines(text, &AUTH_KEYS), "# recall\nOTHER=1\n");
        assert_eq!(
            keep_lines("RECALL_MODE=hook\nRECALL_TOKEN=c\n", &[MODE_KEY]),
            "RECALL_TOKEN=c\n"
        );
        assert_eq!(
            keep_lines(text, &["RECALL_TOKEN"]),
            "# recall\nRECALL_ENDPOINT=https://old\nexport RECALL_CLIENT_ID=a\nRECALL_CLIENT_SECRET=b\nOTHER=1\n"
        );
    }

    #[test]
    fn auto_memory_reads_the_settings_file_through_a_symlink_and_the_env() {
        let dir = std::env::temp_dir().join(format!("recall-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("dotfiles-settings.json");
        let link = dir.join("settings.json");
        std::fs::write(
            &target,
            "{\n  \"model\": \"opus\",\n  \"autoMemoryEnabled\": false\n}\n",
        )
        .unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(!auto_memory_enabled(&link, None));

        std::fs::write(&target, "{\"autoMemoryEnabled\": true}").unwrap();
        assert!(auto_memory_enabled(&link, None));
        assert!(!auto_memory_enabled(&link, Some("1")));
        assert!(auto_memory_enabled(&dir.join("missing.json"), Some("0")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
