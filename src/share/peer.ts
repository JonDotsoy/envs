import type { Channel, Endpoint, ListenOptions, ShareTransport } from "./transport";

export const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
];

const OPEN_TIMEOUT_MS = 30_000;

/** Parses `--peer-server https://host:port/path` into PeerJS options (PeerJS Cloud when absent). */
export function peerServerOptions(peerServer?: string) {
  if (!peerServer) return {};
  const url = new URL(peerServer.includes("://") ? peerServer : `https://${peerServer}`);
  const secure = url.protocol === "https:";
  return {
    host: url.hostname,
    port: Number(url.port || (secure ? 443 : 80)),
    path: url.pathname,
    secure,
  };
}

export const toBytes = (data: unknown): Uint8Array =>
  data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new TextEncoder().encode(String(data));

export function withTimeout<T>(promise: Promise<T>, message: string, ms = OPEN_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Best effort: the remote address of the selected ICE pair (not every WebRTC backend exposes stats). */
async function remoteAddress(connection: any): Promise<string | undefined> {
  try {
    const stats: Map<string, any> = await connection.peerConnection.getStats();
    let remoteId: string | undefined;
    for (const report of stats.values()) {
      if (report.type === "candidate-pair" && (report.selected || report.state === "succeeded")) {
        remoteId = report.remoteCandidateId;
      }
    }
    const candidate = remoteId ? stats.get(remoteId) : undefined;
    return candidate?.address ?? candidate?.ip;
  } catch {
    return undefined;
  }
}

function wrap(connection: any): Channel {
  const queue: Uint8Array[] = [];
  let handler: ((data: Uint8Array) => void) | undefined;
  const channel: Channel = {
    send: (data) => connection.send(data),
    onMessage(next) {
      handler = next;
      for (const data of queue.splice(0)) next(data);
    },
    onClose(next) {
      connection.on("close", next);
      connection.on("error", next);
    },
    close: () => connection.close(),
  };
  connection.on("data", (data: unknown) => {
    const bytes = toBytes(data);
    if (handler) handler(bytes);
    else queue.push(bytes);
  });
  void remoteAddress(connection).then((address) => {
    if (address) channel.remote = address;
  });
  return channel;
}

/**
 * All client/server traffic goes through PeerJS (signaling and data channel).
 * PeerJS targets browsers, so node-datachannel's WebRTC polyfill is installed before it is imported.
 */
export async function createPeerTransport(): Promise<ShareTransport> {
  const polyfill: any = await import("node-datachannel/polyfill");
  for (const name of ["RTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate"]) {
    (globalThis as any)[name] ??= polyfill[name];
  }
  const { Peer } = await import("peerjs");

  const options = (peerServer?: string) => ({
    ...peerServerOptions(peerServer),
    debug: 0,
    config: { iceServers: [{ urls: STUN_SERVERS }] },
  });

  const open = (peer: any) =>
    withTimeout(
      new Promise<void>((resolve, reject) => {
        peer.on("open", () => resolve());
        peer.on("error", (error: Error) => reject(error));
      }),
      "Could not reach the PeerJS broker",
    );

  return {
    async listen(peerId: string, { peerServer }: ListenOptions = {}): Promise<Endpoint> {
      const peer = new Peer(peerId, options(peerServer));
      await open(peer);
      return {
        onConnection(handler) {
          peer.on("connection", (connection: any) => {
            connection.on("open", () => handler(wrap(connection)));
          });
        },
        close: () => peer.destroy(),
      };
    },

    async connect(peerId: string, { peerServer }: ListenOptions = {}): Promise<Channel> {
      const peer = new Peer(options(peerServer));
      await open(peer);
      const connection = peer.connect(peerId, { serialization: "raw", reliable: true });
      try {
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            connection.on("open", () => resolve());
            connection.on("error", (error: Error) => reject(error));
            peer.on("error", (error: Error) =>
              reject(error.message.includes("Could not connect") ? new Error("Host not found: the session ended or the link is wrong") : error),
            );
          }),
          "Could not connect to the host (NAT or firewall blocking the direct connection?)",
        );
      } catch (error) {
        peer.destroy();
        throw error;
      }
      const channel = wrap(connection);
      const close = channel.close;
      channel.close = () => {
        close();
        peer.destroy();
      };
      return channel;
    },
  };
}
