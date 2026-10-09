import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

/** Every key is derived from the link secret with HKDF-SHA512, one `info` label per purpose. */
const SALT = Buffer.from("envs-sharing-v1");
const kdf = (ikm: Uint8Array, salt: Uint8Array, info: string, length: number) =>
  Buffer.from(hkdfSync("sha512", ikm, salt, info, length));

export const generateSecret = () => randomBytes(32).toString("base64url");

export function decodeSecret(secret: string): Buffer {
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== secret) {
    throw new Error("Invalid secret");
  }
  return bytes;
}

/** Encrypts `.envs/sharing-envs` (inner layer). */
export const deriveFileKey = (secret: Uint8Array) => kdf(secret, SALT, "envs/file/v1", 32);
/** Authenticates the handshake (HMAC-SHA512). */
export const deriveAuthKey = (secret: Uint8Array) => kdf(secret, SALT, "envs/auth/v1", 64);

/** HMAC-SHA512 over length-prefixed parts so concatenations are unambiguous. */
export function mac(key: Uint8Array, label: string, ...parts: Uint8Array[]): Buffer {
  const h = createHmac("sha512", key);
  for (const part of [Buffer.from(label), ...parts]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    h.update(length).update(part);
  }
  return h.digest();
}

export function macEquals(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Inner layer: the sharing-envs container -------------------------------

const MAGIC = Buffer.from("ENVSHR1\0");
const HEADER = MAGIC.length + 16;
const NONCE = 12;
const TAG = 16;

/** `ENVSHR1\0 | sessionId(16) | nonce(12) | AES-256-GCM ciphertext | tag(16)`; the header is the AAD. */
export function sealFile(plain: Uint8Array, key: Uint8Array, sessionId: Uint8Array): Buffer {
  const header = Buffer.concat([MAGIC, sessionId]);
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, nonce, body, cipher.getAuthTag()]);
}

export function openFile(data: Uint8Array, key: Uint8Array): { sessionId: Buffer; plain: Buffer } {
  const buf = Buffer.from(data);
  if (buf.length < HEADER + NONCE + TAG || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not an envs sharing file");
  }
  const header = buf.subarray(0, HEADER);
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(HEADER, HEADER + NONCE));
  decipher.setAAD(header);
  decipher.setAuthTag(buf.subarray(buf.length - TAG));
  try {
    const plain = Buffer.concat([
      decipher.update(buf.subarray(HEADER + NONCE, buf.length - TAG)),
      decipher.final(),
    ]);
    return { sessionId: Buffer.from(header.subarray(MAGIC.length)), plain };
  } catch {
    throw new Error("Could not decrypt the payload (wrong key or tampered data)");
  }
}

// ---- Outer layer: handshake and per-direction AEAD -------------------------

export interface EphemeralKey {
  publicKey: Buffer;
  privateKey: KeyObject;
}

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

export function generateEphemeralKey(): EphemeralKey {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { publicKey: Buffer.from(der.subarray(der.length - 32)), privateKey };
}

export function sharedSecret(own: EphemeralKey, peerPublicKey: Uint8Array): Buffer {
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_X25519, peerPublicKey]),
    format: "der",
    type: "spki",
  });
  return diffieHellman({ privateKey: own.privateKey, publicKey });
}

/** Transport keys: the X25519 secret is mixed with the link secret, bound to both nonces and the session id. */
export function deriveSessionKeys(
  shared: Uint8Array,
  secret: Uint8Array,
  nonceC: Uint8Array,
  nonceS: Uint8Array,
  sessionId: Uint8Array,
): { clientToServer: Buffer; serverToClient: Buffer } {
  const salt = createHash("sha512").update(nonceC).update(nonceS).update(sessionId).digest();
  const okm = kdf(Buffer.concat([shared, secret]), salt, "envs/tx/v1", 64);
  return { clientToServer: okm.subarray(0, 32), serverToClient: okm.subarray(32) };
}

/** Direction byte bound into the AAD, so a frame cannot be reflected back to its sender. */
export const DIRECTION = { clientToServer: 0, serverToClient: 1 } as const;

/**
 * AES-256-GCM over numbered frames: `seq(4) | ciphertext | tag(16)`.
 * The nonce is the sequence number (keys are per direction, so it never repeats);
 * frames must arrive in order, which also rejects replays and reordering.
 */
export class SessionCipher {
  private sendSeq = 0;
  private recvSeq = 0;

  constructor(
    private sendKey: Uint8Array,
    private recvKey: Uint8Array,
    private sessionId: Uint8Array,
    private sendDirection: number,
  ) {}

  private aad(direction: number, seq: Buffer) {
    return Buffer.concat([this.sessionId, Buffer.from([direction]), seq]);
  }

  private nonce(seq: Buffer) {
    return Buffer.concat([Buffer.alloc(8), seq]);
  }

  seal(plain: Uint8Array): Buffer {
    const seq = Buffer.alloc(4);
    seq.writeUInt32BE(this.sendSeq++);
    const cipher = createCipheriv("aes-256-gcm", this.sendKey, this.nonce(seq));
    cipher.setAAD(this.aad(this.sendDirection, seq));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([seq, body, cipher.getAuthTag()]);
  }

  open(frame: Uint8Array): Buffer {
    const buf = Buffer.from(frame);
    if (buf.length < 4 + TAG) throw new Error("Frame too short");
    const seq = buf.subarray(0, 4);
    if (seq.readUInt32BE() !== this.recvSeq) throw new Error("Unexpected frame sequence");
    const decipher = createDecipheriv("aes-256-gcm", this.recvKey, this.nonce(seq));
    decipher.setAAD(this.aad(this.sendDirection ^ 1, seq));
    decipher.setAuthTag(buf.subarray(buf.length - TAG));
    try {
      const plain = Buffer.concat([
        decipher.update(buf.subarray(4, buf.length - TAG)),
        decipher.final(),
      ]);
      this.recvSeq++;
      return plain;
    } catch {
      throw new Error("Frame authentication failed");
    }
  }
}
