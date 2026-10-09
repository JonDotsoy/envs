import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { run, type Context } from "../src/envs";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

/**
 * Real PeerJS + WebRTC (node-datachannel) against a local peerjs-server, so no internet is needed.
 * Skipped when the native addon cannot load on this platform.
 */
let available = true;
try {
  await import("node-datachannel/polyfill");
} catch {
  available = false;
}

let hostWs: Workspace;
let guestWs: Workspace;
let broker: { close(): void } | undefined;
let brokerUrl = "";

function testContext(cwd: string) {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx: Context = {
    cwd,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    openEditor: async () => 0,
    confirm: async () => true,
  };
  return { ctx, logs, errors };
}

beforeAll(async () => {
  hostWs = await createWorkspace();
  guestWs = await createWorkspace();
  for (const ws of [hostWs, guestWs]) await run(["init"], testContext(ws.main).ctx);
  await Bun.write(join(hostWs.main, ".envs/values.yml"), "envs:\n  API_TOKEN:\n    main: p2p-secret\n  REGION:\n    main: eu\n");
  if (!available) return;
  const { PeerServer } = await import("peer");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = PeerServer({ port, host: "127.0.0.1", path: "/" });
  broker = { close: () => (server as any).close?.() };
  brokerUrl = `http://127.0.0.1:${port}/`;
});
afterAll(async () => {
  broker?.close();
  await hostWs.cleanup();
  await guestWs.cleanup();
});

describe("envs share over PeerJS", () => {
  test.skipIf(!available)("shares the main profile through a real data channel", async () => {
    const host = testContext(hostWs.main);
    const exit = run(["share", "--peer-server", brokerUrl], host.ctx);
    const link = await (async () => {
      for (let i = 0; i < 400; i++) {
        const found = host.logs.join("\n").match(/envs:\/\/\S+/)?.[0];
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no link printed: ${host.errors.join("\n")}`);
    })();
    expect(link).toMatch(/^envs:\/\/[a-z2-7]{26}\/sharing-envs\?key=/);

    const guest = testContext(guestWs.main);
    expect(await run(["receive", link], guest.ctx)).toBe(0);
    expect(await exit).toBe(0);

    const merged = Bun.YAML.parse(await Bun.file(join(guestWs.main, ".envs/values.yml")).text()) as any;
    expect(merged.defaults).toEqual({ API_TOKEN: "p2p-secret", REGION: "eu" });
    expect(await Bun.file(join(hostWs.main, ".envs/sharing-envs")).exists()).toBe(false);
    const events = (await Bun.file(join(hostWs.main, ".envs/sharing-connections.ndjson")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    expect(events).toContain("transferred");
  }, 40_000);
});
