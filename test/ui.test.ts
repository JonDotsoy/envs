import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { run, type Context } from "../src/envs";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

let ws: Workspace;
beforeAll(async () => {
  ws = await createWorkspace({ worktrees: ["one"], files: {} });
});
afterAll(() => ws.cleanup());

test("edit --ui serves the values and Save writes values.yml and pushes", async () => {
  await Bun.write(join(ws.main, ".env"), "A=1\n");
  const logs: string[] = [];
  let url = "";
  let stop!: () => void;
  const exit = new Promise<void>((resolve) => (stop = resolve));
  const ctx: Context = {
    cwd: ws.main,
    log: (m) => logs.push(m),
    error: (m) => logs.push(m),
    openEditor: async () => 0,
    openUrl: async (u) => {
      url = u;
    },
    waitForExit: () => exit,
  };
  const done = run(["edit", "--ui"], ctx);
  while (!url) await Bun.sleep(20);

  const html = await (await fetch(url)).text();
  expect(html).toContain('<div id="root">');
  const state = (await (await fetch(`${url}/api/values`)).json()) as any;
  expect(state.profiles.default.envs.A).toBeDefined();
  expect(state.worktrees).toContain("one");

  const bad = await fetch(`${url}/api/values`, { method: "PUT", body: "{}" });
  expect(bad.status).toBe(400);

  const res = await fetch(`${url}/api/values`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uses: {},
      profiles: { default: { defaults: { A: "2", B: "x" }, envs: {} } },
    }),
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).ok).toBe(true);
  expect(await Bun.file(join(ws.main, ".env")).text()).toBe("A=2\nB=x\n");
  expect(await Bun.file(join(ws.worktrees.one!, ".env")).text()).toBe("A=2\nB=x\n");

  stop();
  expect(await done).toBe(0);
});
