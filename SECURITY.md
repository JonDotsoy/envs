# Security Policy

## Supported versions

Only the latest version of `@jondotsoy/envs` published on npm is maintained. Security fixes are released in a new version.

## Reporting a vulnerability

Do not open a public issue to report a vulnerability. Report it privately through one of these channels:

- GitHub's private vulnerability reporting: the repository's **Security** tab, **Report a vulnerability**.
- By email to [hi@jon.soy](mailto:hi@jon.soy).

If you can, include:

- the version of `@jondotsoy/envs` and of Bun you use;
- a description of the problem and its impact;
- the steps to reproduce it.

I will reply as soon as possible and we will coordinate the fix and the disclosure of the issue.

## Files it modifies

`envs` only reads and writes the files in this table. `<root>` is the main repo (inside a worktree, the parent repo) and `<worktree>` is the folder of each worktree listed by `git worktree list`, including the main repo, even if it is outside `<root>`.

| Command | Reads | Writes |
| --- | --- | --- |
| `envs init` | — | Creates `<root>/.envs/`, `<root>/.envs/.gitignore` and `<root>/.envs/values.yml`, only if they do not exist. Never overwrites. |
| `envs pull` | `<worktree>/.env` of each worktree | Rewrites `<root>/.envs/values.yml`. The file is serialized again, so YAML comments are lost. |
| `envs push` | `<root>/.envs/values.yml` | Creates or updates `<worktree>/.env` of each worktree that has values. Updates existing variables in place, appends new ones at the end and keeps the rest of the file, except the orphan variables: those `envs` manages (they are or were in `values.yml` or its history) that the worktree no longer resolves are removed. If there are `defaults`, this includes all worktrees. |
| `envs edit` | Same as `pull` and `push` | Same as `pull` and `push`. It also runs `code -w <root>/.envs/values.yml`. With `--ui` it serves the web editor instead (see below). |
| `envs use`, `envs restore` | `<root>/.envs/values.yml`, `<root>/.envs/history.ndjson` | Rewrite `values.yml` and then act as `push`. |
| `envs config` | `<root>/.envs/config.yml` | Creates or updates `<root>/.envs/config.yml` (mode `600`). |

Every command that changes `values.yml` also appends to `<root>/.envs/history.ndjson` (mode `600`, append-only) unless the history is turned off with `envs config set history false`.

Additionally:

- It runs `git rev-parse` and `git worktree list` to locate the root and the worktrees. These are read-only commands.
- `envs edit` runs the `code` program found in the `PATH`.
- It makes no network connections and does not modify other project files, not even your project's `.gitignore`.

## Handling secrets

`envs` works with values that are often secrets:

- `.envs/values.yml` stores the values of all worktrees in plain text.
- `envs init` creates `.envs/.gitignore` with `*`, so the `.envs/` folder is not committed to git. Do not remove that file.
- `envs push` writes the values to the `.env` files of each worktree. Make sure `.env` is in your project's `.gitignore`.
- Do not share `values.yml` or paste it in issues or logs.

## Web editor (`envs edit --ui`)

The server listens on `127.0.0.1` only and exposes the values of every `.env`, secrets included, so each request must pass these checks: a random per-run access token (in the printed URL, then an `HttpOnly`, `SameSite=Strict` cookie), a `Host` of this server (no DNS rebinding), an `Origin` of this server, `application/json` bodies and a body of at most 5 MiB; it never answers CORS preflights. Open only the address printed by the command and do not share it: it carries the token. See [docs/ui.md](docs/ui.md).

## The history

`.envs/history.ndjson` keeps the previous and the new value of every variable that changes. Secrets (a sensitive variable name, or a URL with a password or a sensitive query parameter) are stored only as keyed fingerprints (`envs:redacted:…`, key in `.envs/history.key`), never in clear, unless you set `envs config set history.secrets true`. It is append-only: a value that was recorded cannot be removed without rewriting the file; on a history written before this, run `envs history redact`. `.envs/` is `700` and its files `600`, and, like the rest of `.envs/`, it is ignored by git. `envs lint` checks its permissions and that git ignores it. Turn it off with `envs config set history false` if you do not want it. Writing commands take `.envs/lock`, so concurrent processes cannot corrupt it.

## Console output

`envs push` prints one line for each variable whose value changes, in the form `↻ NAME=VALUE → branch, ...`, and `envs pull` prints `↓ pulling branch, ... - N variables`. To keep secrets out of the terminal and CI logs:

- The value is replaced by `********` when the variable name contains a sensitive word: `SECRET`, `PASSWORD`, `PASSWD`, `PWD`, `TOKEN`, `KEY` (including `API_KEY` and `PRIVATE_KEY`), `CREDENTIAL`, `AUTH`, `SALT` or `SIGNING`. The match is case-insensitive and applies to whole `_`-separated words, so `KEY_FOO` and `AWS_BUCKET_SECRET` are masked but `MONKEY` is not.
- A URL keeps its host and loses its secrets: `postgres://user:********@host/db?token=********` (the password and the values of sensitive query parameters are masked). A secret stored in a variable with an innocuous name and no URL form is still printed as is.
- `envs pull` never prints values, only branch names and the number of variables.
- `envs lint` messages never include the matched value.
- Set `NO_COLOR` to a non-empty value to print the output without colors.
