import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultContext,
  findRoot,
  formatDotenvValue,
  HELP,
  listWorktrees,
  parseDotenv,
  run,
  updateDotenv,
  type Context,
} from "../src/envs";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

// Keep color assertions independent of the developer's shell.
beforeEach(() => {
  delete process.env.NO_COLOR;
});

function testContext(cwd: string, overrides: Partial<Context> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx: Context = {
    cwd,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    openEditor: async () => 0,
    confirm: async () => true,
    ...overrides,
  };
  return { ctx, logs, errors };
}

describe("parseDotenv", () => {
  test("parses plain, quoted, exported and commented lines", () => {
    expect(
      parseDotenv(
        [
          "# comment",
          "",
          "A=1",
          'B="two words"',
          "C='single # quoted'",
          "export D=4",
          "E=5 # trailing comment",
          "F=",
          "not a pair",
          'G="unterminated',
        ].join("\n"),
      ),
    ).toEqual({
      A: "1",
      B: "two words",
      C: "single # quoted",
      D: "4",
      E: "5",
      F: "",
      G: '"unterminated',
    });
  });

  test("supports CRLF line endings", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("formatDotenvValue", () => {
  test("leaves simple values untouched", () => {
    expect(formatDotenvValue("abc-1.2/x")).toBe("abc-1.2/x");
  });

  test("quotes empty values and values with special characters", () => {
    expect(formatDotenvValue("")).toBe('""');
    expect(formatDotenvValue("two words")).toBe('"two words"');
    expect(formatDotenvValue("a#b")).toBe('"a#b"');
    expect(formatDotenvValue('say "hi"')).toBe(`'say "hi"'`);
  });
});

describe("updateDotenv", () => {
  test("creates content from nothing", () => {
    expect(updateDotenv("", { A: "1", B: "x y" })).toBe('A=1\nB="x y"\n');
  });

  test("updates in place, appends new keys and keeps other lines", () => {
    expect(
      updateDotenv("# c\nKEEP=1\nexport A=old\nB=old\n", { A: "new", C: "3" }),
    ).toBe("# c\nKEEP=1\nA=new\nB=old\nC=3\n");
  });
});

describe("run", () => {
  test("prints help for no args, help, --help and -h", async () => {
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const { ctx, logs } = testContext(process.cwd());
      expect(await run(args, ctx)).toBe(0);
      expect(logs).toEqual([HELP]);
    }
  });

  test("fails on unknown commands", async () => {
    const { ctx, errors } = testContext(process.cwd());
    expect(await run(["nope"], ctx)).toBe(1);
    expect(errors[0]).toContain("Unknown command: nope");
    expect(errors[0]).toContain(HELP);
  });

  test("defaultContext targets the process", () => {
    const ctx = defaultContext();
    expect(ctx.cwd).toBe(process.cwd());
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    ctx.log("out");
    ctx.error("err");
    expect(log).toHaveBeenCalledWith("out");
    expect(error).toHaveBeenCalledWith("err");
    log.mockRestore();
    error.mockRestore();
  });

  test("defaultContext.openEditor runs `code -w <file>`", async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), "envs-fakebin-"));
    const argsFile = join(fakeBin, "args.txt");
    const code = join(fakeBin, "code");
    await Bun.write(code, `#!/bin/sh\necho "$@" > "${argsFile}"\nexit 7\n`);
    await chmod(code, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;
    try {
      expect(await defaultContext().openEditor("/some/values.yml")).toBe(7);
      expect((await Bun.file(argsFile).text()).trim()).toBe(
        "-w /some/values.yml",
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});

describe("git helpers", () => {
  let ws: Workspace;
  let notGit: string;

  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["one"] });
    notGit = await realpath(await mkdtemp(join(tmpdir(), "envs-nogit-")));
  });
  afterAll(async () => {
    await ws.cleanup();
    await rm(notGit, { recursive: true, force: true });
  });

  test("findRoot resolves the main workspace from a worktree", async () => {
    expect(await findRoot(ws.worktrees.one!)).toBe(ws.main);
    expect(await findRoot(ws.main)).toBe(ws.main);
  });

  test("findRoot falls back to cwd outside git", async () => {
    expect(await findRoot(notGit)).toBe(notGit);
  });

  test("listWorktrees names by branch and by dir when detached", async () => {
    await $`git -C ${ws.main} worktree add -q --detach ${join(ws.main, "..", "detached-wt")}`
      .nothrow()
      .quiet();
    const list = await listWorktrees(ws.main);
    expect(list.find((w) => w.path === ws.main)?.name).toBe("main");
    expect(list.find((w) => w.path === ws.worktrees.one)?.name).toBe("one");
    const detached = list.find((w) => w.path.endsWith("detached-wt"));
    expect(detached?.name).toBe("detached-wt");
    await $`git -C ${ws.main} worktree remove --force ${detached!.path}`.quiet();
  });
});

describe("commands (in-process)", () => {
  let ws: Workspace;

  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["one"] });
  });
  afterAll(() => ws.cleanup());

  const valuesPath = () => join(ws.main, ".envs/values.yml");

  test("pull, push and edit require init first", async () => {
    for (const command of ["pull", "push", "edit"]) {
      const { ctx, errors } = testContext(ws.main);
      expect(await run([command], ctx)).toBe(1);
      expect(errors[0]).toContain("Run `envs init` first.");
    }
  });

  test("init creates files and reports existing ones", async () => {
    const first = testContext(ws.worktrees.one!);
    expect(await run(["init"], first.ctx)).toBe(0);
    expect(first.logs.every((l) => l.startsWith("Created "))).toBe(true);
    expect(await Bun.file(join(ws.main, ".envs/.gitignore")).text()).toBe(
      "*\n",
    );

    const second = testContext(ws.main);
    expect(await run(["init"], second.ctx)).toBe(0);
    expect(second.logs.every((l) => l.endsWith("already exists"))).toBe(true);
  });

  test("pull writes every .env into values.yml and drops removed keys", async () => {
    await Bun.write(join(ws.main, ".env"), "A=main\nB=b\n");
    await Bun.write(join(ws.worktrees.one!, ".env"), "A=one\n");
    const { ctx, logs } = testContext(ws.main);
    expect(await run(["pull"], ctx)).toBe(0);
    expect(logs).toEqual(["\x1b[32m↓ pulling main, one - 2 variables\x1b[0m"]);
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    expect(values.envs).toEqual({
      A: { main: "main", one: "one" },
      B: { main: "b" },
    });

    await Bun.write(join(ws.main, ".env"), "A=main\n");
    await run(["pull"], testContext(ws.main).ctx);
    const after = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    expect(after.envs.B).toBeUndefined();
  });

  for (const [count, noColor] of [3, 5, 10, 100].flatMap(
    (n) =>
      [
        [n, false],
        [n, true],
      ] as const,
  )) {
    const title = `pull and push log ${count} variables${noColor ? " with NO_COLOR" : ""}`;
    test(title, async () => {
      if (noColor) process.env.NO_COLOR = "1";
      const [g, y, r] = noColor
        ? ["", "", ""]
        : ["\x1b[32m", "\x1b[33m", "\x1b[0m"];
      const keys = Array.from({ length: count }, (_, i) => `VAR_${i}`);
      await Bun.write(
        join(ws.main, ".env"),
        keys.map((k) => `${k}=v`).join("\n") + "\n",
      );
      await rm(join(ws.worktrees.one!, ".env"), { force: true });
      await Bun.write(valuesPath(), "");

      const pulled = testContext(ws.main);
      expect(await run(["pull"], pulled.ctx)).toBe(0);
      expect(pulled.logs).toEqual([
        `${g}↓ pulling main - ${count} variables${r}`,
      ]);
      expect(pulled.logs).toMatchSnapshot();

      // Defaults with a new value change both worktrees, so each line lists both.
      await Bun.write(
        valuesPath(),
        "defaults:\n" + keys.map((k) => `  ${k}: w`).join("\n") + "\n",
      );
      const pushed = testContext(ws.main);
      expect(await run(["push"], pushed.ctx)).toBe(0);
      expect(pushed.logs).toEqual(
        keys.map((k) => `${y}↻ ${k}=w → main, one${r}`),
      );
      expect(pushed.logs).toMatchSnapshot();
    });
  }

  test("NO_COLOR disables colors in pull and push logs", async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      await Bun.write(join(ws.main, ".env"), "A=1\n");
      await rm(join(ws.worktrees.one!, ".env"), { force: true });
      await Bun.write(valuesPath(), "");
      const pulled = testContext(ws.main);
      await run(["pull"], pulled.ctx);
      expect(pulled.logs).toEqual(["↓ pulling main - 1 variables"]);
      await Bun.write(valuesPath(), "defaults:\n  A: 2\n");
      const pushed = testContext(ws.main);
      await run(["push"], pushed.ctx);
      expect(pushed.logs).toEqual(["↻ A=2 → main, one"]);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  test("push masks the value of sensitive variables (snapshot)", async () => {
    // Fake values: only the shape of the log output matters here.
    await Bun.write(
      valuesPath(),
      [
        "defaults:",
        "  KEY_FOO: fake-key-foo",
        "  API_KEY: sk_test_0000000000",
        "  AWS_BUCKET_SECRET: fake/aws+secret==",
        "  DB_PASSWORD: 'p@ss word'",
        "  AUTH_TOKEN: ghp_fake0000",
        "  JWT_SECRET: fake.jwt.secret",
        "envs:",
        "  API_KEY:",
        "    one: sk_test_1111111111",
        "",
      ].join("\n"),
    );
    const { ctx, logs } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(0);
    expect(logs.join("\n")).not.toMatch(/fake|sk_test|ghp_|p@ss/);
    expect(logs).toMatchSnapshot();
  });

  test("pull skips worktrees without .env and keeps defaults", async () => {
    await Bun.write(valuesPath(), "defaults:\n  D: d\n");
    await rm(join(ws.main, ".env"), { force: true });
    await rm(join(ws.worktrees.one!, ".env"), { force: true });
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    expect(values.defaults).toEqual({ D: "d" });
    expect(values.envs).toEqual({});
  });

  test("push skips worktrees with nothing to write", async () => {
    await Bun.write(valuesPath(), "envs:\n  A:\n    one: x\n");
    const { ctx, logs } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(0);
    expect(logs).toEqual(["\x1b[33m↻ A=x → one\x1b[0m"]);
    expect(await Bun.file(join(ws.main, ".env")).exists()).toBe(false);
    expect(await Bun.file(join(ws.worktrees.one!, ".env")).text()).toBe(
      "A=x\n",
    );
  });

  test("push writes defaults to every worktree, overridden by envs", async () => {
    await Bun.write(
      valuesPath(),
      "defaults:\n  D: 1\n  E: def\nenvs:\n  E:\n    one: custom\n",
    );
    expect(await run(["push"], testContext(ws.main).ctx)).toBe(0);
    expect(await Bun.file(join(ws.main, ".env")).text()).toBe("D=1\nE=def\n");
    expect(await Bun.file(join(ws.worktrees.one!, ".env")).text()).toBe(
      "A=x\nD=1\nE=custom\n",
    );
  });

  test("push works with an empty values.yml", async () => {
    await Bun.write(valuesPath(), "");
    const { ctx, logs } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(0);
    expect(logs).toEqual([]);
  });

  test("edit pulls, opens the editor, then pushes", async () => {
    await Bun.write(join(ws.main, ".env"), "E=before\n");
    const opened: string[] = [];
    const { ctx } = testContext(ws.worktrees.one!, {
      openEditor: async (path) => {
        opened.push(path);
        const text = await Bun.file(path).text();
        expect(text).toContain("before");
        await Bun.write(path, text.replace("before", "after"));
        return 0;
      },
    });
    expect(await run(["edit"], ctx)).toBe(0);
    expect(opened).toEqual([valuesPath()]);
    expect(await Bun.file(join(ws.main, ".env")).text()).toBe("E=after\n");
  });

  test("edit does not push when the editor fails", async () => {
    await Bun.write(join(ws.main, ".env"), "E=keep\n");
    const { ctx, logs } = testContext(ws.main, {
      openEditor: async (path) => {
        await Bun.write(path, "envs:\n  E:\n    main: changed\n");
        return 3;
      },
    });
    expect(await run(["edit"], ctx)).toBe(3);
    expect(logs.some((l) => l.includes("↻"))).toBe(false);
    expect(await Bun.file(join(ws.main, ".env")).text()).toBe("E=keep\n");
  });
});

test("parseValue turns booleans and canonical numbers into YAML scalars", async () => {
  const { parseValue } = await import("../src/envs");
  expect(parseValue("true")).toBe(true);
  expect(parseValue("false")).toBe(false);
  expect(parseValue("3000")).toBe(3000);
  expect(parseValue("-1")).toBe(-1);
  expect(parseValue("0.5")).toBe(0.5);
  for (const keep of ["007", "1.50", "True", "1e3", "", "3000 ", "v1"]) {
    expect(parseValue(keep)).toBe(keep);
  }
});

describe("push with many branches", () => {
  for (const branches of [3, 5, 10]) {
    test(`logs one line when the same value changes in ${branches} branches`, async () => {
      const names = Array.from({ length: branches - 1 }, (_, i) => `b${i + 1}`);
      const ws = await createWorkspace({ worktrees: names });
      try {
        await Bun.write(
          join(ws.main, ".envs/values.yml"),
          "defaults:\n  LOG_LEVEL: info\n",
        );
        const { ctx, logs } = testContext(ws.main);
        expect(await run(["push"], ctx)).toBe(0);
        expect(logs).toEqual([
          `\x1b[33m↻ LOG_LEVEL=info → ${["main", ...names].join(", ")}\x1b[0m`,
        ]);
        expect(logs).toMatchSnapshot();

        // Same value again: nothing changed, nothing logged.
        const again = testContext(ws.main);
        expect(await run(["push"], again.ctx)).toBe(0);
        expect(again.logs).toEqual([]);
      } finally {
        await ws.cleanup();
      }
    });
  }
});

describe("share / receive wiring", () => {
  test("help lists both commands", () => {
    expect(HELP).toContain("share");
    expect(HELP).toContain("receive");
  });

  test("both commands ask for `envs init` first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envs-noinit-"));
    try {
      for (const args of [["share"], ["receive", "envs://x"]]) {
        const { ctx, errors } = testContext(dir);
        expect(await run(args, ctx)).toBe(1);
        expect(errors.join("\n")).toContain("Run `envs init` first");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the default confirm only accepts an explicit y or yes", async () => {
    const answers: Array<[string | null, boolean]> = [
      ["y", true],
      ["Y", true],
      ["yes", true],
      [" YES ", true],
      ["n", false],
      ["no", false],
      ["ye", false],
      ["", false],
      [null, false],
    ];
    for (const [answer, expected] of answers) {
      const spy = spyOn(globalThis, "prompt").mockReturnValue(answer);
      try {
        expect(await defaultContext().confirm("Continue? ")).toBe(expected);
        expect(spy).toHaveBeenCalledWith("Continue? ");
      } finally {
        spy.mockRestore();
      }
    }
  });
});
