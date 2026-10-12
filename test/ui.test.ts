import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compareStates, run, stateAfter, type Context } from "../src/envs";
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

/** Starts `envs edit --ui` in `cwd`; resolves with its URL and a function that stops it. */
async function startUi(cwd: string, now?: () => Date) {
  let url = "";
  let stop!: () => void;
  const exit = new Promise<void>((resolve) => (stop = resolve));
  const ctx: Context = {
    cwd,
    log: () => {},
    error: () => {},
    openEditor: async () => 0,
    openUrl: async (u) => {
      url = u;
    },
    waitForExit: () => exit,
    now,
  };
  const done = run(["edit", "--ui"], ctx);
  while (!url) await Bun.sleep(20);
  return {
    url,
    stop: async () => {
      stop();
      return await done;
    },
  };
}

describe("history panel endpoints", () => {
  let hws: Workspace;
  let tick = 0;
  /** A clock that advances one minute per call, so hashes are stable. */
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, tick++));
  const historyPath = () => join(hws.main, ".envs/history.ndjson");
  const restoreRequest = (url: string, body: unknown) =>
    fetch(`${url}/api/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  beforeAll(async () => {
    hws = await createWorkspace({ worktrees: ["one"] });
    // 3 points: the initial state (A=1, LOG=info), then A=2, then LOG removed and B added.
    expect(await run(["init"], { cwd: hws.main, log() {}, error() {}, openEditor: async () => 0 })).toBe(0);
    for (const text of ["A=1\nLOG=info\n", "A=2\nLOG=info\n", "A=2\nB=x\n"]) {
      await Bun.write(join(hws.main, ".env"), text);
      expect(await run(["pull"], { cwd: hws.main, log() {}, error() {}, openEditor: async () => 0, now })).toBe(0);
    }
  });
  afterAll(() => hws.cleanup());

  test("GET /api/history lists the points of the history file, oldest first", async () => {
    const ui = await startUi(hws.main, now);
    try {
      const body = (await (await fetch(`${ui.url}/api/history`)).json()) as any;
      expect(body.enabled).toBe(true);
      expect(body.points).toHaveLength(3);
      const lines = (await Bun.file(historyPath()).text()).trim().split("\n").map((l) => JSON.parse(l));
      expect(body.points).toEqual(lines);
      expect(body.points[1].prev).toBe(body.points[0].hash);
      expect(body.points).toMatchSnapshot();

      // What the panel shows for the first point, from these two responses: A would change (green),
      // B would be removed (red) and LOG would be added (green, labelled added).
      const current = (await (await fetch(`${ui.url}/api/values`)).json()) as any;
      const diff = compareStates(current, stateAfter(body.points, body.points[0]));
      expect(diff.uses).toEqual([]);
      expect(diff.profiles).toEqual([
        {
          name: "default",
          defaults: [],
          envs: [
            { kind: "changed", key: "A", worktree: "main", current: 2, target: 1 },
            { kind: "removed", key: "B", worktree: "main", current: "x" },
            { kind: "added", key: "LOG", worktree: "main", target: "info" },
          ],
        },
      ]);
      // The newest point is the current state: no differences.
      expect(compareStates(current, stateAfter(body.points, body.points.at(-1))).same).toBe(true);
    } finally {
      expect(await ui.stop()).toBe(0);
    }
  });

  test("POST /api/restore validates the hash", async () => {
    const ui = await startUi(hws.main, now);
    try {
      const before = await Bun.file(historyPath()).text();
      for (const body of ["{}", "not json", { hash: 1 }, { hash: "abc" }, { hash: "ZZZZZZZZZZZZ" }, { hash: "../../etc/pa" }]) {
        expect((await restoreRequest(ui.url, body)).status).toBe(400);
      }
      expect((await restoreRequest(ui.url, { hash: "000000000000" })).status).toBe(404);
      expect(await Bun.file(historyPath()).text()).toBe(before);
    } finally {
      expect(await ui.stop()).toBe(0);
    }
  });

  test("POST /api/restore restores a point and appends exactly one point", async () => {
    const ui = await startUi(hws.main, now);
    try {
      const before = await Bun.file(historyPath()).text();
      const points = before.trim().split("\n").map((l) => JSON.parse(l));
      const res = await restoreRequest(ui.url, { hash: points[0].hash });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.errors).toEqual([]);
      expect(body.logs[0]).toContain(`restored ${points[0].hash}`);

      const after = await Bun.file(historyPath()).text();
      // The previous lines are untouched byte for byte; one line is added and chains to the last.
      expect(after.startsWith(before)).toBe(true);
      const added = after.slice(before.length).trim().split("\n");
      expect(added).toHaveLength(1);
      const point = JSON.parse(added[0]!);
      expect(point.prev).toBe(points.at(-1).hash);
      expect(point.changes).toMatchSnapshot();

      // values.yml, the editor state, the history list and the .env files follow the restored state.
      const state = (await (await fetch(`${ui.url}/api/values`)).json()) as any;
      expect(state.profiles.default.envs.A).toEqual({ main: 1 });
      expect(state.profiles.default.envs.LOG).toEqual({ main: "info" });
      expect(state.profiles.default.envs.B).toBeUndefined();
      const history = (await (await fetch(`${ui.url}/api/history`)).json()) as any;
      expect(history.points).toHaveLength(4);
      // push also removes the variables envs manages that the restored state no longer has: B is gone.
      expect(await Bun.file(join(hws.main, ".env")).text()).toBe("A=1\nLOG=info\n");
    } finally {
      expect(await ui.stop()).toBe(0);
    }
  });

  test("with the history off the list is empty and restore is refused", async () => {
    const off = await createWorkspace({ worktrees: [] });
    try {
      await Bun.write(join(off.main, ".env"), "A=1\n");
      const quiet: Context = { cwd: off.main, log() {}, error() {}, openEditor: async () => 0 };
      expect(await run(["config", "set", "history", "false"], quiet)).toBe(0);
      const ui = await startUi(off.main);
      try {
        expect(await (await fetch(`${ui.url}/api/history`)).json()).toEqual({ enabled: false, points: [] });
        expect((await restoreRequest(ui.url, { hash: "000000000000" })).status).toBe(409);
      } finally {
        expect(await ui.stop()).toBe(0);
      }
    } finally {
      await off.cleanup();
    }
  });

  test("an empty history lists no points", async () => {
    const empty = await createWorkspace({ worktrees: [] });
    try {
      const ui = await startUi(empty.main);
      try {
        // The first pull of `edit` created the file; an empty (or missing) file has no points.
        await Bun.write(join(empty.main, ".envs/history.ndjson"), "");
        expect(await (await fetch(`${ui.url}/api/history`)).json()).toEqual({ enabled: true, points: [] });
      } finally {
        expect(await ui.stop()).toBe(0);
      }
    } finally {
      await empty.cleanup();
    }
  });
});
