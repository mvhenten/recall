mod adopt;
mod api;
mod backfill;
mod config;
mod listen;
mod markdown;
mod mcp;
mod repo;
mod restore;
mod seen;
mod sessions;
mod settings;
mod transcripts;
mod ws;

use anyhow::{Context, Result, bail};
use api::{Client, Memory, SaveBody};
use clap::{Args, Parser, Subcommand};
use jiff::Timestamp;
use settings::{Mode, Settings};
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(
    name = "recall",
    version,
    about = "Per-user semantic memory, shared across hosts and harnesses"
)]
struct Cli {
    #[arg(long, global = true, help = "Print JSON instead of markdown")]
    json: bool,
    #[command(flatten)]
    settings: Settings,
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct TagFilter {
    #[arg(
        long = "tag",
        value_name = "TAG",
        help = "Match this tag instead of the repo tag and global (repeatable)"
    )]
    tags: Vec<String>,
    #[arg(long, conflicts_with = "tags", help = "Match every memory, whatever its tags")]
    any: bool,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Save a memory from a markdown file with frontmatter, or from stdin")]
    Save {
        #[arg(value_name = "FILE", help = "Markdown file; stdin when omitted or -")]
        file: Option<PathBuf>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long = "type", value_parser = ["user", "feedback", "project", "reference"])]
        kind: Option<String>,
        #[arg(long = "tag", value_name = "TAG", help = "Add a free-form tag (repeatable)")]
        tags: Vec<String>,
        #[arg(long, help = "Tag the memory global instead of with the current repo")]
        global: bool,
    },
    #[command(about = "Print one memory")]
    Get { name: String },
    #[command(about = "List memories, newest created first")]
    List {
        #[command(flatten)]
        filter: TagFilter,
        #[arg(long, help = "Only memories created at or after this ISO 8601 time or epoch ms")]
        since: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long, default_value = "", help = "nextCursor from a previous --json page")]
        cursor: String,
    },
    #[command(about = "Search memories by meaning")]
    Search {
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        #[command(flatten)]
        filter: TagFilter,
        #[arg(long, default_value_t = 5)]
        limit: u32,
        #[arg(
            long,
            default_value_t = 0.55,
            allow_negative_numbers = true,
            help = "Cosine similarity a vector match must reach; full-text matches do not use it"
        )]
        min_score: f64,
        #[arg(long, default_value = "hybrid", value_parser = ["hybrid", "vector", "text"])]
        mode: String,
    },
    #[command(about = "Change a memory; opens $EDITOR when no field flag is given")]
    Edit {
        name: String,
        #[arg(long)]
        description: Option<String>,
        #[arg(long = "type", value_parser = ["user", "feedback", "project", "reference"])]
        kind: Option<String>,
        #[arg(long = "body-file", value_name = "FILE", help = "Replace the body; - reads stdin")]
        body_file: Option<PathBuf>,
        #[arg(long = "tag", value_name = "TAG")]
        add_tags: Vec<String>,
        #[arg(long = "untag", value_name = "TAG")]
        remove_tags: Vec<String>,
    },
    #[command(about = "Delete a memory")]
    Delete { name: String },
    #[command(about = "Publish an artifact and print the URL it answers on")]
    Publish {
        #[arg(
            value_name = "FILE",
            required = true,
            help = "The files to publish, in track order for an audio artifact"
        )]
        files: Vec<PathBuf>,
        #[arg(
            long,
            help = "Publish under this name, as a kebab-case slug; defaults to the first file's own name"
        )]
        name: Option<String>,
        #[arg(long = "type", default_value = "site", value_parser = ["site", "document", "audio"])]
        kind: String,
        #[arg(long, help = "The heading the artifact's page carries; defaults to its name")]
        title: Option<String>,
        #[arg(long, default_value = "", help = "A line under the title")]
        description: String,
        #[arg(long, default_value = "private", value_parser = ["private", "account"])]
        read: String,
        #[arg(long, default_value = "owner", value_parser = ["owner", "account"])]
        write: String,
        #[arg(long, help = "Replace an artifact already published under this name")]
        replace: bool,
    },
    #[command(about = "List the artifacts this account has published")]
    Artifacts {
        #[arg(value_name = "QUERY", help = "Match a name, a title or a description")]
        query: Option<String>,
        #[arg(long = "type", value_parser = ["site", "document", "audio"])]
        kind: Option<String>,
        #[arg(long, value_parser = ["newest", "name", "largest"])]
        sort: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(
            long,
            help = "Take the artifacts published before they carried a type into the listing; run once per deployment"
        )]
        adopt: bool,
    },
    #[command(about = "Remove a published artifact and every one of its files")]
    Unpublish { name: String },
    #[command(about = "Print the repo tag of the current directory")]
    Repo,
    #[command(about = "Sign this host in through the browser and store its device token")]
    Login {
        #[arg(long, help = "recall service URL; defaults to RECALL_ENDPOINT")]
        endpoint: Option<String>,
        #[arg(long, help = "Device name shown on the approval page; defaults to the host name")]
        name: Option<String>,
    },
    #[command(about = "Revoke this host's device token and remove it from the env file")]
    Logout,
    #[command(about = "List the devices signed in as you")]
    Devices {
        #[arg(long, value_name = "ID", help = "Revoke the device with this id")]
        revoke: Option<String>,
    },
    #[command(about = "List the live Claude Code sessions on every host signed in as you")]
    Sessions {
        #[arg(
            long,
            value_name = "ID",
            help = "Send this host's record for the session with this id to the service"
        )]
        sync: Option<String>,
        #[arg(
            long,
            value_name = "ID",
            conflicts_with = "sync",
            help = "Mark the session with this id gone"
        )]
        end: Option<String>,
        #[arg(
            long,
            conflicts_with_all = ["sync", "end"],
            help = "Write and sync a record for every running session this host's hooks never registered"
        )]
        adopt: bool,
        #[arg(
            long,
            conflicts_with_all = ["sync", "end", "adopt"],
            help = "Send the history and usage of every past session this host holds a transcript for"
        )]
        backfill: bool,
        #[arg(
            long,
            value_name = "NAME",
            conflicts_with_all = ["sync", "end", "adopt", "backfill"],
            help = "Print one session, by its name, its handle or its Claude Code session id"
        )]
        find: Option<String>,
        #[arg(
            long,
            value_name = "QUERY",
            conflicts_with_all = ["sync", "end", "adopt", "backfill", "find"],
            help = "Find sessions on every host by what was said in them"
        )]
        search: Option<String>,
        #[arg(
            long,
            value_name = "NAME",
            conflicts_with_all = ["sync", "end", "adopt", "backfill", "find", "search"],
            help = "Write a stored session's transcript back onto this host, so claude --resume takes it"
        )]
        restore: Option<String>,
        #[arg(
            long,
            value_name = "DIR",
            requires = "restore",
            help = "Restore under this working directory instead of the one the session ran in"
        )]
        cwd: Option<String>,
        #[arg(long, default_value_t = 10, help = "How many sessions --search answers with")]
        limit: u32,
    },
    #[command(about = "Send a message to another host signed in as you, or to one session on it")]
    Send {
        #[arg(
            value_name = "TO",
            help = "Session handle from recall sessions for one session, or a host from recall devices — its label, its name or its id — for every session on that host"
        )]
        to: String,
        #[arg(
            value_name = "MESSAGE",
            num_args = 1..,
            help = "The message; stdin when omitted or -"
        )]
        message: Vec<String>,
    },
    #[command(about = "Send an instruction one session on the target host carries out, and report which one took it")]
    Order {
        #[arg(
            value_name = "TO",
            help = "A host from recall devices — its label, its name or its id — whose sessions compete for the order, or a session handle from recall sessions for one of them"
        )]
        to: String,
        #[arg(
            value_name = "ORDER",
            num_args = 1..,
            help = "The order; stdin when omitted or -"
        )]
        message: Vec<String>,
    },
    #[command(about = "Hold the connection that carries messages from your other hosts to this one")]
    Listen {
        #[arg(
            long,
            conflicts_with = "status",
            help = "Start the listener in the background unless one already holds the lock, then exit"
        )]
        ensure: bool,
        #[arg(
            long,
            help = "Print which sessions are registered for messages and why the hook passed the rest over, then exit"
        )]
        status: bool,
    },
    #[command(about = "Update recall to the latest release")]
    Update,
    #[command(about = "Show the settings, or get or set one")]
    Config {
        #[command(subcommand)]
        action: Option<ConfigAction>,
    },
    #[command(about = "Serve the recall tools over MCP on stdio")]
    Mcp,
}

#[derive(Subcommand)]
enum ConfigAction {
    #[command(about = "Print one setting by its dotted path: recall config get messaging.enabled")]
    Get {
        #[arg(value_name = "KEY")]
        key: String,
    },
    #[command(about = "Change one setting: recall config set mode hook|tools")]
    Set {
        #[arg(value_name = "KEY")]
        key: String,
        value: String,
    },
    #[command(about = "Print the JSON Schema of ~/.config/recall/config.json")]
    Schema,
}

/// The session a send is running inside, so the message can tell its reader which handle to answer
/// on. Claude passes the inbox socket down to the hooks and to every server it starts, and the
/// socket names the process that owns the session; without it, and on a host whose registry cannot
/// settle on one session, the message is answered on this host instead.
pub fn sending_session() -> String {
    std::env::var_os("CLAUDE_CODE_MESSAGING_SOCKET")
        .and_then(|socket| sessions::sending_session(&listen::sessions_dir(), Path::new(&socket)))
        .unwrap_or_default()
}

pub fn host_name() -> String {
    let from_file = std::fs::read_to_string("/etc/hostname").ok();
    let from_command = || {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
    };
    from_file
        .or_else(from_command)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unnamed host".to_string())
}

fn open_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some() {
        "xdg-open"
    } else {
        return;
    };
    let url = url.to_string();
    std::thread::spawn(move || {
        let _ = std::process::Command::new(opener)
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    });
}

fn login(endpoint: Option<String>, name: Option<String>) -> Result<()> {
    let Some(endpoint) = endpoint
        .map(|value| value.trim_end_matches('/').to_string())
        .or(config::endpoint()?)
    else {
        bail!("pass --endpoint https://<your recall host>");
    };
    let device = api::DeviceLogin::new(&endpoint);
    let started = device.start(&name.unwrap_or_else(host_name))?;
    eprintln!(
        "Open {} and enter the code {}
(or open {})",
        started.verification_uri, started.user_code, started.verification_uri_complete
    );
    open_browser(&started.verification_uri_complete);
    let deadline = Instant::now() + Duration::from_secs(started.expires_in);
    let mut interval = Duration::from_secs(started.interval.max(1));
    loop {
        std::thread::sleep(interval);
        if Instant::now() >= deadline {
            bail!("the code expired before it was approved; run recall login again");
        }
        match device.poll(&started.device_code)? {
            api::Poll::Pending => {}
            api::Poll::SlowDown => interval += Duration::from_secs(5),
            api::Poll::Denied => bail!("the sign-in was denied in the browser"),
            api::Poll::Expired => bail!("the code expired before it was approved; run recall login again"),
            api::Poll::Granted(token) => {
                let path = config::save_login(&endpoint, &token)?;
                eprintln!("signed in; wrote {}", path.display());
                return Ok(());
            }
        }
    }
}

fn update(cli_settings: &Settings) -> Result<ExitCode> {
    let updater = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("recall-update")))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("recall-update"));
    let status = std::process::Command::new(&updater).status().with_context(|| {
        format!(
            "could not run {}; reinstall with the installer from https://github.com/mvhenten/recall#install",
            updater.display()
        )
    })?;
    if !status.success() {
        return Ok(ExitCode::from(1));
    }
    match settings::load(cli_settings) {
        Ok(settings) => listen::restart(&settings),
        Err(error) => listen::log(&format!("listen:restart-failed:{error:#}"), Duration::ZERO),
    }
    adopt_after_update();
    Ok(ExitCode::SUCCESS)
}

/// An update replaces the hooks under every session already running, and those sessions keep the
/// hooks they loaded at their start. Taking them on here heals the host as the update lands,
/// rather than leaving the list short until each one restarts. Nothing here may fail the update,
/// so the hooks log is where it reports.
fn adopt_after_update() {
    let started = Instant::now();
    let found = match adopt::Scope::here().and_then(|scope| adopt::adopt(&scope)) {
        Ok(found) => found,
        Err(error) => return listen::log(&format!("sessions:adopt-failed:{error:#}"), started.elapsed()),
    };
    for session in &found {
        log_outcome(session.outcome, "adopt-failed", &session.session_id, || {
            sync_session(&session.session_id)
        });
    }
}

fn print_mode_hint(mode: Mode) {
    let disable_env = std::env::var("CLAUDE_CODE_DISABLE_AUTO_MEMORY").ok();
    if mode == Mode::Tools && config::auto_memory_enabled(&config::claude_settings_file(), disable_env.as_deref()) {
        eprintln!("recall: {}", config::AUTO_MEMORY_OFF);
    }
}

fn run_config(cli_settings: &Settings, json: bool, action: Option<ConfigAction>) -> Result<()> {
    match action {
        Some(ConfigAction::Schema) => print_json(&settings::schema()),
        Some(ConfigAction::Set { key, value }) => {
            let (path, _) = settings::set(&key, &value)?;
            println!("{} set to {value} in {}", settings::display(&key), path.display());
            print_mode_hint(settings::load(cli_settings)?.mode());
            Ok(())
        }
        Some(ConfigAction::Get { key }) => {
            let resolved = settings::resolved(cli_settings)?;
            let value = settings::get(&resolved, &key)?;
            if json {
                print_json(value)?;
            } else {
                println!("{}", settings::scalar(value));
            }
            print_mode_hint(settings::from_value(&resolved)?.mode());
            Ok(())
        }
        None => {
            let resolved = settings::resolved(cli_settings)?;
            if json {
                print_json(&resolved)?;
            } else {
                for line in settings::lines(&resolved) {
                    println!("{line}");
                }
            }
            print_mode_hint(settings::from_value(&resolved)?.mode());
            Ok(())
        }
    }
}

fn current_repo_tag() -> Option<String> {
    let dir = std::env::current_dir().ok()?;
    repo::repo_tag(&dir)
}

fn default_tags() -> Vec<String> {
    match current_repo_tag() {
        Some(tag) => vec![tag, repo::GLOBAL_TAG.to_string()],
        None => {
            eprintln!("recall: no git repository with a remote here; searching only memories tagged global");
            vec![repo::GLOBAL_TAG.to_string()]
        }
    }
}

fn filter_tags(filter: &TagFilter) -> Vec<String> {
    if filter.any {
        return Vec::new();
    }
    if !filter.tags.is_empty() {
        return filter.tags.clone();
    }
    default_tags()
}

fn read_input(file: Option<&PathBuf>) -> Result<String> {
    match file {
        Some(path) if path.as_os_str() != "-" => {
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
        }
        _ => {
            if std::io::stdin().is_terminal() {
                bail!("pass a markdown file, or pipe one into recall");
            }
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            Ok(text)
        }
    }
}

fn message_body(words: &[String]) -> Result<String> {
    let joined = words.join(" ");
    let text = if joined.is_empty() || joined == "-" {
        if std::io::stdin().is_terminal() {
            bail!("pass a message, or pipe one into recall send");
        }
        let mut piped = String::new();
        std::io::stdin().read_to_string(&mut piped)?;
        piped
    } else {
        joined
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        bail!("the message is empty");
    }
    Ok(text)
}

/// Why an order reached nobody, in the words the sender reads. A service that answers with a
/// fanout, or with no outcome at all, predates orders and handed it to every session on the host,
/// which is the thing an order exists to avoid.
pub fn order_refusal(sent: &api::Sent, to: &str) -> String {
    let id = &sent.message.message_id;
    match &sent.outcome {
        Some(api::Outcome::Taken { session_id }) => format!("order {id} was taken by {session_id}"),
        Some(api::Outcome::Untaken { reason }) => format!("order {id} reached no session on {to}: {reason}"),
        _ => format!("the recall serving {to} is too old to carry an order, so order {id} went out as news; update it"),
    }
}

/// An order is worth nothing to the sender who cannot tell whether anyone picked it up, so one
/// nobody took ends the command with the reason the service gave rather than a line that reads
/// like success. A host that is listening and names no session loses the order; one that is not
/// listening keeps it for a session that attaches within the ten minutes of the grace.
fn report_order(sent: &api::Sent, to: &str, json: bool) -> Result<()> {
    let Some(api::Outcome::Taken { session_id }) = &sent.outcome else {
        bail!("{}", order_refusal(sent, to));
    };
    if !json {
        println!("order {} taken by {session_id} on {to}", sent.message.message_id);
    }
    Ok(())
}

/// One sync carries both halves of what a host knows about a session: the document, and the usage
/// delta the hooks fixed since the last one. Nothing here reads the transcript.
/// The record, then the delta it carries, then the transcript itself. The archive goes last so
/// that a file the service holds bytes of is a file whose tokens were counted: the backfill reads
/// it that way, and sending the bytes first would have it count a stretch twice.
/// The transcript files one pending delta read, which is what says their tokens are counted.
fn read(pending: &sessions::UsagePending) -> Vec<String> {
    pending.files.keys().cloned().collect()
}

fn sync_session(session_id: &str) -> Result<()> {
    let dir = listen::sessions_dir();
    let Some(record) = sessions::record(&dir, session_id) else {
        bail!("no session {session_id} is registered on this host");
    };
    let client = Client::new(config::load()?);
    client.sync_record(session_id, &record)?;
    println!("synced {session_id}");
    if let Some(pending) = record.usage_pending.as_ref() {
        let sent = client.post_usage(session_id, &record.host, &record.repo, &read(pending), &pending.events)?;
        sessions::commit_usage(&dir, session_id, pending)?;
        println!("sent {sent} usage deltas for {session_id}");
    }
    let archived = transcripts::Archive::default().send(&client, session_id, &record.transcript_path)?;
    if archived > 0 {
        println!("archived {archived} transcript bytes for {session_id}");
    }
    Ok(())
}

/// The record is what carries a session's closing usage delta, so the delta goes out before the
/// record does: a service that refuses the end keeps the record, and the daemon's own sweep sends
/// the delta again rather than losing it with a session nothing is left to describe.
fn end_session(session_id: &str) -> Result<()> {
    let dir = listen::sessions_dir();
    let record = sessions::record(&dir, session_id);
    let client = Client::new(config::load()?);
    if let Some(record) = record.as_ref() {
        if let Some(pending) = record.usage_pending.as_ref() {
            let sent = client.post_usage(session_id, &record.host, &record.repo, &read(pending), &pending.events)?;
            println!("sent {sent} usage deltas for {session_id}");
        }
        let archived = transcripts::Archive::default().send(&client, session_id, &record.transcript_path)?;
        if archived > 0 {
            println!("archived {archived} transcript bytes for {session_id}");
        }
    }
    let ended = client.end_session(session_id)?;
    sessions::forget(&dir, session_id);
    println!("{} {session_id}", if ended { "ended" } else { "already gone" });
    Ok(())
}

/// The hooks start the session commands detached, with no terminal to read their stderr and no
/// caller to notice their exit code, so the hooks log is the only record that one ran at all.
fn log_outcome(done: &str, failed: &str, session_id: &str, work: impl FnOnce() -> Result<()>) -> bool {
    let started = Instant::now();
    match work() {
        Ok(()) => {
            listen::log(&format!("sessions:{done}:{session_id}"), started.elapsed());
            true
        }
        Err(error) => {
            listen::log(&format!("sessions:{failed}:{session_id}:{error:#}"), started.elapsed());
            eprintln!("recall: {error:#}");
            false
        }
    }
}

fn logged(done: &str, failed: &str, session_id: &str, work: impl FnOnce() -> Result<()>) -> ExitCode {
    if log_outcome(done, failed, session_id, work) {
        return ExitCode::SUCCESS;
    }
    ExitCode::from(2)
}

/// Every session running on this host that no record describes, taken on and synced. Hooks load
/// when a session starts, so the sessions that were already running when a plugin update landed
/// never write a record of their own: without this they stay off the list until each one restarts.
fn adopt_sessions() -> Result<ExitCode> {
    let adopted = adopt::adopt(&adopt::Scope::here()?)?;
    if adopted.is_empty() {
        println!("no running session needs adopting");
        return Ok(ExitCode::SUCCESS);
    }
    let mut synced = true;
    for session in &adopted {
        synced &= log_outcome(session.outcome, "adopt-failed", &session.session_id, || {
            sync_session(&session.session_id)
        });
    }
    if synced {
        return Ok(ExitCode::SUCCESS);
    }
    Ok(ExitCode::from(2))
}

impl transcripts::Store for Client {
    fn held(&self, session_id: &str) -> Result<transcripts::Held> {
        self.transcript_held(session_id)
    }

    fn append(&self, session_id: &str, file: &str, offset: i64, bytes: &[u8]) -> Result<transcripts::Appended> {
        self.append_transcript(session_id, file, offset, bytes)
    }
}

impl backfill::Service for Client {
    fn post_usage(
        &self,
        session_id: &str,
        host: &str,
        repo: &str,
        files: &[String],
        events: &[serde_json::Value],
    ) -> Result<usize> {
        Client::post_usage(self, session_id, host, repo, files, events)
    }

    fn sync(&self, session_id: &str, body: &api::SessionBody) -> Result<()> {
        self.sync_session(session_id, body)
    }

    fn end(&self, session_id: &str) -> Result<()> {
        self.end_session(session_id).map(|_| ())
    }
}

/// Every past session this host holds a transcript for, sent as the session it was: its history,
/// the tokens nothing has counted yet, and the transcript files themselves. The sessions the
/// service already holds on record are read back first, so a session it has keeps its row and is
/// visited only for what it still owes. One session that cannot be sent fails the run, and the
/// next run picks the span up where this one stopped.
fn backfill_sessions() -> Result<ExitCode> {
    let scope = adopt::Scope::here()?;
    let account = backfill::account_here()?;
    let client = Client::new(config::load()?);
    let on_record = client.session_history_ids()?;
    let past = backfill::past(&scope, &on_record)?;
    if past.is_empty() {
        println!("no past session needs backfilling");
        return Ok(ExitCode::SUCCESS);
    }
    let mut touched = 0;
    backfill::send(&client, &past, &account, |session_id, sent| {
        if sent.events == 0 && sent.bytes == 0 {
            return;
        }
        touched += 1;
        println!(
            "backfilled {session_id} with {} usage deltas and {} transcript bytes",
            sent.events, sent.bytes
        );
    })?;
    println!("backfilled {touched} of {} past sessions", past.len());
    Ok(ExitCode::SUCCESS)
}

/// Says which session a name settled on when it named more than one. The service answers with the
/// most recently active, which is the one a caller typing a name from memory means, but a caller
/// about to write a transcript to disk is told there was a choice and how to make it themselves.
fn report_matches(stored: &api::StoredSession, target: &str) {
    if stored.matches <= 1 {
        return;
    }
    eprintln!(
        "recall: {target} names {} sessions; took the most recently active, {}. Pass a session id for another.",
        stored.matches, stored.session.session_id
    );
}

/// One session the account has on record, wherever it ran, by any of the names that reach it.
fn find_session(client: &Client, target: &str, json: bool) -> Result<ExitCode> {
    let Some(stored) = client.session(target)? else {
        eprintln!("recall: no session named {target}");
        return Ok(ExitCode::from(1));
    };
    report_matches(&stored, target);
    if json {
        print_json(&stored)?;
    } else {
        print!("{}", markdown::render_session(&stored.session, &stored.files));
    }
    Ok(ExitCode::SUCCESS)
}

/// The sessions whose transcripts answer a query, on every host signed in as this user.
fn search_sessions(client: &Client, query: &str, limit: u32, json: bool) -> Result<ExitCode> {
    let hits = client.search_sessions(query, limit)?;
    if json {
        print_json(&hits)?;
        return Ok(ExitCode::SUCCESS);
    }
    if hits.is_empty() {
        println!("no sessions matched");
        return Ok(ExitCode::SUCCESS);
    }
    print!("{}", markdown::render_session_hits(&hits));
    Ok(ExitCode::SUCCESS)
}

/// A stored session written back onto this host, transcript and delegated turns alike, so that
/// `claude --resume` takes it from the directory it is restored under.
fn restore_session(client: &Client, target: &str, cwd: Option<&str>, json: bool) -> Result<ExitCode> {
    let Some(stored) = client.session(target)? else {
        eprintln!("recall: no session named {target}");
        return Ok(ExitCode::from(1));
    };
    report_matches(&stored, target);
    let projects = config::claude_dir()
        .context("neither CLAUDE_CONFIG_DIR nor HOME is set, so there is nowhere to restore a session")?
        .join("projects");
    let done = restore::restore(client, &projects, &stored.session, &stored.files, cwd)?;
    let under = cwd.unwrap_or(&stored.session.cwd);
    let name = |path: &PathBuf| path.to_string_lossy().into_owned();
    if json {
        print_json(&serde_json::json!({
            "sessionId": stored.session.session_id,
            "cwd": under,
            "written": done.written.iter().map(|file| name(&file.path)).collect::<Vec<_>>(),
            "kept": done.kept.iter().map(name).collect::<Vec<_>>(),
        }))?;
        return Ok(ExitCode::SUCCESS);
    }
    for file in &done.written {
        println!("restored {} ({} bytes)", file.path.display(), file.bytes);
    }
    for path in &done.kept {
        println!(
            "kept {} (this host holds at least what the archive does)",
            path.display()
        );
    }
    println!(
        "resume it with: cd {under} && claude --resume {}",
        stored.session.session_id
    );
    Ok(ExitCode::SUCCESS)
}

fn require_messaging(settings: &Settings) -> Result<()> {
    if settings.messaging_enabled() {
        return Ok(());
    }
    bail!("messaging is disabled; run recall config set messaging.enabled true to turn it on")
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_saved(json: bool, saved: &api::Saved) -> Result<()> {
    if json {
        return print_json(saved);
    }
    let verb = if saved.created { "saved" } else { "updated" };
    println!("{verb} {} [{}]", saved.memory.name, saved.memory.tags.join(", "));
    Ok(())
}

fn require(value: String, field: &str) -> Result<String> {
    if value.trim().is_empty() {
        bail!("{field} is missing; set it in the frontmatter or pass --{field}");
    }
    Ok(value)
}

fn editor_round_trip(memory: &Memory) -> Result<markdown::Document> {
    let dir = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .context("HOME is not set")?
        .join("recall");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.md", memory.name));
    let draft = format!(
        "---\nname: {}\ndescription: {}\ntype: {}\ntags: [{}]\n---\n\n{}\n",
        memory.name,
        memory.description,
        memory.kind,
        memory.tags.join(", "),
        memory.body.trim_end()
    );
    std::fs::write(&path, draft)?;
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".to_string());
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&path)
        .status()
        .with_context(|| format!("starting {editor}"))?;
    let text = std::fs::read_to_string(&path)?;
    std::fs::remove_file(&path)?;
    if !status.success() {
        bail!("{editor} exited with {status}; nothing saved");
    }
    Ok(markdown::parse(&text))
}

fn run(cli: Cli) -> Result<ExitCode> {
    let client = || -> Result<Client> { Ok(Client::new(config::load()?)) };
    match cli.command {
        Command::Login { endpoint, name } => login(endpoint, name)?,
        Command::Update => return update(&cli.settings),
        Command::Config { action } => run_config(&cli.settings, cli.json, action)?,
        Command::Mcp => mcp::serve(settings::load(&cli.settings)?.messaging_enabled())?,
        Command::Listen { ensure, status } => {
            let settings = settings::load(&cli.settings)?;
            if status {
                let report = listen::status(&settings)?;
                if cli.json {
                    print_json(&report)?;
                } else {
                    for line in report.lines() {
                        println!("{line}");
                    }
                }
            } else {
                listen::run(&settings, ensure)?;
            }
        }
        Command::Sessions {
            sync,
            end,
            adopt,
            backfill,
            find,
            search,
            restore,
            cwd,
            limit,
        } => {
            if let Some(id) = sync {
                return Ok(logged("synced", "sync-failed", &id, || sync_session(&id)));
            }
            if let Some(id) = end {
                return Ok(logged("ended", "end-failed", &id, || end_session(&id)));
            }
            if adopt {
                return adopt_sessions();
            }
            if backfill {
                return backfill_sessions();
            }
            if let Some(target) = find {
                return find_session(&client()?, &target, cli.json);
            }
            if let Some(query) = search {
                return search_sessions(&client()?, &query, limit, cli.json);
            }
            if let Some(target) = restore {
                return restore_session(&client()?, &target, cwd.as_deref(), cli.json);
            }
            let client = client()?;
            let listed = client.sessions()?;
            if cli.json {
                print_json(&listed)?;
            } else if listed.is_empty() {
                println!("no live sessions");
            } else {
                print!(
                    "{}",
                    markdown::render_sessions(&listed, Timestamp::now().as_millisecond())
                );
            }
        }
        Command::Send { to, message } => {
            require_messaging(&settings::load(&cli.settings)?)?;
            let body = message_body(&message)?;
            let client = client()?;
            let target = api::resolve_target(&client.devices()?, || client.sessions(), &to)?;
            let sent = client.send(&target, api::Kind::News, &sending_session(), &body)?;
            if cli.json {
                print_json(&sent.message)?;
            } else {
                println!("sent {} to {to}", sent.message.message_id);
            }
        }
        Command::Order { to, message } => {
            require_messaging(&settings::load(&cli.settings)?)?;
            let body = message_body(&message)?;
            let client = client()?;
            let target = api::resolve_target(&client.devices()?, || client.sessions(), &to)?;
            let sent = client.send(&target, api::Kind::Order, &sending_session(), &body)?;
            if cli.json {
                print_json(&sent)?;
            }
            report_order(&sent, &to, cli.json)?;
        }
        Command::Logout => {
            match client()?.revoke_device("current") {
                Ok(true) => {}
                Ok(false) => eprintln!("recall: this device was already revoked"),
                Err(error) => eprintln!(
                    "recall: the server did not revoke this device ({error:#}); revoke it from another host with recall devices --revoke"
                ),
            }
            let path = config::remove_token()?;
            eprintln!("signed out; removed the token from {}", path.display());
        }
        Command::Devices { revoke } => {
            let client = client()?;
            if let Some(device_id) = revoke {
                if !client.revoke_device(&device_id)? {
                    eprintln!("recall: no device {device_id}");
                    return Ok(ExitCode::from(1));
                }
                println!("revoked {device_id}");
                return Ok(ExitCode::SUCCESS);
            }
            let devices = client.devices()?;
            if cli.json {
                print_json(&devices)?;
            } else {
                for device in &devices {
                    println!(
                        "{}  {}  created {}  last used {}{}",
                        device.device_id,
                        markdown::host_column(&device.label, &device.name),
                        markdown::iso(device.created_at),
                        markdown::iso(device.last_used_at),
                        if device.current { "  (this device)" } else { "" }
                    );
                }
            }
        }
        Command::Repo => match current_repo_tag() {
            Some(tag) => println!("{tag}"),
            None => bail!("no git remote here"),
        },
        Command::Save {
            file,
            name,
            description,
            kind,
            tags,
            global,
        } => {
            let document = markdown::parse(&read_input(file.as_ref())?);
            let name = require(name.unwrap_or(document.name), "name")?;
            let description = require(description.unwrap_or(document.description), "description")?;
            let kind = require(kind.unwrap_or(document.kind), "type")?;
            let mut all_tags = document.tags;
            all_tags.extend(tags);
            match (global, current_repo_tag()) {
                (true, _) => all_tags.push(repo::GLOBAL_TAG.to_string()),
                (false, Some(tag)) => all_tags.push(tag),
                (false, None) => bail!(
                    "no git repository with a remote here, so there is no repo tag; pass --global to save it as a global memory"
                ),
            }
            let saved = client()?.save(
                &name,
                &SaveBody {
                    description: &description,
                    kind: &kind,
                    body: &document.body,
                    tags: &all_tags,
                },
            )?;
            print_saved(cli.json, &saved)?;
        }
        Command::Get { name } => {
            let Some(memory) = client()?.recall(&name)? else {
                eprintln!("recall: no memory named {name}");
                return Ok(ExitCode::from(1));
            };
            if cli.json {
                print_json(&memory)?;
            } else {
                print!("{}", markdown::render(&memory));
            }
        }
        Command::List {
            filter,
            since,
            limit,
            cursor,
        } => {
            let since = match since {
                Some(value) => markdown::parse_since(&value)
                    .with_context(|| format!("--since {value} is neither epoch ms nor ISO 8601"))?,
                None => 0,
            };
            let page = client()?.list(&filter_tags(&filter), since, &cursor, limit)?;
            if cli.json {
                print_json(&page)?;
            } else {
                print!("{}", markdown::render_list(&page.memories));
                if !page.next_cursor.is_empty() {
                    println!("\nmore: recall list --cursor {}", page.next_cursor);
                }
            }
        }
        Command::Search {
            query,
            filter,
            limit,
            min_score,
            mode,
        } => {
            let query = query.join(" ");
            let tags = filter_tags(&filter);
            let result = client()?.search(&api::SearchRequest {
                query: &query,
                tags: &tags,
                any: filter.any,
                limit,
                min_score,
                mode: &mode,
            })?;
            if cli.json {
                print_json(&result)?;
            } else {
                if result.hits.is_empty() {
                    println!("no memories matched");
                }
                print!("{}", markdown::render_hits(&result.hits));
                print!("{}", markdown::render_elsewhere(&result.elsewhere));
            }
        }
        Command::Edit {
            name,
            description,
            kind,
            body_file,
            add_tags,
            remove_tags,
        } => {
            let Some(memory) = client()?.get(&name)? else {
                eprintln!("recall: no memory named {name}");
                return Ok(ExitCode::from(1));
            };
            let flags_given = description.is_some()
                || kind.is_some()
                || body_file.is_some()
                || !add_tags.is_empty()
                || !remove_tags.is_empty();
            let mut document = if flags_given {
                markdown::Document {
                    name: memory.name.clone(),
                    description: description.unwrap_or_else(|| memory.description.clone()),
                    kind: kind.unwrap_or_else(|| memory.kind.clone()),
                    tags: memory.tags.clone(),
                    body: match body_file {
                        Some(path) => read_input(Some(&path))?,
                        None => memory.body.clone(),
                    },
                }
            } else {
                editor_round_trip(&memory)?
            };
            if document.name != memory.name {
                bail!(
                    "renaming is not supported; save under the new name and delete {}",
                    memory.name
                );
            }
            document.tags.extend(add_tags);
            document.tags.retain(|tag| !remove_tags.contains(tag));
            let saved = client()?.save(
                &name,
                &SaveBody {
                    description: &require(document.description, "description")?,
                    kind: &require(document.kind, "type")?,
                    body: &document.body,
                    tags: &document.tags,
                },
            )?;
            print_saved(cli.json, &saved)?;
        }
        Command::Delete { name } => {
            if !client()?.delete(&name)? {
                eprintln!("recall: no memory named {name}");
                return Ok(ExitCode::from(1));
            }
            if cli.json {
                print_json(&serde_json::json!({ "deleted": name }))?;
            } else {
                println!("deleted {name}");
            }
        }
        Command::Publish {
            files,
            name,
            kind,
            title,
            description,
            read,
            write,
            replace,
        } => {
            let first = files.first().context("name at least one file to publish")?;
            let name = api::artifact_name(first, name.as_deref())?;
            let published = client()?.publish(&api::PublishInput {
                title: title.unwrap_or_else(|| name.clone()),
                name: name.clone(),
                kind,
                description,
                read,
                write,
                replace,
                files,
            })?;
            if cli.json {
                print_json(&published.artifact)?;
            } else {
                if published.owned_by_another {
                    eprintln!(
                        "recall: {name} belongs to another account of this recall, which published it for the account to write; this publish replaced its files, its title and both its permissions"
                    );
                }
                println!("{}", published.artifact.url);
            }
        }
        Command::Artifacts {
            query,
            kind,
            sort,
            limit,
            adopt,
        } => {
            let client = client()?;
            if adopt {
                let adopted = client.adopt_artifacts()?;
                if cli.json {
                    print_json(&serde_json::json!({ "adopted": adopted }))?;
                } else {
                    println!("adopted {adopted}");
                }
                return Ok(ExitCode::SUCCESS);
            }
            let page = client.artifacts(&api::ArtifactQuery {
                query: query.unwrap_or_default(),
                kind: kind.unwrap_or_default(),
                sort: sort.unwrap_or_default(),
                limit,
            })?;
            if cli.json {
                print_json(&page)?;
            } else {
                print!("{}", markdown::render_artifacts(&page.artifacts));
                if page.cut {
                    println!("(the search matched more than this; add a word to narrow it)");
                }
            }
        }
        Command::Unpublish { name } => {
            if !client()?.unpublish(&name)? {
                eprintln!("recall: no artifact named {name}");
                return Ok(ExitCode::from(1));
            }
            if cli.json {
                print_json(&serde_json::json!({ "unpublished": name }))?;
            } else {
                println!("unpublished {name}");
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    settings::drop_empty_env();
    match run(Cli::parse()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("recall: {error:#}");
            ExitCode::from(2)
        }
    }
}
