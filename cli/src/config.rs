use anyhow::{Context, Result, bail};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct Config {
    pub endpoint: String,
    pub client_id: String,
    pub client_secret: String,
}

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

pub fn load() -> Result<Config> {
    let path = env_file();
    let file = match std::fs::read_to_string(&path) {
        Ok(text) => parse_env(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let value = |key: &str| -> Result<String> {
        if let Ok(value) = std::env::var(key)
            && !value.is_empty()
        {
            return Ok(value);
        }
        match file.get(key) {
            Some(value) if !value.is_empty() => Ok(value.clone()),
            _ => bail!(
                "{key} is not set; put RECALL_ENDPOINT, RECALL_CLIENT_ID and RECALL_CLIENT_SECRET in {} (mode 600), or point RECALL_ENV_FILE at another file",
                path.display()
            ),
        }
    };
    Ok(Config {
        endpoint: value("RECALL_ENDPOINT")?.trim_end_matches('/').to_string(),
        client_id: value("RECALL_CLIENT_ID")?,
        client_secret: value("RECALL_CLIENT_SECRET")?,
    })
}
