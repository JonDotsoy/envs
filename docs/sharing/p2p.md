# P2P sharing

`envs share` lets you hand the variables of your `main` profile to another machine over the internet, peer to peer, through a single link. The machine that runs `envs share` becomes the **primary peer** (the host); the machine that runs `envs receive` is the client.

All client/server communication uses [PeerJS](https://peerjs.com/): it signals the connection and then carries the data over a WebRTC data channel (`node-datachannel` provides WebRTC under Bun).

> Read [Precautions](#precautions) and the [Network section of SECURITY.md](../../SECURITY.md#network-p2p-sharing) before using it with real secrets.

## Usage

On the machine that owns the variables:

```sh
envs share [--max-peers N] [--ttl MINUTES] [--peer-server URL]
```

1. `envs share` reads `.envs/values.yml`, resolves the `main` profile (`defaults` overridden by `envs.<KEY>.main`, the same rule `envs push` uses) and prints a warning with the [precautions](#precautions).
2. Nothing happens until you type `y` or `yes`. Any other answer (or an empty line, or no terminal input) aborts.
3. It writes the encrypted file `.envs/sharing-envs`, registers the session on the broker and prints the link:

   ```
   envs://fy64nvlu6gqxhfum5zf2krvnat/sharing-envs?key=3vQ5dptPWs0rDtY1Da7BZiAdP0Bmqypt-eGH0Fs_e0g
   ```
4. Send the link to the other person through a private channel. Leave the command running.

On the other machine, inside a project that already ran `envs init`:

```sh
envs receive "envs://…" [--force]
```

It connects, authenticates, downloads and decrypts the variables, reports how many are new, overwritten, unchanged or conflicting, and asks for `y`/`yes` before it adds them to `defaults` in `.envs/values.yml`. Keys that already exist with a different value are kept unless you pass `--force`. Run `envs push` afterwards to write them to your `.env` files.

| Option (share) | Default | Meaning |
| --- | --- | --- |
| `--max-peers N` | `1` | Number of successful transfers before the session closes. |
| `--ttl MINUTES` | `10` | Lifetime of the link. |
| `--peer-server URL` | PeerJS Cloud | Use your own [peerjs-server](https://github.com/peers/peerjs-server). The URL is carried inside the link, so the client needs no flag. |

The session ends when the allowed transfers are done, when the TTL expires, after three failed authentications, or on `Ctrl+C`. Ending it deletes `.envs/sharing-envs`.

## The link

```
envs://<peer-id>/sharing-envs?key=<secret>[&server=<peer-server>]
```

| Part | Meaning |
| --- | --- |
| `<peer-id>` | 128 random bits in lowercase base32 (26 characters). It is the PeerJS id of the host for this session only. |
| `key` | 32 random bytes in base64url (43 characters). The secret every key is derived from. It never travels over the network; only the person who has the link knows it. |
| `server` | Only present with `--peer-server`. |

## How it works

```
 host (envs share)                 PeerJS broker                 client (envs receive)
        │  register <peer-id>  ────────▶│                                  │
        │                               │◀──────── connect <peer-id> ──────│
        │◀═══════ offer / answer / ICE (signaling, relayed) ═══════════════▶│
        │◀══════════════ direct WebRTC data channel (UDP, DTLS) ═══════════▶│
        │◀── HELLO  (nonce, X25519 key, HMAC) ──────────────────────────────│
        │─── ACK    (session id, nonce, X25519 key, HMAC) ─────────────────▶│
        │─── encrypted file, in numbered AEAD chunks ──────────────────────▶│
        │◀── encrypted "received" ──────────────────────────────────────────│
```

The broker only introduces the peers; once the data channel is open the data does not go through it. [STUN](https://en.wikipedia.org/wiki/STUN) is used to discover each peer's public address. The servers are `stun.l.google.com:19302` and `stun1`–`stun4.l.google.com:19302`. There is no TURN relay.

### Cryptography

Every key derives from the link secret with HKDF-SHA512, with a different label per purpose.

| Layer | What it protects | Mechanism |
| --- | --- | --- |
| Inner: `.envs/sharing-envs` | The variables, at rest and as sent. | AES-256-GCM, key `envs/file/v1`. Container `ENVSHR1\0 · session id(16) · nonce(12) · ciphertext · tag(16)`; the header is the authenticated data. |
| Handshake | That both peers know the link; no man in the middle. | HMAC-SHA512 (key `envs/auth/v1`) over both nonces and both X25519 public keys, compared in constant time. |
| Outer: channel | The transfer on the wire. | WebRTC DTLS, plus AES-256-GCM per direction with keys from X25519 (ephemeral, so past sessions stay safe) mixed with the secret (`envs/tx/v1`). Frames carry a sequence number, bound with the session id and direction as authenticated data. |

Consequences:

- The file travels already encrypted and is encrypted again by the channel, as designed. Both layers derive from the same secret, so they add defence in depth but are not independent: **the secret in the link is the weak point**.
- A replayed, reordered, reflected or modified frame is rejected, as is a replayed `HELLO`.
- A broker (or anyone on the path) that rewrites the signaling data and terminates DTLS itself still cannot complete the handshake without the secret.
- The payload is capped at 1 MiB.

### Files

| File | Content | Lifetime |
| --- | --- | --- |
| `.envs/sharing-envs` | JSON `{version, profile, generatedAt, values}` of the `main` profile, encrypted as above. Mode `0600`, covered by `.envs/.gitignore`. | Created after you confirm; deleted when the session ends or on `Ctrl+C`. A stale one is replaced on the next start. |
| `.envs/sharing-connections.ndjson` | Audit log. Mode `0600`, append-only, never cleaned automatically. | Persistent. |

### Audit log format

One JSON object per line:

```json
{"v":1,"ts":"2026-10-09T14:50:54.031Z","session":"4f3cd82c","event":"auth_ok","peer":"p_b41be696","remote":"203.0.113.7","reason":null,"keys":null,"bytes":null,"durationMs":null}
```

| Field | Meaning |
| --- | --- |
| `v` | Format version (`1`). |
| `ts` | ISO 8601 UTC time. |
| `session` | First 8 hex characters of SHA-256 of the session id; correlates the events of one run. |
| `event` | `session_started`, `connection_opened`, `auth_ok`, `auth_failed`, `transferred`, `rejected`, `closed`, `session_ended`. |
| `peer` | Random id of one connection (`p_…`); `null` for session events. |
| `remote` | Peer IP when the WebRTC backend reports it (best effort, it may be `null` early in a connection). Personal data. |
| `reason` | Why: `bad_mac`, `replay`, `timeout`, `max_peers`, `client_rejected`, `completed`, `expired`, `interrupted`, `too_many_failures`… |
| `keys`, `bytes`, `durationMs` | Number of variables, size of the encrypted file, elapsed time, when applicable. |

It never contains the secret, the link, the session id, or the names or values of the variables.

## Precautions

1. The link contains the secret that decrypts your variables: treat it like a password.
2. Anyone who gets the link while the session is open can read the `main` profile, including secrets.
3. The link works for a limited number of peers and expires; close the session with `Ctrl+C` as soon as you are done.
4. Send the link over a private channel; never paste it in repos, issues, logs, screenshots or public chats.
5. Confirm with the other person, through another channel, that they are the one connecting.
6. Your public IP is visible to the PeerJS broker and to the STUN servers (Google); the broker also sees the connection metadata, never the payload.
7. Every connection is recorded in `.envs/sharing-connections.ndjson`.
8. If you suspect the link leaked, close the session and rotate the secrets you shared.

## Limitations and troubleshooting

- **Public broker.** PeerJS Cloud is free and has no uptime guarantee. If it is down or rate limited, `envs share` reports `Could not reach the PeerJS broker`. Run your own with `--peer-server`.
- **No TURN.** A direct UDP path must exist. Two peers behind symmetric NAT or CGNAT (some mobile and corporate networks) may fail with `Could not connect to the host`. Try another network, a VPN, or host a TURN-enabled setup yourself.
- **Signaling exposes IPs to the broker.** The PeerJS client sends the WebRTC session description in clear text through the broker, so the ICE candidates (addresses) are visible to it. The payload is not.
- **`Host not found`.** The session ended, expired, or the link is wrong.
- **`Host authentication failed`.** The `key` does not match, or something altered the connection.
- **Merging into `values.yml`** rewrites the file, so YAML comments are lost (same as `envs pull`).
- Requires a platform supported by `node-datachannel` prebuilt binaries.
