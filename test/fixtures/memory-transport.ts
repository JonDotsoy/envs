import type { Channel, Endpoint, ShareTransport } from "../../src/share/transport";

/** One end of an in-memory pipe; messages are delivered asynchronously, like a real data channel. */
class MemoryChannel implements Channel {
  remote = "203.0.113.7";
  peer!: MemoryChannel;
  closed = false;
  private handler?: (data: Uint8Array) => void;
  private closeHandlers: Array<() => void> = [];
  private queue: Uint8Array[] = [];
  /** Every message this end received, for tests that assert on the wire. */
  received: Uint8Array[] = [];

  send(data: Uint8Array) {
    if (this.closed) return;
    const copy = new Uint8Array(data);
    setTimeout(() => this.peer.deliver(copy), 0);
  }

  private deliver(data: Uint8Array) {
    if (this.closed) return;
    this.received.push(data);
    if (this.handler) this.handler(data);
    else this.queue.push(data);
  }

  onMessage(handler: (data: Uint8Array) => void) {
    this.handler = handler;
    for (const data of this.queue.splice(0)) handler(data);
  }

  onClose(handler: () => void) {
    this.closeHandlers.push(handler);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
    setTimeout(() => this.peer.close(), 0);
  }
}

export interface MemoryNetwork extends ShareTransport {
  /** Channels created by `connect`, client side. */
  clients: MemoryChannel[];
  /** Ids currently registered by `listen`. */
  readonly listening: string[];
}

/** An in-memory stand-in for PeerJS: `listen` registers an id, `connect` reaches it. */
export function createMemoryNetwork(): MemoryNetwork {
  const hosts = new Map<string, (channel: Channel) => void>();
  const network: MemoryNetwork = {
    clients: [],
    get listening() {
      return [...hosts.keys()];
    },
    async listen(peerId): Promise<Endpoint> {
      let handler: ((channel: Channel) => void) | undefined;
      hosts.set(peerId, (channel) => handler?.(channel));
      return {
        onConnection: (next) => void (handler = next),
        close: () => void hosts.delete(peerId),
      };
    },
    async connect(peerId) {
      const accept = hosts.get(peerId);
      if (!accept) throw new Error("Host not found");
      const client = new MemoryChannel();
      const server = new MemoryChannel();
      client.peer = server;
      server.peer = client;
      network.clients.push(client);
      setTimeout(() => accept(server), 0);
      return client;
    },
  };
  return network;
}
