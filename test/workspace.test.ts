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
