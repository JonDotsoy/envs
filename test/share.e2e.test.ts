import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { run, type Context } from "../src/envs";
import { runShare } from "../src/share/host";
import { buildShareUrl, parseShareUrl } from "../src/share/url";
import { generateSecret } from "../src/share/crypto";
import type { ShareTransport } from "../src/share/transport";
import { createWorkspace, type Workspace } from "./fixtures/workspace";
import { createMemoryNetwork } from "./fixtures/memory-transport";

const HOST_VALUES = `defaults:
  A: "1"
envs:
  SECRET_TOKEN:
    main: s3cr3t-value
  A:
    main: from-main
  ONLY_OTHER:
    other: nope
`;

let hostWs: Workspace;
let guestWs: Workspace;

function testContext(cwd: string, transport: ShareTransport, overrides: Partial<Context> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx: Context = {
    cwd,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    openEditor: async () => 0,
    confirm: async () => true,
    shareTransport: async () => transport,
    ...overrides,
  };
  return { ctx, logs, errors };
}

async function waitFor<T>(read: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

const linkOf = (logs: string[]) => logs.join("\n").match(/envs:\/\/\S+/)?.[0];

async function audit(root: string) {
  const text = await Bun.file(join(root, ".envs/sharing-connections.ndjson")).text();
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
}

async function reset() {
  for (const ws of [hostWs, guestWs]) {
    await Bun.write(join(ws.main, ".envs/values.yml"), ws === hostWs ? HOST_VALUES : "");
    await Bun.write(join(ws.main, ".envs/sharing-connections.ndjson"), "");
  }
}

beforeAll(async () => {
  hostWs = await createWorkspace();
  guestWs = await createWorkspace();
  for (const ws of [hostWs, guestWs]) {
    await run(["init"], testContext(ws.main, createMemoryNetwork()).ctx);
  }
});
afterAll(async () => {
  await hostWs.cleanup();
  await guestWs.cleanup();
});
beforeEach(async () => {
  delete process.env.NO_COLOR;
  await reset();
});

/** Starts `envs share` and resolves once the link is printed. */
async function startShare(network: ShareTransport, args: string[] = [], overrides: Partial<Context> = {}) {
  const host = testContext(hostWs.main, network, overrides);
  const exit = run(["share", ...args], host.ctx);
  const link = await waitFor(() => linkOf(host.logs));
  return { ...host, exit, link };
}

describe("envs share / envs receive", () => {
  test("transfers the main profile end to end and cleans up", async () => {
    const network = createMemoryNetwork();
    const host = await startShare(network);

    // While the session is open the sharing file exists, is private and holds no plaintext.
    const file = join(hostWs.main, ".envs/sharing-envs");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const onDisk = Buffer.from(await Bun.file(file).arrayBuffer());
    expect(onDisk.includes(Buffer.from("s3cr3t-value"))).toBe(false);

    const guest = testContext(guestWs.main, network);
    expect(await run(["receive", host.link], guest.ctx)).toBe(0);
    expect(await host.exit).toBe(0);

    const merged = Bun.YAML.parse(await Bun.file(join(guestWs.main, ".envs/values.yml")).text()) as any;
    expect(merged.defaults).toEqual({ A: "from-main", SECRET_TOKEN: "s3cr3t-value" });
    expect(await Bun.file(file).exists()).toBe(false);
    expect(network.listening).toEqual([]);

    // No plaintext values on the wire (outer AEAD) and none in the audit log.
    const wire = Buffer.concat(network.clients.flatMap((c) => c.received));
    expect(wire.includes(Buffer.from("s3cr3t-value"))).toBe(false);
    const secret = parseShareUrl(host.link).secret;
    const log = await Bun.file(join(hostWs.main, ".envs/sharing-connections.ndjson")).text();
    expect(log.includes(secret)).toBe(false);
    expect(log.includes("s3cr3t-value")).toBe(false);
    expect(log.includes("SECRET_TOKEN")).toBe(false);

    const events = (await audit(hostWs.main)).map((e) => e.event);
    expect(events).toEqual(["session_started", "connection_opened", "auth_ok", "transferred", "session_ended"]);
    const transferred = (await audit(hostWs.main)).find((e) => e.event === "transferred")!;
    expect(transferred).toMatchObject({ v: 1, keys: 2, remote: expect.any(String) });
    expect(transferred.peer).toMatch(/^p_[0-9a-f]{8}$/);
  });

  test("shows the precautions and needs an explicit y/yes before listening", async () => {
    const network = createMemoryNetwork();
    const host = testContext(hostWs.main, network, { confirm: async () => false });
    expect(await run(["share"], host.ctx)).toBe(1);
    const output = host.logs.join("\n");
    expect(output).toContain("WARNING");
    expect(output).toContain("treat it like a password");
    expect(host.errors.join("\n")).toContain("Aborted");
    expect(network.listening).toEqual([]);
    expect(await Bun.file(join(hostWs.main, ".envs/sharing-envs")).exists()).toBe(false);
  });

  test("a wrong key is rejected, audited, and does not end the session", async () => {
    const network = createMemoryNetwork();
    const host = await startShare(network, ["--max-peers", "2"]);
    const wrong = buildShareUrl({ ...parseShareUrl(host.link), secret: generateSecret() });

    const bad = testContext(guestWs.main, network);
    expect(await run(["receive", wrong], bad.ctx)).toBe(1);
    expect(bad.errors.join("\n")).toContain("closed the connection");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await audit(hostWs.main)).some((e) => e.event === "auth_failed" && e.reason === "bad_mac")).toBe(true);
    expect(network.listening).toHaveLength(1);

    // The right key still works afterwards.
    const good = testContext(guestWs.main, network);
    expect(await run(["receive", host.link], good.ctx)).toBe(0);
    // One of the two slots is still open; close the session as Ctrl+C would.
    process.emit("SIGINT");
    expect(await host.exit).toBe(0);
    expect(await Bun.file(join(hostWs.main, ".envs/sharing-envs")).exists()).toBe(false);
  });

  test("a replayed HELLO is rejected", async () => {
    const network = createMemoryNetwork();
    const host = await startShare(network, ["--max-peers", "2"]);
    expect(await run(["receive", host.link], testContext(guestWs.main, network).ctx)).toBe(0);
    // The HELLO the host saw is valid (right mac) but its nonce was already used.
    const hello = (network.clients[0] as any).peer.received.find((frame: Uint8Array) => frame[0] === 0x01);
    const attacker = await network.connect(parseShareUrl(host.link).peerId);
    let closed = false;
    attacker.onClose(() => (closed = true));
    attacker.send(hello);
    await waitFor(() => closed);
    expect((await audit(hostWs.main)).some((e) => e.event === "auth_failed" && e.reason === "replay")).toBe(true);
    process.emit("SIGINT");
    expect(await host.exit).toBe(0);
  });

  test("closes the session after three failed authentications", async () => {
    const network = createMemoryNetwork();
    const host = await startShare(network);
    const wrong = buildShareUrl({ ...parseShareUrl(host.link), secret: generateSecret() });
    for (let i = 0; i < 3; i++) {
      await run(["receive", wrong], testContext(guestWs.main, network).ctx);
    }
    expect(await host.exit).toBe(1);
    expect((await audit(hostWs.main)).at(-1)).toMatchObject({ event: "session_ended", reason: "too_many_failures" });
    expect(network.listening).toEqual([]);
  });

  test("the link is single use by default and can be raised with --max-peers", async () => {
    const network = createMemoryNetwork();
    const host = await startShare(network, ["--max-peers", "2"]);
    for (let i = 0; i < 2; i++) {
      const guest = testContext(guestWs.main, network);
      expect(await run(["receive", host.link, "--force"], guest.ctx)).toBe(0);
    }
    expect(await host.exit).toBe(0);
    const late = testContext(guestWs.main, network);
    expect(await run(["receive", host.link], late.ctx)).toBe(1);
    expect(late.errors.join("\n")).toContain("Could not connect");
  });

  test("the link expires after the ttl", async () => {
    const network = createMemoryNetwork();
    const host = testContext(hostWs.main, network);
    expect(await run(["share", "--ttl", "0.001"], host.ctx)).toBe(1);
    expect(host.errors.join("\n")).toContain("expired");
    expect(await Bun.file(join(hostWs.main, ".envs/sharing-envs")).exists()).toBe(false);
    expect((await audit(hostWs.main)).at(-1)).toMatchObject({ event: "session_ended", reason: "expired" });
  });

  test("receive keeps conflicting values unless --force", async () => {
    await Bun.write(join(guestWs.main, ".envs/values.yml"), 'defaults:\n  A: mine\n  KEEP: me\n');
    const network = createMemoryNetwork();
    let host = await startShare(network);
    const guest = testContext(guestWs.main, network);
    expect(await run(["receive", host.link], guest.ctx)).toBe(0);
    await host.exit;
    expect(guest.logs.join("\n")).toContain("1 new, 0 overwritten, 0 unchanged, 1 conflicting");
    let merged = Bun.YAML.parse(await Bun.file(join(guestWs.main, ".envs/values.yml")).text()) as any;
    expect(merged.defaults).toEqual({ A: "mine", KEEP: "me", SECRET_TOKEN: "s3cr3t-value" });

    host = await startShare(network);
    expect(await run(["receive", host.link, "--force"], testContext(guestWs.main, network).ctx)).toBe(0);
    await host.exit;
    merged = Bun.YAML.parse(await Bun.file(join(guestWs.main, ".envs/values.yml")).text()) as any;
    expect(merged.defaults.A).toBe("from-main");
  });

  test("declining the merge leaves values.yml untouched", async () => {
    const network = createMemoryNetwork();
    const host = await startShare(network);
    const guest = testContext(guestWs.main, network, { confirm: async () => false });
    expect(await run(["receive", host.link], guest.ctx)).toBe(1);
    await host.exit;
    expect(await Bun.file(join(guestWs.main, ".envs/values.yml")).text()).toBe("");
  });

  test("tampered data on the wire is detected by the client", async () => {
    const network = createMemoryNetwork();
    const host = await startShare(network);
    const tampering: ShareTransport = {
      listen: network.listen,
      async connect(peerId, options) {
        const channel = await network.connect(peerId, options);
        const onMessage = channel.onMessage.bind(channel);
        channel.onMessage = (handler) =>
          onMessage((data) => {
            if (data[0] === 0x03) {
              const copy = new Uint8Array(data);
              copy[copy.length - 1]! ^= 1;
              return handler(copy);
            }
            handler(data);
          });
        return channel;
      },
    };
    const guest = testContext(guestWs.main, tampering);
    expect(await run(["receive", host.link], guest.ctx)).toBe(1);
    expect(guest.errors.join("\n")).toContain("authentication failed");
    process.emit("SIGINT");
    await host.exit;
    expect(await Bun.file(join(guestWs.main, ".envs/values.yml")).text()).toBe("");
  });

  test("refuses to share when the main profile is empty", async () => {
    await Bun.write(join(hostWs.main, ".envs/values.yml"), "envs:\n  X:\n    other: 1\n");
    const host = testContext(hostWs.main, createMemoryNetwork());
    expect(await run(["share"], host.ctx)).toBe(1);
    expect(host.errors.join("\n")).toContain('no variables to share');
  });

  test("reports bad usage", async () => {
    const network = createMemoryNetwork();
    const share = testContext(hostWs.main, network);
    expect(await run(["share", "--nope"], share.ctx)).toBe(1);
    expect(share.errors.join("\n")).toContain("Unknown option");
    const receive = testContext(guestWs.main, network);
    expect(await run(["receive", "envs://nope"], receive.ctx)).toBe(1);
    expect(receive.errors.join("\n")).toContain("Invalid link");
    expect(await run(["receive"], receive.ctx)).toBe(1);
  });

  test("runShare returns when its abort signal fires", async () => {
    const network = createMemoryNetwork();
    const host = testContext(hostWs.main, network);
    const abort = new AbortController();
    const exit = runShare(host.ctx, { root: hostWs.main, values: Bun.YAML.parse(HOST_VALUES) as any }, [], async () => network, abort.signal);
    await waitFor(() => linkOf(host.logs));
    abort.abort();
    expect(await exit).toBe(0);
    expect(network.listening).toEqual([]);
  });
});
