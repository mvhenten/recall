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
    fn login_replaces_every_credential_and_keeps_other_lines() {
        let text = "# recall\nRECALL_ENDPOINT=https://old\nexport RECALL_CLIENT_ID=a\nRECALL_CLIENT_SECRET=b\nRECALL_TOKEN=c\nOTHER=1\n";
        assert_eq!(keep_lines(text, &AUTH_KEYS), "# recall\nOTHER=1\n");
        assert_eq!(
            keep_lines(text, &["RECALL_TOKEN"]),
            "# recall\nRECALL_ENDPOINT=https://old\nexport RECALL_CLIENT_ID=a\nRECALL_CLIENT_SECRET=b\nOTHER=1\n"
        );
    }
}
