# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `envs edit` runs `envs init` first when `.envs/values.yml` does not exist, so `bunx @jondotsoy/envs edit` works without prior setup.
- README: the quick start uses `bunx @jondotsoy/envs edit`; the global install is optional.

### Fixed

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
