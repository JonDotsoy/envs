import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import { compareStates, run, stateAfter, type Context } from "../src/envs";
import { MAX_BODY_BYTES } from "../src/ui/server";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

const realFetch = globalThis.fetch;
let uiToken = "";
/** fetch that presents the editor's token, as the browser does with the cookie it gets from the URL. */
const fetch = ((input: string | URL | Request, init: RequestInit = {}) =>
  realFetch(input, { ...init, headers: { "x-envs-token": uiToken, ...(init.headers as Record<string, string>) } })) as typeof globalThis.fetch;
/** Visits the URL `envs edit --ui` opens, as the browser does: the token in it is traded for the session cookie. Returns the plain origin. */
const split = async (opened: string) => {
  const parsed = new URL(opened);
  uiToken = await redeem(opened);
  return parsed.origin;
};
/** Trades the single-use token in the URL for the session secret (the cookie's value). */
const redeem = async (opened: string) =>
  (await realFetch(opened, { redirect: "manual" })).headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";

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
  url = await split(url);

  const html = await (await fetch(url)).text();
  expect(html).toContain('<div id="root">');
  const state = (await (await fetch(`${url}/api/values`)).json()) as any;
  expect(state.profiles.default.envs.A).toBeDefined();
  expect(state.worktrees).toContain("one");

  const bad = await fetch(`${url}/api/values`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
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
  url = await split(url);
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

describe("resync points in the history list", () => {
  test("GET /api/history exposes `resync` so the panel can tag the point as external", async () => {
    const rws = await createWorkspace({ worktrees: [] });
    try {
      const quiet = { cwd: rws.main, log() {}, error() {}, openEditor: async () => 0 };
      await Bun.write(join(rws.main, ".env"), "A=1\n");
      expect(await run(["init"], quiet)).toBe(0);
      expect(await run(["pull"], quiet)).toBe(0);
      // A manual edit of values.yml, then the next command that records a point.
      const file = join(rws.main, ".envs/values.yml");
      const values = Bun.YAML.parse(await Bun.file(file).text()) as any;
      values.profiles.default.defaults.MANUAL = "by-hand";
      await Bun.write(file, Bun.YAML.stringify(values));
      await Bun.write(join(rws.main, ".env"), "A=2\n");
      expect(await run(["pull"], quiet)).toBe(0);

      const ui = await startUi(rws.main);
      try {
        const body = (await (await fetch(`${ui.url}/api/history`)).json()) as any;
        expect(body.points.map((p: any) => p.resync)).toEqual([undefined, true, undefined]);
        expect(body.points[1].changes).toEqual([{ path: ["profiles", "default", "defaults", "MANUAL"], to: "by-hand" }]);
      } finally {
        await ui.stop();
      }
    } finally {
      await rws.cleanup();
    }
  });
});

describe("web editor access control", () => {
  const SECRET = "demo-not-a-real-token";
  let aws: Workspace;
  beforeAll(async () => {
    aws = await createWorkspace({ worktrees: [] });
    await Bun.write(join(aws.main, ".env"), `API_TOKEN=${SECRET}\nPORT=3000\n`);
    const quiet = { cwd: aws.main, log() {}, error() {}, openEditor: async () => 0 };
    await run(["init"], quiet);
    await run(["pull"], quiet);
  });
  afterAll(() => aws.cleanup());

  /** Starts the editor and also returns the URL exactly as it is opened (with the token). */
  async function open({ redeemed = true } = {}) {
    let opened = "";
    const logs: string[] = [];
    let stop!: () => void;
    const exit = new Promise<void>((resolve) => (stop = resolve));
    const done = run(["edit", "--ui"], {
      cwd: aws.main,
      log: (m) => logs.push(m),
      error: () => {},
      openEditor: async () => 0,
      openUrl: async (u) => {
        opened = u;
      },
      waitForExit: () => exit,
    });
    while (!opened) await Bun.sleep(20);
    const parsed = new URL(opened);
    return {
      opened,
      logs,
      origin: parsed.origin,
      host: parsed.host,
      port: parsed.port,
      urlToken: parsed.searchParams.get("token")!,
      /** The session secret the URL's token was traded for (empty when \`redeemed\` is false). */
      token: redeemed ? await redeem(opened) : "",
      stop: async () => (stop(), await done),
    };
  }

  test("the opened URL carries a random token, different on every run", async () => {
    const a = await open();
    await a.stop();
    const b = await open();
    await b.stop();
    expect(a.urlToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.urlToken).not.toBe(b.urlToken);
  });

  test("without the token (or with a wrong one) every route answers 401 and reveals nothing", async () => {
    const ui = await open();
    try {
      for (const headers of [{}, { "x-envs-token": "wrong" }, { "x-envs-token": ui.token.slice(0, -1) + (ui.token.endsWith("x") ? "y" : "x") }] as Record<string, string>[]) {
        for (const path of ["/", "/api/values", "/api/history", "/index.html"]) {
          const res = await realFetch(ui.origin + path, { headers });
          expect(res.status).toBe(401);
          expect(await res.text()).not.toContain(SECRET);
        }
        const put = await realFetch(ui.origin + "/api/values", {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ uses: {}, profiles: { default: { defaults: { PORT: "1" }, envs: {} } } }),
        });
        expect(put.status).toBe(401);
        const restore = await realFetch(ui.origin + "/api/restore", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ hash: "0123456789ab" }),
        });
        expect(restore.status).toBe(401);
      }
      expect(await Bun.file(join(aws.main, ".env")).text()).toBe(`API_TOKEN=${SECRET}\nPORT=3000\n`);
    } finally {
      await ui.stop();
    }
  });

  test("the URL's token is traded for an HttpOnly SameSite=Strict cookie, and the cookie alone gives access", async () => {
    const ui = await open({ redeemed: false });
    try {
      const first = await realFetch(ui.opened, { redirect: "manual" });
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toBe("/");
      const cookie = first.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const pair = cookie.split(";")[0]!;
      const page = await realFetch(ui.origin + "/", { headers: { cookie: pair } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="root">');
      const values = await realFetch(ui.origin + "/api/values", { headers: { cookie: pair } });
      expect(values.status).toBe(200);
      // The token is single-use: the session secret is not the URL's token, and the URL no longer works.
      expect(pair).not.toContain(ui.urlToken);
      const again = await realFetch(ui.opened, { redirect: "manual" });
      expect(again.status).toBe(401);
      expect(again.headers.get("set-cookie")).toBeNull();
      expect((await realFetch(ui.origin + "/api/values", { headers: { "x-envs-token": ui.urlToken } })).status).toBe(401);
      // Using the token printed a fresh single-use URL, which works once and gives the same session.
      const next = ui.logs.map((l) => l.match(/New single-use URL: (\S+)/)?.[1]).find(Boolean)!;
      expect(next).toBeTruthy();
      expect(new URL(next).searchParams.get("token")).not.toBe(ui.urlToken);
      const second = await realFetch(next, { redirect: "manual" });
      expect(second.status).toBe(302);
      expect(second.headers.get("set-cookie")!.split(";")[0]).toBe(pair);
      expect((await realFetch(next, { redirect: "manual" })).status).toBe(401);
      // A wrong token in the URL gets no cookie.
      const bad = await realFetch(ui.origin + "/?token=nope", { redirect: "manual" });
      expect(bad.status).toBe(401);
      expect(bad.headers.get("set-cookie")).toBeNull();
    } finally {
      await ui.stop();
    }
  });

  test("a foreign Host (DNS rebinding) is refused with 421 even with a valid token; localhost is accepted", async () => {
    const ui = await open();
    try {
      const status = async (host: string, path = "/api/values") =>
        (await $`curl -s -o /dev/null -w %{http_code} -H ${"Host: " + host} -H ${"x-envs-token: " + ui.token} ${ui.origin + path}`.text());
      expect(await status(`evil.example:${ui.port}`)).toBe("421");
      expect(await status("evil.example")).toBe("421");
      expect(await status(`127.0.0.1:${Number(ui.port) + 1}`)).toBe("421");
      expect(await status(`evil.example:${ui.port}`, "/api/history")).toBe("421");
      expect(await status(`127.0.0.1:${ui.port}`)).toBe("200");
      expect(await status(`localhost:${ui.port}`)).toBe("200");
    } finally {
      await ui.stop();
    }
  });

  test("a foreign Origin is refused with 403, for reads and writes, even with a valid token", async () => {
    const ui = await open();
    try {
      const call = (origin: string, init: RequestInit = {}) =>
        realFetch(ui.origin + "/api/values", {
          ...init,
          headers: { "x-envs-token": ui.token, "content-type": "application/json", origin, ...(init.headers as object) },
        });
      expect((await call("http://evil.example")).status).toBe(403);
      expect((await call("null")).status).toBe(403);
      expect((await call(`http://evil.example:${ui.port}`)).status).toBe(403);
      expect((await call("http://evil.example", { method: "PUT", body: "{}" })).status).toBe(403);
      expect((await call(ui.origin)).status).toBe(200);
      expect((await call(`http://localhost:${ui.port}`)).status).toBe(200);
    } finally {
      await ui.stop();
    }
  });

  test("a body that is not application/json is refused with 415 (a cross-site form or a simple request)", async () => {
    const ui = await open();
    try {
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
        const res = await realFetch(ui.origin + "/api/values", {
          method: "PUT",
          headers: { "x-envs-token": ui.token, "content-type": type },
          body: JSON.stringify({ uses: {}, profiles: { default: { defaults: { PORT: "1" }, envs: {} } } }),
        });
        expect(res.status).toBe(415);
      }
      const noType = await realFetch(ui.origin + "/api/restore", {
        method: "POST",
        headers: { "x-envs-token": ui.token },
        body: JSON.stringify({ hash: "0123456789ab" }),
      });
      expect(noType.status).toBe(415);
      expect(await Bun.file(join(aws.main, ".env")).text()).toBe(`API_TOKEN=${SECRET}\nPORT=3000\n`);
    } finally {
      await ui.stop();
    }
  });

  test("the server never answers CORS preflights, so no other site can send a JSON write", async () => {
    const ui = await open();
    try {
      const res = await realFetch(ui.origin + "/api/values", {
        method: "OPTIONS",
        headers: { origin: "http://evil.example", "access-control-request-method": "PUT" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await ui.stop();
    }
  });

  test("a request body over the limit is refused with 413 and changes nothing; one under it is accepted", async () => {
    const ui = await open();
    try {
      const put = (value: string) =>
        realFetch(ui.origin + "/api/values", {
          method: "PUT",
          headers: { "x-envs-token": ui.token, "content-type": "application/json" },
          body: JSON.stringify({ uses: {}, profiles: { default: { defaults: { BIG: value }, envs: {} } } }),
        });
      const over = await put("x".repeat(MAX_BODY_BYTES));
      expect(over.status).toBe(413);
      // Also refused when the token is missing: the limit applies before anything is read.
      const anon = await realFetch(ui.origin + "/api/values", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "x".repeat(MAX_BODY_BYTES + 1),
      });
      expect(anon.status).toBe(413);
      expect(await Bun.file(join(aws.main, ".envs/values.yml")).text()).not.toContain("BIG");
      const under = await put("x".repeat(100_000));
      expect(under.status).toBe(200);
    } finally {
      await ui.stop();
    }
  });

  test("PUT with a stale `version` is refused with 409 and writes nothing; the current version saves", async () => {
    const ui = await open();
    try {
      const state: any = await (await realFetch(ui.origin + "/api/values", { headers: { "x-envs-token": ui.token } })).json();
      expect(state.version).toMatch(/^[0-9a-f]{12}$/);
      const { worktrees: _, ...body } = state;
      const put = (version: string) =>
        realFetch(ui.origin + "/api/values", {
          method: "PUT",
          headers: { "x-envs-token": ui.token, "content-type": "application/json" },
          body: JSON.stringify({ ...body, version }),
        });
      const before = await Bun.file(join(aws.main, ".envs/values.yml")).text();
      const stale = await put("000000000000");
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as any).errors[0]).toContain("changed after the editor was loaded");
      expect(await Bun.file(join(aws.main, ".envs/values.yml")).text()).toBe(before);
      body.profiles.default.defaults.CHANGED = String(Date.now());
      expect((await put(state.version)).status).toBe(200);
      // The save changed values.yml, so the same version is stale now.
      expect((await put(state.version)).status).toBe(409);
      // A version of the wrong type is a bad request.
      const bad = await realFetch(ui.origin + "/api/values", {
        method: "PUT",
        headers: { "x-envs-token": ui.token, "content-type": "application/json" },
        body: JSON.stringify({ ...body, version: 5 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await ui.stop();
    }
  });
});

