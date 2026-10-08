import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { rules, type LintContext } from "../src/lint-rules";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

const never = async () => false;
const context = (values: LintContext["values"]): LintContext => ({
  values,
  root: "/repo",
  dotenvs: [],
  isTracked: never,
  isIgnored: async () => true,
});
/** Runs one rule by id; returns `location` of each violation. */
const run = async (id: string, values: LintContext["values"]) =>
  (await rules.find((r) => r.id === id)!.check(context(values))).map((v) => v.location);

test("rules have unique ids and descriptions", () => {
  const ids = rules.map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const rule of rules) expect(rule.description).not.toBe("");
});

describe("value rules", () => {
  test("weak-secret flags weak values only for sensitive keys", async () => {
    expect(await run("weak-secret", { envs: { DB_PASSWORD: { main: "changeme" } } })).toEqual(["envs.DB_PASSWORD.main"]);
    expect(await run("weak-secret", { defaults: { API_TOKEN: "" } })).toEqual(["defaults.API_TOKEN"]);
    expect(await run("weak-secret", { defaults: { LOG_LEVEL: "test" } })).toEqual([]);
    expect(await run("weak-secret", { defaults: { DB_PASSWORD: "k3j!x9Qz-long-random" } })).toEqual([]);
  });

  test("shared-secret flags sensitive keys in defaults only", async () => {
    expect(await run("shared-secret", { defaults: { API_KEY: "x", LOG_LEVEL: "info" } })).toEqual(["defaults.API_KEY"]);
    expect(await run("shared-secret", { envs: { API_KEY: { main: "x" } } })).toEqual([]);
  });

  test("secret-pattern detects known formats without echoing the value", async () => {
    const token = "ghp_" + "a".repeat(36);
    const values = { envs: { DEPLOY: { main: token } } };
    expect(await run("secret-pattern", values)).toEqual(["envs.DEPLOY.main"]);
    const [violation] = await rules.find((r) => r.id === "secret-pattern")!.check(context(values));
    expect(violation?.message).not.toContain(token);
    expect(await run("secret-pattern", { defaults: { K: "AKIAABCDEFGHIJKLMNOP" } })).toEqual(["defaults.K"]);
    expect(await run("secret-pattern", { defaults: { K: "-----BEGIN RSA PRIVATE KEY-----" } })).toEqual(["defaults.K"]);
  });

  test("url-credentials flags remote URLs with a password, not localhost", async () => {
    expect(await run("url-credentials", { defaults: { DB: "postgres://user:pw@db.example.com/app" } })).toEqual(["defaults.DB"]);
    expect(await run("url-credentials", { defaults: { DB: "postgres://user:pw@localhost/app" } })).toEqual([]);
    expect(await run("url-credentials", { defaults: { DB: "postgres://db.example.com/app" } })).toEqual([]);
  });

  test("insecure-url flags http/ws/ftp on remote hosts only", async () => {
    expect(await run("insecure-url", { defaults: { API: "http://api.example.com" } })).toEqual(["defaults.API"]);
    expect(await run("insecure-url", { defaults: { API: "http://127.0.0.1:3000" } })).toEqual([]);
    expect(await run("insecure-url", { defaults: { API: "https://api.example.com" } })).toEqual([]);
  });

  test("numbers, booleans and empty values.yml are clean", async () => {
    const values = { defaults: { DEBUG: true }, envs: { PORT: { main: 3000 } } };
    for (const rule of rules) expect(await rule.check(context(values))).toEqual([]);
    for (const rule of rules) expect(await rule.check(context({}))).toEqual([]);
  });
});

describe("git rules", () => {
  test("tracked and unignored files are reported per rule", async () => {
    const ctx = {
      ...context({}),
      dotenvs: [{ name: "main", path: "/repo" }],
      isTracked: async (_: string, file: string) => file === ".env",
      isIgnored: never,
    };
    const check = async (id: string) => (await rules.find((r) => r.id === id)!.check(ctx)).map((v) => v.location);
    expect(await check("tracked-dotenv")).toEqual(["main/.env"]);
    expect(await check("unignored-dotenv")).toEqual([]);
    expect(await check("tracked-values")).toEqual([]);
    expect(await check("unignored-values")).toEqual([".envs/values.yml"]);
  });

  test("executable-files flags values.yml and .env with an execute bit", async () => {
    const check = async (valuesMode?: number, mode?: number) =>
      (
        await rules.find((r) => r.id === "executable-files")!.check({
          ...context({}),
          valuesMode,
          dotenvs: [{ name: "main", path: "/repo", mode }],
        })
      ).map((v) => v.location);
    expect(await check(0o100600, 0o100600)).toEqual([]);
    expect(await check(0o100700, 0o100600)).toEqual([".envs/values.yml"]);
    expect(await check(0o100600, 0o100755)).toEqual(["main/.env"]);
    expect(await check(0o100644, 0o100611)).toEqual(["main/.env"]);
    expect(await check(undefined, undefined)).toEqual([]);
  });

  test("writable-files flags group- or other-writable values.yml and .env", async () => {
    const check = async (valuesMode?: number, mode?: number) =>
      (
        await rules.find((r) => r.id === "writable-files")!.check({
          ...context({}),
          valuesMode,
          dotenvs: [{ name: "main", path: "/repo", mode }],
        })
      ).map((v) => v.location);
    expect(await check(0o100644, 0o100600)).toEqual([]);
    expect(await check(0o100664, 0o100600)).toEqual([".envs/values.yml"]);
    expect(await check(0o100600, 0o100602)).toEqual(["main/.env"]);
    expect(await check(undefined, undefined)).toEqual([]);
  });

  test("open-permissions looks at the mode of values.yml", async () => {
    const check = (valuesMode?: number) => rules.find((r) => r.id === "open-permissions")!.check({ ...context({}), valuesMode });
    expect(await check(0o100644)).toHaveLength(1);
    expect(await check(0o100600)).toEqual([]);
    expect(await check(undefined)).toEqual([]);
  });
});

describe("envs lint", () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  let ws: Workspace;
  const lint = () => $`bun ${bin} lint`.cwd(ws.main).nothrow().quiet();

  beforeAll(async () => {
    ws = await createWorkspace({ main: "main", worktrees: ["wt-1"] });
    await $`bun ${bin} init`.cwd(ws.main).quiet();
  });
  afterAll(() => ws.cleanup());

  test("fails when values.yml does not exist", async () => {
    const other = await createWorkspace({ main: "main" });
    try {
      const result = await $`bun ${bin} lint`.cwd(other.main).nothrow().quiet();
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("envs init");
    } finally {
      await other.cleanup();
    }
  });

  test("passes on a protected, clean setup", async () => {
    await chmod(join(ws.main, ".envs/values.yml"), 0o600);
    await Bun.write(join(ws.main, ".envs/values.yml"), "envs:\n  PORT:\n    main: 3000\n");
    const result = await lint();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("No security problems found.");
  });

  test("warns about open permissions", async () => {
    await chmod(join(ws.main, ".envs/values.yml"), 0o644);
    const result = await lint();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("warning [open-permissions]");
    await chmod(join(ws.main, ".envs/values.yml"), 0o600);
  });

  test("warns about an unignored .env and insecure values", async () => {
    await Bun.write(join(ws.main, ".env"), "PORT=3000\n");
    await Bun.write(
      join(ws.main, ".envs/values.yml"),
      "envs:\n  DB_PASSWORD:\n    main: changeme\n",
    );
    const result = await lint();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("warning [unignored-dotenv] main/.env");
    expect(stderr).toContain("warning [weak-secret] envs.DB_PASSWORD.main");
    expect(stderr).not.toContain("changeme");

    await Bun.write(join(ws.main, ".gitignore"), ".env\n");
    await rm(join(ws.main, ".envs/values.yml"));
    await Bun.write(join(ws.main, ".envs/values.yml"), "");
    await chmod(join(ws.main, ".envs/values.yml"), 0o600);
    expect((await lint()).exitCode).toBe(0);
  });

  test("warns about an executable .env", async () => {
    await Bun.write(join(ws.main, ".env"), "PORT=3000\n");
    await Bun.write(join(ws.main, ".gitignore"), ".env\n");
    await chmod(join(ws.main, ".env"), 0o755);
    const result = await lint();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("warning [executable-files] main/.env");
    await chmod(join(ws.main, ".env"), 0o600);
  });

  test("warns about a world-writable .env", async () => {
    await chmod(join(ws.main, ".env"), 0o666);
    const result = await lint();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("warning [writable-files] main/.env");
    await chmod(join(ws.main, ".env"), 0o600);
  });

  test("warns when values.yml or .env are tracked by git", async () => {
    await $`git add -f .env .envs/values.yml`.cwd(ws.main).quiet();
    const stderr = (await lint()).stderr.toString();
    expect(stderr).toContain("warning [tracked-values]");
    expect(stderr).toContain("warning [tracked-dotenv] main/.env");
    await $`git rm -q --cached .env .envs/values.yml`.cwd(ws.main).quiet();
  });
});
