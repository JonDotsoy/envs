import { createHash, randomBytes } from "node:crypto";
import type { Context, Values } from "../envs";
import { parseShareArgs } from "./args";
import { appendAudit, type AuditEvent, type AuditFields } from "./audit";
import {
  DIRECTION,
  SessionCipher,
  decodeSecret,
  deriveAuthKey,
  deriveFileKey,
  deriveSessionKeys,
  generateEphemeralKey,
  generateSecret,
  mac,
  macEquals,
  sealFile,
  sharedSecret,
} from "./crypto";
import { buildPayload, PROFILE, removeSharingFile, writeSharingFile } from "./payload";
import { generatePeerId, buildShareUrl } from "./url";
import {
  CHUNK_SIZE,
  HANDSHAKE_TIMEOUT_MS,
  KIND,
  MAX_AUTH_FAILURES,
  NONCE_LENGTH,
  TRANSFER_TIMEOUT_MS,
  decodeHello,
  encodeAck,
  encodeData,
  isData,
} from "./protocol";
import type { Channel, ShareTransport } from "./transport";

export const PRECAUTIONS = [
  "The link contains the secret that decrypts your variables: treat it like a password.",
  `Anyone who gets the link while the session is open can read the "${PROFILE}" profile, including secrets.`,
  "The link works for a limited number of peers and expires; press Ctrl+C to close the session earlier.",
  "Send the link over a private channel; never paste it in repos, issues, logs, screenshots or public chats.",
  "Confirm with the other person, through another channel, that they are the one connecting.",
  "Your public IP is visible to the PeerJS broker and to the STUN servers (Google); the broker also sees the connection metadata, never the payload.",
  "Every connection is recorded in .envs/sharing-connections.ndjson (without the secret or any values).",
  "If you suspect the link leaked, close the session and rotate the secrets you shared.",
];

export interface ShareEnv {
  root: string;
  values: Values;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** `envs share`: hosts a one-session P2P endpoint that serves the encrypted `main` profile. */
export async function runShare(
  ctx: Context,
  { root, values }: ShareEnv,
  args: string[],
  createTransport: () => Promise<ShareTransport>,
  signal?: AbortSignal,
): Promise<number> {
  let options;
  try {
    options = parseShareArgs(args);
  } catch (error) {
    ctx.error((error as Error).message);
    return 1;
  }

  const payload = buildPayload(values, PROFILE, new Date());
  const keyCount = Object.keys(payload.values).length;
  if (keyCount === 0) {
    ctx.error(`The "${PROFILE}" profile has no variables to share.`);
    return 1;
  }

  ctx.log(`WARNING: you are about to become the primary peer of a P2P sharing session.\n`);
  PRECAUTIONS.forEach((line, i) => ctx.log(`  ${i + 1}. ${line}`));
  ctx.log("");
  if (!(await ctx.confirm(`Share ${keyCount} variables from "${PROFILE}"? Type y or yes to continue: `))) {
    ctx.error("Aborted: nothing was shared.");
    return 1;
  }

  const secretText = generateSecret();
  const secret = decodeSecret(secretText);
  const kAuth = deriveAuthKey(secret);
  const sessionId = randomBytes(16);
  const session = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  const sealed = sealFile(Buffer.from(JSON.stringify(payload)), deriveFileKey(secret), sessionId);
  const startedAt = Date.now();

  // Audit writes are serialized so the log keeps the order of events.
  let auditChain: Promise<void> = Promise.resolve();
  const audit = (event: AuditEvent, fields: AuditFields = {}) => {
    auditChain = auditChain
      .then(() => appendAudit(root, session, event, fields))
      .catch((error) => ctx.error(`Could not write the audit log: ${(error as Error).message}`));
  };

  await removeSharingFile(root);
  await writeSharingFile(root, sealed);

  const peerId = generatePeerId();
  let endpoint;
  try {
    endpoint = await (await createTransport()).listen(peerId, { peerServer: options.peerServer });
  } catch (error) {
    await removeSharingFile(root);
    ctx.error(`Could not start the session: ${(error as Error).message}`);
    return 1;
  }

  const url = buildShareUrl({ peerId, secret: secretText, peerServer: options.peerServer });
  audit("session_started", { keys: keyCount, reason: `max_peers=${options.maxPeers}` });
  ctx.log(`Share this link (valid ${Math.round(options.ttlMs / 6000) / 10} min, ${options.maxPeers} peer(s)):\n\n  ${url}\n`);
  ctx.log("Waiting for a peer… (Ctrl+C to stop)");

  const channels = new Set<Channel>();
  let transferred = 0;
  let reserved = 0;
  let failures = 0;
  let finished = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));

  const finish = (reason: string, code: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(ttlTimer);
    signal?.removeEventListener("abort", onAbort);
    for (const channel of channels) channel.close();
    endpoint.close();
    void removeSharingFile(root).then(() => {
      audit("session_ended", { reason, durationMs: Date.now() - startedAt });
      return auditChain.then(() => resolveDone(code));
    });
  };
  const onAbort = () => {
    ctx.log("\nSession closed.");
    finish("interrupted", 0);
  };
  const ttlTimer = setTimeout(() => {
    ctx.error("The link expired; nothing else will be shared.");
    finish("expired", transferred > 0 ? 0 : 1);
  }, options.ttlMs);
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();

  const seenNonces = new Set<string>();

  endpoint.onConnection((channel) => {
    const peer = `p_${randomBytes(4).toString("hex")}`;
    const openedAt = Date.now();
    const fields = (extra: AuditFields = {}): AuditFields => ({ peer, remote: channel.remote ?? null, ...extra });
    audit("connection_opened", fields());
    if (finished || transferred + reserved >= options.maxPeers) {
      audit("rejected", fields({ reason: "max_peers" }));
      channel.close();
      return;
    }
    channels.add(channel);

    let state: "hello" | "transfer" | "closed" = "hello";
    let hasSlot = false;
    let cipher: SessionCipher | undefined;
    let timer: ReturnType<typeof setTimeout>;

    const close = (event: AuditEvent, reason: string) => {
      if (state === "closed") return;
      const wasTransfer = state === "transfer";
      state = "closed";
      clearTimeout(timer);
      channels.delete(channel);
      if (hasSlot) reserved--;
      if (event === "auth_failed") failures++;
      audit(event, fields({ reason, durationMs: Date.now() - openedAt }));
      if (event !== "closed" && !wasTransfer) ctx.error(`Peer ${peer} was rejected (${reason}).`);
      channel.close();
      if (failures >= MAX_AUTH_FAILURES) finish("too_many_failures", 1);
    };
    const arm = (ms: number, reason: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => close("auth_failed", reason), ms);
    };
    arm(HANDSHAKE_TIMEOUT_MS, "timeout");

    channel.onClose(() => close("closed", "disconnected"));
    channel.onMessage((data) => {
      try {
        if (state === "hello") {
          const hello = decodeHello(data);
          if (!hello) return close("auth_failed", "bad_hello");
          const nonceKey = hex(hello.nonceC);
          if (seenNonces.has(nonceKey)) return close("auth_failed", "replay");
          seenNonces.add(nonceKey);
          if (!macEquals(hello.mac, mac(kAuth, "envs/hello", hello.nonceC, hello.pubC))) {
            return close("auth_failed", "bad_mac");
          }
          const ephemeral = generateEphemeralKey();
          const nonceS = randomBytes(NONCE_LENGTH);
          const ackMac = mac(kAuth, "envs/ack", hello.nonceC, hello.pubC, sessionId, nonceS, ephemeral.publicKey);
          const keys = deriveSessionKeys(
            sharedSecret(ephemeral, hello.pubC),
            secret,
            hello.nonceC,
            nonceS,
            sessionId,
          );
          cipher = new SessionCipher(keys.serverToClient, keys.clientToServer, sessionId, DIRECTION.serverToClient);
          hasSlot = true;
          reserved++;
          state = "transfer";
          arm(TRANSFER_TIMEOUT_MS, "timeout");
          audit("auth_ok", fields());
          ctx.log(`Peer ${peer} authenticated; sending ${keyCount} variables…`);
          channel.send(encodeAck(sessionId, nonceS, ephemeral.publicKey, ackMac));
          for (let offset = 0; offset < sealed.length; offset += CHUNK_SIZE) {
            const end = Math.min(offset + CHUNK_SIZE, sealed.length);
            const kind = end === sealed.length ? KIND.final : KIND.chunk;
            channel.send(encodeData(cipher.seal(Buffer.concat([Buffer.from([kind]), sealed.subarray(offset, end)]))));
          }
          return;
        }
        if (state === "transfer" && cipher && isData(data)) {
          const plain = cipher.open(Buffer.from(data).subarray(1));
          if (plain[0] === KIND.received) {
            state = "closed";
            clearTimeout(timer);
            channels.delete(channel);
            reserved--;
            hasSlot = false;
            transferred++;
            audit("transferred", fields({ keys: keyCount, bytes: sealed.length, durationMs: Date.now() - openedAt }));
            ctx.log(`Peer ${peer} received the variables.`);
            channel.close();
            if (transferred >= options.maxPeers) finish("completed", 0);
          } else {
            close("rejected", "client_rejected");
          }
        }
      } catch {
        close("auth_failed", "protocol_error");
      }
    });
  });

  return await done;
}
