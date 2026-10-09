# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `envs share`: starts a P2P session (PeerJS + WebRTC) that serves the `main` profile from an encrypted `.envs/sharing-envs`, behind an explicit `y`/`yes` and a list of precautions. The link is `envs://<peer-id>/sharing-envs?key=<secret>`.
- `envs receive <link>`: fetches the variables and merges them into `values.yml` after `y`/`yes`.
- Connections are audited in `.envs/sharing-connections.ndjson`.
- Dependencies: `peerjs` and `node-datachannel` (STUN: `stun[1-4].l.google.com:19302`).
- Documentation: `docs/sharing/p2p.md` and a network section in `SECURITY.md`.

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
