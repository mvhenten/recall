use crate::config;
use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ValueEnum)]
#[serde(rename_all = "lowercase")]
#[value(rename_all = "lowercase")]
pub enum Mode {
    Hook,
    Tools,
}

pub const MESSAGING_ENABLED_KEY: &str = "RECALL_MESSAGING_ENABLED";
pub const ARCHIVE_INTERVAL_KEY: &str = "RECALL_ARCHIVE_INTERVAL_SECONDS";

/// How often the listener carries a running session's newest transcript lines to the service.
/// The floor is what keeps a host from hammering it: a pass costs one call per live session plus
/// one per file that grew, and below this the calls cost more than the lines are worth.
pub const DEFAULT_ARCHIVE_INTERVAL_SECONDS: u64 = 10;
pub const MIN_ARCHIVE_INTERVAL_SECONDS: u64 = 2;
pub const MAX_ARCHIVE_INTERVAL_SECONDS: u64 = 3600;

fn in_range(seconds: u64) -> Result<u64, String> {
    if (MIN_ARCHIVE_INTERVAL_SECONDS..=MAX_ARCHIVE_INTERVAL_SECONDS).contains(&seconds) {
        return Ok(seconds);
    }
    Err(format!(
        "archive.interval.seconds must be a whole number of seconds from {MIN_ARCHIVE_INTERVAL_SECONDS} to {MAX_ARCHIVE_INTERVAL_SECONDS}"
    ))
}

fn archive_interval(raw: &str) -> Result<u64, String> {
    in_range(raw.parse().map_err(|_| {
        format!(
            "archive.interval.seconds must be a whole number of seconds from {MIN_ARCHIVE_INTERVAL_SECONDS} to {MAX_ARCHIVE_INTERVAL_SECONDS}"
        )
    })?)
}

fn deserialize_archive_interval<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    match Option::<u64>::deserialize(deserializer)? {
        None => Ok(None),
        Some(seconds) => in_range(seconds).map(Some).map_err(serde::de::Error::custom),
    }
}

/// Settings read from ~/.config/recall/config.json, overridden by the environment and these flags.
#[derive(Debug, Clone, Default, PartialEq, Eq, Args, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    /// Whether the plugin teaches Claude through hook context or the recall_* MCP tools.
    #[arg(long, value_enum, value_name = "MODE", env = config::MODE_KEY)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    /// Opt in to messaging between Claude Code sessions on the hosts signed in as you.
    #[arg(long, value_name = "BOOL", env = MESSAGING_ENABLED_KEY)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messaging_enabled: Option<bool>,
    /// Seconds between the passes that carry a running session's newest transcript lines up.
    #[arg(long, value_name = "SECONDS", value_parser = archive_interval, env = ARCHIVE_INTERVAL_KEY)]
    #[schemars(range(min = 2, max = 3600))]
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_archive_interval"
    )]
    pub archive_interval_seconds: Option<u64>,
}

impl Settings {
    pub fn mode(&self) -> Mode {
        self.mode.unwrap_or(Mode::Hook)
    }

    pub fn messaging_enabled(&self) -> bool {
        self.messaging_enabled.unwrap_or(false)
    }

    pub fn archive_interval(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            self.archive_interval_seconds
                .unwrap_or(DEFAULT_ARCHIVE_INTERVAL_SECONDS),
        )
    }

    pub fn defaults() -> Settings {
        let empty = Settings::default();
        Settings {
            mode: Some(empty.mode()),
            messaging_enabled: Some(empty.messaging_enabled()),
            archive_interval_seconds: Some(DEFAULT_ARCHIVE_INTERVAL_SECONDS),
        }
    }
}

pub fn drop_empty_env() {
    for name in [config::MODE_KEY, MESSAGING_ENABLED_KEY, ARCHIVE_INTERVAL_KEY] {
        if std::env::var_os(name).is_some_and(|value| value.is_empty()) {
            unsafe { std::env::remove_var(name) };
        }
    }
}

pub fn config_file() -> PathBuf {
    if let Some(path) = std::env::var_os("RECALL_CONFIG_FILE") {
        return PathBuf::from(path);
    }
    config::config_home().join("recall").join("config.json")
}

pub fn schema() -> Value {
    serde_json::to_value(schemars::schema_for!(Settings)).expect("the settings schema is JSON")
}

fn to_object(settings: &Settings) -> Map<String, Value> {
    match serde_json::to_value(settings).expect("settings are JSON") {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn read_file(path: &Path) -> Result<Map<String, Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    let settings = parse(&text).with_context(|| format!("reading {}", path.display()))?;
    Ok(to_object(&settings))
}

pub fn parse(text: &str) -> Result<Settings> {
    serde_json::from_str(text).context("the settings are not valid; run recall config schema to see the keys")
}

fn migrated_mode() -> Result<Map<String, Value>> {
    let Some(value) = config::env_file_mode()? else {
        return Ok(Map::new());
    };
    let mode = serde_json::from_value(Value::String(value.trim().to_string())).with_context(|| {
        format!(
            "unknown mode {value:?} from {} in {}; run recall config set mode hook|tools",
            config::MODE_KEY,
            config::env_file().display()
        )
    })?;
    Ok(to_object(&Settings {
        mode: Some(mode),
        ..Settings::default()
    }))
}

pub fn resolved(flags: &Settings) -> Result<Value> {
    let mut value = to_object(&Settings::defaults());
    value.extend(migrated_mode()?);
    value.extend(read_file(&config_file())?);
    value.extend(to_object(flags));
    Ok(Value::Object(value))
}

pub fn from_value(resolved: &Value) -> Result<Settings> {
    serde_json::from_value(resolved.clone()).context("the resolved settings are invalid")
}

pub fn load(flags: &Settings) -> Result<Settings> {
    from_value(&resolved(flags)?)
}

fn key(path: &str) -> String {
    path.replace('.', "_")
}

pub fn display(path: &str) -> String {
    path.replace('_', ".")
}

pub fn get<'a>(resolved: &'a Value, path: &str) -> Result<&'a Value> {
    resolved
        .get(key(path))
        .with_context(|| format!("unknown setting {path}; run recall config schema to see the keys"))
}

pub fn set(path: &str, raw: &str) -> Result<(PathBuf, Settings)> {
    let file = config_file();
    let mut stored = read_file(&file)?;
    let value = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
    if value.is_null() {
        bail!(
            "{} cannot be set to {raw}; run recall config schema to see the values a setting takes",
            display(path)
        );
    }
    stored.insert(key(path), value);
    let settings = parse(&serde_json::to_string(&Value::Object(stored))?)
        .with_context(|| format!("{} cannot be set to {raw}", display(path)))?;
    write(&file, &settings)?;
    if settings.mode.is_some() {
        config::remove_env_file_mode()?;
    }
    Ok((file, settings))
}

fn write(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let text = format!("{}\n", serde_json::to_string_pretty(settings)?);
    std::fs::write(path, text).with_context(|| format!("writing {}", path.display()))
}

pub fn scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

pub fn lines(resolved: &Value) -> Vec<String> {
    let Value::Object(map) = resolved else {
        return Vec::new();
    };
    map.iter()
        .map(|(key, value)| format!("{}={}", display(key), scalar(value)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::sync::{Mutex, MutexGuard};

    #[derive(Parser)]
    struct Probe {
        #[command(flatten)]
        settings: Settings,
    }

    static ENV: Mutex<()> = Mutex::new(());

    struct Sandbox {
        dir: PathBuf,
        _guard: MutexGuard<'static, ()>,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
            let dir = std::env::temp_dir().join(format!("recall-settings-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            unsafe {
                std::env::set_var("RECALL_CONFIG_FILE", dir.join("config.json"));
                std::env::set_var("RECALL_ENV_FILE", dir.join("env"));
                std::env::remove_var(config::MODE_KEY);
            }
            Sandbox { dir, _guard: guard }
        }

        fn write_config(&self, text: &str) {
            std::fs::write(self.dir.join("config.json"), text).unwrap();
        }

        fn write_env(&self, text: &str) {
            std::fs::write(self.dir.join("env"), text).unwrap();
        }

        fn flags(&self, args: &[&str]) -> Settings {
            let mut argv = vec!["recall"];
            argv.extend(args);
            Probe::try_parse_from(argv).unwrap().settings
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("RECALL_CONFIG_FILE");
                std::env::remove_var("RECALL_ENV_FILE");
                std::env::remove_var(config::MODE_KEY);
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn flags_beat_the_environment_which_beats_the_file_which_beats_the_defaults() {
        let sandbox = Sandbox::new("precedence");
        assert_eq!(load(&sandbox.flags(&[])).unwrap(), Settings::defaults());

        sandbox.write_config("{\"mode\": \"tools\", \"messaging_enabled\": true}");
        let from_file = load(&sandbox.flags(&[])).unwrap();
        assert_eq!(from_file.mode(), Mode::Tools);
        assert!(from_file.messaging_enabled());

        unsafe { std::env::set_var(config::MODE_KEY, "hook") };
        assert_eq!(load(&sandbox.flags(&[])).unwrap().mode(), Mode::Hook);

        let flags = sandbox.flags(&["--mode", "tools", "--messaging-enabled", "false"]);
        let merged = load(&flags).unwrap();
        assert_eq!(merged.mode(), Mode::Tools);
        assert!(!merged.messaging_enabled());
    }

    #[test]
    fn unknown_keys_and_wrong_types_are_rejected() {
        let sandbox = Sandbox::new("unknown");
        sandbox.write_config("{\"messaging\": true}");
        let error = format!("{:#}", load(&Settings::default()).unwrap_err());
        assert!(error.contains("unknown field `messaging`"), "{error}");

        sandbox.write_config("{}");
        let error = format!("{:#}", set("messaging.enabled", "yes").unwrap_err());
        assert!(error.contains("messaging.enabled cannot be set to yes"), "{error}");
        let error = format!("{:#}", set("mesaging.enabled", "true").unwrap_err());
        assert!(error.contains("unknown field `mesaging_enabled`"), "{error}");
    }

    #[test]
    fn a_setting_cannot_be_cleared_back_to_null() {
        let sandbox = Sandbox::new("null");
        sandbox.write_env("RECALL_MODE=tools\n");
        sandbox.write_config("{\"mode\": \"hook\"}");
        let error = format!("{:#}", set("mode", "null").unwrap_err());
        assert!(error.contains("mode cannot be set to null"), "{error}");
        assert_eq!(load(&Settings::default()).unwrap().mode(), Mode::Hook);
    }

    #[test]
    fn a_dotted_path_addresses_the_same_key_as_the_flag() {
        let sandbox = Sandbox::new("paths");
        sandbox.write_config("{\"mode\": \"tools\"}");
        let (path, settings) = set("messaging.enabled", "true").unwrap();
        assert_eq!(path, config_file());
        assert_eq!(settings.mode(), Mode::Tools);
        assert!(settings.messaging_enabled());

        let resolved = resolved(&Settings::default()).unwrap();
        assert_eq!(scalar(get(&resolved, "mode").unwrap()), "tools");
        assert_eq!(scalar(get(&resolved, "messaging.enabled").unwrap()), "true");
        assert_eq!(
            lines(&resolved),
            vec!["archive.interval.seconds=10", "messaging.enabled=true", "mode=tools"]
        );
        assert!(get(&resolved, "listening").is_err());
    }

    #[test]
    fn the_mode_falls_back_to_the_env_file_until_the_config_file_sets_it() {
        let sandbox = Sandbox::new("migration");
        sandbox.write_env("RECALL_ENDPOINT=https://example.test\nRECALL_MODE=tools\n");
        assert_eq!(load(&Settings::default()).unwrap().mode(), Mode::Tools);

        let (_, stored) = set("mode", "hook").unwrap();
        assert_eq!(stored.mode(), Mode::Hook);
        assert_eq!(
            std::fs::read_to_string(config::env_file()).unwrap(),
            "RECALL_ENDPOINT=https://example.test\n"
        );
        assert_eq!(load(&Settings::default()).unwrap().mode(), Mode::Hook);

        sandbox.write_env("RECALL_MODE=sideways\n");
        std::fs::remove_file(config_file()).unwrap();
        let error = format!("{:#}", load(&Settings::default()).unwrap_err());
        assert!(error.contains("unknown mode \"sideways\""), "{error}");
    }

    #[test]
    fn an_archive_interval_outside_its_bounds_is_refused() {
        let sandbox = Sandbox::new("interval");
        assert_eq!(
            load(&sandbox.flags(&[])).unwrap().archive_interval(),
            std::time::Duration::from_secs(DEFAULT_ARCHIVE_INTERVAL_SECONDS)
        );

        let (_, settings) = set("archive.interval.seconds", "2").unwrap();
        assert_eq!(settings.archive_interval(), std::time::Duration::from_secs(2));

        for refused in ["0", "1", "-5", "3601", "soon"] {
            let error = format!("{:#}", set("archive.interval.seconds", refused).unwrap_err());
            assert!(error.contains("archive.interval.seconds cannot be set to"), "{error}");
        }
        assert_eq!(
            load(&sandbox.flags(&[])).unwrap().archive_interval(),
            std::time::Duration::from_secs(2),
            "a refused value leaves the one on record alone"
        );

        sandbox.write_config("{\"archive_interval_seconds\": 0}");
        let error = format!("{:#}", load(&Settings::default()).unwrap_err());
        assert!(error.contains("from 2 to 3600"), "{error}");
    }

    #[test]
    fn the_schema_matches_the_published_snapshot() {
        let expected: Value = serde_json::from_str(include_str!("../tests/settings.schema.json")).unwrap();
        assert_eq!(schema(), expected);
    }
}
