# recall

Per-user semantic memory for coding agents. recall keeps the notes an agent learns about you and your projects (your preferences, feedback you gave, how a repo works) in a small service you run on your own Cloudflare account, so they follow you across machines and harnesses.

- A command-line client, `recall`, saves, lists, searches and edits memories from any shell or agent.
- A Cloudflare Worker stores each user's memories in D1, with an embedding per memory and a full-text index, and answers searches with both.
- `recall mcp` serves the same operations as MCP tools over stdio, for a harness that speaks MCP and has no shell of its own.
- A Claude Code plugin names the CLI as the memory path, adds matching memories to each prompt, and either syncs Claude's auto-memory files to recall or replaces auto-memory outright.
- A remote MCP connector at `<hostname>/mcp` serves the same tools to a client with no CLI and no working copy, behind its own Cloudflare Access application.
- An opt-in add-on carries messages between the Claude Code sessions on the hosts signed in as you: news every session there reads, or an order one of them carries out.
- A dashboard in the browser reads the same store: live sessions, the session history, one session's transcript, the memories and what the tokens cost, and it sends a session a message.

## Install

### The CLI

Install the latest release on Linux or macOS (x86_64 or arm64):

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/mvhenten/recall/releases/latest/download/recall-installer.sh | sh
```

The installer puts `recall` and `recall-update` in `~/.cargo/bin`. Update to the latest release with:

```bash
recall update
```

Without a release for your platform, build from source with `cargo install --git https://github.com/mvhenten/recall recall`, or `cargo install --path cli` from a checkout. Sign each host in once:

```bash
recall login --endpoint https://recall.example.com
```

The CLI prints a URL and a code and opens a browser when it can. Open the URL, sign in with the one-time PIN Cloudflare Access mails you, check the code and approve. The CLI then writes `RECALL_ENDPOINT` and `RECALL_TOKEN` to `~/.config/recall/env` (mode 600; `RECALL_ENV_FILE` points elsewhere). Both can also come from the environment.

```bash
recall devices                  # every device signed in as you
recall devices --revoke <id>    # sign another device out
recall sessions                 # the Claude Code sessions running on all of them
recall logout                   # revoke this device and remove its token
```

A revoked or unknown token gets a 401, and the CLI says to run `recall login`.

To release, run `npm run release -- X.Y.Z` on a clean, up-to-date main: it sets the version, commits, tags `vX.Y.Z` and pushes, and the tag builds and publishes the binaries.

### Self-host the service

You need a Cloudflare account with a domain on it and Zero Trust switched on (the free plan is enough: open Zero Trust in the dashboard once and pick a team name). From a checkout, with Node 22 or later:

```bash
npm ci
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
npm run setup -- --hostname recall.example.com --user alice --email alice@example.com
recall login --endpoint https://recall.example.com
```

The setup creates the D1 database, the R2 bucket the transcript archive lives in, the queue that bucket announces its writes on and its dead letter queue, and two Cloudflare Access applications. One covers the hostname and lets every request through, since the Worker checks device tokens itself. The other covers the two browser pages, `/device` and `/dashboard`: it admits the listed emails through the one-time PIN login method, which the setup switches on. The setup then migrates the database, maps the emails to the user id, deploys the Worker to the hostname and prints the `recall login` command. Run it again at any time: it finds what exists and creates the rest. Run it with a new `--user` and `--email` to add a person; their memories stay apart. `--email` repeats for more addresses, `--dry-run` prints what it would do and `--account <id>` picks an account when the token sees several. `--artifact-hostname <pages.example.com>` turns on [artifacts](#artifacts) and adds a second bucket and a second hostname, and `--mcp-connector` turns on the [desktop connector](#desktop-connector) at `<hostname>/mcp`.

Create the API token under My Profile → API Tokens → Create Custom Token, with:

| Scope   | Permission                                                   |
| ------- | ------------------------------------------------------------ |
| Account | Account Settings · Read                                      |
| Account | D1 · Edit                                                    |
| Account | Workers R2 Storage · Edit                                    |
| Account | Queues · Edit                                                |
| Account | Workers Scripts · Edit                                       |
| Account | Workers AI · Read                                            |
| Account | Access: Apps and Policies · Edit                             |
| Account | Access: Service Tokens · Edit                                |
| Account | Access: Organizations, Identity Providers, and Groups · Edit |
| Zone    | Zone · Read                                                  |
| Zone    | DNS · Edit                                                   |
| Zone    | Workers Routes · Edit                                        |

Limit the zone resources to the zone that holds your hostname. The token is read from the environment only and never printed.

### The Claude Code plugin

In Claude Code:

```
/plugin marketplace add mvhenten/recall
/plugin install recall@recall
```

The plugin is five hooks and registers no MCP server. A Claude Code session has a shell, so it reaches recall through the CLI, and a tool set would load its schemas into that session whether it saves a memory or not. A client with no shell and no working copy — the desktop app, the browser — uses the [connector](#desktop-connector) instead. The hooks need `node` 22 or later and find `recall` on `PATH` or in `~/.cargo/bin`.

- Before a `Write` to an auto-memory file, it saves the content to recall under the file name as a kebab-case slug (`agent_dispatch.md` becomes `agent-dispatch`), with the same tag rules as below, and blocks the write so the local memory folder stops growing; Claude is told the memory is in recall and how to read or change it. When the save fails or takes over 5 seconds, the write goes ahead locally as a fallback and a message shows the first error line. An `Edit` or `MultiEdit` to a memory file is blocked with a pointer to `recall edit <name>`, and any write to `MEMORY.md` is blocked because recall finds memories by search, not by index.
- After a `Write` or `Edit` to an auto-memory file (under `autoMemoryDirectory`, or `~/.claude/projects/*/memory/` when that is unset; `MEMORY.md` excluded), it runs `recall save` under the same slug of the file name. `user` and `feedback` memories are saved as global; `project` and `reference` memories get the repo tag of the session's directory, or `global` outside a repo. When the save fails, a message says the memory was saved locally but not synced.
- On each prompt of three words or more that is not a slash command, it runs `recall search` in the session's directory and adds the top five hits to the prompt as context, bodies truncated and the block capped at 4 KB. Up to three matches from other scopes follow under "In other scopes:", each with its tags. When recall fails, a one-line `recall unavailable: …` message shows and the prompt goes through unchanged.
- On every prompt, including the ones too short to search on, it rewrites the moving half of the session's record — focus, prompt count, last activity, branch, last commit and permission mode — and starts a sync it does not wait for, at most one every thirty seconds, so `recall sessions` shows from any host what this session is working on.
- At session start, it adds a short block: recall is the memory across sessions and no local memory file or `MEMORY.md` index holds anything, the CLI commands that reach it, and the session directory's repo tag (or "global only") with the reminder that a save from a repo needs `--global` to be filed anywhere else. In `tools` mode it first adds the longer memory instructions: what to save, what not to, to update rather than duplicate, and to delete what turns out wrong. When `recall` is missing, it adds an install hint instead.
- Every hook run appends one line to `${XDG_STATE_HOME:-~/.local/state}/recall/hooks.log`: time, session id, outcome (`hits=<n>`, `no-hits`, `skipped:<reason>`, each followed by `focus:<state>`, plus `crib:<mode>:repo:messaging:<state>`, `crib:<mode>:global:messaging:<state>`, `messaging:<state>`, `not-installed`, `timeout`, `saved:<name>`, `redirect:saved:<name>`, `redirect:fallback:<error>`, `redirect:index`, `redirect:edit`, `error:<message>`) and duration. `recall sessions --sync` and `--end`, which the hooks start detached, add their own `sessions:…` lines, and the listener adds `listen:…`, `message:…`, the `sessions:ended:…` and `sessions:usage:…` of the sessions its tick found gone, and the `sessions:adopted:…` and `sessions:refreshed:…` of the ones it took on. Prompts, focus lines and memory bodies are never logged.

### Modes

The plugin works in one of two modes, set per host with `recall config set mode hook|tools` and stored in `~/.config/recall/config.json`.

- `hook` (the default) leaves Claude Code's built-in auto-memory on as a backstop: session start names the CLI commands as the only save path and says no memory file and no `MEMORY.md` index is written whatever else the session is told, and the redirect hook blocks each memory file write and saves it to recall instead.
- `tools` replaces auto-memory with recall. Session start says the same, naming the `recall_*` tools for a harness that has them and the CLI where it does not. Turn auto-memory off yourself too, since a plugin cannot change your settings: add `"autoMemoryEnabled": false` to `~/.claude/settings.json`, or set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. `recall` says so on every `config set` until you do.

Both modes add matching memories to each prompt.

### MCP over stdio

`recall mcp` serves the operations as MCP tools for a harness that speaks MCP and has no shell of its own: `recall_search`, `recall_get`, `recall_list`, `recall_save`, `recall_edit`, `recall_delete`, `recall_publish`, `recall_artifacts` and `recall_unpublish`, plus `recall_send` and `recall_order` while messaging is on. They scope and tag like the CLI, from the directory the harness runs in, and `recall_save` tags `user` and `feedback` memories global unless told otherwise. A failure comes back as a tool error with the CLI's message, such as `run recall login`. Register it where you want it; the Claude Code plugin does not.

## Settings

`~/.config/recall/config.json` holds the settings; `~/.config/recall/env` keeps the endpoint and the device token. A setting comes from the first place that names it: a command flag, then the environment, then the file, then the default. `XDG_CONFIG_HOME` moves the file and `RECALL_CONFIG_FILE` names it outright.

```bash
recall config                             # every setting, as key=value
recall config get messaging.enabled       # one setting
recall config set messaging.enabled true  # write it to the file
recall config schema                      # the JSON Schema of the file
```

| Setting                    | Default | Environment                       | Flag                                |
| -------------------------- | ------- | --------------------------------- | ----------------------------------- |
| `mode`                     | `hook`  | `RECALL_MODE`                     | `--mode hook\|tools`                |
| `messaging.enabled`        | `false` | `RECALL_MESSAGING_ENABLED`        | `--messaging-enabled <BOOL>`        |
| `archive.interval.seconds` | `10`    | `RECALL_ARCHIVE_INTERVAL_SECONDS` | `--archive-interval-seconds <SECS>` |

`archive.interval.seconds` is how often the listener looks for a running session's newest [transcript](#the-transcript-archive) lines without having been told to, from 2 seconds to an hour. It is the backstop: what normally carries those lines up is the session writing them, which a watch on the directories it writes in announces, and the beat is there for the filesystems that watch does not reach and the writes no event arrived for. A pass over a session that has not written since the one before costs no call, so only sessions actually writing generate traffic. It moves nothing else: the registry sweep that ends dead sessions and runs adoption keeps its own thirty second beat.

A flag goes before the subcommand: `recall --mode tools mcp`. The dotted name is the display name; `messaging.enabled` on the command line is `messaging_enabled` in the file. An unknown key or a value of the wrong type is rejected and the message names the key. A `RECALL_MODE` left in `~/.config/recall/env` still sets the mode until `recall config set mode` writes one, which also takes it out of the env file.

## Memories, tags and scope

A memory has a kebab-case `name` (unique per user), a `description`, a `type` (`user`, `feedback`, `project` or `reference`), a markdown `body` and a set of `tags`.

Tags scope memories. `recall save` tags a memory with the current repo, `repo:<host>/<owner>/<repo>`, taken from the git remote: SSH and HTTPS remotes give the same tag, and a worktree gives its repo's tag. `--global` tags it `global` instead, and `--tag` adds free-form tags. Search and list match the current repo tag or `global` by default; `--tag` replaces that set, and `--any` matches every memory. Outside a repo, `save` needs `--global`, and search covers `global` only.

Search is hybrid: it ranks by embedding similarity and by full-text match, then fuses the two rankings (reciprocal rank fusion, k = 60). `--mode vector` or `--mode text` uses one ranking. `--min-score` (default 0.55) is the cosine similarity a vector match must reach before fusion; hybrid scores are fusion values near 0.03, not cosines. Full-text search skips common English words such as "the" and "and", so a memory that shares only those with the query never matches, while an exact identifier still does. Search hits do not count as recalls; only a deliberate read (`recall get` or the `recall_get` tool) does, so each memory carries a recall count and the time it was last recalled. A scoped search also answers `elsewhere`: the top three matches outside the requested tags, ranked the same way, with name, type, tags, description and score. `recall search` lists these under "Also in other scopes". `recall --json search` prints `{hits, elsewhere}`.

```bash
recall save note.md                 # frontmatter: name, description, type, tags
echo "two spaces" | recall save --name indent --description "indent style" --type feedback --global
recall search how do we cache builds
recall search --mode text ERR_4521  # exact identifiers
recall list --since 2026-10-01
recall get indent
recall edit indent --tag style      # no field flags opens $EDITOR
recall delete indent
recall --json search cache          # machine output
```

## Messaging between hosts

A Claude Code session on one host can message one session, or every session, running on another host signed in as you. Messaging stays off until you turn it on, on each host that takes part.

```bash
recall config set messaging.enabled true
recall devices                                        # the host names you can address
recall sessions                                       # the session handles you can address
recall send desktop-9f8a "the build is green"
recall send desktop "the build is green"
recall send core "the build is green"                  # the label the dashboard gave that host
echo "the build is green" | recall send desktop
recall order core "pull main and rerun the migration"  # one session there, not all of them
recall listen --status                                # who can receive here, and who cannot
```

`<to>` is a session handle as `recall sessions` prints it, which reaches that one session, or a host, which reaches every live session on it and is named by its label, its device name or its device id. The message arrives as a user turn. Claude addresses the same hosts and sessions through the `recall_send` MCP tool, registered only while messaging is on; Claude Code's own cross-session tools see only the machine they run on, so `recall_send` is the only route to a session elsewhere.

### News and orders

`recall send` is news: every session the host has registered reads it. `recall order` is an instruction one of them carries out, and the other sessions there never see it. Use news to tell a host something and an order to have something done — a publish, a migration, a fleet update that is not idempotent — because news sent to a host running three sessions is three sessions each doing the work and each answering.

News is published, not delivered. It goes to the sockets attached the moment it is sent, and that is the whole of what the bus owes it: `recall send` reports it sent, nothing is kept for a session that starts later, and news published where no host was listening expires unread. Send an order where you need to know the work landed and which session took it.

```
$ recall order core "pull main and rerun the migration"
order 4f2c… taken by ip-10-0-7-31-9f8a on core
```

An order nobody took is an error, not a quiet success: the command says which of the three things happened — no host is listening as that device, the host is listening and no session took the order, or the host took the order back because it has no session that can act on it — and exits non-zero. `recall_order` is the same verb as an MCP tool, and refuses with the same reason. In every case the error is the end of it. Nothing is left behind for a session that starts later, so the sender is never told an order failed while a copy of it waits to run, and never has to wonder whether sending it again would run it twice. Send it again once that host is listening.

The mailbox decides which kind a message is, once, at send time; a message's kind never changes afterwards. News is pushed to every socket the host has open, the host fans it out, and nothing is written back. An order is pushed to one socket under a token that socket has to quote in its receipt, so no other connection can answer for it. The host picks one of its sessions, writes the order into it, and reports back which session took it, which is what the sender is shown; a host with no session that could take it reports that instead, and the sender hears it at once rather than waiting the window out. An order whose host reports neither — its chosen session died, or the socket dropped before the receipt landed — is dropped when the send gives up waiting, ten seconds on, and the sender is told no session took it.

Those ten seconds are the one number the two sides share. A host tries its sessions in turn, and a session that will not take the write loses its registration, so the walk is bounded by that window rather than by how many sessions the host has: it starts a write only while five seconds of the window are left, which with the five seconds it allows one write fits inside the ten, and past that the order is retired where it stands. A host walking on past it would have a session take an order whose sender had already been told nobody did, and a re-send would then run the work twice. `TAKER_WINDOW_MS` in `src/mailbox.ts` and `ORDER_WALK` in `cli/src/sessions.rs` are the two halves of that arithmetic.

News and an order are different shapes on the wire, since only an order is answered: news arrives as `{"type":"message","message":…}` and an order as `{"type":"order","message":…,"token":…}`. A pushed message also carries an `expiresAt` equal to its `createdAt` that nothing reads: every daemon released while messages were still stored refuses a frame without the field, and it goes once none of those is left running.

A host attaching is handed nothing at all. There is no queue to drain: a message reaches the host that was listening when it was sent, or nobody.

The connection says whether the daemon behind it reads a message's kind. One from a recall older than orders says nothing and is handed no order, since it would write the order into every session it has; the sender is told no host is listening as that device, and nothing is kept. So a fleet where one host has not updated yet runs the order on the hosts that have, and names the one that cannot.

A host with two sockets open is pushed news on both, so news can arrive twice; an order goes to one socket and cannot. The daemon's `seen.json` suppresses the duplicate before it reaches a session.

The mailbox owes no alarm and makes no pass. Revoking a device closes that device's sockets as part of the revocation, so it stops reading news the moment it loses its login rather than up to a quarter of an hour later.

A name or label two hosts answer to is refused, naming both, rather than resolved to one of them. Only the device id, which is unique, settles an address on its own.

Signing in again from a machine already signed in takes a second login rather than replacing the first: the name is suffixed, `core-box` and then `core-box-2`, while both stay under the one host `core-box`, which is what a label is set on. They are one machine, so they do not read as two: an address naming that host reaches its newest login, the only one a daemon still reads.

Each message arrives under one line naming where it came from and what to answer: `[recall from core/ip-10-0-7-31-9f8a; reply with recall_send to "ip-10-0-7-31-9f8a"]`. A send that can tell which session it is running inside names that session's handle, and the reply goes back to it alone; one that cannot is answered on its device id, which reaches every session on that host. Either way the address is one nothing can rename under the message: the host's label reads as prose and is never what the reply is sent to. Both are resolved where the message is sent and ride with it, so the receiver looks nothing up. A message typed into the dashboard has no device behind it and so no address to answer, and its line says that instead: `[recall from the dashboard, signed in as owner@example.com; it has no reply address, so answer in this session]`.

A handle is the host's device name, a dash and the first four characters of the session id, so `desktop-9f8a` names one session and `desktop` the whole host. It is a function of the session alone, so it never moves to another session. The name Claude Code gave the session reaches it too, where the service has read one out of the transcript. A host answers before a session does, so a string that names both reaches the host, and an ordinary host send is settled from the device listing alone without costing one of the sessions. The service derives it from the synced session records, so a send from any host resolves it the same way: the message carries the session it is addressed to, and the daemon there writes it into that one inbox.

The plugin runs the listener. At session start the hook writes `$XDG_RUNTIME_DIR/recall/sessions/<session-id>.json`, carrying the session's `state`, the pid of its Claude process and, when it registered, the inbox socket and token, then runs `recall listen --ensure`. That starts a background daemon unless one already holds an exclusive `flock` on `$XDG_RUNTIME_DIR/recall/listen.lock`; the daemon holding it names itself in `listen.pid`, so `recall update` can end the one it replaced. The daemon holds one WebSocket to the Worker, reconnects with a backoff that doubles from a second to a minute, and writes each message it receives into the inbox of the session it names, or, when it names the host, into every registered socket that was already running when the message was sent. Session end takes the registry file out, and the daemon exits once the registry has stood empty for five minutes; the next session start brings it back. Each thirty second tick also unlinks the record of any session whose Claude process is gone and tells the service that session is over, and takes on the running sessions no record describes. It writes its own `listen:…`, `message:…` and `sessions:…` lines to the hooks log.

Delivery rides on Claude Code's cross-session inbox, which sits behind the server-side gate `agents_cross_session_inbox`. With the gate off, Claude sets no `CLAUDE_CODE_MESSAGING_SOCKET`, the hooks log one line and stop, and no listener ever starts, so news sent to such a host expires unread and an order there is reported as taken by nobody. Everywhere else the listener writes what it is pushed into the sessions it has registered. A message addressed to the host goes to every session registered on it, which are the sessions that were running when it was sent: the service only pushes to a socket attached at that moment and the daemon writes it the instant it arrives. No timestamp is compared, because a host's own clock and the stamps the service puts on a message differ by skew and that says nothing about who should read it. A message addressed to one session handle reaches that session or nobody. An order follows the same rule on which session is eligible and picks one of them rather than all; a session that will not take the write loses its registration and the next one is offered the order, since no other connection will ever see it, for as long as the service's window has room for another write. It is logged as `order:…:taken:<session>` or `order:…:retired`, and news as `message:…:<target>:<delivered>/<pruned>`.

`recall listen --status` says why. It prints whether messaging is on and whether a listener holds the lock, then one line per running session: the session id, its directory, and what the hook recorded — `registered` with the pid that receives, `off` for messaging being off, `no-inbox` for a session Claude gave no inbox, `adopted` for one read out of its transcript, or the error a failed registry write raised. A session leaves the list at session end, or on the next read once its Claude process is gone, so a crash leaves nothing behind. Add `--json` for the same report as a document; it carries no socket and no token.

The mailbox is a Durable Object, one per account, and a message carries at most 32 KiB. It stores no message at all, so there is nothing to cap and nothing to expire: a send pushes to the sockets attached at that moment, and the only thing the mailbox holds is the order it is waiting on, in the memory of the isolate the send is running in. Its durable storage holds nothing at all, and it keeps no alarm. A revoked device loses its sockets as it loses its login.

Durable Objects run on the Workers Free plan, which allows 100,000 Durable Object requests a day; every send, push, receipt and reconnect counts against it.

### The board

The bus reaches whoever is listening. The board waits for whoever reads it next.

```bash
recall post fleet "rerun the migration once main is green"   # the first session anywhere
recall post core "pull main"                                 # the first session on that host
recall post desktop-9f8a "finish the rebase"                 # that one session
recall board                                                 # what is waiting, and who took what
```

`<to>` is read exactly as `recall send` reads it — a device id, a host's name or its label, or a session handle — with `fleet` naming every host signed in as you. A host that answers to `fleet` is posted to by its label or its device id instead.

A board message is taken by one session, once. The first session that picks one up acknowledges it by taking it, and no other session is ever handed it: a post to the fleet runs once across every host, and a post to a host runs once on that host however many sessions it has. Two sessions booting at the same moment both claim and only one writes the row that is the claim, so neither can run the work the other is running. This is the thing news cannot do, and the reason the bus was cut back to a push in the first place: one broadcast woke every session on every host and each of them answered it.

A session picks up at start. The plugin's `SessionStart` hook runs `recall pickup`, and what it took leads the session's injected context, over the memory crib. Each message reads as one line of facts and then the message: `[recall board, posted 2d ago by core/ip-10-0-7-31-9f8a]`. The age is there because a reader acting on a week-old instruction has to know that is what it is doing. One pickup takes 32 kB of bodies, as much as one message may hold, and the rest stay on the board for the next session: what it took rides every turn of that session. A pickup that never reached the service takes nothing, and the next session reads the board again. One that timed out after the claim was written is read back by the same session, because a pickup hands a session what it already holds and `SessionStart` fires again on resume and on compact.

A board message expires seven days after it was posted, so one nobody ever booted into cannot wait on a fleet forever. Past the window it is picked up by nobody and reads on no listing, and the next post to the board takes its row out; nothing makes a pass of its own.

The rows live in D1, in `board_messages` and `board_pickups`, and not in the mailbox: the dashboard lists and posts them, and D1 is what every other dashboard view reads. The mailbox is untouched and still stores nothing. The address is one `scope` and one `target` — the account for the fleet, a device id for a host, a session id for a session — and the pickup's primary key is the message, which is the whole of the one-taker guarantee. A message addressed to a session is only ever taken from the host that session runs on, so naming somebody else's session takes nothing. The Board tab shows the same board and posts to it, picking the address out of the hosts and sessions the account holds; a message posted there reads as from the dashboard and the email that signed in.

## Live sessions

`recall sessions` lists the Claude Code sessions running on every host signed in as you, one line each: host, the handle `recall send` takes, repo and branch, age, state and focus. A host that carries a label reads as `core (ip-10-0-7-31)`, in the listing and in `recall devices` alike: the label leads and the raw name stays, so no host reads as another.

```bash
recall sessions
recall --json sessions      # the whole document of each
recall sessions --adopt     # take on the running sessions this host's hooks never registered
recall sessions --backfill  # send the history and usage of this host's past sessions
recall sessions --replay    # read the archive back and send every session over as records
recall sessions --find kisuvpalas                  # one stored session, wherever it ran
recall sessions --search "the r2 offset protocol"  # stored sessions, by what was said in them
recall sessions --restore kisuvpalas               # put one back here for claude --resume
```

```
laptop  laptop-9f8a  repo:github.com/mvhenten/recall@feat/sessions-list  12m  busy  list every host's sessions → why is the worker test red
tower   tower-c4e2   global                                              3h   idle  draft the release notes
```

The session's registry record is the document. Beside the state the hook left it in, it carries the host, the repo tag, the branch and the last commit subject, the start and last-activity times in epoch milliseconds, a prompt count, the focus, the permission mode Claude reports on the hook's stdin, and whether the session is interactive or headless. Nothing in it costs a model call: the focus line is the session's first prompt and its latest, each cut to 72 characters, and the branch and subject come from one `git log` in the session's directory.

Hooks load when a session starts, so a plugin update leaves every session already running with the hooks it started with: it writes no record, never syncs, and the list stays short until each one restarts. `recall sessions --adopt` takes those sessions on. It reads the Claude processes from `/proc` and pairs each with the transcript it opened under `~/.claude/projects/<directory>/`: the one born soonest after that process started, since Claude Code opens the transcript seconds into the session, and a session that ended minutes ago can leave the directory's most recently written transcript behind. Then it writes the record the hooks would have written: the session id from the file name, the start from its first line, the last activity from its last write, the focus and the prompt count from the prompts in it, and the repo, branch and commit from one `git log`. A session the registry already names is left alone — including one whose record is caught mid-write and does not parse, since overwriting that would throw away the inbox in it.

`recall sessions --backfill` goes further back. History and stats start the day the hooks shipped, while `~/.claude/projects/` holds every session that ran before them, so this pass reads those transcripts back and sends each one as the session it was: the tokens it still owes go out as usage deltas, the sync writes the history row for a session the service has never seen, the end that follows leaves the row standing, and the transcript files go into the archive. A session it already holds keeps its row and is visited for the delegated turns alone. A session is the transcript directly under a project directory plus the delegated turns beside it; a transcript holding neither a prompt nor an answer is no session — a `claude -p` that failed to start leaves one of those, and a row with nothing in it is worse than no row. One event covers one model on one day, so a session that ran past midnight or was resumed over weeks counts on each of the days it spent its tokens rather than piling them all on its last.

`recall sessions --replay` carries the archive itself across. A host that has run `recall update` speaks `/v2` and sends records; what it archived before that is in the byte path, where `/v2` cannot read it as records. This pass takes every session on record that nothing is still writing, reads each of its files back over `GET /v2/sessions/<id>/transcript?file=<file>`, and sends it again through the very reader the live sender uses, so a replayed file and a live one are cut into the same records. A file the record path already holds refuses the first run with the ordinal it waits at, which costs one call and sends nothing, and the file is reported and passed over rather than stopping the run. A session the byte path wrote is what the pass is for: an append opening at ordinal 0 carries the whole file after it, so it takes the session over — the byte mark is cleared and the chunks that path wrote are dropped in the very batch that stores the records' own, and the session holds one path's chunks and never both. An append landing where the records of such a session do not reach is refused and told where they do, which is ordinal 0 for a session the byte path alone wrote and the end of the stored records for a replay that stored them and lost the file before it could index them.

A record is one line of a file and the file is its records with one break between them, so the archive also holds whether a line break closed the last record of each append: a transcript ends on one and a tool output a session stopped writing part way through a line does not, and a file reads back on the break it had. A line that is not valid UTF-8 — a tool output holds whatever a command printed — carries its own bytes in base64 behind a marker the service decodes before it stores them, so nothing crosses lossily and no file is refused for the bytes it holds. A file ends on the record a session stopped writing part way through, so an append behind such a record is refused: its bytes would land under an ordinal of their own and the two would read back as the one line they are, leaving the archive counting one record more than the file holds.

Each file's reading spends a block of chunk numbers of its own, and the block comes from the file's name and nothing else. Numbering by position would move every later file's block the moment a delegated turn with an earlier name joined the set, onto numbers another file had already spent. The blocks sit above the numbers a running session's hooks hand out, which climb from nothing, so a whole-file reading can never be taken for a delta that had already arrived.

What a session still owes is a usage fact, and the service keeps it as one. Every delta names the transcript files it read, so `counted_files` says which of a session's files have had their tokens counted, by whoever counted them — the hooks as it ran, or a run reading the file back long after. The archive says nothing about it: a running session's lines go up on a beat of their own with no counting pass behind them, so bytes held has not meant tokens counted since. A session the service has never seen owes all of its files and is not asked about, since the route that answers knows only a session on record and nothing it could say would change the answer. A session it has owes the delegated turns it has not counted, and never its own transcript again.

A reading sent twice costs nothing either way. The same file read again yields the same chunk numbers, every event a backfill sends is marked to be kept rather than swept at two weeks, and the rollup counts a chunk number it already holds exactly once — so an interrupted run is finished by the next one, and a second run adds nothing at all, however long after the first it runs. The run reads `GET /v1/sessions?scope=history` to the last page first, so it knows which sessions to ask about, and a session the registry still names is live and adoption's.

A past session carries less than a live one. A transcript names no subscription, so every event it yields is attributed to the account this host is signed in as now; it also says neither whether the session was interactive nor which commit its directory sat on, and the history row carries the API's empty readings for both. The directory and the branch are what the entries themselves name.

One gap stays open. A session's own transcript is read once and never again: the hooks counted it as the session ran, or the run that wrote its history row did, and a transcript cannot say which. So a session adoption took on, which is on record from the moment it was adopted and whose earlier tokens no pass ever read, keeps those tokens uncounted, and so does any session on record whose own transcript only partly landed. Its transcript is still archived whole; it is the tokens that stay missing. The delegated turns are not in this gap — nothing ever counted one before, so there is nothing to tell apart.

Its prompt count is what the transcript supports. A tool result, a notification about a task and the expansion of a slash command are all written as user turns as well; a transcript Claude Code writes now marks the turns the user submitted and only those are counted, and one written before that mark existed is read off the marks it does have. The usage counting above still takes its prompts from the record, which counts a prompt as it is submitted.

Every host syncs its own sessions, whether or not messaging is on, so the list covers them all. No hook ever waits for the service: session start, session end and every prompt start the sync and walk away, at most one per session every thirty seconds, and the hooks log is where each one reports. A detached sync that failed leaves a `sessions:sync-failed:…` line and nothing else.

Token usage is read out of the session's own transcript, so counting it costs no model call and no second API. On the same beat, just before the sync goes out, the hook reads the stretch of the Claude Code transcript JSONL the session has not sent, cut back to its last complete line, sums the per-message usage by model and writes that delta into the record; the sync carries it. The service keeps the first delta it saw for a chunk number and ignores a second one, so a delta that did not land is sent again byte for byte, never re-read to the end of the file, and the record moves past a stretch only once every event in it has landed. Chunk numbers climb and are never reused, whatever the transcript does under them. One answer is written as several transcript entries carrying the same usage, so a message counts once by its id, across the end of a stretch as well as inside one. The prompt count comes from the record, which counts a prompt as it is submitted, and not from the transcript, where a harness notification reads like one. Session end reads the closing stretch and `recall sessions --end` sends it before marking the session gone, since a delta carries its own host and repo; a session whose Claude process died has both sent by the listener's sweep instead. A transcript that is missing, unreadable or rewritten shorter than the offset starts counting again at the file's end rather than failing the session, and so does a session resumed into a transcript this host has no record of counting.

The count covers every file the session writes. A delegated turn goes to a file of its own under `<session id>/subagents/` and never into the session's own transcript, so reading the one file counted a fraction of what a session spends — on a host measured over a week, about a fifth. Each file carries its own mark and its own last-counted message id, since the ids of one say nothing about another, and a model that answered in several of them spends once on the session. A file the session opens after it starts is counted from nothing; every file that already existed when the record was written starts at its end, which is where a resumed session picks up without recounting what the run before it counted.

### The transcript archive

Every transcript lands in the service's object storage and stays there: nothing is deleted and nothing expires. A running session's new lines reach it on the beat the hooks already fire, and on the listener watching the directories that session writes in: a write wakes it, a burst of writes half a second apart is one pass rather than one each, and a long turn that answers no prompt for twenty minutes is archived while it works rather than once it is over. Behind the watch the listener keeps a beat of its own, every `archive.interval.seconds` (10 by default), for the filesystems inotify does not reach and the writes no event arrived for. A pass over a session that has not written since the pass before it costs no call at all, so a quiet host is free either way. `recall sessions --backfill` carries up everything a host still holds.

Object storage has no append, so a file is kept as one object per appended stretch, under `<user id>/<session id>/<file>/<start>.<end>.<inflates>`. The first two are zero-padded places in the file on disk — where the stretch begins there, and where it ends there — and the third is how many bytes of it the object holds. Listing a session's prefix gives its stretches in the order the file puts them, and the furthest place any key names is how far into the file the archive reaches — which is the one place a host sends on from and a restore weighs a local file against. Reading a file back is a concatenation of those stretches, and where one sits in that concatenation is the lengths of the stretches in front of it, counted off the same listing.

Every stretch is redacted on its way out, so what an object holds is the file with its secrets written out as placeholders of another length. The object's size therefore says nothing about how much of the file it accounts for, which is why the key names the end as well as the start.

A stretch then goes up gzipped, after the redaction and never before: the scanner reads bytes, and nothing of a compressed stretch reads as the secret it holds. A transcript is prose and JSON, so a stretch of one stores and transfers at under a third of its size — measured over 456 MiB of real transcripts, 3.47 times smaller. The member is stored as it stands and handed to the reader to inflate, so a restore writes back the bytes the host read, byte for byte, and the service inflates nothing on that path. A gzip member has no inner range and says nothing about how long it inflates to, which is where the third segment of the key comes from: the one number every placing of a stretch rests on comes off the listing rather than out of the objects. The append takes that number by inflating the member once, on a path already paying for a listing, so no caller names it and none can store a stretch under a name claiming part of what it holds. A key of two segments is a stretch stored as it stands — everything archived before this, every stretch from a host that has yet to learn to compress one, and any whose member came out larger than the cap on a body — and both forms are read side by side. Nothing is rewritten and nothing is backfilled.

A key of one segment names one number, and what that number means depends on the host that wrote it. Before redaction a stretch ran to exactly the bytes it was read from, so the one offset named a place in the file and in the archive at once. v0.15.0 and v0.16.0 redacted and still wrote one offset, and there it is a place in the archive over a body of another length than the span of the file it accounts for — so the number is no place in the file at all, and a host reading the file at it would leave the bytes between in no object or send a span the archive already holds a second time. **Those two releases must never be installed on a host**: a host goes from 0.14.0 or earlier straight to the release that keys both ends. No object in this archive was written by either of them.

Nothing rewrites those keys and nothing backfills them, so the service says which keys a reach rests on rather than leaving it assumed. A reach standing on a key of one segment is handed over as what it is, and a host or a restore told one the file on disk disagrees with — a reach past the end of the local file — stops and says so, rather than archiving across the gap or writing a complete local transcript over with a redacted copy. Once a file holds a key naming both ends, every single offset past it is passed over: the two forms share no scale, and reading both would lay one file out as runs with holes between them and point reads inside the wrong objects.

An append is one read and one write and claims nothing. The read says how far into the file the archive reaches, and the stretch is taken only where it begins exactly there; how far the archive reaches afterwards is then the stretch's own end, so a host carries its own place from there and never reads the file twice to find it.

Only one reading is kept out of the archive and in the database: how many bytes of a session's own transcript the archive holds, which the indexer consults on every pass and could not pay a listing for. The append writes it, off the listing it weighed its own stretch against — counting it again when the storage event lands would have cost a listing of the whole of the file's prefix per stretch, which is the length of the session. Every count is folded in with MAX, so nothing lowers the row below what the archive already holds; the price is a second write on the append path, and a row left standing ahead of the objects if one of them is ever lost outright. Every other question about where a file ends — a host working out where to send the rest of one, a restore writing files back to disk, a box following a session as it is written — is answered by counting the objects.

Everything else the service holds about a transcript follows the object. R2 announces each write to a queue, and the Worker consuming it reads off the key who wrote which file of which session and indexes that session's prose. The queue delivers at least once, so the same event does arrive twice; indexing reads from the mark the last pass left, so a second delivery indexes nothing again.

A box following a live session beats against one page of the end of the file's prefix, however long the session has run. It carries two numbers: how far it has read the archive, and the stretch that place is the end of. The second is what places the first — a stretch keyed by both its ends sits where the sizes of the stretches in front of it put it — so the listing opens past that stretch instead of counting the whole prefix again. Both come off the manifest the service itself wrote. A reader whose cursor is a key of one segment is read on that key's terms: the listing reaches one stretch back from it, which is as far as a stretch of at most 1 MiB can reach, so a stretch landing below a key it has already taken is named however late it lands.

Two writers do reach one file at once — the listener's beat and a session ending — and both offer a stretch beginning at the same place in it, each read at its own instant and so accounting for a different span. One lands and the other is answered 409 carrying how far the archive now reaches, which is where its next stretch begins. Letting both land would have the archive account for the span they share twice, and nothing can be trimmed off the head of the second: what it holds is the file redacted, and no count of those bytes answers for a place in the file.

`GET /v1/sessions/<id>/transcript` answers how many bytes of each of a session's files the archive holds and how far into each one it reaches, both counted off the objects, `GET /v1/sessions/<id>/transcript?file=<file>` reads one of them back whole as the concatenation of its stretches, and `PUT /v1/sessions/<id>/transcript?file=<file>&offset=<from>&through=<to>` appends one stretch of at most 1 MiB, naming the span of the file it accounts for; a host from before redaction names `offset` alone and is answered in archive offsets, which is what keeps it writing while it waits for a release. All three take the device token and answer 404 for a session the account does not hold, so the only prefix a caller can reach is its own. The first costs a listing, so a host asks it once for a session it has no place for and carries its own place from there; it is kept apart from the mark the usage counter keeps in the session record, so moving either can neither skip nor replay the other.

A file shorter than where the archive reaches into it is not that file any more: a transcript rewritten or truncated under the archive. The stretches already written stay as they are and nothing is spliced onto them, since the places they are keyed by no longer describe anything in the new file. The usage counter reads the same shape the same way, counting the new file from its end rather than counting the old one over again.

### Finding, searching and restoring a session

A stored session answers to three names, and any of them reaches it from any host signed in as you: its Claude Code session id, the handle `recall send` takes, and the name Claude Code gave it — the ten-letter word it writes into the transcript as an `agent-name` entry, `kisuvpalas` and the like. The service reads that name off the head of the session's own transcript on its first indexing pass, so a host reports nothing and a session archived long before this existed is named too. A name recurs, since the harness hands the same word to a session resumed weeks later, so a name that answers for more than one session gives back the most recently active — and says how many it answered for, since `--restore` writes a transcript to disk off that pick.

```bash
recall sessions --find kisuvpalas                  # one session, by any of its three names
recall sessions --search "the r2 offset protocol"  # sessions on every host, by what was said in them
recall sessions --restore kisuvpalas               # write its transcript back here, then claude --resume
recall sessions --restore kisuvpalas --cwd ~/src/recall
```

`--restore` writes the session's transcript into `~/.claude/projects/<directory>/<session id>.jsonl` and each of its delegated turns under `<session id>/subagents/`, where Claude Code looks for them, and prints the `claude --resume` that takes it. Claude Code resumes from the transcript alone — there is no registry to join and no metadata to mint — so a session that ran on another machine resumes here and answers about its own history, because what is restored is the transcript whole and not a summary of it. The directory is the one the session ran in unless `--cwd` names another, so the paths the transcript talks about still mean what they said. A file this host already holds the whole of is left where it is: a restore onto the machine that ran the session never truncates a live transcript, and restoring twice costs nothing.

### The session index

`--search` finds sessions by meaning across every host, over an index of what was said in them. Only two things are indexed: the prompts the user typed and the prose the model answered with. A transcript is mostly machinery — tool calls, tool results, file snapshots, hook output — and a delegated turn is the model talking to itself, so none of that is read. On a real transcript the prose is a few per cent of the bytes.

Each speaker is chunked on its own, so a prompt is never indexed under the answer that followed it. A chunk closes when the next turn would push it past 2,000 characters, or when it already holds 400 and shares too few of its words with what is there to be about the same thing — a mechanical reading of the subject changing, which is what keeps a chunk from straddling two of the dozen subjects a day-long session covers.

Indexing happens when the bytes arrive, on the same storage event that moved the archive: the write that made the work is what schedules it, so there is no beat, no queue table and nothing that asks what is due. A stretch is at most 1 MiB, so one event is one pass — one read of the archive, one batched embedding call per 96 chunks, and one batch of inserts. A session far behind, one backfilled from years of transcripts, is caught up over as many passes as it takes, each picking up where the last stopped and each committing its own mark, and a session resumed months later appends to its index rather than rewriting it. Nothing is ever deleted. A 3.5 MB transcript boils down to roughly a hundred chunks and two embedding calls.

`session_index` keeps one row per session with how far the archive runs and how far the index has read. The first is a cache of the objects, moved by the event that wrote them; the second is the index's own and no listing could recover it.

One gap stays open: a session whose last stretch loses its notification stays short by that stretch, since a session catches up only on the next event it gets and nothing sweeps for one that never comes.

Each session in a delivery is caught on its own. A transcript the indexer cannot get through — a hole in the archive, a model call that keeps failing — would otherwise fail the delivery and hold back every other session's stretches in it; caught, it leaves its own mark where it was and sends its own messages back for redelivery, so that session is tried again while the rest of the delivery acks. The mark a pass leaves is where its bite ended in the file and never how much it read: the two part company over a hole, and the read steps over one rather than stalling on it or indexing prose it already holds.

A search scores the query against every chunk the account holds and runs the full-text query over the same table, then fuses three rankings: the chunks by vector, the user's own chunks by vector, and the full-text matches. The user's prompts ranking twice is deliberate — a session that was asked for a thing outranks one that merely mentioned it. Scoring every chunk is the point: a vector is 388 bytes, so a few thousand chunks is under a megabyte and a few thousand dot products, the same shape the memory search has always had, and a long session that covered a dozen subjects answers on the one that matches rather than on an average of all of them. Each hit carries the chunk that answered, verbatim, so a search says why it returned what it did.

State is read, never stored. A session prompted within the last five minutes is `busy` and one quiet since is `idle`. A session that is gone is one its own host dropped: nothing ends a session on another host's behalf. The `recall sessions --end` the session end hook starts drops it, once the delta the record carries has gone out, and so does the listener's own thirty second tick, which deletes the session whose Claude process it finds gone — the `recall listen --status` sweep and the service's copy come out together. Only a host that dies with no listener running leaves a record behind, and that one expires a day after its last prompt. `name` is the handle that addresses the session, so the listing doubles as the address book for messaging.

## Dashboard

Opening the hostname in a browser answers `303 /dashboard`; a client that does not ask for `text/html` still gets the 404 JSON. Both answers carry `Vary: Accept`.

The dashboard is server-rendered. The one page that runs script is a session page, which reads the transcript in the browser; the script is served from `/transcript.js`, named by origin in the page's own content security policy, and reaches no host but this one. That path sits outside the Access application covering `/device` and `/dashboard`, under the hostname-wide bypass: the script carries code and no user data, and a tab restored after the sign-in ran out would otherwise be handed a login page in its place, which nothing on the page can notice. It is written in `browser/view.ts` and shares the transcript reader with the index, so what the page shows and what the index holds cannot drift; `npm-scripts/build-browser.mjs` bundles it on install and before every deploy and setup. It reads the same Access JWT as `/device`, from the one Access application that covers both paths. It refuses an email that is not invited. `npm run setup` and the OpenTofu config under `infra/` each add `<hostname>/dashboard` to that application as a second public destination. A self-hoster who deploys the Worker another way adds that destination by hand. The dashboard answers a `GET` everywhere but the Labels tab, the Board tab and a session page, which take their own form posts behind an origin and CSRF check; saving, editing and deleting memories stay with the CLI and the tools.

Every page carries the signed-in email and a line on now: the live and busy session counts, today's cost and today's sessions. The tabs are Sessions, Board, History, Memory, Artifacts, Stats, Insights and Labels.

- `/dashboard` lists the live sessions of every host as a ledger, newest activity first: state, handle, `repo@branch`, the focus line, age and prompt count. Beside it sits one line per host with its live and busy counts, and the oldest idle session. Every handle opens the session, and every host opens its history.
- `/dashboard/sessions/<session id>` reads one session, live or long over: its state, host, scope, directory, start, prompt count, the accounts that paid for it and what it spent, then its transcript. A transcript is a chain of R2 objects, so the page carries a manifest of them — every stretch of the chosen file, where it sits and how long it is, off one listing — and the browser fetches the bytes against it, 64 kB at a time, newest first, scrolling back for older. The Worker streams one object per request and parses nothing; splitting the JSONL into prompts and answers is the browser's work. A stretch boundary is not an entry boundary, so the part line at the head of each fetch is held back and joined to the fetch after it. Where the archive never got a run of bytes the page says so and skips the entry that straddles it. A session archiving delegated turns offers a chip per file. A session a host is still holding is followed forward as well as read back: the box asks every 10 seconds what has landed past the stretch it last took, reads it in the same 64 kB steps, carries a reader sitting at the foot of the box along with it, and tells one who has scrolled back how many turns arrived below. It asks less often the longer the session says nothing, down to once every five minutes, and comes back to 10 seconds the moment something arrives; a hidden tab asks nothing at all, and following stops and says so when the session ends or three beats in a row fail. A beat reads how far the file reaches off the row the queue keeps, so one that finds nothing new opens no object; that row is a cache and can lag the objects, so it is trusted to say a file has grown and never to say it has not. A message reaches a session while its host still holds it, which is up to a day after its last prompt, and only while that host is listening: a box sends one over the same bus `recall send` uses, the host hands it to the session as its next turn, and the answer lands in the transcript below. It is news, so it is published and not delivered, and one typed while that host is not listening expires unread. The message says it came from the dashboard and carries the signed-in email as its sender, since no device typed it, and it arrives with no reply address rather than one `recall_send` cannot resolve; a session whose host has let it go says so instead of offering the box.
- `/dashboard/board` shows [the board](#the-board), newest first, each row carrying the message, where it is addressed, who posted it, its age and either that it is waiting or the session that took it. It pages on the same cursor the other listings use. Above it one form posts to the board, picking the address out of the fleet, the hosts signed in and the live sessions, so the page hands over an address and never a string somebody has to resolve twice. A message posted here reads as from the dashboard and the email that signed in.
- `/dashboard/history` reads the session history: every session ever synced, grouped by UTC day, newest day first, each row carrying its handle, host, `repo@branch`, the span from the first prompt to the last activity, the prompt count and the focus line. A session that is still running is marked and stays in the list. `host` and `repo` narrow the page as links built from the hosts and repos the page holds, and the page walks back on the same cursor shape the memory listing uses. A search matches the focus lines, the commit subject and the agent name, off an index kept by triggers on the history table, and the rows also sort by agent name.
- `/dashboard/memory` lists memories newest created first and pages on the same cursor `/v1/memories` answers. A form narrows the page by tag and by type, and a search there runs the hybrid ranking the CLI runs, at the same `--min-score` default of 0.55, showing the fusion score of each hit. Query, filters, sort and cursor live in the URL, so a search is a link, and the rows also sort by name and by recall count. `/dashboard/memory/<name>` renders one memory's body. Both read without recalling: browsing never moves a memory's recall count or the time it was last recalled. The strip above the listing counts the memories, the ever recalled, the never recalled and the ones saved in the last 30 days, and each type chip carries its own count.
- `/dashboard/artifacts` browses the [artifacts](#artifacts) this account has published, newest first, each row carrying the name as a link to the address it answers on, the type and file count, the size, when it was last published, both permissions and the email that wrote it. It pages twenty at a time, narrows by type, searches name, title and description, and sorts by publish time, name or size. It reads the same listing `GET /v1/artifacts` answers, scoped to the signed-in user, so one page view costs one indexed read of the rows and one of the counts the chips print, and reads no artifact's bytes. Opening an artifact is a second Access sign-in on the artifact hostname, so every link opens a tab of its own. The second line of each row's last column carries the artifact's live share count, or `Share` where it holds none, and that count is itself the link to the artifact's [share page](#sharing-one-artifact). Publishing and unpublishing stay with `recall publish`, `recall unpublish` and the tools. Where the deployment names no artifact hostname the tab says publishing is off rather than drawing an empty shelf.
- `/dashboard/stats` prices the usage. Five tiles show today's cost against the seven day average, the seven day cost against the week before it, today's tokens, the seven day cache hit rate and today's session count. Under them: cost per day stacked by model, over 14 days and over 30 days, and the model mix as a donut and a table. Input, output and cache-read tokens each get a bar per day. An efficiency list over seven days gives cost per prompt, cost per session, tokens per prompt, output against input and cache hit, and the last three tables split the 30 days by account, by host and by repo.
- `/dashboard/insights` reads the last 14 days. The working set is the top five memories by recall count over the last 30 days, with the share of every recall they carry. Going stale lists five of the memories at risk, which are the ones last recalled over 60 days ago and the ones never recalled and saved over 14 days ago. Cache economics counts the fortnight's cache reads, what they saved against fresh input, and its best and worst day. The rhythm is a heat map of sessions by weekday and hour, and the next card ranks five repos by session time. A last row reads back over everything the rollups hold, so months of backfilled transcripts shape the page: cost by month stacked by model, five repos ranked by the session time of every session on record, and the cache hit rate month by month. A month is the month of the UTC day the rollup counted the delta under, and a session lends each window only the stretch that falls inside it.
- `/dashboard/labels` names the hosts and the accounts. It lists every host and every account the account has on record, live or past, each with a field holding the friendly name it carries, and one post saves the lot. A name replaces the raw value wherever a page prints it: the sessions ledger and its hosts card, the history rows and the filter chips, and the account and host tables on Stats. Filtering and grouping stay on the raw value, so a link built on a host keeps working whatever it is called, and clearing a field puts the raw value back. A host label also travels: `recall sessions` and `recall devices` print it beside the raw name, and `recall send` and `recall_send` take it as an address.

The prices are Anthropic's published list, in US dollars per million tokens, with a cache write at 1.25 times input and a cache read at a tenth of it. A model the table does not name has its tokens counted and its cost left out, and the page names that model and the tokens it spent. A total mixing priced and unpriced models is marked `≈`.

How far back each page reads:

| Record                | Kept                                 |
| --------------------- | ------------------------------------ |
| a live session        | 24 hours past its last activity      |
| a session history row | for good                             |
| a raw usage event     | 14 days past the server recording it |
| a daily usage rollup  | for good                             |

## Artifacts

A deployment can publish artifacts: a site of self-contained HTML, a markdown document, or a set of audio files that play as one artifact. They answer on a second hostname of their own, `https://<artifact hostname>/a/<name>`, behind its own Cloudflare Access application admitting the emails that reach the dashboard. Every artifact address begins `/a/`, its files answer under `/a/<name>/f/<path>` and the player's script under `/a/<name>/player.js`, so a name can never collide with a route and a file path can never collide with one either.

```
recall publish burn-up.html
recall publish ./build/report.html --name q3-report
recall publish notes.md --type document --title "Q3 notes" --read account
recall publish track-01.mp3 track-02.mp3 --type audio --name panel-episode-12
recall artifacts --type audio --sort largest
recall unpublish q3-report
recall share q3-report
recall share q3-report --email reader@example.com
recall shares q3-report
recall unshare q3-report --link
```

Every artifact carries a type, a title, a description, a read permission and a write permission. A `site` is one file, served as its bytes: the sandbox it loads in gives it an opaque origin, so `'self'` matches nothing and a page can never load a second file of its own; a site manifest naming more than one file is refused, and `document` and `audio` are the types that hold several. A `document` renders in the Worker, from a markdown renderer written here that escapes every character it prints, and reads raw at `?view=raw`; over 2 MB the bare address answers the raw view. An `audio` artifact draws a player over the track list the publish named, and each track's own address streams its bytes and answers a range request, so a seek never waits for the file. Read `private` means its owner alone and `account` every invited email; write `owner` means its owner alone and `account` any device of the account. A refused read and a name that holds nothing answer the same 404.

`recall publish` sends one or more files and prints the URL the artifact answers on. The files land in the order they were named, which is the track order of an audio artifact, and the first of them is what the bare address serves. The name defaults to the first file's own, lower-cased with every run of anything else a dash. A name that already holds an artifact is refused with a 409 naming what is there, its size, when it was last written and by whom, until `--replace` says to replace it. `recall artifacts` lists what the account has published and takes a query, `--type`, `--sort` and `--limit`; `recall unpublish <name>` removes an artifact and every one of its files. Claude reaches all three through `recall_publish`, `recall_artifacts` and `recall_unpublish`, and publishes from the path of a file it wrote so the bytes go from disk to the service without passing through the conversation. Where a deployment names no artifact hostname, every one of them reports that it publishes no artifacts.

### Sharing one artifact

A share is one grant of read access to one artifact, and it comes in two modes. A **link share** carries a 32-byte token in its address; storage holds only the token's SHA-256, Access bypasses the prefix the address sits under, and a reader with no account at all opens the artifact. An **email share** names one lower-cased address and answers under a second prefix behind its own Access application, which admits any address through Cloudflare's one-time PIN; recall verifies the assertion against that application's audience, resolves the share by a random id in the path, and compares the proven address to the one the share names. Both expire thirty days after they are made and are renewed by the owner. An artifact holds one link share, which a second replaces, and up to twenty email shares.

```
recall share q3-report                                 # a link, printed once
recall share q3-report --email reader@example.com      # one named address
recall shares                                          # every share, grouped by artifact
recall shares q3-report
recall unshare q3-report --link
recall unshare q3-report --email reader@example.com
recall unshare q3-report --all
```

The owner creates, extends and revokes from `/dashboard/artifacts/<name>/shares` as well, reached from each row of the Artifacts tab and from the bar an owner sees on their own document and player pages. **No MCP tool shares or unshares**: a tool minting a bypassed public address for any artifact would give a prompt-injected session a way out, so `recall_artifacts` carries each artifact's live share count and an agent can read what is shared and change none of it.

A share address reaches one artifact's page, the files that artifact's own manifest names and the player's script under that share's base, and nothing else on the host: it cannot reach a second artifact, any listing, any API route, any page of the dashboard or any method but GET, and it mints no Access session on the dashboard hostname. Liveness is a predicate on every read and never a state a row is moved into, so nothing sweeps: an expired row is invisible everywhere, and a read of its own address past its expiry deletes it by its primary key and answers the same 404 an unknown token gets. An unknown token costs one read and no write. An unpublish takes every share on the name with it, and a republish leaves them alone.

Sharing is on where `ARTIFACT_SHARE_ACCESS_AUD` is bound, which `npm run deploy` does from the email application's audience. A deployment that publishes artifacts and binds no share audience shares none: the share page says so and draws no control, no owner bar is drawn, both prefixes answer the 404 page, the share routes answer 404, and every artifact reports no shares.

A publish is `multipart/form-data`: one part carrying the manifest, then one part per file in the manifest's order, each streamed into R2 as it arrives rather than buffered. A file holds at most 32 MB, an artifact at most 64 MB and 50 files. Each revision's bytes live under `<user id>/<name>/<rev>/<path>`, which is what makes a publish atomic: the new revision is written where no reader can reach it, and one compare-and-swap moves the row forward. A publish that fails anywhere before that statement leaves the artifact and every one of its files as they were. An artifact published before artifacts carried a type still reads at its old address, and `recall artifacts --adopt` takes it into the listing; it is run once per deployment, because a migration cannot read storage and nothing here sweeps on a schedule.

The second hostname is the point. A published site carries its own inline style, script and `data:` assets and may reach no other host, so it runs on an origin holding nothing else: the dashboard, the device pages and the API all refuse to answer there, and the main hostname never renders an artifact. A site is served `sandbox allow-scripts allow-downloads`, so it loads into an opaque origin and reaches neither the storage nor the cookies of anyone else publishing on that hostname. That is also why a site holds one file and not several: without the sandbox an `account`-readable page could read every artifact on the host, and with it the page has no origin of its own to load a stylesheet, a script or an image from. Every file a document or an audio artifact holds is served under that same policy, because an address under a name is navigated to as readily as the name itself and HTML or SVG of the publisher's reached that way must land in an opaque origin too; `sandbox` binds the document a navigation makes, so a track the player asks for still plays and still answers a range. recall's own pages on that host — a document, a player and the refusals — carry no script but the player's, which is served from that host and connects nowhere. Every read goes through the Worker with `Cache-Control: private, no-cache`, so a republished artifact is the one the next reload draws.

The feature is off until a deployment names that hostname — `--artifact-hostname` for `npm run setup`, `RECALL_ARTIFACT_HOSTNAME` for a Workers Builds deploy. Without it the deployment is unchanged and no R2 bucket is created, since R2 needs billing switched on even where it costs nothing. Turning it back off is a deliberate act: unsetting the variable makes the OpenTofu plan destroy the bucket, and the deploy refuses any plan that destroys, as it does for the D1 database. Empty the bucket, `tofu state rm cloudflare_r2_bucket.artifacts[0]` and delete it by hand, then deploy.

## Desktop connector

The Claude Code desktop app reaches recall as a custom connector, without the CLI. The endpoint speaks MCP over streamable HTTP at a path of the main hostname:

```
https://recall.example.com/mcp
```

Paste that URL into Settings → Connectors → Add custom connector. It serves seven of the tools `recall mcp` serves on stdio, under the same names: `recall_search`, `recall_get`, `recall_list`, `recall_save`, `recall_edit`, `recall_delete` and `recall_send`. The publishing tools stay on stdio, because a publish names files on disk and this end holds no working copy. This is the lane for a client with no shell; a host that has one uses the CLI.

The missing working copy is also why the connector runs in no repository: with no repo tag to read, global is the default a call falls back to. It is a default and not a boundary — a search or a listing names `tags` to cover others, a search names `any` to cover every memory, `recall_get`, `recall_edit` and `recall_delete` reach any memory of the account by name, and `recall_save` needs `global` or `tags` for a `project` or `reference` memory. Every one of those paths is keyed by the user the assertion names, so a call reaches that user's memories and no one else's.

It answers both eras of the transport on the one address. A client that opens with `initialize` is served the handshake revisions, `2024-11-05` through `2025-11-25`, and one that declares its version in `_meta` on every request is served `2026-07-28`, where the mirrored `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers must match the body or the call is refused. An answer rides the POST that asked for it, as a JSON body or, for a client that accepts only a stream, as the one SSE event that stream carries. Nothing is ever sent unasked, so there is no session to keep and no standalone stream to open, and a GET is declined the way the spec has a server decline one.

The endpoint sits behind an Access application of its own, admitting two schemes. A browser sign-in works where the app carries an Access session cookie: the Worker reads the email out of the assertion with the same verifier the dashboard uses, maps it to the user, and refuses a sign-in relayed from another origin. The scheme that needs no browser is an Access service token, sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers; a service-token assertion carries a common name and no email, so the deployment maps each client id to one user. Every refusal names the scheme it tried and why Access turned it down, so a connector that will not connect says which half is wrong.

It registers as a device of its own kind. The row is not a host: it never appears in `recall devices`, never answers a `recall_send`, carries no sessions and counts no tokens, so the sessions, hosts and usage views stay a record of real machines.

Switching it on is one flag — `--mcp-connector` for `npm run setup`, `RECALL_MCP_CONNECTOR=true` for a Workers Builds deploy, which also takes it as an object in the `recall-builder-secrets` bucket. OpenTofu then creates the Access application, one service token per user, and the non-identity policy that admits them. Leaving it out deploys exactly as before and `/mcp` answers 404. Turning it back off is a deliberate act, as the artifact hostname is: unsetting the variable makes the plan destroy the application, the policy and the tokens, and the deploy refuses any plan that destroys. Delete them by hand and `tofu state rm` them first, then deploy.

Cloudflare shows a service token's secret once, when it is created, and neither the setup nor the deploy reads or prints it. To get one you can paste into the desktop app, open Zero Trust → Access → Service Auth, find `recall-<user>-connector` and rotate it; the Client ID stays the same, so the deployment's mapping still holds.

## API

The routes under `/v1/memories`, `/v1/search`, `/v1/devices`, `/v1/messages`, `/v1/board`, `/v1/sessions` and `/v1/artifacts` need `Authorization: Bearer <device token>`. The Worker resolves the user from the token; a client never names a user. D1 stores only the SHA-256 hash of each token.

| Method   | Path                                            |                                                                                                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT`    | `/v1/memories/:name`                            | create or replace `{description, type, body, tags}`                                                                                                                                                                                                                                                         |
| `GET`    | `/v1/memories/:name`                            | read one                                                                                                                                                                                                                                                                                                    |
| `DELETE` | `/v1/memories/:name`                            | delete one                                                                                                                                                                                                                                                                                                  |
| `GET`    | `/v1/memories?tag=&type=&since=&cursor=&limit=` | newest created first; `tag` and `type` repeat, and each narrows the page                                                                                                                                                                                                                                    |
| `POST`   | `/v1/search`                                    | `{query, tags, any, limit, minScore, mode}`; each hit is a recall                                                                                                                                                                                                                                           |
| `GET`    | `/v1/devices`                                   | the caller's devices, each with the `label` its host carries                                                                                                                                                                                                                                                |
| `DELETE` | `/v1/devices/:deviceId`                         | revoke a device; `current` names the caller's own                                                                                                                                                                                                                                                           |
| `POST`   | `/v1/messages`                                  | `{toDeviceId, toSessionId, fromSessionId, body}`; pushes a message to one session, or to every session on the device when `toSessionId` is empty, and answers what became of it                                                                                                                             |
| `GET`    | `/v1/messages/listen`                           | WebSocket only; takes what is pushed while it is attached, and writes a receipt back for each order                                                                                                                                                                                                         |
| `POST`   | `/v1/board`                                     | `{scope, deviceId, sessionId, fromSessionId, body}`; puts one message on the board, addressed to the fleet, a host or a session, and answers the message it wrote                                                                                                                                           |
| `GET`    | `/v1/board?cursor=`                             | the board, newest first, answering `{entries, nextCursor}`; each entry is `waiting` or `taken` with the session that took it                                                                                                                                                                                |
| `POST`   | `/v1/board/pickup`                              | `{sessionId}`; takes the messages addressed to that session, the fleet and its host, up to 32 kB of bodies, and answers `{messages}` with what that session holds and nobody else can read                                                                                                                  |
| `PUT`    | `/v1/sessions/:sessionId`                       | create or replace one session document                                                                                                                                                                                                                                                                      |
| `GET`    | `/v1/sessions/:name`                            | one session by its session id, its handle or the name Claude Code gave it, with the transcript files the archive holds and how many sessions the name answered for                                                                                                                                          |
| `GET`    | `/v1/sessions?scope=&cursor=&q=&limit=`         | the live sessions, newest activity first, each with the `hostLabel` its host carries; `scope=history` answers `{sessionIds, nextCursor}` over every session on record; `scope=search&q=` answers `{hits}` by meaning                                                                                        |
| `DELETE` | `/v1/sessions/:sessionId`                       | the session is over; every host stops listing it                                                                                                                                                                                                                                                            |
| `PUT`    | `/v1/artifacts/:name?replace=true`              | publish an artifact; `multipart/form-data`, a manifest part then one part per file, and the answer names the artifact and whether the name belongs to another account. A name already taken answers 409 unless `replace` says to replace it                                                                 |
| `GET`    | `/v1/artifacts/:name`                           | one artifact's type, title, description, permissions, file count, size and last writer; resolves the caller's own first and then one published for the account to read, the way a read of its files does                                                                                                    |
| `GET`    | `/v1/artifacts/:name/files/:path`               | one file's bytes, 200 or 206 for a range. Under a name the next segment is a route word — `files` or `shares` — so no file path and no name can reach a route                                                                                                                                               |
| `DELETE` | `/v1/artifacts/:name`                           | unpublish one artifact and every one of its files                                                                                                                                                                                                                                                           |
| `GET`    | `/v1/artifacts?q=&type=&sort=&cursor=&limit=`   | the caller's artifacts, newest published first, answering `{artifacts, nextCursor, total, cut}`; `sort` takes `newest`, `name` or `largest`, and a `q` answers one page of at most 50 matches by relevance. Each row carries `shareCount`, and `shares=true` returns each row's shares instead of the count |
| `GET`    | `/v1/artifacts/:name/shares`                    | one artifact's live shares, link first, answering `{shares}`. A link share carries no address: there is nothing to print for it                                                                                                                                                                             |
| `POST`   | `/v1/artifacts/:name/shares`                    | `{mode: "link"}` or `{mode: "email", address}`; answers `{share, address, replaced}` or `{share, address, renewed}`. The address is printed on this one response and, for a link, nowhere else                                                                                                              |
| `DELETE` | `/v1/artifacts/:name/shares/:shareId`           | revoke one share, answering `{revoked, shares}`, or 404                                                                                                                                                                                                                                                     |
| `DELETE` | `/v1/artifacts/:name/shares?link&email=&all=`   | revoke by lane: exactly one of `link`, `email=<address>` and `all=true`, answering `{revoked, shares}`. Naming none or more than one answers 400 and names the three                                                                                                                                        |
| `POST`   | `/v1/artifacts/adopt`                           | take the artifacts published before they carried a type into the listing; answers `{adopted}` and is run once per deployment                                                                                                                                                                                |
| `POST`   | `/v1/sessions/:sessionId/usage`                 | one token delta `{seq, host, repo, provider, account, model, prompts, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, at}`                                                                                                                                                                    |

`scope` on the session listing says which sessions it covers: the live ones by default, `history` every one the account has on record, as ids alone in id order, a hundred to the page, paged from the `nextCursor` the last answer gave, and `search` the ones whose transcripts answer `q`, each hit carrying the session, a fusion score and the chunk that answered. A scope the service does not know is refused rather than read as the default. The page walks the session id and not the activity time the History tab orders by, since a live session syncing under a caller's paging moves its own last activity and a row that moves under an ordering keyed on it is never read. A client sending a host's past sessions needs the whole set before it starts, since a transcript says nothing about whether the service already holds the session it describes.

A usage delta counts the tokens a session spent since the one before it. `seq` is the client's chunk number, the insert ignores a `seq` it already holds, and the same batch adds the delta into that UTC day's `usage_daily` row, keyed by day, host, repo, account, provider and model — all taken from the delta itself, so a session that already ended still gets its tail counted. Tokens are stored and money never is: cost is computed on read, so correcting a price needs no backfill. `at` is refused before 2020 or more than a day ahead of the server's clock, since the rollup is unbounded and the insights page draws every month it holds; a backfill of real months passes.

A delta also names the transcript files it read, which is what records their tokens as counted; `GET /v1/sessions/<id>/transcript` answers that set beside the archive's, and a client that reads no files apart names none and counts for none.

`provider`, `account` and `model` are the columns a second provider fills. The hooks send `claude` and the subscription the host is signed in as, and those three values are the whole record of where the tokens went. A delta from OpenRouter's usage API, or from Codex's local session logs, fills the same fields with its own provider, account and models. No integration ships here, and the schema takes one as it stands.

The device login follows RFC 8628. `POST /v1/device/code` with `{device_name}` answers a device code, a user code, the verification URL, `expires_in` (600) and `interval` (5). `POST /v1/device/token` with `{grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code}` answers `{access_token, token_type}` once approved, or a 400 with `authorization_pending`, `slow_down`, `access_denied`, `expired_token` or `invalid_grant`. A poll inside the interval gets `slow_down` and widens the interval by five seconds. At most 5 codes per client address and 200 overall wait for approval at once; past that the start answers 429. The approval page at `/device` sits behind an Access login; the approve and deny form checks the Access JWT, the origin and a CSRF token.

## Deploying from CI

As an alternative to `npm run setup`, Cloudflare Workers Builds can deploy the repo on every push with `npm run deploy` as the deploy command. It applies `infra/` with OpenTofu, migrates D1, syncs the users from `RECALL_USERS` and deploys the Worker. The account needs the One-time PIN login method (Zero Trust, Settings, Authentication). It refuses a plan that would destroy a resource, except the retired Access service tokens and their policy. Use one path per deployment, not both.

The build reads the instance from build variables and stops with a message naming any that is missing:

| Variable            | Example                                        |
| ------------------- | ---------------------------------------------- |
| `RECALL_ACCOUNT_ID` | `0123456789abcdef0123456789abcdef`             |
| `RECALL_ZONE_ID`    | `fedcba9876543210fedcba9876543210`             |
| `RECALL_HOSTNAME`   | `recall.example.com`                           |
| `RECALL_USERS`      | `{"alice": {"emails": ["alice@example.com"]}}` |

Two variables are optional. `RECALL_MCP_CONNECTOR=true` turns on the [desktop connector](#desktop-connector) at `<hostname>/mcp`. Setting `RECALL_ARTIFACT_HOSTNAME` to a second hostname in the same zone, such as `artifact.recall.example.com`, turns on [artifacts](#artifacts): OpenTofu then creates the R2 bucket and that hostname's Access application, and the Worker takes the hostname as a second custom domain. Leaving either out deploys exactly as before. The Workers Builds variables API refuses account-owned API tokens, so both can also be set as objects of the same name in the `recall-builder-secrets` bucket; the build variable wins when both are present.

The account needs an R2 bucket `recall-tfstate` for the OpenTofu state, and a private R2 bucket `recall-builder-secrets` holding three objects: `CLOUDFLARE_TOFU_TOKEN` (an API token with the permissions above), and `TFSTATE_ACCESS_KEY_ID` and `TFSTATE_SECRET_ACCESS_KEY` (R2 S3 credentials for the state bucket). Each email in `RECALL_USERS` may approve devices and signs in as that user id; adding a person is one entry. Removing a user signs out all their devices.

## Develop

`npm test` runs the Worker in the Workers vitest pool against a local D1, with a stand-in for Workers AI. `npm run lint` and `npm run typecheck` check the TypeScript; `cargo fmt`, `cargo clippy` and `cargo test` check the CLI.

## License

MIT. See [LICENSE](LICENSE).
