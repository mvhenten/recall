# recall

Per-user semantic memory for coding agents. recall keeps the notes an agent learns about you and your projects (your preferences, feedback you gave, how a repo works) in a small service you run on your own Cloudflare account, so they follow you across machines and harnesses.

- A command-line client, `recall`, saves, lists, searches and edits memories from any shell or agent.
- A Cloudflare Worker stores each user's memories in D1, with an embedding per memory and a full-text index, and answers searches with both.
- `recall mcp` serves the same operations as MCP tools over stdio, for any harness that speaks MCP.
- A Claude Code plugin gives Claude the recall tools, adds matching memories to each prompt, and either syncs Claude's auto-memory files to recall or replaces auto-memory outright.
- An opt-in add-on carries messages between the Claude Code sessions on the hosts signed in as you.
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

The setup creates the D1 database, the R2 bucket the transcript archive lives in, the queue that bucket announces its writes on and its dead letter queue, and two Cloudflare Access applications. One covers the hostname and lets every request through, since the Worker checks device tokens itself. The other covers the two browser pages, `/device` and `/dashboard`: it admits the listed emails through the one-time PIN login method, which the setup switches on. The setup then migrates the database, maps the emails to the user id, deploys the Worker to the hostname and prints the `recall login` command. Run it again at any time: it finds what exists and creates the rest. Run it with a new `--user` and `--email` to add a person; their memories stay apart. `--email` repeats for more addresses, `--dry-run` prints what it would do and `--account <id>` picks an account when the token sees several. `--artifact-hostname <pages.example.com>` turns on [artifacts](#artifacts) and adds a second bucket and a second hostname.

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

The plugin starts `recall mcp` as an MCP server and adds four hooks. The hooks need `node` 22 or later; the hooks and the server find `recall` on `PATH` or in `~/.cargo/bin`.

- The MCP server offers `recall_search`, `recall_get`, `recall_list`, `recall_save`, `recall_edit`, `recall_delete`, `recall_publish`, `recall_artifacts` and `recall_unpublish`. They scope and tag like the CLI, from the directory Claude Code runs in, and `recall_save` tags `user` and `feedback` memories global unless told otherwise. A failure comes back as a tool error with the CLI's message, such as `run recall login`.
- Before a `Write` to an auto-memory file, it saves the content to recall under the file name as a kebab-case slug (`agent_dispatch.md` becomes `agent-dispatch`), with the same tag rules as below, and blocks the write so the local memory folder stops growing; Claude is told the memory is in recall and how to read or change it. When the save fails or takes over 5 seconds, the write goes ahead locally as a fallback and a message shows the first error line. An `Edit` or `MultiEdit` to a memory file is blocked with a pointer to `recall edit <name>`, and any write to `MEMORY.md` is blocked because recall finds memories by search, not by index.
- After a `Write` or `Edit` to an auto-memory file (under `autoMemoryDirectory`, or `~/.claude/projects/*/memory/` when that is unset; `MEMORY.md` excluded), it runs `recall save` under the same slug of the file name. `user` and `feedback` memories are saved as global; `project` and `reference` memories get the repo tag of the session's directory, or `global` outside a repo. When the save fails, a message says the memory was saved locally but not synced.
- On each prompt of three words or more that is not a slash command, it runs `recall search` in the session's directory and adds the top five hits to the prompt as context, bodies truncated and the block capped at 4 KB. Up to three matches from other scopes follow under "In other scopes:", each with its tags. When recall fails, a one-line `recall unavailable: …` message shows and the prompt goes through unchanged.
- On every prompt, including the ones too short to search on, it rewrites the moving half of the session's record — focus, prompt count, last activity, branch, last commit and permission mode — and starts a sync it does not wait for, at most one every thirty seconds, so `recall sessions` shows from any host what this session is working on.
- At session start, it adds a short block saying recall is the durable store, listing the CLI commands and the session directory's repo tag (or "global only"). In `tools` mode it first adds memory instructions: what to save, what not to, to update rather than duplicate, and to delete what turns out wrong. When `recall` is missing, it adds an install hint instead.
- Every hook run appends one line to `${XDG_STATE_HOME:-~/.local/state}/recall/hooks.log`: time, session id, outcome (`hits=<n>`, `no-hits`, `skipped:<reason>`, each followed by `focus:<state>`, plus `crib:<mode>:repo:messaging:<state>`, `crib:<mode>:global:messaging:<state>`, `messaging:<state>`, `not-installed`, `timeout`, `saved:<name>`, `redirect:saved:<name>`, `redirect:fallback:<error>`, `redirect:index`, `redirect:edit`, `error:<message>`) and duration. `recall sessions --sync` and `--end`, which the hooks start detached, add their own `sessions:…` lines, and the listener adds `listen:…`, `message:…`, the `sessions:ended:…` and `sessions:usage:…` of the sessions its tick found gone, and the `sessions:adopted:…` and `sessions:refreshed:…` of the ones it took on. Prompts, focus lines and memory bodies are never logged.

### Modes

The plugin works in one of two modes, set per host with `recall config set mode hook|tools` and stored in `~/.config/recall/config.json`.

- `hook` (the default) leaves Claude Code's built-in auto-memory on. Claude saves memories its usual way and the plugin redirects each memory file write into recall.
- `tools` replaces auto-memory with recall. Session start tells Claude what to remember and to use the `recall_*` tools. Turn auto-memory off yourself, since a plugin cannot change your settings: add `"autoMemoryEnabled": false` to `~/.claude/settings.json`, or set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

Both modes serve the tools and add matching memories to each prompt.

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

`archive.interval.seconds` is how often the listener carries a running session's newest [transcript](#the-transcript-archive) lines up, from 2 seconds to an hour. A pass over a session that has not written since the one before costs no call, so only sessions actually writing generate traffic; the floor is there because below it the calls cost more than the lines are worth. It moves nothing else: the registry sweep that ends dead sessions and runs adoption keeps its own thirty second beat.

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
recall send desktop-9f8a "pull main and rerun the migration"
recall send desktop "pull main and rerun the migration"
recall send core "pull main and rerun the migration"   # the label the dashboard gave that host
echo "the build is green" | recall send desktop
recall listen --status                                # who can receive here, and who cannot
```

`<to>` is a session handle as `recall sessions` prints it, which reaches that one session, or a host, which reaches every live session on it and is named by its label, its device name or its device id. The message arrives as a user turn. Claude addresses the same hosts and sessions through the `recall_send` MCP tool, registered only while messaging is on; Claude Code's own cross-session tools see only the machine they run on, so `recall_send` is the only route to a session elsewhere.

A name or label two hosts answer to is refused, naming both, rather than resolved to one of them. Only the device id, which is unique, settles an address on its own.

Signing in again from a machine already signed in takes a second login rather than replacing the first: the name is suffixed, `core-box` and then `core-box-2`, while both stay under the one host `core-box`, which is what a label is set on. They are one machine, so they do not read as two: an address naming that host reaches its newest login, the only one a daemon still reads.

Each message arrives under one line naming where it came from and what to answer: `[recall from core/ip-10-0-7-31-9f8a; reply with recall_send to "ip-10-0-7-31-9f8a"]`. A send that can tell which session it is running inside names that session's handle, and the reply goes back to it alone; one that cannot is answered on its device id, which reaches every session on that host. Either way the address is one nothing can rename under the message: the host's label reads as prose and is never what the reply is sent to. Both are resolved where the message is sent and ride with it, so the receiver looks nothing up. A message typed into the dashboard has no device behind it and so no address to answer, and its line says that instead: `[recall from the dashboard, signed in as owner@example.com; it has no reply address, so answer in this session]`.

A handle is the host's device name, a dash and the first four characters of the session id, so `desktop-9f8a` names one session and `desktop` the whole host. It is a function of the session alone, so it never moves to another session. The name Claude Code gave the session reaches it too, where the service has read one out of the transcript. A host answers before a session does, so a string that names both reaches the host, and an ordinary host send is settled from the device listing alone without costing one of the sessions. The service derives it from the synced session records, so a send from any host resolves it the same way: the message carries the session it is addressed to, and the daemon there writes it into that one inbox.

The plugin runs the listener. At session start the hook writes `$XDG_RUNTIME_DIR/recall/sessions/<session-id>.json`, carrying the session's `state`, the pid of its Claude process and, when it registered, the inbox socket and token, then runs `recall listen --ensure`. That starts a background daemon unless one already holds an exclusive `flock` on `$XDG_RUNTIME_DIR/recall/listen.lock`; the daemon holding it names itself in `listen.pid`, so `recall update` can end the one it replaced. The daemon holds one WebSocket to the Worker, reconnects with a backoff that doubles from a second to a minute, and writes each message it receives into the inbox of the session it names, or, when it names the host, into every registered socket that was already running when the message was sent. Session end takes the registry file out, and the daemon exits once the registry has stood empty for five minutes; the next session start brings it back. Each thirty second tick also unlinks the record of any session whose Claude process is gone and tells the service that session is over, and takes on the running sessions no record describes. It writes its own `listen:…`, `message:…` and `sessions:…` lines to the hooks log.

Delivery rides on Claude Code's cross-session inbox, which sits behind the server-side gate `agents_cross_session_inbox`. With the gate off, Claude sets no `CLAUDE_CODE_MESSAGING_SOCKET`, the hooks log one line and stop, and no listener ever starts, so a message sent to such a host does sit in the queue until it expires. Everywhere else the queue only holds a message until a listener attaches: it takes the whole backlog and acks it, so a message is acked whether or not a session took it. A message addressed to the host goes to the sessions that were already running when it was sent; when none of those is left it still goes to whoever is registered, as long as it was sent in the last ten minutes, and past that it is retired unread as `message:retired:…` rather than landing in a session that has no idea what it refers to. A message addressed to one session handle reaches that session or nobody.

`recall listen --status` says why. It prints whether messaging is on and whether a listener holds the lock, then one line per running session: the session id, its directory, and what the hook recorded — `registered` with the pid that receives, `off` for messaging being off, `no-inbox` for a session Claude gave no inbox, `adopted` for one read out of its transcript, or the error a failed registry write raised. A session leaves the list at session end, or on the next read once its Claude process is gone, so a crash leaves nothing behind. Add `--json` for the same report as a document; it carries no socket and no token.

The mailbox is a SQLite-backed Durable Object, one per account. A message carries at most 32 KiB, an account queues at most 1000 messages, and a message expires after 72 hours. A revoked device loses its socket and its queued messages.

Durable Objects with SQLite storage run on the Workers Free plan, which allows 100,000 Durable Object requests and 100,000 SQLite rows written a day. Every send, push, ack and reconnect counts against both.

## Live sessions

`recall sessions` lists the Claude Code sessions running on every host signed in as you, one line each: host, the handle `recall send` takes, repo and branch, age, state and focus. A host that carries a label reads as `core (ip-10-0-7-31)`, in the listing and in `recall devices` alike: the label leads and the raw name stays, so no host reads as another.

```bash
recall sessions
recall --json sessions      # the whole document of each
recall sessions --adopt     # take on the running sessions this host's hooks never registered
recall sessions --backfill  # send the history and usage of this host's past sessions
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

Every transcript lands in the service's object storage and stays there: nothing is deleted and nothing expires. A running session's new lines reach it on the beat the hooks already fire and on the listener's own, every `archive.interval.seconds` (10 by default), so a long turn that answers no prompt for twenty minutes is archived while it works rather than once it is over. A pass over a session that has not written since the pass before it costs no call at all, so a short beat over a quiet host is free. `recall sessions --backfill` carries up everything a host still holds.

Object storage has no append, so a file is kept as one object per appended stretch, under `<user id>/<session id>/<file>/<start offset>`. The offset is zero-padded, so listing a session's prefix gives its stretches in the order they were written and reading one file back is a concatenation. A stretch is keyed by where it starts and nothing else, and it is written only where nothing is yet, so a pass that retries is answered 409 carrying where the file reaches rather than leaving a second copy of the same lines.

Writing that object is the only thing the call does. Nothing is claimed first and no row is touched, so there is no second write to disagree with the first and nothing to give back when one fails. Where the file reaches once the stretch is in it is arithmetic — the offset it was sent at plus its length — so the answer costs no read either, and a host carries its own place from there.

Everything else the service holds about a transcript follows the object. R2 announces each write to a queue, and the Worker consuming it computes what it needs from the key alone: who, which session, which file, where the stretch starts, and how long it is. The queue delivers at least once, so the same event does arrive twice; every end it writes is folded in with MAX, which leaves the row where the objects already put it.

Only one reading is kept out of the archive and in the database: how far a session's own transcript runs, which the indexer consults on every pass and could not pay a listing for. It is a cache and may lag the archive by seconds. Every other question about where a file ends — a host working out where to send the rest of one, a restore writing files back to disk — is answered by counting the objects. The storage event is the only thing that moves the cache, and every end it writes is folded in with MAX, so nothing can lower it below what the archive already holds.

Two writers do reach one file at once — the listener's beat and a session ending — and both offer a stretch from the same offset, each read at its own instant and so of its own length. The first to land wins and the second is answered 409 carrying where the file now reaches, which is where its next stretch goes. Letting the second write over the first instead would have the shorter stretch replace the longer, leaving the bytes between in no object at all while the writer that sent them carries on past them.

`GET /v1/sessions/<id>/transcript` answers how far into each of a session's files the archive runs, counted off the objects, `GET /v1/sessions/<id>/transcript?file=<file>` reads one of them back whole as the concatenation of its stretches, and `PUT /v1/sessions/<id>/transcript?file=<file>&offset=<bytes>` appends one stretch of at most 1 MiB; a transcript of any size goes up as a run of those. All three take the device token and answer 404 for a session the account does not hold, so the only prefix a caller can reach is its own. The first costs a listing, so a host asks it once for a session it has no place for and carries its own place from there; it is kept apart from the mark the usage counter keeps in the session record, so moving either can neither skip nor replay the other.

A file shorter than where the service says it ends is not that file any more: a transcript rewritten or truncated under the archive. The stretches already written stay as they are and nothing is spliced onto them, since the offsets they are keyed by no longer describe anything in the new file. The usage counter reads the same shape the same way, counting the new file from its end rather than counting the old one over again.

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

The dashboard is server-rendered. The one page that runs script is a session page, which reads the transcript in the browser; the script is served from `/transcript.js`, named by origin in the page's own content security policy, and reaches no host but this one. That path sits outside the Access application covering `/device` and `/dashboard`, under the hostname-wide bypass: the script carries code and no user data, and a tab restored after the sign-in ran out would otherwise be handed a login page in its place, which nothing on the page can notice. It is written in `browser/view.ts` and shares the transcript reader with the index, so what the page shows and what the index holds cannot drift; `npm-scripts/build-browser.mjs` bundles it on install and before every deploy and setup. It reads the same Access JWT as `/device`, from the one Access application that covers both paths. It refuses an email that is not invited. `npm run setup` and the OpenTofu config under `infra/` each add `<hostname>/dashboard` to that application as a second public destination. A self-hoster who deploys the Worker another way adds that destination by hand. The dashboard answers a `GET` everywhere but the Labels tab and a session page, which take their own form posts behind an origin and CSRF check; saving, editing and deleting memories stay with the CLI and the tools.

Every page carries the signed-in email and a line on now: the live and busy session counts, today's cost and today's sessions. The tabs are Sessions, History, Memory, Artifacts, Stats, Insights and Labels.

- `/dashboard` lists the live sessions of every host as a ledger, newest activity first: state, handle, `repo@branch`, the focus line, age and prompt count. Beside it sits one line per host with its live and busy counts, and the oldest idle session. Every handle opens the session, and every host opens its history.
- `/dashboard/sessions/<session id>` reads one session, live or long over: its state, host, scope, directory, start, prompt count, the accounts that paid for it and what it spent, then its transcript. A transcript is a chain of R2 objects, so the page carries a manifest of them — every stretch of the chosen file, where it sits and how long it is, off one listing — and the browser fetches the bytes against it, 64 kB at a time, newest first, scrolling back for older. The Worker streams one object per request and parses nothing; splitting the JSONL into prompts and answers is the browser's work. A stretch boundary is not an entry boundary, so the part line at the head of each fetch is held back and joined to the fetch after it. Where the archive never got a run of bytes the page says so and skips the entry that straddles it. A session archiving delegated turns offers a chip per file. A session a host is still holding is followed forward as well as read back: the box asks every 10 seconds what has landed past the stretch it last took, reads it in the same 64 kB steps, carries a reader sitting at the foot of the box along with it, and tells one who has scrolled back how many turns arrived below. It asks less often the longer the session says nothing, down to once every five minutes, and comes back to 10 seconds the moment something arrives; a hidden tab asks nothing at all, and following stops and says so when the session ends or three beats in a row fail. A beat reads how far the file reaches off the row the queue keeps, so one that finds nothing new opens no object; that row is a cache and can lag the objects, so it is trusted to say a file has grown and never to say it has not. A message reaches a session while its host still holds it, which is up to a day after its last prompt: a box sends one over the same bus `recall send` uses, the host hands it to the session as its next turn, and the answer lands in the transcript below. The message says it came from the dashboard and carries the signed-in email as its sender, since no device typed it, and it arrives with no reply address rather than one `recall_send` cannot resolve; a session whose host has let it go says so instead of offering the box.
- `/dashboard/history` reads the session history: every session ever synced, grouped by UTC day, newest day first, each row carrying its handle, host, `repo@branch`, the span from the first prompt to the last activity, the prompt count and the focus line. A session that is still running is marked and stays in the list. `host` and `repo` narrow the page as links built from the hosts and repos the page holds, and the page walks back on the same cursor shape the memory listing uses. A search matches the focus lines, the commit subject and the agent name, off an index kept by triggers on the history table, and the rows also sort by agent name.
- `/dashboard/memory` lists memories newest created first and pages on the same cursor `/v1/memories` answers. A form narrows the page by tag and by type, and a search there runs the hybrid ranking the CLI runs, at the same `--min-score` default of 0.55, showing the fusion score of each hit. Query, filters, sort and cursor live in the URL, so a search is a link, and the rows also sort by name and by recall count. `/dashboard/memory/<name>` renders one memory's body. Both read without recalling: browsing never moves a memory's recall count or the time it was last recalled. The strip above the listing counts the memories, the ever recalled, the never recalled and the ones saved in the last 30 days, and each type chip carries its own count.
- `/dashboard/artifacts` browses the [artifacts](#artifacts) this account has published, newest first, each row carrying the name as a link to the address it answers on, the type and file count, the size, when it was last published, both permissions and the email that wrote it. It pages twenty at a time, narrows by type, searches name, title and description, and sorts by publish time, name or size. It reads the same listing `GET /v1/artifacts` answers, scoped to the signed-in user, so one page view costs one indexed read of the rows and one of the counts the chips print, and reads no artifact's bytes. Opening an artifact is a second Access sign-in on the artifact hostname, so every link opens a tab of its own. Publishing and unpublishing stay with `recall publish`, `recall unpublish` and the tools. Where the deployment names no artifact hostname the tab says publishing is off rather than drawing an empty shelf.
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

A deployment can publish artifacts: a site of self-contained HTML, a markdown document, or a set of audio files that play as one artifact. They answer on a second hostname of their own, `https://<artifact hostname>/<name>`, behind its own Cloudflare Access application admitting the emails that reach the dashboard.

```
recall publish burn-up.html
recall publish ./build/report.html --name q3-report
recall publish notes.md --type document --title "Q3 notes" --read account
recall publish track-01.mp3 track-02.mp3 --type audio --name panel-episode-12
recall artifacts --type audio --sort largest
recall unpublish q3-report
```

Every artifact carries a type, a title, a description, a read permission and a write permission. A `site` is served as its bytes under today's sandbox policy. A `document` renders in the Worker, from a markdown renderer written here that escapes every character it prints, and reads raw at `?view=raw`; over 2 MB the bare address answers the raw view. An `audio` artifact draws a player over the track list the publish named, and each track's own address streams its bytes and answers a range request, so a seek never waits for the file. Read `private` means its owner alone and `account` every invited email; write `owner` means its owner alone and `account` any device of the account. A refused read and a name that holds nothing answer the same 404.

`recall publish` sends one or more files and prints the URL the artifact answers on. The files land in the order they were named, which is the track order of an audio artifact, and the first of them is what the bare address serves. The name defaults to the first file's own, lower-cased with every run of anything else a dash. A name that already holds an artifact is refused with a 409 naming what is there, its size, when it was last written and by whom, until `--replace` says to replace it. `recall artifacts` lists what the account has published and takes a query, `--type`, `--sort` and `--limit`; `recall unpublish <name>` removes an artifact and every one of its files. Claude reaches all three through `recall_publish`, `recall_artifacts` and `recall_unpublish`, and publishes from the path of a file it wrote so the bytes go from disk to the service without passing through the conversation. Where a deployment names no artifact hostname, every one of them reports that it publishes no artifacts.

A publish is `multipart/form-data`: one part carrying the manifest, then one part per file in the manifest's order, each streamed into R2 as it arrives rather than buffered. A file holds at most 32 MB, an artifact at most 64 MB and 50 files. Each revision's bytes live under `<user id>/<name>/<rev>/<path>`, which is what makes a publish atomic: the new revision is written where no reader can reach it, and one compare-and-swap moves the row forward. A publish that fails anywhere before that statement leaves the artifact and every one of its files as they were. An artifact published before artifacts carried a type still reads at its old address, and `recall artifacts --adopt` takes it into the listing; it is run once per deployment, because a migration cannot read storage and nothing here sweeps on a schedule.

The second hostname is the point. A published site carries its own inline style, script and `data:` assets and may reach no other host, so it runs on an origin holding nothing else: the dashboard, the device pages and the API all refuse to answer there, and the main hostname never renders an artifact. A site is served `sandbox allow-scripts allow-downloads`, so it loads into an opaque origin and reaches neither the storage nor the cookies of anyone else publishing on that hostname. recall's own pages on that host — a document, a player and the refusals — carry no script but the player's, which is served from that host and connects nowhere. Every read goes through the Worker with `Cache-Control: private, no-cache`, so a republished artifact is the one the next reload draws.

The feature is off until a deployment names that hostname — `--artifact-hostname` for `npm run setup`, `RECALL_ARTIFACT_HOSTNAME` for a Workers Builds deploy. Without it the deployment is unchanged and no R2 bucket is created, since R2 needs billing switched on even where it costs nothing. Turning it back off is a deliberate act: unsetting the variable makes the OpenTofu plan destroy the bucket, and the deploy refuses any plan that destroys, as it does for the D1 database. Empty the bucket, `tofu state rm cloudflare_r2_bucket.artifacts[0]` and delete it by hand, then deploy.

## API

The routes under `/v1/memories`, `/v1/search`, `/v1/devices`, `/v1/messages`, `/v1/sessions` and `/v1/artifacts` need `Authorization: Bearer <device token>`. The Worker resolves the user from the token; a client never names a user. D1 stores only the SHA-256 hash of each token.

| Method   | Path                                            |                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT`    | `/v1/memories/:name`                            | create or replace `{description, type, body, tags}`                                                                                                                                                                  |
| `GET`    | `/v1/memories/:name`                            | read one                                                                                                                                                                                                             |
| `DELETE` | `/v1/memories/:name`                            | delete one                                                                                                                                                                                                           |
| `GET`    | `/v1/memories?tag=&type=&since=&cursor=&limit=` | newest created first; `tag` and `type` repeat, and each narrows the page                                                                                                                                             |
| `POST`   | `/v1/search`                                    | `{query, tags, any, limit, minScore, mode}`; each hit is a recall                                                                                                                                                    |
| `GET`    | `/v1/devices`                                   | the caller's devices, each with the `label` its host carries                                                                                                                                                         |
| `DELETE` | `/v1/devices/:deviceId`                         | revoke a device; `current` names the caller's own                                                                                                                                                                    |
| `POST`   | `/v1/messages`                                  | `{toDeviceId, toSessionId, fromSessionId, body}`; queues a message for one session, or for every session on the device when `toSessionId` is empty                                                                   |
| `GET`    | `/v1/messages/listen`                           | WebSocket only; pushes the caller's queue and takes ack frames                                                                                                                                                       |
| `PUT`    | `/v1/sessions/:sessionId`                       | create or replace one session document                                                                                                                                                                               |
| `GET`    | `/v1/sessions/:name`                            | one session by its session id, its handle or the name Claude Code gave it, with the transcript files the archive holds and how many sessions the name answered for                                                   |
| `GET`    | `/v1/sessions?scope=&cursor=&q=&limit=`         | the live sessions, newest activity first, each with the `hostLabel` its host carries; `scope=history` answers `{sessionIds, nextCursor}` over every session on record; `scope=search&q=` answers `{hits}` by meaning |
| `DELETE` | `/v1/sessions/:sessionId`                       | the session is over; every host stops listing it                                                                                                                                                                     |
| `PUT`    | `/v1/artifacts/:name?replace=true`              | publish an artifact; `multipart/form-data`, a manifest part then one part per file, and the answer names the artifact. A name already taken answers 409 unless `replace` says to replace it                          |
| `GET`    | `/v1/artifacts/:name`                           | one artifact's type, title, description, permissions, file count, size and last writer                                                                                                                               |
| `GET`    | `/v1/artifacts/:name/:path`                     | one file's bytes, 200 or 206 for a range                                                                                                                                                                             |
| `DELETE` | `/v1/artifacts/:name`                           | unpublish one artifact and every one of its files                                                                                                                                                                    |
| `GET`    | `/v1/artifacts?q=&type=&sort=&cursor=&limit=`   | the caller's artifacts, newest published first, answering `{artifacts, nextCursor, total, cut}`; `sort` takes `newest`, `name` or `largest`, and a `q` answers one page of at most 50 matches by relevance           |
| `POST`   | `/v1/artifacts/adopt`                           | take the artifacts published before they carried a type into the listing; answers `{adopted}` and is run once per deployment                                                                                         |
| `POST`   | `/v1/sessions/:sessionId/usage`                 | one token delta `{seq, host, repo, provider, account, model, prompts, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, at}`                                                                             |

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

`RECALL_ARTIFACT_HOSTNAME` is the one optional variable. Setting it to a second hostname in the same zone, such as `artifact.recall.example.com`, turns on [artifacts](#artifacts): OpenTofu then creates the R2 bucket and that hostname's Access application, and the Worker takes the hostname as a second custom domain. Leaving it out deploys exactly as before. The Workers Builds variables API refuses account-owned API tokens, so it can also be set as an object named `RECALL_ARTIFACT_HOSTNAME` in the `recall-builder-secrets` bucket, holding the hostname; the build variable wins when both are present.

The account needs an R2 bucket `recall-tfstate` for the OpenTofu state, and a private R2 bucket `recall-builder-secrets` holding three objects: `CLOUDFLARE_TOFU_TOKEN` (an API token with the permissions above), and `TFSTATE_ACCESS_KEY_ID` and `TFSTATE_SECRET_ACCESS_KEY` (R2 S3 credentials for the state bucket). Each email in `RECALL_USERS` may approve devices and signs in as that user id; adding a person is one entry. Removing a user signs out all their devices.

## Develop

`npm test` runs the Worker in the Workers vitest pool against a local D1, with a stand-in for Workers AI. `npm run lint` and `npm run typecheck` check the TypeScript; `cargo fmt`, `cargo clippy` and `cargo test` check the CLI.

## License

MIT. See [LICENSE](LICENSE).
