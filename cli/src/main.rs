mod api;
mod config;
mod markdown;
mod repo;

use anyhow::{Context, Result, bail};
use api::{Client, Memory, SaveBody};
use clap::{Args, Parser, Subcommand};
use std::io::{IsTerminal, Read};
use std::path::PathBuf;
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
        #[arg(long, default_value_t = 0.5, help = "Cosine cutoff for vector matches")]
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
}

fn host_name() -> String {
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
                        device.name,
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
            let Some(memory) = client()?.get(&name)? else {
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
                print_json(&result.hits)?;
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
    }
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("recall: {error:#}");
            ExitCode::from(2)
        }
    }
}
