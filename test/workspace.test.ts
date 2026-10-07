import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
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
  const envPath = join(dir, ".env");
  expect(await Bun.file(envPath).exists()).toBe(false);

  const result = await $`bun ${bin} init`.cwd(dir).quiet();
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(envPath).exists()).toBe(true);
  expect(await Bun.file(envPath).text()).toBe("");

  // Running again must not overwrite an existing .env.
  await Bun.write(envPath, "FOO=bar\n");
  const again = await $`bun ${bin} init`.cwd(dir).quiet();
  expect(again.exitCode).toBe(0);
  expect(await Bun.file(envPath).text()).toBe("FOO=bar\n");
});
