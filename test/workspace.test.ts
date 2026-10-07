import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  // Run from a worktree: files are generated in the parent (main) workspace.
  const gitignore = join(ws.main, ".envs/.gitignore");
  const values = join(ws.main, ".envs/values.yml");
  expect(await Bun.file(gitignore).exists()).toBe(false);

  const result = await $`bun ${bin} init`.cwd(dir).quiet();
  expect(result.exitCode).toBe(0);
  expect((await stat(join(ws.main, ".envs"))).isDirectory()).toBe(true);
  expect(await Bun.file(join(dir, ".envs/.gitignore")).exists()).toBe(false);
  expect(await Bun.file(gitignore).text()).toBe("*\n");
  expect(await Bun.file(values).exists()).toBe(true);

  // Running again must not overwrite existing files.
  await Bun.write(values, "FOO: bar\n");
  const again = await $`bun ${bin} init`.cwd(dir).quiet();
  expect(again.exitCode).toBe(0);
  expect(await Bun.file(values).text()).toBe("FOO: bar\n");
});

test("envs edit", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const dir = ws.worktrees["wt-2"]!;

  // Fake `code` executable that records its arguments.
  const fakeBin = await mkdtemp(join(tmpdir(), "envs-fakebin-"));
  const argsFile = join(fakeBin, "args.txt");
  const code = join(fakeBin, "code");
  await Bun.write(code, `#!/bin/sh\necho "$@" > "${argsFile}"\n`);
  await chmod(code, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };

  try {
    // Runs from a worktree: opens values.yml of the parent workspace.
    await $`bun ${bin} init`.cwd(dir).quiet();
    const result = await $`bun ${bin} edit`.cwd(dir).env(env).quiet();
    expect(result.exitCode).toBe(0);
    expect((await Bun.file(argsFile).text()).trim()).toBe(
      `-w ${join(ws.main, ".envs/values.yml")}`,
    );
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("envs pull", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const dir = ws.worktrees["worktree-1"]!;
  const valuesPath = join(ws.main, ".envs/values.yml");
  const readValues = async () => Bun.YAML.parse(await Bun.file(valuesPath).text()) as any;

  await $`bun ${bin} init`.cwd(dir).quiet();
  await Bun.write(valuesPath, ""); // independent from other tests
  await Bun.write(join(ws.main, ".env"), "FOO=main\n");
  await Bun.write(join(dir, ".env"), "FOO=one\n# comment\nBAR=\"two words\"\n");

  const first = await $`bun ${bin} pull`.cwd(dir).quiet();
  expect(first.exitCode).toBe(0);
  let values = await readValues();
  expect(values.envs.FOO).toEqual({ main: "main", "worktree-1": "one" });
  expect(values.envs.BAR).toEqual({ "worktree-1": "two words" });

  // Modify the .env of one worktree: the change is reflected in values.yml.
  await Bun.write(join(dir, ".env"), "FOO=changed\n");
  await $`bun ${bin} pull`.cwd(dir).quiet();
  values = await readValues();
  expect(values.envs.FOO).toEqual({ main: "main", "worktree-1": "changed" });
  expect(values.envs.BAR).toBeUndefined();
});
