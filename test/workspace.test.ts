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

test("envs edit pulls before opening and pushes after closing", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const dir = ws.worktrees["wt-2"]!;
  const valuesPath = join(ws.main, ".envs/values.yml");

  // Fake `code` executable: records its arguments and the file content it was
  // opened with, then edits the file like a user would.
  const fakeBin = await mkdtemp(join(tmpdir(), "envs-fakebin-"));
  const argsFile = join(fakeBin, "args.txt");
  const openedWith = join(fakeBin, "opened.yml");
  const code = join(fakeBin, "code");
  await Bun.write(
    code,
    `#!/bin/sh\necho "$@" > "${argsFile}"\ncp "$2" "${openedWith}"\nsed -i 's/initial/edited/' "$2"\n`,
  );
  await chmod(code, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };

  try {
    await $`bun ${bin} init`.cwd(dir).quiet();
    await Bun.write(valuesPath, ""); // independent from other tests
    await Bun.write(join(dir, ".env"), "EDIT=initial\n");

    // Runs from a worktree: opens values.yml of the parent workspace.
    const result = await $`bun ${bin} edit`.cwd(dir).env(env).quiet();
    expect(result.exitCode).toBe(0);
    expect((await Bun.file(argsFile).text()).trim()).toBe(`-w ${valuesPath}`);
    // pull ran before the editor opened the file...
    expect(await Bun.file(openedWith).text()).toContain("initial");
    // ...and push ran after it closed.
    expect(await Bun.file(join(dir, ".env")).text()).toBe("EDIT=edited\n");
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
  expect(values.profiles.default.envs.FOO).toEqual({ main: "main", "worktree-1": "one" });
  expect(values.profiles.default.envs.BAR).toEqual({ "worktree-1": "two words" });

  // Modify the .env of one worktree: the change is reflected in values.yml.
  await Bun.write(join(dir, ".env"), "FOO=changed\n");
  await $`bun ${bin} pull`.cwd(dir).quiet();
  values = await readValues();
  expect(values.profiles.default.envs.FOO).toEqual({ main: "main", "worktree-1": "changed" });
  expect(values.profiles.default.envs.BAR).toBeUndefined();
});

test("envs pull skips values equal to defaults", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const dir = ws.worktrees["worktree-1"]!;
  const valuesPath = join(ws.main, ".envs/values.yml");

  await $`bun ${bin} init`.cwd(dir).quiet();
  await rm(join(ws.main, ".env"), { force: true }); // independent from other tests
  await Bun.write(valuesPath, "defaults:\n  FOO: tar\n");
  await Bun.write(join(dir, ".env"), "FOO=tar\n");

  const result = await $`bun ${bin} pull`.cwd(dir).quiet();
  expect(result.exitCode).toBe(0);
  const values = Bun.YAML.parse(await Bun.file(valuesPath).text()) as any;
  expect(values.profiles.default.defaults).toEqual({ FOO: "tar" });
  expect(values.profiles.default.envs?.FOO).toBeUndefined();
});

test("envs push", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const one = ws.worktrees["worktree-1"]!;
  const two = ws.worktrees["wt-2"]!;
  await $`bun ${bin} init`.cwd(one).quiet();
  await rm(join(two, ".env"), { force: true }); // independent from other tests
  await Bun.write(
    join(ws.main, ".envs/values.yml"),
    `envs:
  FOO:
    main: from-main
    worktree-1: "two words"
  BAR:
    wt-2: "2"
`,
  );
  // Existing content is kept; managed keys are updated in place.
  await Bun.write(join(one, ".env"), "# mine\nKEEP=1\nFOO=old\n");
  await Bun.write(join(ws.main, ".env"), "");

  const result = await $`bun ${bin} push`.cwd(one).quiet();
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(join(ws.main, ".env")).text()).toBe("FOO=from-main\n");
  expect(await Bun.file(join(one, ".env")).text()).toBe(
    '# mine\nKEEP=1\nFOO="two words"\n',
  );
  expect(await Bun.file(join(two, ".env")).text()).toBe("BAR=2\n");
});

test("envs push writes defaults and lets envs override them", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const one = ws.worktrees["worktree-1"]!;
  const two = ws.worktrees["wt-2"]!;
  await $`bun ${bin} init`.cwd(one).quiet();
  await Bun.write(
    join(ws.main, ".envs/values.yml"),
    `defaults:
  FOO: tar

envs:
  FOO:
    main: biz
`,
  );
  for (const dir of [ws.main, one, two]) await rm(join(dir, ".env"), { force: true });

  await $`bun ${bin} push`.cwd(one).quiet();
  expect(await Bun.file(join(ws.main, ".env")).text()).toBe("FOO=biz\n");
  expect(await Bun.file(join(one, ".env")).text()).toBe("FOO=tar\n");
  expect(await Bun.file(join(two, ".env")).text()).toBe("FOO=tar\n");
});

test("envs push translates YAML numbers and booleans into the .env", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const one = ws.worktrees["worktree-1"]!;
  await $`bun ${bin} init`.cwd(one).quiet();
  await Bun.write(
    join(ws.main, ".envs/values.yml"),
    `defaults:
  DEBUG: true
  RATIO: 0.5

envs:
  PORT:
    main: 3000
    worktree-1: 3001
`,
  );
  for (const dir of [ws.main, one]) await rm(join(dir, ".env"), { force: true });

  await $`bun ${bin} push`.cwd(one).quiet();
  expect(await Bun.file(join(ws.main, ".env")).text()).toBe(
    "DEBUG=true\nRATIO=0.5\nPORT=3000\n",
  );
  expect(await Bun.file(join(one, ".env")).text()).toBe(
    "DEBUG=true\nRATIO=0.5\nPORT=3001\n",
  );
});

test("envs push preserves comments, blank lines and order; new keys go at the end", async () => {
  const bin = join(import.meta.dir, "../src/bin/envs.ts");
  const one = ws.worktrees["worktree-1"]!;
  await $`bun ${bin} init`.cwd(one).quiet();
  await Bun.write(
    join(ws.main, ".envs/values.yml"),
    `envs:
  PORT:
    worktree-1: 4000
  NEW_KEY:
    worktree-1: added
  DEBUG:
    worktree-1: false
`,
  );
  const original = `# App config
# Second header comment

HOST=localhost
PORT=3000 # inline comment

# Feature flags
export DEBUG=true

   # indented comment
UNTOUCHED="keep me"


# trailing comment
`;
  await Bun.write(join(one, ".env"), original);

  await $`bun ${bin} push`.cwd(one).quiet();
  expect(await Bun.file(join(one, ".env")).text()).toBe(`# App config
# Second header comment

HOST=localhost
PORT=4000

# Feature flags
DEBUG=false

   # indented comment
UNTOUCHED="keep me"


# trailing comment
NEW_KEY=added
`);
});
