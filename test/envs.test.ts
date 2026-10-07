import { expect, test } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";

const bin = join(import.meta.dir, "../src/bin/envs.ts");

test("envs help prints the help message and exits with 0", async () => {
  const result = await $`bun ${bin} help`.quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Usage: envs <command>");
});
