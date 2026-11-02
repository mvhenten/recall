# recall

Per-user semantic memory for coding agents. recall keeps the notes an agent learns about you and your projects (your preferences, feedback you gave, how a repo works) in a small service you run on your own Cloudflare account, so they follow you across machines and harnesses.

- A command-line client, `recall`, saves, lists, searches and edits memories from any shell or agent.
- A Cloudflare Worker stores each user's memories in D1, with an embedding per memory and a full-text index, and answers searches with both.
- `recall mcp` serves the same operations as MCP tools over stdio, for any harness that speaks MCP.
- A Claude Code plugin gives Claude the recall tools, adds matching memories to each prompt, and either syncs Claude's auto-memory files to recall or replaces auto-memory outright.
- An opt-in add-on carries messages between the Claude Code sessions on the hosts signed in as you.
- A dashboard in the browser reads the same store: live sessions, the session history, the memories and what the tokens cost.

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

The setup creates the D1 database and two Cloudflare Access applications. One covers the hostname and lets every request through, since the Worker checks device tokens itself. The other covers the two browser pages, `/device` and `/dashboard`: it admits the listed emails through the one-time PIN login method, which the setup switches on. The setup then migrates the database, maps the emails to the user id, deploys the Worker to the hostname and prints the `recall login` command. Run it again at any time: it finds what exists and creates the rest. Run it with a new `--user` and `--email` to add a person; their memories stay apart. `--email` repeats for more addresses, `--dry-run` prints what it would do and `--account <id>` picks an account when the token sees several.

Create the API token under My Profile → API Tokens → Create Custom Token, with:

| Scope   | Permission                                                   |
| ------- | ------------------------------------------------------------ |
| Account | Account Settings · Read                                      |
| Account | D1 · Edit                                                    |
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

- The MCP server offers `recall_search`, `recall_get`, `recall_list`, `recall_save`, `recall_edit` and `recall_delete`. They scope and tag like the CLI, from the directory Claude Code runs in, and `recall_save` tags `user` and `feedback` memories global unless told otherwise. A failure comes back as a tool error with the CLI's message, such as `run recall login`.
- Before a `Write` to an auto-memory file, it saves the content to recall under the file name, with the same tag rules as below, and blocks the write so the local memory folder stops growing; Claude is told the memory is in recall and how to read or change it. When the save fails or takes over 5 seconds, the write goes ahead locally as a fallback and a message shows the first error line. An `Edit` or `MultiEdit` to a memory file is blocked with a pointer to `recall edit <name>`, and any write to `MEMORY.md` is blocked because recall finds memories by search, not by index.
- After a `Write` or `Edit` to an auto-memory file (under `autoMemoryDirectory`, or `~/.claude/projects/*/memory/` when that is unset; `MEMORY.md` excluded), it runs `recall save`. `user` and `feedback` memories are saved as global; `project` and `reference` memories get the repo tag of the session's directory, or `global` outside a repo. When the save fails, a message says the memory was saved locally but not synced.
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

| Setting             | Default | Environment                | Flag                         |
| ------------------- | ------- | -------------------------- | ---------------------------- |
| `mode`              | `hook`  | `RECALL_MODE`              | `--mode hook\|tools`         |
| `messaging.enabled` | `false` | `RECALL_MESSAGING_ENABLED` | `--messaging-enabled <BOOL>` |

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
echo "the build is green" | recall send desktop
recall listen --status                                # who can receive here, and who cannot
```

`<to>` is a session handle as `recall sessions` prints it, which reaches that one session, or a device name as `recall devices` prints it, or a device id, each of which reaches every live session on that host. The message arrives as a user turn. Claude addresses the same hosts and sessions through the `recall_send` MCP tool, registered only while messaging is on.

A handle is the host's device name, a dash and the first four characters of the session id, so `desktop-9f8a` names one session and `desktop` the whole host. It is a function of the session alone, so it never moves to another session; a string that names both a host and a session is refused rather than resolved. The service derives it from the synced session records, so a send from any host resolves it the same way: the message carries the session it is addressed to, and the daemon there writes it into that one inbox.

The plugin runs the listener. At session start the hook writes `$XDG_RUNTIME_DIR/recall/sessions/<session-id>.json`, carrying the session's `state`, the pid of its Claude process and, when it registered, the inbox socket and token, then runs `recall listen --ensure`. That starts a background daemon unless one already holds an exclusive `flock` on `$XDG_RUNTIME_DIR/recall/listen.lock`; the daemon holding it names itself in `listen.pid`, so `recall update` can end the one it replaced. The daemon holds one WebSocket to the Worker, reconnects with a backoff that doubles from a second to a minute, and writes each message it receives into the inbox of the session it names, or into every registered socket when it names the host. Session end takes the registry file out, and the daemon exits once the registry has stood empty for five minutes; the next session start brings it back. Each thirty second tick also unlinks the record of any session whose Claude process is gone and tells the service that session is over, and takes on the running sessions no record describes. It writes its own `listen:…`, `message:…` and `sessions:…` lines to the hooks log.

Delivery rides on Claude Code's cross-session inbox, which sits behind the server-side gate `agents_cross_session_inbox`. With the gate off, Claude sets no `CLAUDE_CODE_MESSAGING_SOCKET` and the hooks log one line and stop. A message sent to such a host sits in the queue until it expires.

`recall listen --status` says why. It prints whether messaging is on and whether a listener holds the lock, then one line per running session: the session id, its directory, and what the hook recorded — `registered` with the pid that receives, `off` for messaging being off, `no-inbox` for a session Claude gave no inbox, `adopted` for one read out of its transcript, or the error a failed registry write raised. A session leaves the list at session end, or on the next read once its Claude process is gone, so a crash leaves nothing behind. Add `--json` for the same report as a document; it carries no socket and no token.

The mailbox is a SQLite-backed Durable Object, one per account. A message carries at most 32 KiB, an account queues at most 1000 messages, and a message expires after 72 hours. A revoked device loses its socket and its queued messages.

Durable Objects with SQLite storage run on the Workers Free plan, which allows 100,000 Durable Object requests and 100,000 SQLite rows written a day. Every send, push, ack and reconnect counts against both.

## Live sessions

`recall sessions` lists the Claude Code sessions running on every host signed in as you, one line each: host, the handle `recall send` takes, repo and branch, age, state and focus.

```bash
recall sessions
recall --json sessions      # the whole document of each
recall sessions --adopt     # take on the running sessions this host's hooks never registered
recall sessions --backfill  # send the history and usage of this host's past sessions
```

```
laptop  laptop-9f8a  repo:github.com/mvhenten/recall@feat/sessions-list  12m  busy  list every host's sessions → why is the worker test red
tower   tower-c4e2   global                                              3h   idle  draft the release notes
```

The session's registry record is the document. Beside the state the hook left it in, it carries the host, the repo tag, the branch and the last commit subject, the start and last-activity times in epoch milliseconds, a prompt count, the focus, the permission mode Claude reports on the hook's stdin, and whether the session is interactive or headless. Nothing in it costs a model call: the focus line is the session's first prompt and its latest, each cut to 72 characters, and the branch and subject come from one `git log` in the session's directory.

Hooks load when a session starts, so a plugin update leaves every session already running with the hooks it started with: it writes no record, never syncs, and the list stays short until each one restarts. `recall sessions --adopt` takes those sessions on. It reads the Claude processes from `/proc` and pairs each with the transcript it opened under `~/.claude/projects/<directory>/`: the one born soonest after that process started, since Claude Code opens the transcript seconds into the session, and a session that ended minutes ago can leave the directory's most recently written transcript behind. Then it writes the record the hooks would have written: the session id from the file name, the start from its first line, the last activity from its last write, the focus and the prompt count from the prompts in it, and the repo, branch and commit from one `git log`. A session the registry already names is left alone — including one whose record is caught mid-write and does not parse, since overwriting that would throw away the inbox in it.

`recall sessions --backfill` goes further back. History and stats start the day the hooks shipped, while `~/.claude/projects/` holds every session that ran before them, so this pass reads those transcripts back and sends each one as the session it was: the sync writes the history row, the tokens go out as usage deltas, and the end that follows leaves the row standing. It reads the same transcripts adoption reads, and only the session's own: a subagent writes its own a level down and that is no session. The whole transcript is one stretch, so the chunk numbers are the ones a first hook pass over it would have spent and the service keeps the first event it saw for each; the ids that landed go into `${XDG_STATE_HOME:-~/.local/state}/recall/backfilled`, and a session the registry still names is live and adoption's. An interrupted run resumes, and a second run sends nothing. Nothing is dropped: session history has no retention sweep, so the whole span lands and stays.

A past session carries less than a live one. A transcript names no subscription, so every event it yields is attributed to the account this host is signed in as now; it also says neither whether the session was interactive nor which commit its directory sat on, and the history row carries the API's empty readings for both. The directory and the branch are what the entries themselves name.

The record says `state: adopted`, which is also what lets a later pass move it on. The listener's thirty second tick runs the same adoption, one pass at a time, reading only the stretch of transcript past the mark the last pass left, so an adopted session's last activity keeps up with its own transcript until its process is gone. The first prompt a current hook sees takes the record back: the state becomes that session's own, and adoption leaves it alone from there on. Until then the session takes no messages, because the inbox it would take them on was known only to the hooks it never ran. `recall update` ends the daemon it just replaced, starts one from the new binary and runs a pass of its own, so an update heals the host instead of waiting for restarts.

Its prompt count is what the transcript supports. A tool result, a notification about a task and the expansion of a slash command are all written as user turns as well; a transcript Claude Code writes now marks the turns the user submitted and only those are counted, and one written before that mark existed is read off the marks it does have. The usage counting above still takes its prompts from the record, which counts a prompt as it is submitted.

Every host syncs its own sessions, whether or not messaging is on, so the list covers them all. No hook ever waits for the service: session start, session end and every prompt start the sync and walk away, at most one per session every thirty seconds, and the hooks log is where each one reports. A detached sync that failed leaves a `sessions:sync-failed:…` line and nothing else.

Token usage is read out of the session's own transcript, so counting it costs no model call and no second API. On the same beat, just before the sync goes out, the hook reads the stretch of the Claude Code transcript JSONL the session has not sent, cut back to its last complete line, sums the per-message usage by model and writes that delta into the record; the sync carries it. The service keeps the first delta it saw for a chunk number and ignores a second one, so a delta that did not land is sent again byte for byte, never re-read to the end of the file, and the record moves past a stretch only once every event in it has landed. Chunk numbers climb and are never reused, whatever the transcript does under them. One answer is written as several transcript entries carrying the same usage, so a message counts once by its id, across the end of a stretch as well as inside one. The prompt count comes from the record, which counts a prompt as it is submitted, and not from the transcript, where a harness notification reads like one. Session end reads the closing stretch and `recall sessions --end` sends it before marking the session gone, since a delta carries its own host and repo; a session whose Claude process died has both sent by the listener's sweep instead. A transcript that is missing, unreadable or rewritten shorter than the offset starts counting again at the file's end rather than failing the session, and so does a session resumed into a transcript this host has no record of counting.

The count covers the session's own thread. A subagent writes its own transcript, and those land with [#58](https://github.com/mvhenten/recall/issues/58).

State is read, never stored. A session prompted within the last five minutes is `busy` and one quiet since is `idle`. A session that is gone is one its own host dropped: nothing ends a session on another host's behalf. The `recall sessions --end` the session end hook starts drops it, once the delta the record carries has gone out, and so does the listener's own thirty second tick, which deletes the session whose Claude process it finds gone — the `recall listen --status` sweep and the service's copy come out together. Only a host that dies with no listener running leaves a record behind, and that one expires a day after its last prompt. `name` is the handle that addresses the session, so the listing doubles as the address book for messaging.

## Dashboard

Opening the hostname in a browser answers `303 /dashboard`; a client that does not ask for `text/html` still gets the 404 JSON. Both answers carry `Vary: Accept`.

The dashboard is server-rendered, with no client-side JavaScript. It reads the same Access JWT as `/device`, from the one Access application that covers both paths. It refuses an email that is not invited. `npm run setup` and the OpenTofu config under `infra/` each add `<hostname>/dashboard` to that application as a second public destination. A self-hoster who deploys the Worker another way adds that destination by hand. The dashboard answers a `GET` and never writes; saving, editing and deleting stay with the CLI and the tools.

Every page carries the signed-in email and a line on now: the live and busy session counts, today's cost and today's sessions. The tabs are Sessions, History, Memory, Stats and Insights.

- `/dashboard` lists the live sessions of every host as a ledger, newest activity first: state, handle, `repo@branch`, the focus line, age and prompt count. Beside it sits one line per host with its live and busy counts, and the oldest idle session.
- `/dashboard/history` reads the session history: every session ever synced, grouped by UTC day, newest day first, each row carrying its handle, host, `repo@branch`, the span from the first prompt to the last activity, the prompt count and the focus line. A session that is still running is marked and stays in the list. `host` and `repo` narrow the page as links built from the hosts and repos the page holds, and the page walks back on the same cursor shape the memory listing uses.
- `/dashboard/memory` lists memories newest created first and pages on the same cursor `/v1/memories` answers. A form narrows the page by tag and by type, and a search there runs the hybrid ranking the CLI runs, at the same `--min-score` default of 0.55, showing the fusion score of each hit. Query, filters and cursor live in the URL, so a search is a link. `/dashboard/memory/<name>` renders one memory's body. Both read without recalling: browsing never moves a memory's recall count or the time it was last recalled. The strip above the listing counts the memories, the ever recalled, the never recalled and the ones saved in the last 30 days, and each type chip carries its own count.
- `/dashboard/stats` prices the usage. Five tiles show today's cost against the seven day average, the seven day cost against the week before it, today's tokens, the seven day cache hit rate and today's session count. Under them: cost per day stacked by model, over 14 days and over 30 days, and the model mix as a donut and a table. Input, output and cache-read tokens each get a bar per day. An efficiency list over seven days gives cost per prompt, cost per session, tokens per prompt, output against input and cache hit, and the last three tables split the 30 days by account, by host and by repo.
- `/dashboard/insights` reads the last 14 days. The working set is the top five memories by recall count over the last 30 days, with the share of every recall they carry. Going stale lists five of the memories at risk, which are the ones last recalled over 60 days ago and the ones never recalled and saved over 14 days ago. Cache economics counts the fortnight's cache reads, what they saved against fresh input, and its best and worst day. The rhythm is a heat map of sessions by weekday and hour, and the next card ranks five repos by session time. A last row reads back over everything the rollups hold, so months of backfilled transcripts shape the page: cost by month stacked by model, five repos ranked by the session time of every session on record, and the cache hit rate month by month. A month is the month of the UTC day the rollup counted the delta under, and a session lends each window only the stretch that falls inside it.

The prices are Anthropic's published list, in US dollars per million tokens, with a cache write at 1.25 times input and a cache read at a tenth of it. A model the table does not name has its tokens counted and its cost left out, and the page names that model and the tokens it spent. A total mixing priced and unpriced models is marked `≈`.

How far back each page reads:

| Record                | Kept                                 |
| --------------------- | ------------------------------------ |
| a live session        | 24 hours past its last activity      |
| a session history row | for good                             |
| a raw usage event     | 14 days past the server recording it |
| a daily usage rollup  | for good                             |

## API

The routes under `/v1/memories`, `/v1/search`, `/v1/devices`, `/v1/messages` and `/v1/sessions` need `Authorization: Bearer <device token>`. The Worker resolves the user from the token; a client never names a user. D1 stores only the SHA-256 hash of each token.

| Method   | Path                                            |                                                                                                                                          |
| -------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT`    | `/v1/memories/:name`                            | create or replace `{description, type, body, tags}`                                                                                      |
| `GET`    | `/v1/memories/:name`                            | read one                                                                                                                                 |
| `DELETE` | `/v1/memories/:name`                            | delete one                                                                                                                               |
| `GET`    | `/v1/memories?tag=&type=&since=&cursor=&limit=` | newest created first; `tag` and `type` repeat, and each narrows the page                                                                 |
| `POST`   | `/v1/search`                                    | `{query, tags, any, limit, minScore, mode}`; each hit is a recall                                                                        |
| `GET`    | `/v1/devices`                                   | the caller's devices                                                                                                                     |
| `DELETE` | `/v1/devices/:deviceId`                         | revoke a device; `current` names the caller's own                                                                                        |
| `POST`   | `/v1/messages`                                  | `{toDeviceId, toSessionId, body}`; queues a message for one session, or for every session on the device when `toSessionId` is empty      |
| `GET`    | `/v1/messages/listen`                           | WebSocket only; pushes the caller's queue and takes ack frames                                                                           |
| `PUT`    | `/v1/sessions/:sessionId`                       | create or replace one session document                                                                                                   |
| `GET`    | `/v1/sessions`                                  | the account's sessions, newest activity first                                                                                            |
| `DELETE` | `/v1/sessions/:sessionId`                       | the session is over; every host stops listing it                                                                                         |
| `POST`   | `/v1/sessions/:sessionId/usage`                 | one token delta `{seq, host, repo, provider, account, model, prompts, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, at}` |

A usage delta counts the tokens a session spent since the one before it. `seq` is the client's chunk number, the insert ignores a `seq` it already holds, and the same batch adds the delta into that UTC day's `usage_daily` row, keyed by day, host, repo, account, provider and model — all taken from the delta itself, so a session that already ended still gets its tail counted. Tokens are stored and money never is: cost is computed on read, so correcting a price needs no backfill. `at` is refused before 2020 or more than a day ahead of the server's clock, since the rollup is unbounded and the insights page draws every month it holds; a backfill of real months passes.

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

The account needs an R2 bucket `recall-tfstate` for the OpenTofu state, and a private R2 bucket `recall-builder-secrets` holding three objects: `CLOUDFLARE_TOFU_TOKEN` (an API token with the permissions above), and `TFSTATE_ACCESS_KEY_ID` and `TFSTATE_SECRET_ACCESS_KEY` (R2 S3 credentials for the state bucket). Each email in `RECALL_USERS` may approve devices and signs in as that user id; adding a person is one entry. Removing a user signs out all their devices.

## Develop

`npm test` runs the Worker in the Workers vitest pool against a local D1, with a stand-in for Workers AI. `npm run lint` and `npm run typecheck` check the TypeScript; `cargo fmt`, `cargo clippy` and `cargo test` check the CLI.

## License

MIT. See [LICENSE](LICENSE).
