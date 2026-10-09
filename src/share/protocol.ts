/** Wire format shared by `envs share` (host) and `envs receive` (client). All frames are binary. */

export const FRAME = { hello: 0x01, ack: 0x02, data: 0x03 } as const;

/** First byte of the decrypted plaintext of a data frame. */
export const KIND = { chunk: 0x00, final: 0x01, received: 0x02, rejected: 0x03 } as const;

export const NONCE_LENGTH = 16;
export const KEY_LENGTH = 32;
export const MAC_LENGTH = 64;
export const SESSION_ID_LENGTH = 16;

/** Chunk size of the encrypted file; data channels cap message sizes. */
export const CHUNK_SIZE = 12 * 1024;
/** The payload is a handful of variables; anything bigger is hostile or broken. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

export const HELLO_LENGTH = 1 + NONCE_LENGTH + KEY_LENGTH + MAC_LENGTH;
export const ACK_LENGTH = 1 + SESSION_ID_LENGTH + NONCE_LENGTH + KEY_LENGTH + MAC_LENGTH;

export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const TRANSFER_TIMEOUT_MS = 30_000;
export const MAX_AUTH_FAILURES = 3;

/** client → host: `hello | nonceC | pubC | mac(nonceC, pubC)` */
export function encodeHello(nonceC: Uint8Array, pubC: Uint8Array, mac: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([FRAME.hello]), nonceC, pubC, mac]);
}

export function decodeHello(frame: Uint8Array) {
  if (frame.length !== HELLO_LENGTH || frame[0] !== FRAME.hello) return undefined;
  const buf = Buffer.from(frame);
  return {
    nonceC: buf.subarray(1, 17),
    pubC: buf.subarray(17, 49),
    mac: buf.subarray(49),
  };
}

/** host → client: `ack | sessionId | nonceS | pubS | mac(nonceC, pubC, sessionId, nonceS, pubS)` */
export function encodeAck(
  sessionId: Uint8Array,
  nonceS: Uint8Array,
  pubS: Uint8Array,
  mac: Uint8Array,
): Buffer {
  return Buffer.concat([Buffer.from([FRAME.ack]), sessionId, nonceS, pubS, mac]);
}

export function decodeAck(frame: Uint8Array) {
  if (frame.length !== ACK_LENGTH || frame[0] !== FRAME.ack) return undefined;
  const buf = Buffer.from(frame);
  return {
    sessionId: buf.subarray(1, 17),
    nonceS: buf.subarray(17, 33),
    pubS: buf.subarray(33, 65),
    mac: buf.subarray(65),
  };
}

export const encodeData = (sealed: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from([FRAME.data]), sealed]);

export const isData = (frame: Uint8Array) => frame.length > 1 && frame[0] === FRAME.data;
