import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

let ws: Workspace;

beforeAll(async () => {
  ws = await createWorkspace({
    main: "main",
    worktrees: ["worktree-1", "wt-2"],
    files: { foo: "biz", "nested/bar.txt": "baz" },
  });
});

afterAll(() => ws.cleanup());

test("creates main workspace and worktrees in separate temp dirs", async () => {
  const list = await $`git -C ${ws.main} worktree list --porcelain`.text();
  expect(list).toContain(ws.main);
  expect(list).toContain(ws.worktrees["worktree-1"]!);
  expect(list).toContain(ws.worktrees["wt-2"]!);
});

test("files created on main are present in every worktree", async () => {
  for (const dir of [ws.main, ...Object.values(ws.worktrees)]) {
    expect(await Bun.file(join(dir, "foo")).text()).toBe("biz");
    expect(await Bun.file(join(dir, "nested/bar.txt")).text()).toBe("baz");
  }
});

test("$ envs help", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const result = await $`bun ${bin} help`.cwd(ws.main).quiet();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Usage: envs <command>");
});

test("envs init", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const dir = ws.worktrees["worktree-1"]!;
  const gitignore = join(dir, ".envs/.gitignore");
  const values = join(dir, ".envs/values.yml");
  expect(await Bun.file(gitignore).exists()).toBe(false);

  const result = await $`bun ${bin} init`.cwd(dir).quiet();
  expect(result.exitCode).toBe(0);
  expect((await stat(join(dir, ".envs"))).isDirectory()).toBe(true);
  expect(await Bun.file(gitignore).text()).toBe("*\n");
  expect(await Bun.file(values).exists()).toBe(true);

  // Running again must not overwrite existing files.
  await Bun.write(values, "FOO: bar\n");
  const again = await $`bun ${bin} init`.cwd(dir).quiet();
  expect(again.exitCode).toBe(0);
  expect(await Bun.file(values).text()).toBe("FOO: bar\n");
});
