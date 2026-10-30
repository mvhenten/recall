# recall

Per-user semantic memory for coding agents. recall keeps the notes an agent learns about you and your projects (your preferences, feedback you gave, how a repo works) in a small service you run on your own Cloudflare account, so they follow you across machines and harnesses.

- A command-line client, `recall`, saves, lists, searches and edits memories from any shell or agent.
- A Cloudflare Worker stores each user's memories in D1, with an embedding per memory and a full-text index, and answers searches with both.
- `recall mcp` serves the same operations as MCP tools over stdio, for any harness that speaks MCP.
- A Claude Code plugin gives Claude the recall tools, adds matching memories to each prompt, and either syncs Claude's auto-memory files to recall or replaces auto-memory outright.

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

The setup creates the D1 database and two Cloudflare Access applications. One covers the hostname and lets every request through, since the Worker checks device tokens itself. The other covers only `/device`, the approval page: it admits the listed emails through the one-time PIN login method, which the setup switches on. The setup then migrates the database, maps the emails to the user id, deploys the Worker to the hostname and prints the `recall login` command. Run it again at any time: it finds what exists and creates the rest. Run it with a new `--user` and `--email` to add a person; their memories stay apart. `--email` repeats for more addresses, `--dry-run` prints what it would do and `--account <id>` picks an account when the token sees several.

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
- At session start, it adds a short block saying recall is the durable store, listing the CLI commands and the session directory's repo tag (or "global only"). In `tools` mode it first adds memory instructions: what to save, what not to, to update rather than duplicate, and to delete what turns out wrong. When `recall` is missing, it adds an install hint instead.
- Every hook run appends one line to `${XDG_STATE_HOME:-~/.local/state}/recall/hooks.log`: time, session id, outcome (`hits=<n>`, `no-hits`, `skipped:<reason>`, `crib:<mode>:repo`, `crib:<mode>:global`, `not-installed`, `timeout`, `saved:<name>`, `redirect:saved:<name>`, `redirect:fallback:<error>`, `redirect:index`, `redirect:edit`, `error:<message>`) and duration. Prompts and memory bodies are never logged.

### Modes

The plugin works in one of two modes, set per host with `recall config set mode hook|tools` and stored as `RECALL_MODE` in `~/.config/recall/env`. `recall config` prints the current mode.

- `hook` (the default) leaves Claude Code's built-in auto-memory on. Claude saves memories its usual way and the plugin redirects each memory file write into recall.
- `tools` replaces auto-memory with recall. Session start tells Claude what to remember and to use the `recall_*` tools. Turn auto-memory off yourself, since a plugin cannot change your settings: add `"autoMemoryEnabled": false` to `~/.claude/settings.json`, or set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

Both modes serve the tools and add matching memories to each prompt.

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

## API

The routes under `/v1/memories`, `/v1/search` and `/v1/devices` need `Authorization: Bearer <device token>`. The Worker resolves the user from the token; a client never names a user. D1 stores only the SHA-256 hash of each token.

| Method   | Path                                      |                                                                   |
| -------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `PUT`    | `/v1/memories/:name`                      | create or replace `{description, type, body, tags}`               |
| `GET`    | `/v1/memories/:name`                      | read one                                                          |
| `DELETE` | `/v1/memories/:name`                      | delete one                                                        |
| `GET`    | `/v1/memories?tag=&since=&cursor=&limit=` | newest created first                                              |
| `POST`   | `/v1/search`                              | `{query, tags, any, limit, minScore, mode}`; each hit is a recall |
| `GET`    | `/v1/devices`                             | the caller's devices                                              |
| `DELETE` | `/v1/devices/:deviceId`                   | revoke a device; `current` names the caller's own                 |

The device login follows RFC 8628. `POST /v1/device/code` with `{device_name}` answers a device code, a user code, the verification URL, `expires_in` (600) and `interval` (5). `POST /v1/device/token` with `{grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code}` answers `{access_token, token_type}` once approved, or a 400 with `authorization_pending`, `slow_down`, `access_denied`, `expired_token` or `invalid_grant`. A poll inside the interval gets `slow_down` and widens the interval by five seconds. At most 5 codes per client address and 200 overall wait for approval at once; past that the start answers 429. The approval page at `/device` is the only path behind an Access login; its approve and deny form checks the Access JWT, the origin and a CSRF token.

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
