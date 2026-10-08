import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { lintValue, lintValues } from "../src/lint";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

const rules = (findings: { rule: string }[]) => findings.map((f) => f.rule);

describe("lintValue", () => {
  test("flags weak values only for sensitive keys", () => {
    expect(rules(lintValue("DB_PASSWORD", "changeme", "x"))).toEqual(["weak-secret"]);
    expect(rules(lintValue("API_TOKEN", "", "x"))).toEqual(["weak-secret"]);
    expect(lintValue("LOG_LEVEL", "test", "x")).toEqual([]);
    expect(lintValue("DB_PASSWORD", "k3j!x9Qz-long-random", "x")).toEqual([]);
  });

  test("detects well-known secret formats without echoing the value", () => {
    const token = "ghp_" + "a".repeat(36);
    const [finding] = lintValue("DEPLOY", token, "envs.DEPLOY.main");
    expect(finding?.rule).toBe("secret-pattern");
    expect(finding?.message).not.toContain(token);
    expect(rules(lintValue("K", "AKIAABCDEFGHIJKLMNOP", "x"))).toEqual(["secret-pattern"]);
    expect(rules(lintValue("K", "-----BEGIN RSA PRIVATE KEY-----", "x"))).toEqual(["secret-pattern"]);
  });

  test("flags credentials in remote URLs and insecure schemes, but not localhost", () => {
    expect(rules(lintValue("DB", "postgres://user:pw@db.example.com/app", "x"))).toEqual(["url-credentials"]);
    expect(rules(lintValue("API", "http://api.example.com", "x"))).toEqual(["insecure-url"]);
    expect(lintValue("DB", "postgres://user:pw@localhost/app", "x")).toEqual([]);
    expect(lintValue("API", "http://127.0.0.1:3000", "x")).toEqual([]);
    expect(lintValue("API", "https://api.example.com", "x")).toEqual([]);
  });

  test("handles numbers and booleans", () => {
    expect(lintValue("PORT", 3000, "x")).toEqual([]);
    expect(lintValue("DEBUG", true, "x")).toEqual([]);
  });
});

describe("lintValues", () => {
  test("warns when a sensitive key is shared through defaults", () => {
    const findings = lintValues({
      defaults: { API_KEY: "a-long-random-value", LOG_LEVEL: "info" },
    });
    expect(findings.map((f) => [f.rule, f.location])).toEqual([["shared-secret", "defaults.API_KEY"]]);
  });

  test("reports the location of per-worktree findings", () => {
    const findings = lintValues({ envs: { DB_PASSWORD: { main: "secret" } } });
    expect(findings[0]?.location).toBe("envs.DB_PASSWORD.main");
  });

  test("returns nothing for clean values", () => {
    expect(lintValues({})).toEqual([]);
    expect(lintValues({ envs: { PORT: { main: 3000 } } })).toEqual([]);
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

  test("warns when values.yml or .env are tracked by git", async () => {
    await $`git add -f .env .envs/values.yml`.cwd(ws.main).quiet();
    const stderr = (await lint()).stderr.toString();
    expect(stderr).toContain("warning [tracked-values]");
    expect(stderr).toContain("warning [tracked-dotenv] main/.env");
    await $`git rm -q --cached .env .envs/values.yml`.cwd(ws.main).quiet();
  });
});
