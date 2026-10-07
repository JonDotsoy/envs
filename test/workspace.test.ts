import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { CreateWorkspace, type Workspace } from "./fixtures/workspace";

let ws: Workspace;

beforeAll(async () => {
  ws = await CreateWorkspace("main", "worktree-1", "wt-2");
});

afterAll(() => ws.cleanup());

test("creates main workspace and worktrees in separate temp dirs", async () => {
  const list = await $`git -C ${ws.main} worktree list --porcelain`.text();
  expect(list).toContain(ws.main);
  expect(list).toContain(ws.worktrees["worktree-1"]!);
  expect(list).toContain(ws.worktrees["wt-2"]!);
});
