import { expect, test } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";

const bin = join(import.meta.dir, "../src/bin/envs.ts");

test("envs help prints the help message and exits with 0", async () => {
  const result = await $`bun ${bin} help`.quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Usage: envs <command>");
});

test("envs --help and -h print the general help", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await $`bun ${bin} ${flag}`.quiet();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: envs <command>");
  }
});

test.each(["init", "pull", "push", "lint", "edit", "use", "restore", "history", "config"])(
  "envs %s --help and -h print the command help without running it",
  async (command) => {
    for (const flag of ["--help", "-h"]) {
      const result = await $`bun ${bin} ${command} ${flag}`.cwd("/").quiet();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`Usage: envs ${command}`);
    }
  },
);
