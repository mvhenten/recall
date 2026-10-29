# recall

Per-user semantic memory for coding agents. recall keeps the notes an agent learns about you and your projects (your preferences, feedback you gave, how a repo works) in a small service you run on your own Cloudflare account, so they follow you across machines and harnesses.

- A command-line client, `recall`, saves, lists, searches and edits memories from any shell or agent.
- A Cloudflare Worker behind Cloudflare Access stores each user's memories in D1, with an embedding per memory and a full-text index, and answers searches with both.
- A Claude Code plugin saves Claude's auto-memory files to recall and adds matching memories to each prompt.

## Install

### The CLI

```bash
cargo install --git https://github.com/mvhenten/recall recall
```

From a checkout, `cargo install --path cli` does the same. The CLI reads `RECALL_ENDPOINT`, `RECALL_CLIENT_ID` and `RECALL_CLIENT_SECRET` from the environment or from `~/.config/recall/env` (`RECALL_ENV_FILE` points elsewhere). The setup below writes that file.

### Self-host the service

You need a Cloudflare account with a domain on it and Zero Trust switched on (the free plan is enough: open Zero Trust in the dashboard once and pick a team name). From a checkout, with Node 22 or later:

```bash
npm ci
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
npm run setup -- --hostname recall.example.com --user alice --host laptop
```

The setup creates the D1 database, a Cloudflare Access application on the hostname, an Access service token for that user and host, and a policy that admits it. It then migrates the database, registers the token as the user, deploys the Worker to the hostname and writes `~/.config/recall/env` (mode 600). Run it again at any time: it finds what exists and creates the rest. Run it on each new machine with a new `--host`, or with a new `--user` for another person; their memories stay apart. `--dry-run` prints what it would do, `--account <id>` picks an account when the token sees several, and `--env-path <path>` writes the env file elsewhere.

Create the API token under My Profile → API Tokens → Create Custom Token, with:

| Scope   | Permission                                                   |
| ------- | ------------------------------------------------------------ |
| Account | Account Settings · Read                                      |
| Account | D1 · Edit                                                    |
| Account | Workers Scripts · Edit                                       |
| Account | Workers AI · Read                                            |
| Account | Access: Apps and Policies · Edit                             |
| Account | Access: Service Tokens · Edit                                |
| Account | Access: Organizations, Identity Providers, and Groups · Read |
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

The plugin adds two hooks. Both need `node` 22 or later and find `recall` on `PATH` or in `~/.cargo/bin`.

- After a `Write` or `Edit` to an auto-memory file (under `autoMemoryDirectory`, or `~/.claude/projects/*/memory/` when that is unset; `MEMORY.md` excluded), it runs `recall save`. `user` and `feedback` memories are saved as global; `project` and `reference` memories get the repo tag of the session's directory, or `global` outside a repo. When the save fails, a message says the memory was saved locally but not synced.
- On each prompt of three words or more that is not a slash command, it runs `recall search` in the session's directory and adds the top five hits to the prompt as context, bodies truncated and the block capped at 4 KB. When recall fails, a one-line `recall unavailable: …` message shows and the prompt goes through unchanged.
- Every hook run appends one line to `${XDG_STATE_HOME:-~/.local/state}/recall/hooks.log`: time, session id, outcome (`hits=<n>`, `no-hits`, `skipped:<reason>`, `timeout`, `saved:<name>`, `error:<message>`) and duration. Prompts and memory bodies are never logged.

## Memories, tags and scope

A memory has a kebab-case `name` (unique per user), a `description`, a `type` (`user`, `feedback`, `project` or `reference`), a markdown `body` and a set of `tags`.

Tags scope memories. `recall save` tags a memory with the current repo, `repo:<host>/<owner>/<repo>`, taken from the git remote: SSH and HTTPS remotes give the same tag, and a worktree gives its repo's tag. `--global` tags it `global` instead, and `--tag` adds free-form tags. Search and list match the current repo tag or `global` by default; `--tag` replaces that set, and `--any` matches every memory. Outside a repo, `save` needs `--global`, and search covers `global` only.

Search is hybrid: it ranks by embedding similarity and by full-text match, then fuses the two rankings (reciprocal rank fusion, k = 60). `--mode vector` or `--mode text` uses one ranking. Every returned hit counts as a recall, so each memory carries a recall count and the time it was last recalled.

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

All routes sit under `/v1` and need a Cloudflare Access service token. The Worker resolves the user from the token; a client never names a user.

| Method   | Path                                      |                                                                   |
| -------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `PUT`    | `/v1/memories/:name`                      | create or replace `{description, type, body, tags}`               |
| `GET`    | `/v1/memories/:name`                      | read one                                                          |
| `DELETE` | `/v1/memories/:name`                      | delete one                                                        |
| `GET`    | `/v1/memories?tag=&since=&cursor=&limit=` | newest created first                                              |
| `POST`   | `/v1/search`                              | `{query, tags, any, limit, minScore, mode}`; each hit is a recall |

## Deploying from CI

As an alternative to `npm run setup`, Cloudflare Workers Builds can deploy the repo on every push with `npm run deploy` as the deploy command. It applies `infra/` with OpenTofu, migrates D1, syncs the users from `RECALL_USERS` and deploys the Worker. It refuses a plan that would destroy a resource. Use one path per deployment, not both.

The build reads the instance from build variables and stops with a message naming any that is missing:

| Variable            | Example                                  |
| ------------------- | ---------------------------------------- |
| `RECALL_ACCOUNT_ID` | `0123456789abcdef0123456789abcdef`       |
| `RECALL_ZONE_ID`    | `fedcba9876543210fedcba9876543210`       |
| `RECALL_HOSTNAME`   | `recall.example.com`                     |
| `RECALL_USERS`      | `{"alice": {"hosts": ["laptop", "ci"]}}` |

The account needs an R2 bucket `recall-tfstate` for the OpenTofu state, and a private R2 bucket `recall-builder-secrets` holding three objects: `CLOUDFLARE_TOFU_TOKEN` (an API token with the permissions above), and `TFSTATE_ACCESS_KEY_ID` and `TFSTATE_SECRET_ACCESS_KEY` (R2 S3 credentials for the state bucket). Each (user, host) pair in `RECALL_USERS` gets its own service token. Once a deploy is green, `npm run service-token -- <user> <host>` writes that host's env file from the state, with `RECALL_ACCOUNT_ID` and the two state keys in the environment.

## Develop

`npm test` runs the Worker in the Workers vitest pool against a local D1, with a stand-in for Workers AI. `npm run lint` and `npm run typecheck` check the TypeScript; `cargo fmt`, `cargo clippy` and `cargo test` check the CLI.

## License

MIT. See [LICENSE](LICENSE).
