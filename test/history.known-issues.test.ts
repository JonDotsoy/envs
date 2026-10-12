/**
 * Known issues of the history feature, found by the audit. One test per finding (H01…H34).
 *
 * Every test asserts the CORRECT behavior, so each one fails today: it reproduces a known gap.
 * They are declared with `bug(...)`, which is `test.failing`: the suite stays green while the gap
 * exists, and a test starts failing ("expected to fail but passed") as soon as its gap is fixed,
 * which is the signal to turn it into a regular `test`.
 *
 * To see the real failures (the assertion that does not hold) run:
 *
 *   SHOW_KNOWN_ISSUES=1 bun test test/history.known-issues.test.ts
 *
 * Not reproduced here: H30 (ruled out by the audit) and the process-level races of `envs use`
 * (non-deterministic); H15 is reproduced in-process with two concurrent `recordHistory` calls.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { appendFile, chmod, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  applyChanges,
  compareStates,
  loadUiHistory,
  normalizeValues,
  parseDotenv,
  readHistoryPoints,
  recordHistory,
  run,
  saveUiState,
  type Context,
  type NormalizedValues,
} from "../src/envs";
import { serveUi } from "../src/ui/server";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

const bug = process.env.SHOW_KNOWN_ISSUES ? test : test.failing;

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

/** What the web editor sends on Save: every value as text, empty cells dropped (see fromVarRows in src/ui/app.tsx). */
const uiPayload = (state: NormalizedValues): NormalizedValues => {
  const out = structuredClone(state) as any;
  for (const profile of Object.values<any>(out.profiles)) {
    for (const [k, v] of Object.entries<any>(profile.defaults)) {
      if (String(v) === "") delete profile.defaults[k];
      else profile.defaults[k] = String(v);
    }
    for (const [k, by] of Object.entries<any>(profile.envs)) {
      for (const [w, v] of Object.entries<any>(by)) {
        if (String(v) === "") delete by[w];
        else by[w] = String(v);
      }
      if (Object.keys(by).length === 0) delete profile.envs[k];
    }
  }
  return out;
};

const saveCtx = (d: Demo): Context => ({
  cwd: d.main,
  log: () => {},
  error: () => {},
  openEditor: async () => 0,
});

/** Starts the web editor server; resolves with its URL and a stop function. */
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
  return { url, stop: async () => (stop(), await done) };
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
    expect(canon(await replayOf(d))).toBe(canon(await snapshotOf(d)));
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
    expect(canon(await replayOf(d))).toBe(canon(await snapshotOf(d)));
    await d.cmd(["restore", last.hash]);
    expect(await d.text()).toContain("STRIPE_SECRET");
  }, T);

  test("H04 (fixed) a manual edit of values.yml (outside envs edit) is recorded by a resync point", async () => {
    const d = await demo();
    const text = await d.text();
    await Bun.write(d.values, text.replace("    defaults: \n      {}\n", "    defaults: \n      SENTRY_DSN: https://demo@sentry.invalid/1\n"));
    await d.cmd(["pull"]);
    expect(await Bun.file(d.history).text()).toContain("SENTRY_DSN");
    expect(canon(await replayOf(d))).toBe(canon(await snapshotOf(d)));
  }, T);

  bug("H05 a cancelled envs edit (editor exits non-zero) leaves its changes in values.yml, without a point or a push", async () => {
    const d = await demo();
    const { code } = await d.cmd(["edit"], {
      openEditor: async (path) => {
        await Bun.write(path, (await Bun.file(path).text()).replace("main: 3000", "main: 9999"));
        return 130;
      },
    });
    expect(code).toBe(130);
    // A cancelled edit must not change values.yml…
    expect(await d.text()).not.toContain("main: 9999");
    // …so a later push cannot apply it.
    await d.cmd(["push"]);
    expect(await d.dotenv(d.main)).not.toContain("PORT=9999");
  }, T);

  bug("H06 Save in the web editor removes variables whose value is empty (FOO=)", async () => {
    const d = await demo();
    await appendFile(join(d.main, ".env"), "OPTIONAL_FLAG=\n");
    await d.cmd(["pull"]);
    expect(await d.text()).toContain("OPTIONAL_FLAG");
    await saveUiState(saveCtx(d), uiPayload(await snapshotOf(d)));
    expect(await d.text()).toContain("OPTIONAL_FLAG");
  }, T);

  bug("H07 Save in the web editor overwrites what the CLI changed after the editor was loaded (lost update)", async () => {
    const d = await demo();
    const loaded = await snapshotOf(d);
    await appendFile(join(d.login, ".env"), "NEW_FROM_TERMINAL=1\n");
    await d.cmd(["pull"]);
    expect(await d.text()).toContain("NEW_FROM_TERMINAL");
    (loaded.profiles.default!.envs.LOG_LEVEL as any).main = "warn";
    // Either the save is refused (conflict) or the newer variable survives.
    await saveUiState(saveCtx(d), loaded).catch(() => {});
    expect(await d.text()).toContain("NEW_FROM_TERMINAL");
  }, T);

  bug("H08 entries of a deleted or renamed worktree stay orphan in values.yml forever, and lint does not warn", async () => {
    const d = await demo();
    await $`git worktree remove --force ${d.login}`.cwd(d.main).quiet();
    await d.cmd(["pull"]);
    const mentioned = (await d.text()).includes("fix-login");
    const lint = await d.cmd(["lint"]);
    // Either pull cleans them up or lint reports them.
    expect(!mentioned || lint.out.includes("fix-login")).toBe(true);
  }, T);

  bug("H09 deleting a profile: the history replay keeps it (snapshot != replay)", async () => {
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

  bug("H10 creating an empty profile is not recorded in the history", async () => {
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

  bug("H11 a variable in `defaults` removed from a .env: pull does not drop it and push writes it back", async () => {
    const d = await demo();
    await d.cmd(["edit"], {
      openEditor: async (path) => {
        await Bun.write(path, (await Bun.file(path).text()).replace("    defaults: \n      {}\n", "    defaults: \n      REGION: eu\n"));
        return 0;
      },
    });
    expect(await d.dotenv(d.login)).toContain("REGION=eu");
    await Bun.write(join(d.login, ".env"), (await d.dotenv(d.login)).replace("REGION=eu\n", ""));
    await d.cmd(["pull"]);
    await d.cmd(["push"]);
    expect(await d.dotenv(d.login)).not.toContain("REGION=eu");
  }, T);

  bug("H33 worktree on a profile other than default: deleting a variable from its .env is not reflected and push brings it back", async () => {
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
    expect(canon(await replayOf(d).catch(() => ({ uses: {}, profiles: {} })))).toBe(canon(await snapshotOf(d)));
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

  bug("H14 the hash chain is never verified: a tampered point is applied by restore without a warning", async () => {
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

  bug("H15 concurrent writers fork the chain: two points with the same prev", async () => {
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

  bug("H16 two identical points get the same hash, which makes restore ambiguous forever", async () => {
    const d = await demo();
    const before = await snapshotOf(d);
    const after = structuredClone(before);
    (after.profiles.default!.envs.PORT as any).main = 5000;
    const now = () => new Date("2026-05-05T00:00:00.000Z");
    const [x, y] = await Promise.all([recordHistory(d.main, before, after, now), recordHistory(d.main, before, after, now)]);
    expect(x).not.toBe(y);
    expect((await d.cmd(["restore", x!])).code).toBe(0);
  }, T);

  bug("H34 envs restore on the CLI with history=false rewrites values.yml without a point and says \"Already at\"", async () => {
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
  bug("H17 (high) the server does not check Host: a foreign Host (DNS rebinding) reads every secret", async () => {
    const d = await demo();
    const ui = await startUi(d);
    try {
      const port = new URL(ui.url).port;
      const body = await $`curl -s -H ${"Host: evil.example:" + port} ${ui.url + "/api/values"}`.text();
      expect(body).not.toContain("demo-not-a-real-token");
      const history = await $`curl -s -H ${"Host: evil.example:" + port} ${ui.url + "/api/history"}`.text();
      expect(history).not.toContain("demo-not-a-real-token");
    } finally {
      await ui.stop();
    }
  }, T);

  bug("H18 CSRF: POST /api/restore accepts text/plain (a \"simple\" request) and a foreign Origin", async () => {
    const d = await demo();
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("PORT=3000", "PORT=4000"));
    await d.cmd(["pull"]);
    const [first] = await readHistoryPoints(d.main);
    const ui = await startUi(d);
    try {
      const res = await fetch(ui.url + "/api/restore", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", origin: "http://evil.example" },
        body: JSON.stringify({ hash: first!.hash }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await d.dotenv(d.main)).toContain("PORT=4000");
    } finally {
      await ui.stop();
    }
  }, T);

  bug("H19 no practical body limit: a ~20 MB PUT is accepted and dumped into values.yml, the history and the .env", async () => {
    const d = await demo();
    const ui = await startUi(d);
    try {
      const state: any = await (await fetch(ui.url + "/api/values")).json();
      delete state.worktrees;
      for (let i = 0; i < 2000; i++) state.profiles.default.defaults[`JUNK_${i}`] = "x".repeat(10_000);
      const res = await fetch(ui.url + "/api/values", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await ui.stop();
    }
  }, T);

  bug("H20 permissions: values.yml and .envs/ are created readable by others; an existing history.ndjson is not hardened", async () => {
    const d = await demo();
    expect((await stat(d.values)).mode & 0o777).toBe(0o600);
    expect((await stat(join(d.main, ".envs"))).mode & 0o777).toBe(0o700);
    await chmod(d.history, 0o644);
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("PORT=3000", "PORT=4000"));
    await d.cmd(["pull"]);
    expect((await stat(d.history)).mode & 0o777).toBe(0o600);
  }, T);

  bug("H21 lint does not check history.ndjson: it can be versioned with the secrets in clear without a warning", async () => {
    const d = await demo();
    await Bun.write(join(d.main, ".envs/.gitignore"), "values.yml\nconfig.yml\n");
    await $`git add -A && git commit -qm leak`.cwd(d.main).quiet();
    expect(await $`git ls-files .envs`.cwd(d.main).text()).toContain(".envs/history.ndjson");
    expect((await d.cmd(["lint"])).out).toMatch(/history/i);
  }, T);

  bug("H22 credentials inside URLs (DATABASE_URL) are not masked in push/restore logs", async () => {
    const d = await demo();
    await Bun.write(join(d.main, ".env"), (await d.dotenv(d.main)).replace("postgres://localhost/shop", "postgres://shop:demo-pass@db.invalid/shop"));
    await d.cmd(["pull"]);
    const points = await readHistoryPoints(d.main);
    await d.cmd(["restore", points[0]!.hash]);
    const restored = await d.cmd(["restore", points[1]!.hash]);
    expect(restored.out).not.toContain("demo-pass");
  }, T);

  bug("H23 the history keeps rotated secrets forever, in clear (sensitive values should not be stored as is)", async () => {
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
  bug("H24 PUT /api/values with envs.__proto__ pollutes Object.prototype", async () => {
    const d = await demo();
    const body = JSON.parse(JSON.stringify(await snapshotOf(d)).replace('"envs":{', '"envs":{"__proto__":{"polluted":"yes"},'));
    expect(Object.hasOwn(body.profiles.default.envs, "__proto__")).toBe(true);
    await saveUiState(saveCtx(d), body).catch(() => {});
    expect(({} as any).polluted).toBeUndefined();
  }, T);

  bug("H24b the pollution changes what push writes: Object.prototype.main leaks into the variables of main", async () => {
    const d = await demo();
    const state = await snapshotOf(d);
    state.profiles.default!.defaults.ONLY_DEFAULT = "safe";
    state.profiles.default!.envs.ONLY_DEFAULT_ENV = { "fix-login": "x" };
    const body = JSON.parse(JSON.stringify(state).replace('"envs":{', '"envs":{"__proto__":{"main":"pwned"},'));
    await saveUiState(saveCtx(d), body).catch(() => {});
    expect(await d.dotenv(d.main)).not.toContain("ONLY_DEFAULT_ENV=pwned");
  }, T);

  bug("H25 applying a history with the path envs.__proto__ pollutes Object.prototype (restore and the browser panel)", () => {
    const state = { uses: {}, profiles: {} } as NormalizedValues;
    applyChanges(state, [{ path: ["profiles", "default", "envs", "__proto__", "x"], to: "1" }]);
    expect(({} as any).x).toBeUndefined();
  });

  bug("H26 a values.yml with a __proto__ key pollutes Object.prototype in any command that reads it", () => {
    const raw = Bun.YAML.parse("profiles:\n  default:\n    envs:\n      __proto__:\n        polluted: yes\n") as any;
    normalizeValues(raw);
    expect(({} as any).polluted).toBeUndefined();
  });

  bug("H27 a branch named constructor, toString or __proto__ breaks pull and push", async () => {
    const d = await demo();
    await $`git worktree add -q -b constructor ${join(d.ws.main, "..", "wt-constructor")}`.cwd(d.main).quiet();
    await Bun.write(join(d.main, "..", "wt-constructor", ".env"), "PORT=3009\n");
    expect((await d.cmd(["pull"])).code).toBe(0);
    expect((await d.cmd(["push"])).code).toBe(0);
    await rm(join(d.main, "..", "wt-constructor"), { recursive: true, force: true });
  }, T);

  bug("H28 variables named constructor/toString/__proto__ in a .env are silently lost", async () => {
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

  bug("H29 a multiline value in values.yml makes push write a .env that injects another variable", async () => {
    const d = await demo();
    const y = Bun.YAML.parse(await d.text()) as any;
    y.profiles.default.defaults.GREETING = "hola\nINJECTED=1";
    await Bun.write(d.values, Bun.YAML.stringify(y, null, 2));
    await d.cmd(["push"]);
    expect(parseDotenv(await d.dotenv(d.main)).INJECTED).toBeUndefined();
    await d.cmd(["pull"]);
    expect(await d.text()).not.toContain("INJECTED");
  }, T);

  bug("H31 Save in the web editor changes the type of quoted numeric/boolean strings (\"3000\", \"true\") and records a change nobody made", async () => {
    const d = await demo();
    const y = Bun.YAML.parse(await d.text()) as any;
    y.profiles.default.defaults.ZIP = "3000";
    y.profiles.default.defaults.FLAG = "true";
    await Bun.write(d.values, Bun.YAML.stringify(y, null, 2));
    const before = (await readHistoryPoints(d.main)).length;
    // The editor sends everything as text, with no user change.
    await saveUiState(saveCtx(d), uiPayload(await snapshotOf(d)));
    expect((await readHistoryPoints(d.main)).length).toBe(before);
  }, T);

  bug("H32 history panel: with an empty variable the latest point shows differences instead of \"in editor\" and offers Restore", () => {
    const target: NormalizedValues = { uses: { main: "default" }, profiles: { default: { defaults: {}, envs: { OPT: { main: "" } } } } };
    // What the editor holds (fromVarRows drops empty cells).
    const current: NormalizedValues = { uses: { main: "default" }, profiles: { default: { defaults: {}, envs: {} } } };
    expect(compareStates(current, target).same).toBe(true);
  });
});
