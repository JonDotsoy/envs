/**
 * Regression tests for the findings of the audit of the history feature (H01…H34): one test per
 * finding, each asserting the correct behavior. They were written first as known issues (failing on
 * purpose) and turned into regular tests as each gap was fixed; every title says "(fixed)", or
 * "(reported)" for H11, which is by design (a default applies to every worktree) and is now explained
 * by `pull` instead of surprising later.
 *
 * Not reproduced here: H30 (ruled out by the audit). The races between real processes are in
 * test/concurrency.test.ts; H15 and H16 are also reproduced here in-process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { appendFile, chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  applyChanges,
  compareStates,
  loadUiHistory,
  loadUiState,
  normalizeValues,
  parseDotenv,
  readHistoryPoints,
  recordHistory,
  redactForHistory,
  run,
  saveUiState,
  type Context,
  type NormalizedValues,
} from "../src/envs";
import { fromVarRows, toVarRows } from "../src/ui/rows";
import { serveUi } from "../src/ui/server";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

// ── Demo project ─────────────────────────────────────────────────────────────────────────────

const env = (port: number) =>
  `DATABASE_URL=postgres://localhost/shop\nPORT=${port}\nLOG_LEVEL=info\nDEBUG=false\nFEATURE_CHECKOUT=off\nAPI_TOKEN=demo-not-a-real-token\n`;

interface Demo {
  ws: Workspace;
  main: string;
  checkout: string;
  login: string;
  values: string;
  history: string;
  /** Runs a command in-process from `cwd` (default: the main workspace) with a fixed clock. */
  cmd(args: string[], opts?: { cwd?: string; openEditor?: Context["openEditor"] }): Promise<{ code: number | "threw"; out: string }>;
  text(): Promise<string>;
  dotenv(dir: string): Promise<string>;
}

const created: Workspace[] = [];

/** A project with three worktrees (main, feature-checkout, fix-login), initialized and pulled once. */
async function demo(options: { init?: boolean } = {}): Promise<Demo> {
  const ws = await createWorkspace({ worktrees: ["feature-checkout", "fix-login"] });
  created.push(ws);
  const main = ws.main;
  const checkout = ws.worktrees["feature-checkout"]!;
  const login = ws.worktrees["fix-login"]!;
  await Bun.write(join(main, ".env"), env(3000));
  await Bun.write(join(checkout, ".env"), env(3001));
  await Bun.write(join(login, ".env"), env(3002));
  let tick = 0;
  const d: Demo = {
    ws,
    main,
    checkout,
    login,
    values: join(main, ".envs/values.yml"),
    history: join(main, ".envs/history.ndjson"),
    async cmd(args, opts = {}) {
      const logs: string[] = [];
      const ctx: Context = {
        cwd: opts.cwd ?? main,
        log: (m) => logs.push(m),
        error: (m) => logs.push(m),
        openEditor: opts.openEditor ?? (async () => 0),
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
      };
      const code = await run(args, ctx).catch((e) => {
        logs.push(String(e));
        return "threw" as const;
      });
      return { code, out: logs.join("\n") };
    },
    text: () => Bun.file(join(main, ".envs/values.yml")).text(),
    dotenv: (dir) => Bun.file(join(dir, ".env")).text(),
  };
  if (options.init !== false) {
    await d.cmd(["init"]);
    await d.cmd(["pull"]);
  }
  return d;
}

const snapshotOf = async (d: Demo) =>
  normalizeValues((Bun.YAML.parse(await d.text()) ?? {}) as never) as NormalizedValues;

/** values.yml as the history stores it (secrets redacted), to compare with a replay. */
const storedSnapshotOf = async (d: Demo) => redactForHistory(d.main, await snapshotOf(d));

/** The state obtained by applying every history point in order. */
const replayOf = async (d: Demo): Promise<NormalizedValues> => {
  const state: NormalizedValues = { uses: {}, profiles: {} };
  for (const point of await readHistoryPoints(d.main)) applyChanges(state, point.changes);
  return state;
};

/** Canonical form to compare states: sorted keys, no empty variables. */
const canon = (v: NormalizedValues) => {
  const sort = (o: any): any =>
    typeof o !== "object" || o === null ? o : Object.fromEntries(Object.keys(o).sort().map((k) => [k, sort(o[k])]));
  const profiles: any = {};
  for (const [name, p] of Object.entries(v.profiles)) {
    profiles[name] = { defaults: p.defaults, envs: Object.fromEntries(Object.entries(p.envs).filter(([, b]) => Object.keys(b).length)) };
  }
  return JSON.stringify(sort({ uses: v.uses, profiles }));
};

/** What the web editor sends on Save: the real table functions of the page, every value as text. */
const uiPayload = (state: NormalizedValues): NormalizedValues => {
  const profiles: any = {};
  for (const [name, profile] of Object.entries(state.profiles)) profiles[name] = fromVarRows(toVarRows(profile));
  return { uses: { ...state.uses }, profiles };
};

const saveCtx = (d: Demo): Context => ({
  cwd: d.main,
  log: () => {},
  error: () => {},
  openEditor: async () => 0,
});

/** Starts the web editor server; resolves with its origin, its access token and a stop function. */
async function startUi(d: Demo) {
  let url = "";
  let stop!: () => void;
  const exit = new Promise<void>((resolve) => (stop = resolve));
  const ctx: Context = { ...saveCtx(d), waitForExit: () => exit };
  const got = new Promise<void>((resolve) => {
    ctx.openUrl = async (u) => {
      url = u;
      resolve();
    };
  });
  const done = serveUi(ctx);
  await got;
  // The opened URL carries the access token: split it into the plain origin and the token.
  const opened = new URL(url);
  return {
    url: opened.origin,
    token: opened.searchParams.get("token")!,
    stop: async () => (stop(), await done),
  };
}

afterEach(async () => {
  // Some tests pollute Object.prototype / Object on purpose (H24–H28); never leak it to other tests.
  for (const key of ["polluted", "main", "x"]) delete (Object.prototype as any)[key];
  for (const key of ["main", "feature-checkout", "fix-login"]) delete (Object as any)[key];
  await Promise.all(created.splice(0).map((ws) => ws.cleanup()));
});

const T = 60_000;

// ── A/B: data loss, orphan variables and drift between the snapshot and the history ───────────

describe("data loss and orphan variables", () => {
  // Fixed: push removes the variables envs manages that the state no longer has.
  test("H01 (fixed) restore to a point without a variable removes it from the .env and the next pull does not bring it back", async () => {
    const d = await demo();
    const [first] = await readHistoryPoints(d.main);
    await appendFile(join(d.main, ".env"), "NEW_SECRET_KEY=demo-new\n");
    await d.cmd(["pull"]);
    expect(await d.text()).toContain("NEW_SECRET_KEY");
    expect((await d.cmd(["restore", first!.hash])).code).toBe(0);
    expect(await d.text()).not.toContain("NEW_SECRET_KEY");
    // The restored state sticks: push removed the variable from the .env too, so pull does not resurrect it.
    expect(await d.dotenv(d.main)).not.toContain("NEW_SECRET_KEY");
    await d.cmd(["pull"]);
    expect(await d.text()).not.toContain("NEW_SECRET_KEY");
  }, T);

  // Fixed: the first point of a history always describes the whole state, whichever command writes it.
  test("H02 (fixed) a first point not written by pull still holds the base state, so restore keeps values.yml", async () => {
    // A project from before the history existed: values.yml with data, no history.ndjson.
    const d = await demo();
    const y = Bun.YAML.parse(await d.text()) as any;
    y.profiles.staging = { defaults: { LOG_LEVEL: "warn" }, envs: {} };
    await Bun.write(d.values, Bun.YAML.stringify(y, null, 2));
    await rm(d.history);
    expect((await d.cmd(["use", "staging"], { cwd: d.login })).code).toBe(0);
    const points = await readHistoryPoints(d.main);
    expect((await d.cmd(["restore", points[0]!.hash])).code).toBe(0);
    const after = await d.text();
    expect(after).toContain("DATABASE_URL");
    expect(after).toContain("API_TOKEN");
    expect(after).toContain("LOG_LEVEL: warn");
  }, T);

  test("H02b (fixed) same through Save in the web editor after deleting history.ndjson", async () => {
    const d = await demo();
    await rm(d.history);
    const state = await snapshotOf(d);
    (state.profiles.default!.envs.PORT as any).main = "4000";
    await saveUiState(saveCtx(d), state);
    const points = await readHistoryPoints(d.main);
    expect(canon(await replayOf(d))).toBe(canon(await storedSnapshotOf(d)));
    await d.cmd(["restore", points[0]!.hash]);
    expect(await d.text()).toContain("DATABASE_URL");
  }, T);

  // Fixed: a resync point records what changed outside the history.
  test("H03 (fixed) with history=false the gap is recorded by a resync point, so restoring the last point keeps it", async () => {
    const d = await demo();
    await d.cmd(["config", "set", "history", "false"]);
    await appendFile(join(d.checkout, ".env"), "STRIPE_SECRET=demo-stripe\n");
    await d.cmd(["pull"]);
    await d.cmd(["config", "set", "history", "true"]);
    await Bun.write(join(d.login, ".env"), (await d.dotenv(d.login)).replace("LOG_LEVEL=info", "LOG_LEVEL=debug"));
    await d.cmd(["pull"]);
    const last = (await readHistoryPoints(d.main)).at(-1)!;
    expect(canon(await replayOf(d))).toBe(canon(await storedSnapshotOf(d)));
    await d.cmd(["restore", last.hash]);
    expect(await d.text()).toContain("STRIPE_SECRET");
  }, T);

  test("H04 (fixed) a manual edit of values.yml (outside envs edit) is recorded by a resync point", async () => {
    const d = await demo();
    const text = await d.text();
    // Edit the parsed YAML, not its text: the serializer's exact layout depends on the Bun version.
    const manual = Bun.YAML.parse(text) as any;
    manual.profiles.default.defaults.SENTRY_DSN = "https://demo@sentry.invalid/1";
    await Bun.write(d.values, Bun.YAML.stringify(manual, null, 2));
    await d.cmd(["pull"]);
    expect(await Bun.file(d.history).text()).toContain("SENTRY_DSN");
    expect(canon(await replayOf(d))).toBe(canon(await storedSnapshotOf(d)));
  }, T);

  test("H05 (fixed) a cancelled envs edit (editor exits non-zero) leaves values.yml as it was", async () => {
    const d = await demo();
    const { code } = await d.cmd(["edit"], {
      openEditor: async (path) => {
        const values = Bun.YAML.parse(await Bun.file(path).text()) as any;
        values.profiles.default.envs.PORT.main = 9999;
        await Bun.write(path, Bun.YAML.stringify(values, null, 2));
        return 130;
      },
    });
    expect(code).toBe(130);
    // A cancelled edit must not change values.yml…
    expect((await snapshotOf(d)).profiles.default!.envs.PORT!.main).toBe(3000);
    // …so a later push cannot apply it.
    await d.cmd(["push"]);
    expect(await d.dotenv(d.main)).not.toContain("PORT=9999");
  }, T);

  // Fixed: an empty string is shown as `""` in the table, so it is not confused with an empty (unset) cell.
  test("H06 (fixed) Save in the web editor keeps variables whose value is empty (FOO=)", async () => {
    const d = await demo();
    await appendFile(join(d.main, ".env"), "OPTIONAL_FLAG=\n");
    await d.cmd(["pull"]);
    expect(await d.text()).toContain("OPTIONAL_FLAG");
    await saveUiState(saveCtx(d), uiPayload(await snapshotOf(d)));
    expect(await d.text()).toContain("OPTIONAL_FLAG");
  }, T);

  // Fixed: the editor sends the version of values.yml it loaded; a stale save is refused (409).
  test("H07 (fixed) Save in the web editor refuses to overwrite what the CLI changed after the editor was loaded", async () => {
    const d = await demo();
    const loaded = await loadUiState(saveCtx(d)); // what GET /api/values handed to the editor
    await appendFile(join(d.login, ".env"), "NEW_FROM_TERMINAL=1\n");
    await d.cmd(["pull"]);
    expect(await d.text()).toContain("NEW_FROM_TERMINAL");
    const { worktrees: _, version, ...edited } = loaded;
    (edited.profiles.default!.envs.LOG_LEVEL as any).main = "warn";
    const result = await saveUiState(saveCtx(d), edited as NormalizedValues, { base: version });
    expect(result.conflict).toBe(true);
    expect(result.code).toBe(1);
    expect(await d.text()).toContain("NEW_FROM_TERMINAL");
    expect(await d.text()).not.toContain("main: warn");
    // After reloading, the same change saves fine.
    const fresh = await loadUiState(saveCtx(d));
    const { worktrees: __, version: v2, ...again } = fresh;
    (again.profiles.default!.envs.LOG_LEVEL as any).main = "warn";
    expect((await saveUiState(saveCtx(d), again as NormalizedValues, { base: v2 })).code).toBe(0);
  }, T);

  test("H08 (fixed) entries of a deleted or renamed worktree are reported by lint", async () => {
    const d = await demo();
    await $`git worktree remove --force ${d.login}`.cwd(d.main).quiet();
    await d.cmd(["pull"]);
    const mentioned = (await d.text()).includes("fix-login");
    const lint = await d.cmd(["lint"]);
    // Either pull cleans them up or lint reports them.
    expect(!mentioned || lint.out.includes("fix-login")).toBe(true);
  }, T);

  test("H09 (fixed) deleting a profile: the history replay drops it too", async () => {
    const d = await demo();
    await d.cmd(["edit"], {
      openEditor: async (path) => {
        await Bun.write(path, (await Bun.file(path).text()).trimEnd() + "\n  qa: \n    defaults: \n      LOG_LEVEL: trace\n    envs: \n      {}\n");
        return 0;
      },
    });
    await d.cmd(["edit"], {
      openEditor: async (path) => {
        const y = Bun.YAML.parse(await Bun.file(path).text()) as any;
        delete y.profiles.qa;
        await Bun.write(path, Bun.YAML.stringify(y, null, 2));
        return 0;
      },
    });
    expect(Object.keys((await snapshotOf(d)).profiles)).not.toContain("qa");
    expect(Object.keys((await replayOf(d)).profiles)).not.toContain("qa");
  }, T);

  test("H10 (fixed) creating an empty profile is recorded in the history", async () => {
    const d = await demo();
    await d.cmd(["edit"], {
      openEditor: async (path) => {
        await Bun.write(path, (await Bun.file(path).text()).trimEnd() + "\n  empty: \n    defaults: \n      {}\n    envs: \n      {}\n");
        return 0;
      },
    });
    expect(Object.keys((await snapshotOf(d)).profiles)).toContain("empty");
    expect(Object.keys((await replayOf(d)).profiles)).toContain("empty");
  }, T);

  // By design (a default applies to every worktree), now reported by pull instead of surprising later.
  test("H11 (reported) a default removed from one .env: pull says push writes it back, and dropping it from the defaults removes it everywhere", async () => {
    const d = await demo();
    await d.cmd(["edit"], {
      openEditor: async (path) => {
        const values = Bun.YAML.parse(await Bun.file(path).text()) as any;
        values.profiles.default.defaults.REGION = "eu";
        await Bun.write(path, Bun.YAML.stringify(values, null, 2));
        return 0;
      },
    });
    expect(await d.dotenv(d.login)).toContain("REGION=eu");
    await Bun.write(join(d.login, ".env"), (await d.dotenv(d.login)).replace("REGION=eu\n", ""));
    const pulled = await d.cmd(["pull"]);
    expect(pulled.out).toContain("REGION is in the defaults but missing from the .env of fix-login");
    expect(pulled.out).toContain("writes it back");
    await d.cmd(["push"]);
    expect(await d.dotenv(d.login)).toContain("REGION=eu");
    // The way to drop it everywhere: remove it from the defaults; push then removes it from every .env.
    await d.cmd(["edit"], {
      openEditor: async (path) => {
        const values = Bun.YAML.parse(await Bun.file(path).text()) as any;
        delete values.profiles.default.defaults.REGION;
        await Bun.write(path, Bun.YAML.stringify(values, null, 2));
        return 0;
      },
    });
    for (const dir of [d.main, d.checkout, d.login]) expect(await d.dotenv(dir)).not.toContain("REGION");
  }, T);

  test("H33 (fixed) worktree on a profile other than default: deleting a variable from its .env is reflected and push does not bring it back", async () => {
    const d = await demo();
    const y = Bun.YAML.parse(await d.text()) as any;
    y.profiles.staging = { defaults: { LOG_LEVEL: "warn" }, envs: {} };
    await Bun.write(d.values, Bun.YAML.stringify(y, null, 2));
    expect((await d.cmd(["use", "staging"], { cwd: d.checkout })).code).toBe(0);
    await Bun.write(join(d.checkout, ".env"), (await d.dotenv(d.checkout)).replace(/FEATURE_CHECKOUT=.*\n/, ""));
    await d.cmd(["pull"]);
    await d.cmd(["push"]);
    expect(await d.dotenv(d.checkout)).not.toContain("FEATURE_CHECKOUT");
  }, T);
});

// ── C: history integrity ─────────────────────────────────────────────────────────────────────

describe("history integrity", () => {
  // Fixed: a damaged history never stops a command; an incomplete last line is ignored and dropped on the next append.
  test("H12 (fixed) a truncated last line does not make pull fail or leave a change without a point", async () => {
    const d = await demo();
    await appendFile(d.history, '{"hash":"abc","prev":"x","timesta');
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("PORT=3000", "PORT=4000"));
    const pulled = await d.cmd(["pull"]);
    // A crash in the middle of an append must not brick the project, nor leave a change without a point.
    expect(pulled.code).toBe(0);
    expect(canon(await replayOf(d).catch(() => ({ uses: {}, profiles: {} })))).toBe(canon(await storedSnapshotOf(d)));
  }, T);

  // Fixed: restore refuses with a clear message and the panel loads, flagging the damaged lines.
  test("H13 (fixed) a corrupt line in the middle is reported clearly by restore and does not break the history panel", async () => {
    const d = await demo();
    const first = (await readHistoryPoints(d.main))[0]!.hash;
    const lines = (await Bun.file(d.history).text()).trimEnd().split("\n");
    await Bun.write(d.history, [lines[0], "not json", ...lines.slice(1)].join("\n") + "\n");
    const restored = await d.cmd(["restore", first]);
    // Expected: a clear diagnostic that names the file, not a stack trace from JSON.parse.
    expect(restored.out).toContain("history.ndjson");
    await expect(loadUiHistory(saveCtx(d))).resolves.toBeDefined();
  }, T);

  // Fixed: the chain is verified; restore refuses (unless --force) and recording commands warn.
  test("H14 (fixed) a tampered point is detected: restore refuses and does not apply it", async () => {
    const d = await demo();
    const lines = (await Bun.file(d.history).text()).trimEnd().split("\n");
    lines[0] = lines[0]!.replace('"to":"postgres://localhost/shop"', '"to":"postgres://attacker.invalid/shop"');
    await Bun.write(d.history, lines.join("\n") + "\n");
    const [point] = await readHistoryPoints(d.main);
    const recomputed = createHash("sha256")
      .update(JSON.stringify({ prev: point!.prev, timestamp: point!.timestamp, changes: point!.changes }))
      .digest("hex")
      .slice(0, 12);
    expect(recomputed).not.toBe(point!.hash); // the chain is broken…
    const restored = await d.cmd(["restore", point!.hash]);
    expect(restored.code).not.toBe(0); // …and restore must refuse
    expect(await d.dotenv(d.main)).not.toContain("attacker.invalid");
  }, T);

  test("H15 (fixed) concurrent writers no longer fork the chain (see test/concurrency.test.ts for separate processes)", async () => {
    const d = await demo();
    const before = await snapshotOf(d);
    const a = structuredClone(before);
    (a.profiles.default!.envs.PORT as any).main = 5000;
    const b = structuredClone(before);
    (b.profiles.default!.envs.PORT as any).main = 6000;
    await Promise.all([recordHistory(d.main, before, a), recordHistory(d.main, before, b)]);
    const points = await readHistoryPoints(d.main);
    points.forEach((point, i) => i > 0 && expect(point.prev).toBe(points[i - 1]!.hash));
  }, T);

  test("H16 (fixed) two identical concurrent points no longer share a hash", async () => {
    const d = await demo();
    const before = await snapshotOf(d);
    const after = structuredClone(before);
    (after.profiles.default!.envs.PORT as any).main = 5000;
    const now = () => new Date("2026-05-05T00:00:00.000Z");
    const [x, y] = await Promise.all([recordHistory(d.main, before, after, now), recordHistory(d.main, before, after, now)]);
    expect(x).not.toBe(y);
    expect((await d.cmd(["restore", x!])).code).toBe(0);
  }, T);

  test("H34 (fixed) envs restore on the CLI with history=false is refused, like the web editor does", async () => {
    const d = await demo();
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("PORT=3000", "PORT=4000"));
    await d.cmd(["pull"]);
    const [first] = await readHistoryPoints(d.main);
    await d.cmd(["config", "set", "history", "false"]);
    const restored = await d.cmd(["restore", first!.hash]);
    // The web editor refuses (409) because the restore would not be recorded; the CLI must too.
    expect(restored.code).not.toBe(0);
  }, T);
});

// ── D: web editor server, permissions, secrets and logs ──────────────────────────────────────

describe("security", () => {
  // Fixed: the server checks Host, Origin and a per-run token (see test/ui.test.ts for the full set).
  test("H17 (fixed) no token, or a foreign Host, never reads a secret or writes anything", async () => {
    const d = await demo();
    const ui = await startUi(d);
    try {
      const port = new URL(ui.url).port;
      // Any other program on the machine (no token) and a page reaching the server through DNS rebinding.
      for (const path of ["/api/values", "/api/history"]) {
        const anon = await $`curl -s -H ${"Host: evil.example:" + port} ${ui.url + path}`.text();
        expect(anon).not.toContain("demo-not-a-real-token");
        const plain = await $`curl -s ${ui.url + path}`.text();
        expect(plain).not.toContain("demo-not-a-real-token");
        // Even with a valid token, a foreign Host is refused.
        const rebound = await $`curl -s -o /dev/null -w %{http_code} -H ${"Host: evil.example:" + port} -H ${"x-envs-token: " + ui.token} ${ui.url + path}`.text();
        expect(rebound).toBe("421");
      }
      const put = await $`curl -s -o /dev/null -w %{http_code} -X PUT -H "content-type: application/json" --data ${'{"uses":{},"profiles":{"default":{"defaults":{"X":"attacker.invalid"},"envs":{}}}}'} ${ui.url + "/api/values"}`.text();
      expect(put).toBe("401");
      expect(await d.dotenv(d.main)).not.toContain("attacker.invalid");
    } finally {
      await ui.stop();
    }
  }, T);

  // Fixed: Origin must be this server and bodies must be application/json.
  test("H18 (fixed) CSRF: a foreign Origin or a text/plain body is refused and changes nothing", async () => {
    const d = await demo();
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("PORT=3000", "PORT=4000"));
    await d.cmd(["pull"]);
    const [first] = await readHistoryPoints(d.main);
    const ui = await startUi(d);
    try {
      const attempt = (headers: Record<string, string>) =>
        fetch(ui.url + "/api/restore", {
          method: "POST",
          headers: { "x-envs-token": ui.token, ...headers },
          body: JSON.stringify({ hash: first!.hash }),
        });
      expect((await attempt({ "content-type": "text/plain;charset=UTF-8", origin: "http://evil.example" })).status).toBe(403);
      expect((await attempt({ "content-type": "text/plain" })).status).toBe(415);
      expect((await attempt({ "content-type": "application/json", origin: "http://evil.example" })).status).toBe(403);
      expect(await d.dotenv(d.main)).toContain("PORT=4000");
    } finally {
      await ui.stop();
    }
  }, T);

  // Fixed: the server limits the size of a request body (413).
  test("H19 (fixed) a ~20 MB PUT is refused instead of being dumped into values.yml, the history and the .env", async () => {
    const d = await demo();
    const ui = await startUi(d);
    try {
      const state: any = await (await fetch(ui.url + "/api/values", { headers: { "x-envs-token": ui.token } })).json();
      delete state.worktrees;
      for (let i = 0; i < 2000; i++) state.profiles.default.defaults[`JUNK_${i}`] = "x".repeat(10_000);
      const res = await fetch(ui.url + "/api/values", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-envs-token": ui.token },
        body: JSON.stringify(state),
      });
      expect(res.status).toBe(413);
      expect(await d.text()).not.toContain("JUNK_");
    } finally {
      await ui.stop();
    }
  }, T);

  test("H20 (fixed) permissions: .envs/ is 700, its files 600, and an existing history.ndjson is hardened", async () => {
    const d = await demo();
    expect((await stat(d.values)).mode & 0o777).toBe(0o600);
    expect((await stat(join(d.main, ".envs"))).mode & 0o777).toBe(0o700);
    await chmod(d.history, 0o644);
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("PORT=3000", "PORT=4000"));
    await d.cmd(["pull"]);
    expect((await stat(d.history)).mode & 0o777).toBe(0o600);
  }, T);

  test("H21 (fixed) lint checks history.ndjson: tracked or not ignored it is reported", async () => {
    const d = await demo();
    await Bun.write(join(d.main, ".envs/.gitignore"), "values.yml\nconfig.yml\n");
    await $`git add -A && git commit -qm leak`.cwd(d.main).quiet();
    expect(await $`git ls-files .envs`.cwd(d.main).text()).toContain(".envs/history.ndjson");
    expect((await d.cmd(["lint"])).out).toMatch(/history/i);
  }, T);

  test("H22 (fixed) credentials inside URLs (DATABASE_URL) are masked in push/restore logs", async () => {
    const d = await demo();
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("postgres://localhost/shop", "postgres://shop:demo-pass@db.invalid/shop"));
    await d.cmd(["pull"]);
    const points = await readHistoryPoints(d.main);
    await d.cmd(["restore", points[0]!.hash]);
    const restored = await d.cmd(["restore", points[1]!.hash]);
    expect(restored.out).not.toContain("demo-pass");
  }, T);

  test("H23 (fixed) the history does not keep secrets in clear, so a rotated one is gone (see `envs history redact` for old histories)", async () => {
    const d = await demo();
    for (const dir of [d.main, d.checkout, d.login]) {
      await Bun.write(join(dir, ".env"), (await d.dotenv(dir)).replace("demo-not-a-real-token", "demo-rotated-token"));
    }
    await d.cmd(["pull"]);
    expect(await d.text()).not.toContain("demo-not-a-real-token");
    expect(await Bun.file(d.history).text()).not.toContain("demo-not-a-real-token");
  }, T);
});

// ── E: prototype pollution, odd names, types ─────────────────────────────────────────────────

describe("types, odd names and prototype pollution", () => {
  test("H24 (fixed) PUT /api/values with envs.__proto__ no longer pollutes Object.prototype", async () => {
    const d = await demo();
    const body = JSON.parse(JSON.stringify(await snapshotOf(d)).replace('"envs":{', '"envs":{"__proto__":{"polluted":"yes"},'));
    expect(Object.hasOwn(body.profiles.default.envs, "__proto__")).toBe(true);
    await saveUiState(saveCtx(d), body).catch(() => {});
    expect(({} as any).polluted).toBeUndefined();
  }, T);

  test("H24b (fixed) a __proto__ key cannot change what push writes", async () => {
    const d = await demo();
    const state = await snapshotOf(d);
    state.profiles.default!.defaults.ONLY_DEFAULT = "safe";
    state.profiles.default!.envs.ONLY_DEFAULT_ENV = { "fix-login": "x" };
    const body = JSON.parse(JSON.stringify(state).replace('"envs":{', '"envs":{"__proto__":{"main":"pwned"},'));
    await saveUiState(saveCtx(d), body).catch(() => {});
    expect(await d.dotenv(d.main)).not.toContain("ONLY_DEFAULT_ENV=pwned");
  }, T);

  test("H25 (fixed) applying a history with the path envs.__proto__ does not pollute Object.prototype", () => {
    const state = { uses: {}, profiles: {} } as NormalizedValues;
    applyChanges(state, [{ path: ["profiles", "default", "envs", "__proto__", "x"], to: "1" }]);
    expect(({} as any).x).toBeUndefined();
  });

  test("H26 (fixed) a values.yml with a __proto__ key does not pollute Object.prototype", () => {
    const raw = Bun.YAML.parse("profiles:\n  default:\n    envs:\n      __proto__:\n        polluted: yes\n") as any;
    normalizeValues(raw);
    expect(({} as any).polluted).toBeUndefined();
  });

  // Fixed: maps keyed by names have no prototype, so odd branch, variable and profile names are just names.
  test("H27 (fixed) a branch named constructor, toString or __proto__ no longer breaks pull and push", async () => {
    const d = await demo();
    for (const name of ["constructor", "toString", "__proto__"]) {
      const dir = await mkdtemp(join(tmpdir(), `envs-odd-${name.replace(/_/g, "")}-`));
      await rm(dir, { recursive: true });
      await $`git worktree add -q -b ${name} ${dir}`.cwd(d.main).quiet();
      await Bun.write(join(dir, ".env"), "PORT=3009\n");
      try {
        expect((await d.cmd(["pull"])).code).toBe(0);
        expect(Object.hasOwn((await snapshotOf(d)).uses, name)).toBe(true);
        expect((await d.cmd(["push"])).code).toBe(0);
        expect(await Bun.file(join(dir, ".env")).text()).toContain("PORT=3009");
        expect(({} as any).PORT).toBeUndefined();
      } finally {
        await $`git worktree remove --force ${dir}`.cwd(d.main).quiet();
      }
    }
  }, T);

  test("H28 (fixed) variables named constructor/toString/__proto__ in a .env are kept", async () => {
    const d = await demo();
    await appendFile(join(d.main, ".env"), "constructor=demo1\ntoString=demo2\n__proto__=demo3\n");
    expect(Object.keys(parseDotenv("__proto__=demo3\n"))).toContain("__proto__");
    expect((await d.cmd(["pull"])).code).toBe(0);
    const text = await d.text();
    expect(text).toContain("demo1");
    expect(text).toContain("demo2");
    expect(text).toContain("demo3");
    expect((Object as any).main).toBeUndefined();
  }, T);

  // Fixed: push refuses a value or a name with a line break, and writes nothing.
  test("H29 (fixed) a multiline value in values.yml is refused by push instead of injecting another variable", async () => {
    const d = await demo();
    const y = Bun.YAML.parse(await d.text()) as any;
    y.profiles.default.defaults.GREETING = "hola\nINJECTED=1";
    await Bun.write(d.values, Bun.YAML.stringify(y, null, 2));
    const before = await d.dotenv(d.main);
    const pushed = await d.cmd(["push"]);
    expect(pushed.code).toBe(1);
    expect(pushed.out).toContain("line break");
    expect(pushed.out).not.toContain("hola");
    expect(await d.dotenv(d.main)).toBe(before);
    expect(parseDotenv(await d.dotenv(d.main)).INJECTED).toBeUndefined();
    await d.cmd(["pull"]);
    expect(Object.keys((await snapshotOf(d)).profiles.default!.envs)).not.toContain("INJECTED");
  }, T);

  test("H31 (fixed) Save in the web editor keeps the type of quoted numeric/boolean strings (\"3000\", \"true\") and records no change", async () => {
    const d = await demo();
    const y = Bun.YAML.parse(await d.text()) as any;
    y.profiles.default.defaults.ZIP = "3000";
    y.profiles.default.defaults.FLAG = "true";
    await Bun.write(d.values, Bun.YAML.stringify(y, null, 2));
    await d.cmd(["pull"]); // records the manual edit above (a resync point) before measuring
    const before = (await readHistoryPoints(d.main)).length;
    // The editor sends everything as text, with no user change.
    await saveUiState(saveCtx(d), uiPayload(await snapshotOf(d)));
    expect((await readHistoryPoints(d.main)).length).toBe(before);
  }, T);

  // Fixed: the editor holds an empty value as `""`, so it matches the history (see src/ui/rows.ts).
  test("H32 (fixed) history panel: with an empty variable the latest point is \"in editor\", not a difference", () => {
    const target: NormalizedValues = { uses: { main: "default" }, profiles: { default: { defaults: {}, envs: { OPT: { main: "" } } } } };
    // What the editor holds: the table's cells, parsed back the way Save sends them.
    const current: NormalizedValues = { uses: { main: "default" }, profiles: { default: fromVarRows(toVarRows(target.profiles.default!)) } };
    expect(current.profiles.default!.envs.OPT).toEqual({ main: "" });
    expect(compareStates(current, target).same).toBe(true);
  });
});
