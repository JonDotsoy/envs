/** A bidirectional, message-oriented binary pipe between two peers. */
export interface Channel {
  /** Remote IP when the transport can tell; used only for the audit log. */
  remote?: string;
  send(data: Uint8Array): void;
  /** Messages arriving before the handler is attached are delivered once it is. */
  onMessage(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface ListenOptions {
  /** `--peer-server`: a self-hosted peerjs-server; PeerJS Cloud when absent. */
  peerServer?: string;
}

export interface Endpoint {
  onConnection(handler: (channel: Channel) => void): void;
  close(): void;
}

/** Everything the share protocol needs from the network. Implemented over PeerJS in peer.ts; faked in tests. */
export interface ShareTransport {
  /** Registers `peerId` and accepts incoming connections. */
  listen(peerId: string, options?: ListenOptions): Promise<Endpoint>;
  /** Connects to the peer registered as `peerId`. */
  connect(peerId: string, options?: ListenOptions): Promise<Channel>;
}
