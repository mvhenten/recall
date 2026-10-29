# recall

Per-user semantic memory on Cloudflare, with a CLI that works in any harness. A Worker behind Cloudflare Access stores memories in D1 and their embeddings in Vectorize, one namespace per user.

## Memories and tags

A memory has a kebab-case `name` (unique per user), a `description`, a `type` (`user`, `feedback`, `project` or `reference`), a markdown `body` and a set of `tags`.

`recall save` tags a memory with the current repo, `repo:<host>/<owner>/<repo>` taken from the git remote. SSH and HTTPS remotes give the same tag, and a worktree gives its repo's tag. `--global` tags it `global` instead, and `--tag` adds free-form tags. Search and list match the repo tag or `global` by default; `--tag` replaces that set, and `--any` matches everything.

```bash
recall save note.md                 # frontmatter: name, description, type, tags
echo "two spaces" | recall save --name indent --description "indent style" --type feedback --global
recall search how do we cache builds
recall list --since 2026-10-01
recall get indent
recall edit indent --tag style      # no field flags opens $EDITOR
recall delete indent
recall --json search cache          # machine output
```

The CLI reads `RECALL_ENDPOINT`, `RECALL_CLIENT_ID` and `RECALL_CLIENT_SECRET` from the environment or from `~/.config/recall/env` (`RECALL_ENV_FILE` overrides the path).

## API

All routes sit under `/v1` and need a Cloudflare Access service token. The Worker resolves the user from the token; a client never names a user.

| Method | Path | |
| --- | --- | --- |
| `PUT` | `/v1/memories/:name` | create or replace `{description, type, body, tags}` |
| `GET` | `/v1/memories/:name` | read one |
| `DELETE` | `/v1/memories/:name` | delete one |
| `GET` | `/v1/memories?tag=&since=&cursor=&limit=` | newest created first |
| `POST` | `/v1/search` | `{query, tags, limit, minScore}`; each hit counts as a recall |

## Setup

1. Bootstrap the `ischen` account for OpenTofu: `tofu-bootstrap recall --permissions infra/bootstrap-permissions.json`.
2. Connect this repo to Workers Builds as the Worker `recall`, with `npm run deploy` as the deploy command. It applies `infra/`, creates the Vectorize index, migrates D1, syncs the principals table and deploys.
3. Once a deploy is green, write a host's env file: `npm run service-token -- <user> <host>`.
4. Install the CLI: `cargo install --path cli`.

Users and their hosts live in `infra/users.auto.tfvars`. Adding a user or a host is a change to that file; each (user, host) pair gets its own service token.
