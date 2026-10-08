# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `envs` CLI with the `init`, `pull`, `push` and `edit` commands, plus build, tests and workflows (#1).
- `envs lint` command: warns about insecure values and unprotected files (#4).
- `values.yml` accepts YAML numbers and booleans as values.
- Documentation and metadata: README, MIT license, `SECURITY.md` and `package.json` (#2).

### Changed

- `envs pull` parses boolean and numeric values when reading `.env` files.
- The build includes `README.md` and `SECURITY.md` in `dist` (#3).

### Tests

- Verify that `envs push` preserves `.env` comments, spacing and order.

[Unreleased]: https://github.com/JonDotsoy/envs/commits/develop
