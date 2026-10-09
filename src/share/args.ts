export interface ShareArgs {
  maxPeers: number;
  /** Session lifetime in milliseconds (the flag is in minutes). */
  ttlMs: number;
  peerServer?: string;
}

export interface ReceiveArgs {
  url: string;
  force: boolean;
}

function positive(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

export function parseShareArgs(args: string[]): ShareArgs {
  const parsed: ShareArgs = { maxPeers: 1, ttlMs: 10 * 60_000 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--max-peers") {
      parsed.maxPeers = Math.floor(positive(arg, args[++i]));
    } else if (arg === "--ttl") {
      parsed.ttlMs = positive(arg, args[++i]) * 60_000;
    } else if (arg === "--peer-server") {
      const server = args[++i];
      if (!server) throw new Error("--peer-server needs a URL");
      parsed.peerServer = server;
    } else {
      throw new Error(`Unknown option for share: ${arg}`);
    }
  }
  if (parsed.maxPeers < 1) throw new Error("--max-peers needs a positive number");
  return parsed;
}

export function parseReceiveArgs(args: string[]): ReceiveArgs {
  let url: string | undefined;
  let force = false;
  for (const arg of args) {
    if (arg === "--force") force = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option for receive: ${arg}`);
    else if (url === undefined) url = arg;
    else throw new Error("receive takes a single link");
  }
  if (!url) throw new Error("Usage: envs receive <envs://…link> [--force]");
  return { url, force };
}
