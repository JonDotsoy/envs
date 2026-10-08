# @jondotsoy/envs

CLI that keeps the `.env` values of every git worktree in a single file (`.envs/values.yml`). Edit all values together and distribute them to each worktree, or collect them from the existing `.env` files.

Requires [Bun](https://bun.com) and git.

## Installation

```bash
bun add -g @jondotsoy/envs
```

Or without installing:

```bash
bunx @jondotsoy/envs help
```

## Usage

Run the commands inside the repo or any of its worktrees. Inside a worktree, `.envs/` always lives in the main repo.

| Command | What it does |
| --- | --- |
| `envs init` | Creates `.envs/`, `.envs/.gitignore` (containing `*`) and an empty `.envs/values.yml`. Does not overwrite existing files. |
| `envs pull` | Reads the `.env` of the main repo and of each worktree and writes it to `values.yml`. Variables that are no longer in a `.env` are removed from `values.yml` for that worktree. |
| `envs push` | Writes `values.yml` to the `.env` of each worktree. Updates existing variables in place, appends new ones at the end, and keeps comments and variables that are not in `values.yml`. |
| `envs lint` | Checks security and prints a warning for each problem. Exits with code 1 if there is any (useful in CI). See below. |
| `envs edit` | Runs `pull`, opens `values.yml` with `code -w` and, when the editor closes, runs `push`. If the editor fails, it does not `push`. |
| `envs help` | Shows the help. |

Worktrees are identified by their branch name (or their folder name if they are in detached HEAD). The main repo uses its branch name, for example `main`.

### `envs lint`

It never prints values, only the variable and its location (`envs.DB_PASSWORD.main`).

| Rule | Detects |
| --- | --- |
| `tracked-values`, `unignored-values` | `values.yml` is tracked by git or is not ignored. |
| `tracked-dotenv`, `unignored-dotenv` | A worktree's `.env` is tracked or is not ignored. |
| `open-permissions` | `values.yml` is readable by other users (use `chmod 600`). |
| `executable-files` | `values.yml` or a `.env` has the execute permission (use `chmod -x`). |
| `writable-files` | `values.yml` or a `.env` is writable by the group or other users (use `chmod go-w`). |
| `weak-secret` | Sensitive variable (`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY`…) that is empty or has a typical value (`changeme`, `admin`…). |
| `shared-secret` | Sensitive variable in `defaults`, which is written to all worktrees. |
| `secret-pattern` | Value with a known secret format (AWS, GitHub, Slack, `sk-…`, private key). |
| `url-credentials`, `insecure-url` | Remote URL with an embedded password, or using `http://`, `ws://` or `ftp://`. |

## `values.yml` format

```yaml
defaults:
  LOG_LEVEL: info

envs:
  DATABASE_URL:
    main: postgres://localhost/main
    feature-x: postgres://localhost/feature_x
  PORT:
    main: "3000"
    feature-x: "3001"
```

- `defaults`: default value of each variable. `push` writes it to the `.env` of all worktrees.
- `envs.<VARIABLE>.<worktree>`: value of the variable in that worktree. It overrides the value from `defaults`.
- Values can be strings, numbers or booleans (`PORT: 3000`, `DEBUG: true`); `push` writes them to the `.env` as text (`PORT=3000`, `DEBUG=true`). `pull` converts `true`/`false` and canonical numbers (`3000`, `0.5`) to booleans and numbers; anything else (`007`, `1e3`) stays a string.

The schema (JSON Schema) is at [`schema/values.schema.json`](schema/values.schema.json). To have VS Code validate the file with the YAML extension, add this at the top of `values.yml`:

```yaml
# yaml-language-server: $schema=../schema/values.schema.json
```

## Development

```bash
bun install
bun test              # run the tests
bun test --coverage   # with coverage
bun run build         # generates dist/ (envs.js and package.json)
```

- `src/envs.ts`: command logic. `src/bin/envs.ts`: CLI entry point.
- `test/fixtures/workspace.ts`: `createWorkspace({ main, worktrees, files })` fixture, which creates a temporary git repo with worktrees, each in its own temporary folder.

## Publishing

The **Publish** workflow (Actions → Publish → Run workflow) bumps the version, builds and publishes `dist/` to npm via OIDC (trusted publishing). Inputs:

- `bump`: `major`, `minor`, `patch` or `prerelease`.
- `tag`: npm dist-tag (`latest`, `default`, `alpha` or `demo`). With a tag other than `latest` the version is a prerelease (`0.0.2-alpha.0`).
- `provenance`: publish with provenance. npm only accepts it if the repository is public.

After publishing, it creates the version commit and tag, and a GitHub release linking to the version on npm.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
