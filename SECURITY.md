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
| `envs share` | `<root>/.envs/values.yml` | Creates `<root>/.envs/sharing-envs` (encrypted, mode `0600`) and deletes it when the session ends. Appends to `<root>/.envs/sharing-connections.ndjson` (mode `0600`). |
| `envs receive` | `<root>/.envs/values.yml` | After an explicit `y`/`yes`, rewrites `<root>/.envs/values.yml` (YAML comments are lost) adding the received variables to `defaults`. |

Additionally:

- It runs `git rev-parse` and `git worktree list` to locate the root and the worktrees. These are read-only commands.
- `envs edit` runs the `code` program found in the `PATH`.
- Only `envs share` and `envs receive` use the network (see [Network: P2P sharing](#network-p2p-sharing)). Every other command makes no network connections.
- It does not modify other project files, not even your project's `.gitignore`.

## Handling secrets

`envs` works with values that are often secrets:

- `.envs/values.yml` stores the values of all worktrees in plain text.
- `envs init` creates `.envs/.gitignore` with `*`, so the `.envs/` folder is not committed to git. Do not remove that file.
- `envs push` writes the values to the `.env` files of each worktree. Make sure `.env` is in your project's `.gitignore`.
- Do not share `values.yml` or paste it in issues or logs.
- `.envs/sharing-envs` is encrypted with a key that exists only in the sharing link, is created with mode `0600`, covered by `.envs/.gitignore`, and is deleted when the session ends (also on `Ctrl+C`).
- The sharing link contains the secret that decrypts your variables. Treat it as a password.

## Console output

`envs push` prints one line for each variable whose value changes, in the form `↻ NAME=VALUE → branch, ...`, and `envs pull` prints `↓ pulling branch, ... - N variables`. To keep secrets out of the terminal and CI logs:

- The value is replaced by `********` when the variable name contains a sensitive word: `SECRET`, `PASSWORD`, `PASSWD`, `PWD`, `TOKEN`, `KEY` (including `API_KEY` and `PRIVATE_KEY`), `CREDENTIAL`, `AUTH`, `SALT` or `SIGNING`. The match is case-insensitive and applies to whole `_`-separated words, so `KEY_FOO` and `AWS_BUCKET_SECRET` are masked but `MONKEY` is not.
- Masking is based on the name only. A secret stored in a variable with an innocuous name (for example `DATABASE_URL` with a password inside) is printed as is.
- `envs pull` never prints values, only branch names and the number of variables.
- `envs lint` messages never include the matched value.
- `envs share` prints the sharing link, which includes the secret. It is printed once, to the terminal only; it is never written to disk or to the audit log. Do not run it in a terminal whose output is recorded.
- `envs receive` prints the number of variables received, never their names or values.
- Set `NO_COLOR` to a non-empty value to print the output without colors.

## Network: P2P sharing

`envs share` and `envs receive` are the only commands that use the network. Full details are in [docs/sharing/p2p.md](docs/sharing/p2p.md); this is what is protected and what is not.

**Consent.** `envs share` prints a warning with precautions and does nothing until you type `y` or `yes`. `envs receive` asks the same before it modifies `values.yml`.

**What the mechanism protects.**

- *Confidentiality of the variables.* They travel in two encrypted layers derived from the link secret with HKDF-SHA512: the `sharing-envs` file (AES-256-GCM) and, on top of the WebRTC channel (DTLS), an authenticated application layer (AES-256-GCM with X25519 forward-secret keys). Whoever relays the traffic (network, PeerJS broker) sees only ciphertext.
- *Authentication of both peers.* A handshake authenticated with HMAC-SHA512 over the secret proves that each side knows the link. A broker or network attacker that rewrites the signaling data cannot forge it, so it cannot sit in the middle.
- *Replays and tampering.* Frames are numbered, bound to the session and direction, and rejected if they repeat, arrive out of order or are modified.
- *Exposure window.* A session is single use by default (`--max-peers`), expires after 10 minutes (`--ttl`), closes after 3 failed authentications, and removes `sharing-envs` when it ends.
- *Auditing.* Every connection attempt is appended to `.envs/sharing-connections.ndjson` (one JSON object per line: time, session hash, event, a random peer id, the remote IP when the WebRTC backend reports it, and counters). It never contains the secret, the link, or variable names or values.

**What it does not protect.**

- *The link.* Anyone who obtains it before it expires or is used can read your `main` variables. Send it over a private channel.
- *Metadata.* All client/server communication goes through [PeerJS](https://peerjs.com/). The PeerJS broker (PeerJS Cloud by default, or your own with `--peer-server`) sees the random peer ids, when a session exists and the IPs that connect to it. The WebRTC session description also passes through it in clear text, so it exposes the ICE candidates (IP addresses). Google's STUN servers (`stun*.l.google.com:19302`) see your public IP. Neither sees the payload.
- *Availability.* The public broker is a free service with no guarantees. There is no TURN relay, so peers behind symmetric NAT or CGNAT may be unable to connect.
- *Endpoints.* Once received, variables are plain text in `values.yml` and `.env` with the protections described above.

The `remote` field of the audit log is personal data (an IP address). The file stays on your machine, but treat it accordingly if you share or archive it.
