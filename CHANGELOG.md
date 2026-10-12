# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `envs edit --ui`: the automatically opened browser ended in `401` because the session cookie was `SameSite=Strict` and the navigation starts from a `file://` page; it is now `SameSite=Lax`.
- A `HEAD` request no longer spends the single-use token; unsupported methods answer `405` instead of `415`.
- The web editor sends `Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

### Changed

- The token in the URL that `envs edit --ui` opens is now single-use: the first visit trades it for a session cookie with a different random value, and the URL stops working (`401`), so it is useless if read later from the browser history or the terminal. The browser is opened on a private temporary page (mode `600`, removed as soon as the token is used) that redirects to the URL, so the token never appears in the arguments of the opener process (`ps`). If the browser cannot be opened, the URL is printed with a message to open it manually. Using it prints a fresh single-use URL to stdout right away (`New single-use URL: ...`).

### Added

- The web editor (`envs edit --ui`) has a **History** panel: it lists the history points newest first; hovering or clicking a point shows what restoring it would change in the editor (red: removed, green: changed or added), and **Restore** restores it after a confirmation, adding a new point. New endpoints `GET /api/history` and `POST /api/restore`.
- Saving from the web editor keeps numbers and booleans typed (`3000`, `true`), as `pull` does, so an untouched value is no longer rewritten or recorded in the history as a change to a string.
- The History panel tags resync points as **external** (changes made outside the history).
- The web editor header has a **History** button, with the number of points, that scrolls to the history panel.
- `envs restore <hash>` restores `values.yml` to the state after a history point, adds a new point with the difference (no point is ever removed) and pushes.
- Edit history: when `envs edit`, the web editor's Save or `envs use` changes `values.yml`, one line `{"hash", "prev", "timestamp", "changes"}` is appended to `.envs/history.ndjson`. `changes` has only the differences (`path`, `from`, `to`); `prev` is the hash of the previous point and `hash` covers the rest of the line, forming a chain. The first `envs pull` creates the first point with the initial state, and later pulls add a point when they change `values.yml` (e.g. after a manual `.env` edit). The file is created with mode `600`. The history is active by default; `envs config set history false` turns it off. Nothing is written when nothing changed.
- GitHub Pages workflow: every push to `develop` publishes `sites/` (landing page in `sites/index.html`) and serves the values schema at <https://jondotsoy.github.io/envs/schema.json>.
- `envs init`, `envs pull` and `envs edit` write `# yaml-language-server: $schema=https://jondotsoy.github.io/envs/schema.json` at the top of `values.yml`, so editors validate it against the published schema.
- `envs edit --ui` serves a web editor (React) on `127.0.0.1` with the values of `.envs/values.yml`: the profile of each worktree, profile selector, worktree filter and one variables table with a default column and a column per worktree. The **Save** button (or Ctrl/Cmd+S) writes `values.yml` and runs `push`; Ctrl+C stops the server.
- The web editor has a **→ All** button that copies a default value to every worktree, a compact mode for many worktrees and an "Unsaved changes" indicator.
- The build bundles the web editor into `dist/ui`.

### Changed

- `envs edit` runs `envs init` first when `.envs/values.yml` does not exist, so `bunx @jondotsoy/envs edit` works without prior setup.
- The `$id` of the values schema is now its published URL, <https://jondotsoy.github.io/envs/schema.json>.
- README: the schema section points to the published URL.
- README: the quick start uses `bunx @jondotsoy/envs edit`; the global install is optional.

### Fixed

- `envs pull` reads backtick-quoted values, so a value with single and double quotes (`p'a"ss`) written by `push` is no longer stored with the backticks; a value that would need backticks but has one is rejected by `dotenvProblem` (and `lint`).
- The `sk-`, `AKIA`, `gh*_` and `xox*-` secret patterns no longer match inside a longer word (`task-management-service-prod` is not a secret).
- Docs: `push` sets `.env` files to mode `600` (SECURITY.md) and well-known secret formats are masked whatever the variable name.
- The history never holds a secret: sensitive variable names and URLs with a password are stored as keyed fingerprints (`envs:redacted:…`, key in `.envs/history.key`), so a rotated secret is not kept. `envs restore` keeps the current value of a secret and says so; `envs history redact` cleans an existing history and `history.secrets true` opts out. The console masks the password and the sensitive query parameters of a URL.
- Writing commands take `.envs/lock`: concurrent `envs` processes no longer fork the history chain, repeat a hash or lose a `use`.
- `.envs/` is created `700` and its files `600` (existing projects are tightened by the next writing command); a `.env` created by `push` is `600`.
- The history records the creation and the removal of a profile (`["profiles", name]`), so an empty profile is no longer lost and a deleted one no longer comes back, empty, on a replay or a `restore`.
- `envs lint` also checks the history (`tracked-history`, `unignored-history`, and `open-permissions`, `executable-files` and `writable-files`) and reports values of worktrees git no longer lists (`unknown-worktree`).
- `envs pull` says when a variable of the defaults is missing from a `.env` (`push` writes it back; remove it from the defaults to drop it everywhere).
- `envs edit`: a cancelled or failed editor (non-zero exit) leaves `values.yml` as it was before, instead of keeping the half-made edit for the next `push`.
- `envs restore` is refused with the history off, as the web editor already did, instead of rewriting `values.yml` without a point.
- `envs pull`: deleting a variable from the `.env` of a worktree on a profile other than `default` now also drops its entry under `default`, so `push` does not write it back.
- Web editor: Save no longer turns unchanged quoted strings (`"3000"`, `"true"`) into numbers or booleans, and a variable set to the empty string (`FOO=`) is no longer dropped: it is shown as `""` (an empty cell still means "not set").
- Web editor: Save is refused (409) when `values.yml` changed after the editor was loaded, instead of overwriting what another command saved meanwhile.
- `envs push` refuses, writing nothing, a variable name that is not valid or a value with a line break (it would inject another variable into the `.env`); Save in the web editor refuses it before saving, and `envs lint` reports it as `unsafe-dotenv-value`.
- The hash chain of the history is verified: `envs restore` refuses (unless `--force`) when a point was edited, removed or reordered, other commands warn, and the History panel flags it.
- Variables, profiles and worktrees named `__proto__`, `constructor`, `toString`… are now ordinary names: values, history and `.env` data are held in maps without a prototype and read by own key, so they no longer pollute `Object.prototype` (through `values.yml`, the web editor API or a history file), break `pull`/`push` (a branch called `constructor`) or get silently lost (a variable called `__proto__`).
- The web editor server refuses request bodies over 5 MiB (`413`), so a single request can no longer dump hundreds of megabytes into `values.yml`, the history and the `.env` files.
- The web editor server (`envs edit --ui`) now checks every request: a random per-run token (in the printed URL, traded for an `HttpOnly` `SameSite=Strict` cookie), the `Host` (no DNS rebinding), the `Origin` and `application/json` bodies. Any other program, or a web page, can no longer read the secrets or write through it.
- A damaged `.envs/history.ndjson` no longer breaks commands: an incomplete last line (interrupted write) is ignored and dropped by the next point, an unreadable line in the middle is skipped with a warning, `envs restore` refuses with a clear message naming the lines, and the History panel flags them.
- Resync points: when `values.yml` differs from the replayed history (a manual edit, or changes made with `history` off), the next recorded point is preceded by a point with `"resync": true` holding the difference, so `restore` no longer reverts those changes.
- The first history point always holds the whole state, whichever command writes it (`use` and Save in the web editor included), so `restore` to it no longer wipes `values.yml` in a project that predates the history or whose `history.ndjson` was deleted.
- `envs push` removes orphan variables from the `.env` files: the ones `envs` manages (in `values.yml` or its history) that the worktree no longer resolves, e.g. after `envs restore`, so the next `pull` does not bring them back. Variables that `envs` never saw are kept.
- Web editor: the sticky header is no longer covered by the sticky columns of the variables table when scrolling.
- `envs pull` no longer writes to `envs:` the values that are equal to their entry in `defaults:`.

## [0.1.0] - 2026-10-08

### Added

- `envs` CLI with the `init`, `pull`, `push` and `edit` commands, plus build, tests and workflows.
- `envs lint` command: warns about insecure values and unprotected files.
- `values.yml` accepts YAML numbers and booleans as values.
- `envs pull` parses boolean and numeric values when reading `.env` files.
- `envs push` preserves `.env` comments, spacing and order.
- Documentation and metadata: README, MIT license, `SECURITY.md` and `package.json`.
- The build includes `README.md` and `SECURITY.md` in `dist`.

[Unreleased]: https://github.com/JonDotsoy/envs/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JonDotsoy/envs/releases/tag/v0.1.0
