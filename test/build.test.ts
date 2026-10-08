import { afterAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../scripts/build";

const outdir = await mkdtemp(join(tmpdir(), "envs-dist-"));
afterAll(() => rm(outdir, { recursive: true, force: true }));

test("build creates the compiled script and a self-pointing package.json", async () => {
  await build(outdir);

  const original = await Bun.file(join(import.meta.dir, "../package.json")).json();
  const pkg = await Bun.file(join(outdir, "package.json")).json();
  expect(pkg.name).toBe(original.name);
  expect(pkg.version).toBe(original.version);
  expect(pkg.type).toBe(original.type);
  expect(pkg.bin).toEqual({ envs: "envs.js" });
  expect(pkg.module).toBe("envs.js");
  expect(pkg.license).toBe("MIT");
  expect(await Bun.file(join(outdir, "LICENSE")).text()).toContain("MIT License");
  expect(await Bun.file(join(outdir, "README.md")).text()).toContain("# @jondotsoy/envs");
  expect(await Bun.file(join(outdir, "SECURITY.md")).text()).toContain("Security Policy");
  expect(pkg.scripts).toBeUndefined();
  expect(pkg.devDependencies).toBeUndefined();
  expect(pkg.files).toBeUndefined();

  const result = await $`bun ${join(outdir, pkg.bin.envs)} help`.quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Usage: envs <command>");
});
