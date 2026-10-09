import { randomBytes } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const PEER_ID = /^[a-z2-7]{26}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface ShareLink {
  /** PeerJS id of the primary peer (the host). */
  peerId: string;
  /** 32 random bytes, base64url. Decrypts the payload; never leaves the link. */
  secret: string;
  /** Custom PeerJS broker (`--peer-server`); PeerJS Cloud when absent. */
  peerServer?: string;
}

/** 128 random bits in lowercase base32 (26 chars): a valid PeerJS id and the `<hostname-identified>` of the link. */
export function generatePeerId(): string {
  const bytes = randomBytes(26);
  let id = "";
  for (const byte of bytes) id += BASE32[byte & 31];
  return id;
}

export function buildShareUrl({ peerId, secret, peerServer }: ShareLink): string {
  const query = new URLSearchParams({ key: secret });
  if (peerServer) query.set("server", peerServer);
  return `envs://${peerId}/sharing-envs?${query}`;
}

/** Parses an `envs://<peer-id>/sharing-envs?key=<secret>` link; throws a readable error when malformed. */
export function parseShareUrl(text: string): ShareLink {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error("Invalid link: expected envs://<peer-id>/sharing-envs?key=<secret>");
  }
  if (url.protocol !== "envs:") throw new Error("Invalid link: the scheme must be envs://");
  if (url.pathname !== "/sharing-envs") throw new Error("Invalid link: the path must be /sharing-envs");
  const peerId = url.hostname;
  if (!PEER_ID.test(peerId)) throw new Error("Invalid link: malformed peer id");
  const secret = url.searchParams.get("key") ?? "";
  if (!SECRET.test(secret)) throw new Error("Invalid link: missing or malformed key");
  const peerServer = url.searchParams.get("server") ?? undefined;
  return { peerId, secret, ...(peerServer ? { peerServer } : {}) };
}
