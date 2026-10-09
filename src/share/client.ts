import { randomBytes } from "node:crypto";
import type { Context, Values } from "../envs";
import { parseReceiveArgs } from "./args";
import {
  DIRECTION,
  SessionCipher,
  decodeSecret,
  deriveAuthKey,
  deriveFileKey,
  deriveSessionKeys,
  generateEphemeralKey,
  mac,
  macEquals,
  openFile,
  sharedSecret,
} from "./crypto";
import { mergePayload, parsePayload } from "./payload";
import {
  KIND,
  MAX_PAYLOAD_BYTES,
  NONCE_LENGTH,
  TRANSFER_TIMEOUT_MS,
  decodeAck,
  encodeData,
  encodeHello,
  isData,
} from "./protocol";
import type { ShareTransport } from "./transport";
import { parseShareUrl } from "./url";

export interface ReceiveEnv {
  valuesPath: string;
  values: Values;
}

/** `envs receive <link>`: fetches, decrypts and (after a y/yes) merges the shared variables into values.yml. */
export async function runReceive(
  ctx: Context,
  { valuesPath, values }: ReceiveEnv,
  args: string[],
  createTransport: () => Promise<ShareTransport>,
): Promise<number> {
  let link;
  let options;
  try {
    options = parseReceiveArgs(args);
    link = parseShareUrl(options.url);
  } catch (error) {
    ctx.error((error as Error).message);
    return 1;
  }

  const secret = decodeSecret(link.secret);
  const kAuth = deriveAuthKey(secret);
  const kFile = deriveFileKey(secret);

  let channel;
  try {
    ctx.log("Connecting to the host…");
    channel = await (await createTransport()).connect(link.peerId, { peerServer: link.peerServer });
  } catch (error) {
    ctx.error(`Could not connect: ${(error as Error).message}`);
    return 1;
  }

  const nonceC = randomBytes(NONCE_LENGTH);
  const ephemeral = generateEphemeralKey();

  /** Runs the handshake and collects the encrypted file; rejects on any authentication problem. */
  const transfer = new Promise<{ sealed: Buffer; sessionId: Buffer; cipher: SessionCipher }>((resolve, reject) => {
    let cipher: SessionCipher | undefined;
    let sessionId: Buffer | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Timed out waiting for the host")), TRANSFER_TIMEOUT_MS);

    channel.onClose(() => fail(new Error("The host closed the connection before the transfer finished")));
    channel.onMessage((data) => {
      try {
        if (!cipher) {
          const ack = decodeAck(data);
          if (!ack) throw new Error("Unexpected reply from the host");
          const expected = mac(kAuth, "envs/ack", nonceC, ephemeral.publicKey, ack.sessionId, ack.nonceS, ack.pubS);
          if (!macEquals(ack.mac, expected)) {
            throw new Error("Host authentication failed (wrong key or the connection was tampered with)");
          }
          const keys = deriveSessionKeys(sharedSecret(ephemeral, ack.pubS), secret, nonceC, ack.nonceS, ack.sessionId);
          sessionId = ack.sessionId;
          cipher = new SessionCipher(keys.clientToServer, keys.serverToClient, ack.sessionId, DIRECTION.clientToServer);
          return;
        }
        if (!isData(data)) throw new Error("Unexpected frame");
        const plain = cipher.open(Buffer.from(data).subarray(1));
        const chunk = plain.subarray(1);
        size += chunk.length;
        if (size > MAX_PAYLOAD_BYTES) throw new Error("The payload is too large");
        chunks.push(chunk);
        if (plain[0] === KIND.final && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ sealed: Buffer.concat(chunks), sessionId: sessionId!, cipher });
        }
      } catch (error) {
        fail(error as Error);
      }
    });
    channel.send(encodeHello(nonceC, ephemeral.publicKey, mac(kAuth, "envs/hello", nonceC, ephemeral.publicKey)));
  });

  const reply = (cipher: SessionCipher, kind: number) => {
    channel.send(encodeData(cipher.seal(Buffer.from([kind]))));
  };

  let received;
  try {
    received = await transfer;
  } catch (error) {
    channel.close();
    ctx.error((error as Error).message);
    return 1;
  }

  let payload;
  try {
    const opened = openFile(received.sealed, kFile);
    if (!opened.sessionId.equals(received.sessionId)) throw new Error("The payload belongs to another session");
    payload = parsePayload(opened.plain.toString("utf8"));
  } catch (error) {
    reply(received.cipher, KIND.rejected);
    channel.close();
    ctx.error((error as Error).message);
    return 1;
  }
  reply(received.cipher, KIND.received);
  // Give the acknowledgement a moment to leave before the connection goes away.
  await new Promise((resolve) => setTimeout(resolve, 200));
  channel.close();

  const keyCount = Object.keys(payload.values).length;
  const preview = mergePayload(structuredClone(values), payload, options.force);
  ctx.log(
    `Received ${keyCount} variables from profile "${payload.profile}": ` +
      `${preview.added.length} new, ${preview.overwritten.length} overwritten, ` +
      `${preview.unchanged.length} unchanged, ${preview.conflicts.length} conflicting` +
      (preview.conflicts.length > 0 ? " (kept; use --force to overwrite)" : "") +
      ".",
  );
  if (preview.added.length + preview.overwritten.length === 0) {
    ctx.log("Nothing to merge.");
    return 0;
  }
  if (!(await ctx.confirm(`Merge them into ${valuesPath} as defaults? Type y or yes to continue: `))) {
    ctx.error("Aborted: values.yml was not modified.");
    return 1;
  }
  mergePayload(values, payload, options.force);
  await Bun.write(valuesPath, Bun.YAML.stringify(values, null, 2));
  ctx.log(`Merged ${preview.added.length + preview.overwritten.length} variables into ${valuesPath}. Run \`envs push\` to apply them.`);
  return 0;
}
