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
| `envs push` | `<root>/.envs/values.yml` | Creates or updates `<worktree>/.env` of each worktree that has values. Updates existing variables in place, appends new ones at the end and keeps the rest of the file. If there are `defaults`, this includes all worktrees. |
| `envs edit` | Same as `pull` and `push` | Same as `pull` and `push`. It also runs `code -w <root>/.envs/values.yml`. |

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
