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
import { appendFile, chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultContext,
  findRoot,
  formatDotenvValue,
  HELP,
  listWorktrees,
  loadUiHistory,
  loadUiState,
  normalizeValues,
  parseDotenv,
  resolveEntries,
  run,
  saveUiState,
  stringifyValues,
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

  test("values survive a dotenv parser", () => {
    const { parseEnv } = require("node:util");
    for (const value of [`p'a"ss`, "a\\nb", "two words", `it's`, "$HOME", "a`b", "x#y"]) {
      expect(parseEnv(`X=${formatDotenvValue(value)}`).X).toBe(value);
    }
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

  test("pull and push require init first", async () => {
    for (const command of ["pull", "push"]) {
      const { ctx, errors } = testContext(ws.main);
      expect(await run([command], ctx)).toBe(1);
      expect(errors[0]).toContain("Run `envs init` first.");
    }
  });

  test("edit initializes first when values.yml is missing", async () => {
    const opened: string[] = [];
    const { ctx } = testContext(ws.main, {
      openEditor: async (path) => {
        opened.push(path);
        expect(await Bun.file(path).exists()).toBe(true);
        return 0;
      },
    });
    expect(await run(["edit"], ctx)).toBe(0);
    expect(opened).toEqual([valuesPath()]);
    expect(await Bun.file(join(ws.main, ".envs/.gitignore")).text()).toBe(
      "*\n",
    );
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
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
    expect(values.uses).toEqual({ main: "default", one: "default" });
    expect(values.profiles.default.envs).toEqual({
      A: { main: "main", one: "one" },
      B: { main: "b" },
    });

    await Bun.write(join(ws.main, ".env"), "A=main\n");
    await run(["pull"], testContext(ws.main).ctx);
    const after = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    expect(after.profiles.default.envs.B).toBeUndefined();
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
    // Variables left over from earlier tests are not the point here: forget they were ever managed.
    await rm(join(ws.main, ".envs/history.ndjson"), { force: true });
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
    // Legacy root keys are migrated; worktrees are registered even without a .env.
    expect(values).toEqual({
      uses: { main: "default", one: "default" },
      profiles: { default: { defaults: { D: "d" }, envs: {} } },
    });
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
    // `A` was never managed by values.yml or the history, so push keeps it.
    await rm(join(ws.main, ".envs/history.ndjson"), { force: true });
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

  test("edit shows a notice while editing and removes it afterwards", async () => {
    await Bun.write(join(ws.main, ".env"), "E=1\n");
    let seen = "";
    const { ctx } = testContext(ws.main, {
      openEditor: async (path) => {
        seen = await Bun.file(path).text();
        return 0;
      },
    });
    expect(await run(["edit"], ctx)).toBe(0);
    expect(seen.startsWith("# ")).toBe(true);
    expect(seen).toContain("Ctrl+C");
    expect(await Bun.file(valuesPath()).text()).not.toContain("Ctrl+C");
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

describe("edit creates .envs/ in the main repo", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({
      worktrees: ["one"],
      files: { "src/foo/.keep": "" },
    });
  });
  afterAll(() => ws.cleanup());

  const cases: [string, () => string][] = [
    ["a worktree root", () => ws.worktrees.one!],
    ["a subfolder of the main repo", () => join(ws.main, "src/foo")],
    ["a subfolder of a worktree", () => join(ws.worktrees.one!, "src/foo")],
  ];

  for (const [label, cwd] of cases) {
    test(`from ${label}`, async () => {
      await rm(join(ws.main, ".envs"), { recursive: true, force: true });
      const opened: string[] = [];
      const { ctx } = testContext(cwd(), {
        openEditor: async (path) => {
          opened.push(path);
          return 0;
        },
      });
      expect(await run(["edit"], ctx)).toBe(0);
      const valuesPath = join(ws.main, ".envs/values.yml");
      expect(opened).toEqual([valuesPath]);
      expect(await Bun.file(valuesPath).exists()).toBe(true);
      expect(await Bun.file(join(ws.main, ".envs/.gitignore")).text()).toBe(
        "*\n",
      );
      // Nothing is created next to where the command ran.
      for (const dir of [ws.worktrees.one!, cwd()]) {
        expect(await Bun.file(join(dir, ".envs/values.yml")).exists()).toBe(
          false,
        );
      }
    });
  }
});

describe("profiles", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  const valuesPath = () => join(ws.main, ".envs/values.yml");
  const read = async () => Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
  const dotenv = (dir: string) => Bun.file(join(dir, ".env")).text();
  const reset = async (yaml: string) => {
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
    for (const dir of [ws.main, ws.worktrees["feature-x"]!]) {
      await rm(join(dir, ".env"), { force: true });
    }
    if (yaml !== "") {
      await Bun.write(valuesPath(), yaml);
      await Bun.write(join(ws.main, ".envs/.gitignore"), "*\n");
    }
  };
  /** Runs `edit` with an editor that rewrites values.yml (replacing the notice header too). */
  const edit = async (yaml?: string, code = 0) => {
    const { ctx, logs } = testContext(ws.main, {
      openEditor: async (path) => {
        if (yaml !== undefined) await Bun.write(path, yaml);
        return code;
      },
    });
    return { code: await run(["edit"], ctx), logs };
  };

  test("edit writes the published schema modeline at the top of values.yml", async () => {
    await reset("");
    expect((await edit()).code).toBe(0);
    expect(await Bun.file(valuesPath()).text()).toStartWith(
      "# yaml-language-server: $schema=https://jondotsoy.github.io/envs/schema.json\n",
    );
  });

  const history = async () =>
    (await Bun.file(join(ws.main, ".envs/history.ndjson")).text()).trim().split("\n").map((l) => JSON.parse(l));

  test("the first pull initializes the history with the whole state", async () => {
    await reset("uses:\n  main: default\n  feature-x: default\nprofiles:\n  default:\n    defaults:\n      A: one\n    envs: {}\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    const [first, ...rest] = await history();
    expect(rest).toHaveLength(0);
    expect(Object.keys(first).sort()).toEqual(["changes", "hash", "prev", "timestamp"]);
    expect(first.prev).toBeNull();
    expect(new Date(first.timestamp).toISOString()).toBe(first.timestamp);
    expect(first.changes).toContainEqual({ path: ["profiles", "default", "defaults", "A"], to: "one" });
    // A later pull that changes nothing does not add a point.
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    expect(await history()).toHaveLength(1);
  });

  test("edit appends only the changes, chained to the previous point", async () => {
    const head = "uses:\n  main: default\n  feature-x: default\nprofiles:\n  default:\n    defaults:\n";
    await reset(head + "      A: one\n    envs: {}\n");
    expect((await edit(head + "      A: two\n      B: new\n    envs: {}\n")).code).toBe(0);
    const [first, second, ...rest] = await history();
    expect(rest).toHaveLength(0);
    expect(first.prev).toBeNull();
    expect(second.prev).toBe(first.hash);
    expect(second.changes).toEqual([
      { path: ["profiles", "default", "defaults", "A"], from: "one", to: "two" },
      { path: ["profiles", "default", "defaults", "B"], to: "new" },
    ]);
    await edit(head + "      A: three\n      B: new\n    envs: {}\n");
    const third = (await history())[2];
    expect(third.prev).toBe(second.hash);
  });

  test("the hash covers prev, timestamp and changes", async () => {
    await reset("");
    await edit();
    const { hash, ...point } = (await history())[0];
    expect(hash).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(point)).digest("hex").slice(0, 12));
  });

  test("edit without changes adds no point after the initial one", async () => {
    await reset("");
    expect((await edit()).code).toBe(0);
    expect(await history()).toHaveLength(1);
  });

  test("edit in a new project with no .env writes uses and an empty default profile", async () => {
    await reset("");
    expect((await edit()).code).toBe(0);
    expect(await read()).toEqual({
      uses: { main: "default", "feature-x": "default" },
      profiles: { default: { defaults: {}, envs: {} } },
    });
  });

  test("edit migrates a legacy file to profiles.default without losing values", async () => {
    await reset("defaults:\n  LOG: info\nenvs:\n  PORT:\n    main: 3000\n");
    await Bun.write(join(ws.main, ".env"), "LOG=info\nPORT=3000\n");
    expect((await edit()).code).toBe(0);
    const values = await read();
    expect(values.defaults).toBeUndefined();
    expect(values.envs).toBeUndefined();
    expect(values.profiles.default).toEqual({
      defaults: { LOG: "info" },
      envs: { PORT: { main: 3000 } },
    });
  });

  test("push applies the profile of each worktree on top of default", async () => {
    await reset(
      [
        "uses:",
        "  main: local",
        "  feature-x: dev",
        "profiles:",
        "  default:",
        "    defaults: { LOG: info, URL: base }",
        "    envs: { PORT: { main: 3000, feature-x: 3001 } }",
        "  local:",
        "    defaults: { URL: localhost }",
        "  dev:",
        "    defaults: { URL: dev.internal, LOG: debug }",
        "    envs: { PORT: { feature-x: 4001 } }",
        "",
      ].join("\n"),
    );
    const { ctx, logs } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(0);
    expect(await dotenv(ws.main)).toBe("LOG=info\nURL=localhost\nPORT=3000\n");
    expect(await dotenv(ws.worktrees["feature-x"]!)).toBe(
      "LOG=debug\nURL=dev.internal\nPORT=4001\n",
    );
    // Only worktrees on another profile are labelled.
    expect(logs).toContain("\x1b[33m↻ URL=localhost → main [local]\x1b[0m");
    expect(logs).toContain("\x1b[33m↻ LOG=info → main [local]\x1b[0m");
  });

  test("push fails on an unknown profile and leaves everything untouched", async () => {
    await reset("uses:\n  feature-x: nope\nprofiles:\n  default:\n    defaults: { A: 1 }\n");
    const before = await Bun.file(valuesPath()).text();
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(1);
    expect(errors[0]).toContain('Unknown profile "nope" for worktree feature-x');
    expect(errors[0]).toContain("Available: default");
    expect(await Bun.file(valuesPath()).text()).toBe(before);
    expect(await Bun.file(join(ws.main, ".env")).exists()).toBe(false);
  });

  test("edit creates a new profile named in uses as a copy of default", async () => {
    await reset("profiles:\n  default:\n    defaults: { A: 1 }\n    envs: { B: { main: 2 } }\n");
    const { code, logs } = await edit(
      "uses:\n  main: default\n  feature-x: staging\nprofiles:\n  default:\n    defaults: { A: 1 }\n    envs: { B: { main: 2 } }\n",
    );
    expect(code).toBe(0);
    const values = await read();
    expect(values.profiles.staging).toEqual(values.profiles.default);
    expect(values.profiles.staging).toEqual({ defaults: { A: 1 }, envs: { B: { main: 2 } } });
    expect(logs).toContain("\x1b[32m+ created staging from default\x1b[0m");
    expect(await dotenv(ws.worktrees["feature-x"]!)).toBe("A=1\n");
  });

  test("edit does not touch a profile added by hand, with values or empty", async () => {
    for (const manual of ["\n    defaults: { Z: 9 }\n", " {}\n", "\n"]) {
      await reset("profiles:\n  default:\n    defaults: { A: 1 }\n");
      const { logs } = await edit(
        `uses:\n  feature-x: staging\nprofiles:\n  default:\n    defaults: { A: 1 }\n  staging:${manual}`,
      );
      const { profiles } = await read();
      // Never null, and nothing is copied from default.
      expect(profiles.staging).toEqual({
        defaults: manual.includes("Z") ? { Z: 9 } : {},
        envs: {},
      });
      expect(logs.some((l) => l.includes("created"))).toBe(false);
    }
  });

  test("edit keeps comments when every profile is already complete and nothing is created", async () => {
    await reset("profiles:\n  default:\n    defaults: {}\n    envs: {}\n");
    const yaml = "# mine\nprofiles:\n  default:\n    defaults: { A: 1 } # note\n    envs: {}\n";
    expect((await edit(yaml)).code).toBe(0);
    expect(await Bun.file(valuesPath()).text()).toBe(yaml);
  });

  test("edit does not create the profile when the editor fails", async () => {
    await reset("profiles:\n  default:\n    defaults: { A: 1 }\n");
    const { code } = await edit("uses:\n  feature-x: staging\nprofiles:\n  default:\n    defaults: { A: 1 }\n", 3);
    expect(code).toBe(3);
    expect((await read()).profiles.staging).toBeUndefined();
  });

  test("pull stores a value in the active profile unless the profile already provides it", async () => {
    await reset(
      "uses:\n  feature-x: dev\nprofiles:\n  default:\n    defaults: { A: base }\n  dev:\n    defaults: { A: devval }\n",
    );
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "A=devval\nB=own\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    const values = await read();
    expect(values.profiles.dev.envs).toEqual({ B: { "feature-x": "own" } });
    expect(values.profiles.default.envs).toEqual({});
    // A key removed from the .env disappears from the profile.
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "A=devval\n");
    await run(["pull"], testContext(ws.main).ctx);
    expect((await read()).profiles.dev.envs).toEqual({});
  });

  test("use sets the profile of the current worktree and pushes only that worktree", async () => {
    await reset("profiles:\n  default:\n    defaults: { A: 1 }\n  dev:\n    defaults: { A: 2 }\n");
    const sub = testContext(ws.worktrees["feature-x"]!);
    expect(await run(["use", "dev"], sub.ctx)).toBe(0);
    expect((await read()).uses).toEqual({ main: "default", "feature-x": "dev" });
    expect(await dotenv(ws.worktrees["feature-x"]!)).toBe("A=2\n");
    expect(await Bun.file(join(ws.main, ".env")).exists()).toBe(false);

    const list = testContext(ws.main);
    expect(await run(["use"], list.ctx)).toBe(0);
    expect(list.logs).toEqual(["main: default", "feature-x: dev"]);

    const bad = testContext(ws.main);
    expect(await run(["use", "nope"], bad.ctx)).toBe(1);
    expect(bad.errors[0]).toContain('Unknown profile "nope"');
  });

  test("use records the profile change in the history", async () => {
    await reset("uses:\n  main: default\n  feature-x: default\nprofiles:\n  default:\n    defaults: { A: 1 }\n  dev:\n    defaults: { A: 2 }\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    expect(await run(["use", "dev"], testContext(ws.worktrees["feature-x"]!).ctx)).toBe(0);
    const [first, second, ...rest] = (await Bun.file(join(ws.main, ".envs/history.ndjson")).text())
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(rest).toHaveLength(0);
    expect(second.prev).toBe(first.hash);
    expect(second.changes).toEqual([{ path: ["uses", "feature-x"], from: "default", to: "dev" }]);
    // Selecting the profile it already has changes nothing, so no point is added.
    expect(await run(["use", "dev"], testContext(ws.worktrees["feature-x"]!).ctx)).toBe(0);
    expect((await Bun.file(join(ws.main, ".envs/history.ndjson")).text()).trim().split("\n")).toHaveLength(2);
  });
});

describe("history on the first edit of a project", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  /** The whole history file. Timestamps come from the pinned clock, so hashes are stable. */
  const readHistory = async () =>
    (await Bun.file(join(ws.main, ".envs/history.ndjson")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  let tick = 0;
  /** A clock that advances one minute per call. */
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, tick++));

  test("the first edit initializes the history with the whole state", async () => {
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
    await Bun.write(join(ws.main, ".env"), "LOG=info\nPORT=3000\n");
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "LOG=info\nPORT=3001\n");

    const { ctx } = testContext(ws.main, { now });
    expect(await run(["edit"], ctx)).toBe(0);

    const history = await readHistory();
    expect(history).toHaveLength(1);
    expect(history[0].prev).toBeNull();
    // The history holds variable values: only the owner can read or write it, and it stays so after appends.
    if (process.platform !== "win32") {
      expect((await stat(join(ws.main, ".envs/history.ndjson"))).mode & 0o777).toBe(0o600);
    }
    expect(history).toMatchSnapshot();
  });

  test("later edits chain to the initial point", async () => {
    const { ctx } = testContext(ws.main, {
      now,
      openEditor: async (path) => {
        const text = (await Bun.file(path).text()).replace("main: 3000", "main: 4000");
        await Bun.write(path, text);
        return 0;
      },
    });
    expect(await run(["edit"], ctx)).toBe(0);

    const history = await readHistory();
    expect(history).toHaveLength(2);
    expect(history[1].prev).toBe(history[0].hash);
    if (process.platform !== "win32") {
      expect((await stat(join(ws.main, ".envs/history.ndjson"))).mode & 0o777).toBe(0o600);
    }
    expect(history).toMatchSnapshot();
  });

  test("a manual change to a worktree's .env is recorded by the next edit", async () => {
    const before = await readHistory();
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "LOG=info\nPORT=3002\n");

    const { ctx } = testContext(ws.main, { now });
    expect(await run(["edit"], ctx)).toBe(0);

    const history = await readHistory();
    expect(history).toHaveLength(before.length + 1);
    expect(history.at(-1).prev).toBe(before.at(-1).hash);
    expect(history.at(-1).changes).toEqual([
      { path: ["profiles", "default", "envs", "PORT", "feature-x"], from: 3001, to: 3002 },
    ]);
    expect(history).toMatchSnapshot();
  });

  test("pull detects a manual .env change, records a point and updates values.yml", async () => {
    const before = await readHistory();
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "LOG=info\nPORT=3003\n");

    expect(await run(["pull"], testContext(ws.main, { now }).ctx)).toBe(0);

    const history = await readHistory();
    expect(history).toHaveLength(before.length + 1);
    expect(history.at(-1).prev).toBe(before.at(-1).hash);
    expect(history.at(-1).changes).toEqual([
      { path: ["profiles", "default", "envs", "PORT", "feature-x"], from: 3002, to: 3003 },
    ]);
    const values = Bun.YAML.parse(await Bun.file(join(ws.main, ".envs/values.yml")).text()) as any;
    expect(values.profiles.default.envs.PORT["feature-x"]).toBe(3003);

    // Pulling again with the .env untouched adds nothing.
    expect(await run(["pull"], testContext(ws.main, { now }).ctx)).toBe(0);
    expect(await readHistory()).toHaveLength(history.length);
    expect(await readHistory()).toMatchSnapshot();
  });

  test("the history is active by default and `config set history false` turns it off", async () => {
    const history = () => Bun.file(join(ws.main, ".envs/history.ndjson"));
    const length = async () => (await readHistory()).length;
    const before = await length();
    // Nothing configured: active.
    expect(await run(["config", "get", "history"], testContext(ws.main).ctx)).toBe(1);

    expect(await run(["config", "set", "history", "false"], testContext(ws.main).ctx)).toBe(0);
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "LOG=info\nPORT=3004\n");
    expect(await run(["pull"], testContext(ws.main, { now }).ctx)).toBe(0);
    expect(await length()).toBe(before);
    // values.yml is still updated.
    const values = Bun.YAML.parse(await Bun.file(join(ws.main, ".envs/values.yml")).text()) as any;
    expect(values.profiles.default.envs.PORT["feature-x"]).toBe(3004);

    expect(await run(["config", "set", "history", "true"], testContext(ws.main).ctx)).toBe(0);
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "LOG=info\nPORT=3005\n");
    expect(await run(["pull"], testContext(ws.main, { now }).ctx)).toBe(0);
    const entries = await readHistory();
    // What happened while it was off is recorded by a resync point, then the new change follows.
    expect(entries).toHaveLength(before + 2);
    const [resync, point] = entries.slice(-2);
    expect(resync.resync).toBe(true);
    expect(resync.changes).toEqual([
      { path: ["profiles", "default", "envs", "PORT", "feature-x"], from: 3003, to: 3004 },
    ]);
    expect(point.resync).toBeUndefined();
    expect(point.prev).toBe(resync.hash);
    expect(point.changes).toEqual([
      { path: ["profiles", "default", "envs", "PORT", "feature-x"], from: 3004, to: 3005 },
    ]);
    expect(await history().exists()).toBe(true);
  });

  test("with the history off no history file is created", async () => {
    const dir = await createWorkspace({ worktrees: [] });
    try {
      await Bun.write(join(dir.main, ".env"), "A=1\n");
      expect(await run(["config", "set", "history", "false"], testContext(dir.main).ctx)).toBe(0);
      expect(await run(["edit"], testContext(dir.main).ctx)).toBe(0);
      expect(await Bun.file(join(dir.main, ".envs/history.ndjson")).exists()).toBe(false);
    } finally {
      await dir.cleanup();
    }
  });
});

describe("restore", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace();
  });
  afterAll(() => ws.cleanup());

  const historyText = () => Bun.file(join(ws.main, ".envs/history.ndjson")).text();
  const readHistory = async () =>
    (await historyText()).trim().split("\n").map((l) => JSON.parse(l));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, tick++));

  test("restore applies a point's state and adds a point without removing any", async () => {
    // 4 points: the initial state, then A=2, A=3 and A=4.
    expect(await run(["init"], testContext(ws.main).ctx)).toBe(0);
    for (const a of [1, 2, 3, 4]) {
      await Bun.write(join(ws.main, ".env"), `A=${a}\n`);
      expect(await run(["pull"], testContext(ws.main, { now }).ctx)).toBe(0);
    }
    const before = await readHistory();
    expect(before).toHaveLength(4);
    const beforeText = await historyText();

    const { ctx, logs } = testContext(ws.main, { now });
    expect(await run(["restore", before[1].hash], ctx)).toBe(0);

    const after = await readHistory();
    expect(after).toHaveLength(5);
    // The first 4 points are untouched; the new one chains to the last.
    expect(await historyText()).toStartWith(beforeText);
    expect(after[4].prev).toBe(before[3].hash);
    expect(after[4].changes).toEqual([
      { path: ["profiles", "default", "envs", "A", "main"], from: 4, to: 2 },
    ]);
    expect(logs[0]).toContain(`restored ${before[1].hash}`);
    // values.yml and the .env go back to A=2.
    const values = Bun.YAML.parse(await Bun.file(join(ws.main, ".envs/values.yml")).text()) as any;
    expect(values.profiles.default.envs.A.main).toBe(2);
    expect(await Bun.file(join(ws.main, ".env")).text()).toBe("A=2\n");

    // A unique prefix of the hash is enough; restoring the state it already has adds nothing.
    const again = testContext(ws.main, { now });
    expect(await run(["restore", before[1].hash.slice(0, 6)], again.ctx)).toBe(0);
    expect(again.logs[0]).toContain("nothing to restore");
    expect(await readHistory()).toHaveLength(5);

    // Going back to the first point adds a sixth.
    expect(await run(["restore", before[0].hash], testContext(ws.main, { now }).ctx)).toBe(0);
    expect(await readHistory()).toHaveLength(6);
    expect(await Bun.file(join(ws.main, ".env")).text()).toBe("A=1\n");
  });

  test("restore fails on a missing or unknown hash", async () => {
    for (const args of [["restore"], ["restore", "zzzz"], ["restore", ""]]) {
      const { ctx, errors } = testContext(ws.main);
      expect(await run(args, ctx)).toBe(1);
      expect(errors).toHaveLength(1);
    }
    const length = (await readHistory()).length;
    expect(length).toBe(6);
  });
});

describe("saving from the web editor keeps value types", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace();
  });
  afterAll(() => ws.cleanup());

  /** What the editor sends: every value as text. */
  const asText = (state: Awaited<ReturnType<typeof loadUiState>>) => {
    const { worktrees: _, ...values } = state;
    const text = structuredClone(values) as any;
    for (const profile of Object.values<any>(text.profiles)) {
      for (const k of Object.keys(profile.defaults)) profile.defaults[k] = String(profile.defaults[k]);
      for (const byWorktree of Object.values<any>(profile.envs)) {
        for (const w of Object.keys(byWorktree)) byWorktree[w] = String(byWorktree[w]);
      }
    }
    return text;
  };

  test("an untouched number or boolean saved as text is neither rewritten nor recorded", async () => {
    await run(["init"], testContext(ws.main).ctx);
    await Bun.write(join(ws.main, ".env"), "PORT=3000\nDEBUG=true\nCODE=007\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    const lines = async () =>
      (await Bun.file(join(ws.main, ".envs/history.ndjson")).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(await lines()).toHaveLength(1);

    const state = await loadUiState(testContext(ws.main).ctx);
    expect((await saveUiState(testContext(ws.main).ctx, asText(state))).code).toBe(0);

    expect(await lines()).toHaveLength(1);
    const values = Bun.YAML.parse(await Bun.file(join(ws.main, ".envs/values.yml")).text()) as any;
    expect(values.profiles.default.envs.PORT.main).toBe(3000);
    expect(values.profiles.default.envs.DEBUG.main).toBe(true);
    expect(values.profiles.default.envs.CODE.main).toBe("007");

    // A real change is recorded with its type.
    const edited = asText(state);
    edited.profiles.default.envs.PORT.main = "3001";
    expect((await saveUiState(testContext(ws.main).ctx, edited)).code).toBe(0);
    const all = await lines();
    expect(all).toHaveLength(2);
    expect(all[1].changes).toEqual([
      { path: ["profiles", "default", "envs", "PORT", "main"], from: 3000, to: 3001 },
    ]);
  });
});

describe("push removes orphan variables", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  const main = () => join(ws.main, ".env");
  const feature = () => join(ws.worktrees["feature-x"]!, ".env");
  const valuesPath = () => join(ws.main, ".envs/values.yml");

  test("updateDotenv drops the lines of the keys to remove and keeps the rest", () => {
    const text = "# comment\nA=1\nB=2\nexport C=3\nD=4\n";
    expect(updateDotenv(text, { D: "x" }, new Set(["B", "C", "D"]))).toBe("# comment\nA=1\nD=x\n");
    expect(updateDotenv("A=1\n", {}, new Set(["A"]))).toBe("");
  });

  test("a variable envs managed and no longer resolves is removed; unmanaged ones and comments stay", async () => {
    await run(["init"], testContext(ws.main).ctx);
    await Bun.write(main(), "KEEP=1\nGONE=2\n");
    await Bun.write(feature(), "GONE=2\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    // A variable and a comment envs never saw (never pulled): they must survive.
    await appendFile(main(), "# my note\nUNMANAGED=secret\n");
    // GONE is dropped from values.yml (it stays in the history), KEEP stays.
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    delete values.profiles.default.envs.GONE;
    await Bun.write(valuesPath(), Bun.YAML.stringify(values));

    const { ctx, logs } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(0);
    expect(await Bun.file(main()).text()).toBe("KEEP=1\n# my note\nUNMANAGED=secret\n");
    // A worktree left with nothing to write is cleaned too.
    expect(await Bun.file(feature()).text()).toBe("");
    expect(logs).toEqual(["\x1b[31m✕ GONE removed from main, feature-x\x1b[0m"]);
    // The log never prints values.
    expect(logs.join("")).not.toContain("=2");

    // Nothing left to remove: a second push is silent.
    const again = testContext(ws.main);
    expect(await run(["push"], again.ctx)).toBe(0);
    expect(again.logs).toEqual([]);
  });

  test("a damaged history does not stop push: values.yml still decides what is managed", async () => {
    await Bun.write(main(), "KEEP=1\nSTALE=1\n");
    await appendFile(join(ws.main, ".envs/history.ndjson"), "not json\n");
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    values.profiles.default.envs.STALE = { main: "1" };
    await Bun.write(valuesPath(), Bun.YAML.stringify(values));
    expect(await run(["push"], testContext(ws.main).ctx)).toBe(0);
    expect(await Bun.file(main()).text()).toBe("KEEP=1\nSTALE=1\n");
  });
});

describe("the first history point holds the whole state", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  const valuesPath = () => join(ws.main, ".envs/values.yml");
  const historyPath = () => join(ws.main, ".envs/history.ndjson");
  const points = async () =>
    (await Bun.file(historyPath()).text()).trim().split("\n").map((l) => JSON.parse(l));
  /** A project that had a values.yml before the history existed: data, but no history.ndjson. */
  const legacyProject = async () => {
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
    await run(["init"], testContext(ws.main).ctx);
    await Bun.write(
      valuesPath(),
      "uses:\n  main: default\n  feature-x: default\nprofiles:\n  default:\n    defaults:\n      LOG: info\n    envs:\n      PORT:\n        main: 3000\n  staging:\n    defaults:\n      LOG: warn\n    envs: {}\n",
    );
  };

  test("use as the first command records the full state, and restore to it loses nothing", async () => {
    await legacyProject();
    expect(await run(["use", "staging"], testContext(ws.worktrees["feature-x"]!).ctx)).toBe(0);
    const [first, ...rest] = await points();
    expect(rest).toHaveLength(0);
    expect(first.prev).toBeNull();
    expect(first.changes).toContainEqual({ path: ["profiles", "default", "envs", "PORT", "main"], to: 3000 });
    expect(first.changes).toContainEqual({ path: ["profiles", "staging", "defaults", "LOG"], to: "warn" });
    expect(first.changes).toContainEqual({ path: ["uses", "feature-x"], to: "staging" });

    expect(await run(["restore", first.hash], testContext(ws.main).ctx)).toBe(0);
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    expect(values.profiles.default.defaults).toEqual({ LOG: "info" });
    expect(values.profiles.default.envs.PORT).toEqual({ main: 3000 });
    expect(values.profiles.staging.defaults).toEqual({ LOG: "warn" });
    expect(values.uses["feature-x"]).toBe("staging");
  });

  test("Save in the web editor as the first action records the full state", async () => {
    await legacyProject();
    const state = await loadUiState(testContext(ws.main).ctx);
    const { worktrees: _, ...values } = state;
    (values.profiles.default!.envs.PORT as any).main = "4000";
    await saveUiState(testContext(ws.main).ctx, values as any);
    const [first, ...rest] = await points();
    expect(rest).toHaveLength(0);
    expect(first.changes).toContainEqual({ path: ["profiles", "staging", "defaults", "LOG"], to: "warn" });
    expect(first.changes).toContainEqual({ path: ["profiles", "default", "envs", "PORT", "main"], to: 4000 });
  });

  test("later points stay small: only the first one is the whole state", async () => {
    await legacyProject();
    await run(["use", "staging"], testContext(ws.worktrees["feature-x"]!).ctx);
    await run(["use", "default"], testContext(ws.worktrees["feature-x"]!).ctx);
    const all = await points();
    expect(all).toHaveLength(2);
    expect(all[1].changes).toEqual([{ path: ["uses", "feature-x"], from: "staging", to: "default" }]);
    expect(all[1].prev).toBe(all[0].hash);
  });
});

describe("resync points", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  const valuesPath = () => join(ws.main, ".envs/values.yml");
  const points = async () =>
    (await Bun.file(join(ws.main, ".envs/history.ndjson")).text()).trim().split("\n").map((l) => JSON.parse(l));
  const edited = async (change: (values: any) => void) => {
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    change(values);
    await Bun.write(valuesPath(), Bun.YAML.stringify(values));
  };

  test("a manual edit of values.yml gets a resync point before the next operation's own point", async () => {
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
    await run(["init"], testContext(ws.main).ctx);
    await Bun.write(join(ws.main, ".env"), "A=1\n");
    await rm(join(ws.worktrees["feature-x"]!, ".env"), { force: true });
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    const [initial] = await points();

    await edited((v) => {
      v.profiles.default.defaults.MANUAL = "by-hand";
    });
    await Bun.write(join(ws.main, ".env"), "A=2\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);

    const [, resync, own, ...rest] = await points();
    expect(rest).toHaveLength(0);
    expect(resync.resync).toBe(true);
    expect(resync.prev).toBe(initial.hash);
    expect(resync.changes).toEqual([{ path: ["profiles", "default", "defaults", "MANUAL"], to: "by-hand" }]);
    expect(own.resync).toBeUndefined();
    expect(own.prev).toBe(resync.hash);
    expect(own.changes).toEqual([{ path: ["profiles", "default", "envs", "A", "main"], from: 1, to: 2 }]);
  });

  test("restore to the latest point keeps a manual edit, and resync points are valid restore targets", async () => {
    const all = await points();
    const latest = all.at(-1);
    const resync = all.find((p) => p.resync)!;
    expect(await run(["restore", latest.hash], testContext(ws.main).ctx)).toBe(0);
    expect(Bun.YAML.parse(await Bun.file(valuesPath()).text())).toMatchObject({
      profiles: { default: { defaults: { MANUAL: "by-hand" }, envs: { A: { main: 2 } } } },
    });
    // Restoring the resync point itself brings A back to what it was then (1) and keeps MANUAL.
    expect(await run(["restore", resync.hash], testContext(ws.main).ctx)).toBe(0);
    expect(Bun.YAML.parse(await Bun.file(valuesPath()).text())).toMatchObject({
      profiles: { default: { defaults: { MANUAL: "by-hand" }, envs: { A: { main: 1 } } } },
    });
  });

  test("no drift, no resync: a normal operation adds a single point", async () => {
    const before = (await points()).length;
    await Bun.write(join(ws.main, ".env"), "A=3\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    const after = await points();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1).resync).toBeUndefined();
  });

  test("the chain with resync points still verifies: each hash covers the whole line", async () => {
    let prev: string | null = null;
    for (const line of await points()) {
      const { hash, ...point } = line;
      expect(point.prev).toBe(prev);
      expect(hash).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(point)).digest("hex").slice(0, 12));
      prev = hash;
    }
  });
});

describe("a damaged history", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: [] });
  });
  afterAll(() => ws.cleanup());

  const valuesPath = () => join(ws.main, ".envs/values.yml");
  const historyPath = () => join(ws.main, ".envs/history.ndjson");
  const lines = async () => (await Bun.file(historyPath()).text()).split("\n");
  /** A project with two recorded points (the initial state and A: 1 → 2). */
  const project = async () => {
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
    await run(["init"], testContext(ws.main).ctx);
    await Bun.write(join(ws.main, ".env"), "A=1\n");
    await run(["pull"], testContext(ws.main).ctx);
    await Bun.write(join(ws.main, ".env"), "A=2\n");
    await run(["pull"], testContext(ws.main).ctx);
  };
  const valid = (text: string) => text.trim().split("\n").every((l) => { try { JSON.parse(l); return true; } catch { return false; } });

  test("an incomplete last line is ignored, warned about and dropped by the next append", async () => {
    await project();
    const [first, second] = (await lines()).filter(Boolean);
    await appendFile(historyPath(), '{"hash":"abc","prev":"x","timesta');
    await Bun.write(join(ws.main, ".env"), "A=3\n");
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["pull"], ctx)).toBe(0);
    expect(errors[0]).toContain("incomplete line");
    // The torn tail is gone and the new point chains to the last valid one.
    const text = await Bun.file(historyPath()).text();
    expect(valid(text)).toBe(true);
    expect(text).not.toContain('"hash":"abc"');
    const all = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(all).toHaveLength(3);
    expect(all[2].prev).toBe(JSON.parse(second!).hash);
    expect(JSON.parse(first!).prev).toBeNull();
    expect(Bun.YAML.parse(await Bun.file(valuesPath()).text())).toMatchObject({
      profiles: { default: { envs: { A: { main: 3 } } } },
    });
  });

  test("a valid last line without a trailing newline gets one before the next point", async () => {
    await project();
    await Bun.write(historyPath(), (await Bun.file(historyPath()).text()).trimEnd());
    await Bun.write(join(ws.main, ".env"), "A=3\n");
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["pull"], ctx)).toBe(0);
    expect(errors).toEqual([]);
    const all = (await Bun.file(historyPath()).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(all).toHaveLength(3);
    expect(all[2].prev).toBe(all[1].hash);
  });

  test("a damaged line in the middle: recording commands warn and carry on, healing with a resync point", async () => {
    await project();
    const [first, second] = (await lines()).filter(Boolean);
    await Bun.write(historyPath(), [first, "not json", second].join("\n") + "\n");
    await Bun.write(join(ws.main, ".env"), "A=3\n");
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["pull"], ctx)).toBe(0);
    expect(errors[0]).toContain("damaged lines (2)");
    const text = await Bun.file(historyPath()).text();
    // The bad line is kept (nothing is rewritten), and the points after it still record the truth.
    expect(text.split("\n")[1]).toBe("not json");
    const points = text.trim().split("\n").filter((l) => l !== "not json").map((l) => JSON.parse(l));
    expect(points.at(-1).changes).toEqual([{ path: ["profiles", "default", "envs", "A", "main"], from: 2, to: 3 }]);
  });

  test("restore refuses with a clear message, and changes nothing, while a line is damaged", async () => {
    await project();
    const [first, second] = (await lines()).filter(Boolean);
    await Bun.write(historyPath(), [first, "not json", second].join("\n") + "\n");
    const before = await Bun.file(valuesPath()).text();
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["restore", JSON.parse(first!).hash], ctx)).toBe(1);
    expect(errors[0]).toContain(".envs/history.ndjson has damaged lines (2)");
    expect(await Bun.file(valuesPath()).text()).toBe(before);
  });

  test("the history panel data lists the readable points and flags the damaged lines", async () => {
    await project();
    const [first, second] = (await lines()).filter(Boolean);
    await Bun.write(historyPath(), [first, "not json", second].join("\n") + "\n");
    const loaded = await loadUiHistory(testContext(ws.main).ctx);
    expect(loaded.points.map((p) => p.hash)).toEqual([JSON.parse(first!).hash, JSON.parse(second!).hash]);
    expect(loaded.damaged).toEqual([2]);
    // Without damage the field is absent.
    await Bun.write(historyPath(), [first, second].join("\n") + "\n");
    expect(await loadUiHistory(testContext(ws.main).ctx)).not.toHaveProperty("damaged");
  });
});

describe("names that look like prototype members in values.yml and .env files", () => {
  const clean = () => {
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as any).polluted).toBeUndefined();
  };

  test("normalizeValues keeps them as names and never reaches Object.prototype", () => {
    const raw = Bun.YAML.parse(
      [
        "uses:",
        "  constructor: __proto__",
        "profiles:",
        "  __proto__:",
        "    defaults:",
        "      toString: a",
        "    envs:",
        "      __proto__:",
        "        polluted: yes",
        "      constructor:",
        "        constructor: b",
        "",
      ].join("\n"),
    ) as any;
    const values = normalizeValues(raw);
    clean();
    expect(Object.getPrototypeOf(values.profiles)).toBeNull();
    expect(Object.hasOwn(values.profiles, "__proto__")).toBe(true);
    expect(values.profiles["__proto__"]!.defaults["toString"]).toBe("a");
    expect(values.profiles["__proto__"]!.envs["constructor"]!["constructor"]).toBe("b");
    expect(values.uses["constructor"]).toBe("__proto__");
  });

  test("stringifyValues and parsing it again keep them", () => {
    const values = normalizeValues({ profiles: { dev: { defaults: { __proto__x: 1 } as any, envs: { constructor: { toString: "v" } } } } });
    const text = stringifyValues(values);
    const again = normalizeValues(Bun.YAML.parse(text) as any);
    expect(again.profiles.dev!.envs["constructor"]!["toString"]).toBe("v");
    clean();
  });

  test("parseDotenv keeps variables named like prototype members", () => {
    const parsed = parseDotenv("constructor=1\ntoString=2\n__proto__=3\nA=4\n");
    expect(Object.keys(parsed)).toEqual(["constructor", "toString", "__proto__", "A"]);
    expect(parsed["__proto__"]).toBe("3");
    expect(({} as any).A).toBeUndefined();
    clean();
  });

  test("resolveEntries and push work for a worktree named constructor", () => {
    const values = normalizeValues({ defaults: { D: "d" }, envs: { PORT: { constructor: "3009" } } });
    expect({ ...resolveEntries(values, "constructor", "default") }).toEqual({ D: "d", PORT: "3009" });
    // A worktree that has no entry of its own never inherits one from Object.prototype.
    expect({ ...resolveEntries(values, "main", "default") }).toEqual({ D: "d" });
  });
});

describe("hash chain verification", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: [] });
  });
  afterAll(() => ws.cleanup());

  const historyPath = () => join(ws.main, ".envs/history.ndjson");
  const valuesPath = () => join(ws.main, ".envs/values.yml");
  const lines = async () => (await Bun.file(historyPath()).text()).trimEnd().split("\n");
  /** Three recorded points: the initial state and A: 1 → 2 → 3. */
  const project = async () => {
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
    await run(["init"], testContext(ws.main).ctx);
    for (const a of [1, 2, 3]) {
      await Bun.write(join(ws.main, ".env"), `A=${a}\n`);
      await run(["pull"], testContext(ws.main).ctx);
    }
    return (await lines()).map((l) => JSON.parse(l));
  };
  const restoreOf = (hash: string, ...extra: string[]) => {
    const t = testContext(ws.main);
    return run(["restore", hash, ...extra], t.ctx).then((code) => ({ code, errors: t.errors }));
  };

  test("an intact chain restores without any warning", async () => {
    const [first] = await project();
    const { code, errors } = await restoreOf(first.hash);
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(await loadUiHistory(testContext(ws.main).ctx)).not.toHaveProperty("broken");
  });

  test("an edited point (its content no longer matches its hash) makes restore refuse and change nothing", async () => {
    const [first, second] = await project();
    const all = await lines();
    all[1] = all[1]!.replace('"to":2', '"to":99');
    await Bun.write(historyPath(), all.join("\n") + "\n");
    const before = await Bun.file(valuesPath()).text();
    const { code, errors } = await restoreOf(first.hash);
    expect(code).toBe(1);
    expect(errors[0]).toContain(`${second.hash} (its content does not match its hash)`);
    expect(errors[0]).toContain("--force");
    expect(await Bun.file(valuesPath()).text()).toBe(before);
    expect((await loadUiHistory(testContext(ws.main).ctx)).broken).toEqual([second.hash]);
  });

  test("a removed point (the next one no longer follows) and reordered points are detected", async () => {
    const [first, second, third] = await project();
    await Bun.write(historyPath(), JSON.stringify(first) + "\n" + JSON.stringify(third) + "\n");
    expect((await restoreOf(first.hash)).errors[0]).toContain(`${third.hash} (it does not follow the previous point)`);
    await Bun.write(historyPath(), [first, third, second].map((p) => JSON.stringify(p)).join("\n") + "\n");
    const { code, errors } = await restoreOf(first.hash);
    expect(code).toBe(1);
    expect(errors[0]).toContain("does not follow the previous point");
  });

  test("--force restores anyway, saying so, and the broken point is not applied silently", async () => {
    const [first] = await project();
    const all = await lines();
    all[2] = all[2]!.replace('"to":3', '"to":77');
    await Bun.write(historyPath(), all.join("\n") + "\n");
    const { code, errors } = await restoreOf(first.hash, "--force");
    expect(code).toBe(0);
    expect(errors[0]).toContain("Restoring anyway (--force)");
    // The flag may come before the hash too.
    const again = testContext(ws.main);
    expect(await run(["restore", "--force", first.hash], again.ctx)).toBe(0);
  });

  test("recording commands warn about a broken chain but carry on", async () => {
    await project();
    const all = await lines();
    all[1] = all[1]!.replace('"to":2', '"to":99');
    await Bun.write(historyPath(), all.join("\n") + "\n");
    await Bun.write(join(ws.main, ".env"), "A=4\n");
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["pull"], ctx)).toBe(0);
    expect(errors[0]).toContain("the hash chain is broken at");
    expect(Bun.YAML.parse(await Bun.file(valuesPath()).text())).toMatchObject({
      profiles: { default: { envs: { A: { main: 4 } } } },
    });
  });
});

describe("values that cannot be written to a .env", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  const valuesPath = () => join(ws.main, ".envs/values.yml");
  const dotenv = (dir: string) => Bun.file(join(dir, ".env")).text();
  const project = async () => {
    await rm(join(ws.main, ".envs"), { recursive: true, force: true });
    await run(["init"], testContext(ws.main).ctx);
    await Bun.write(join(ws.main, ".env"), "KEEP=1\n");
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "KEEP=1\n");
    await run(["pull"], testContext(ws.main).ctx);
  };
  const edit = async (change: (values: any) => void) => {
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    change(values);
    await Bun.write(valuesPath(), Bun.YAML.stringify(values, null, 2));
  };

  test("push refuses a value with a line break, names it without echoing it, and writes nothing", async () => {
    await project();
    await edit((v) => {
      v.profiles.default.defaults.GOOD = "fine";
      v.profiles.default.envs.PEM = { "feature-x": "-----BEGIN KEY-----\nsecretbody\n-----END KEY-----" };
    });
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"PEM" (feature-x): the value has a line break');
    expect(errors.join("")).not.toContain("secretbody");
    // Nothing was written, not even the good value: the push is all or nothing.
    expect(await dotenv(ws.main)).toBe("KEEP=1\n");
    expect(await dotenv(ws.worktrees["feature-x"]!)).toBe("KEEP=1\n");
  });

  test("a carriage return or a line break in a variable name is refused too", async () => {
    await project();
    await edit((v) => {
      v.profiles.default.defaults["A\nB"] = "x";
      v.profiles.default.defaults["C D"] = "y";
    });
    const { ctx, errors } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(1);
    expect(errors.some((e) => e.includes('"A\\nB"') && e.includes("not a valid variable name"))).toBe(true);
    expect(errors.some((e) => e.includes('"C D"'))).toBe(true);
    expect(await dotenv(ws.main)).toBe("KEEP=1\n");
  });

  test("values with escaped \\n (one line) and other special characters are still written", async () => {
    await project();
    await edit((v) => {
      v.profiles.default.defaults.KEY = "line1\\nline2";
      v.profiles.default.defaults.SPACES = "two words # not a comment";
    });
    expect(await run(["push"], testContext(ws.main).ctx)).toBe(0);
    const parsed = parseDotenv(await dotenv(ws.main));
    expect(parsed.KEY).toBe("line1\\nline2");
    expect(parsed.SPACES).toBe("two words # not a comment");
  });

  test("Save in the web editor refuses them before writing values.yml or the history", async () => {
    await project();
    const history = join(ws.main, ".envs/history.ndjson");
    const before = { values: await Bun.file(valuesPath()).text(), history: await Bun.file(history).text() };
    const state = await loadUiState(testContext(ws.main).ctx);
    const { worktrees: _, ...values } = state;
    (values.profiles.default!.defaults as any).MULTI = "a\nINJECTED=1";
    const { ctx, errors } = testContext(ws.main);
    const result = await saveUiState(ctx, values as any);
    expect(result.code).toBe(1);
    expect(errors[0]).toContain('"MULTI" (default defaults): the value has a line break');
    expect(await Bun.file(valuesPath()).text()).toBe(before.values);
    expect(await Bun.file(history).text()).toBe(before.history);
    expect(await dotenv(ws.main)).toBe("KEEP=1\n");
  });
});

describe.skipIf(process.platform === "win32")("file permissions of .envs", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  const mode = async (path: string) => (await stat(path)).mode & 0o777;
  const envs = () => join(ws.main, ".envs");

  test("init creates the folder 700 and values.yml 600", async () => {
    await rm(envs(), { recursive: true, force: true });
    await run(["init"], testContext(ws.main).ctx);
    expect(await mode(envs())).toBe(0o700);
    expect(await mode(join(envs(), "values.yml"))).toBe(0o600);
  });

  test("a project created before (folder 755, files 644) is tightened by the next command, history included", async () => {
    await Bun.write(join(ws.main, ".env"), "A=1\n");
    await run(["pull"], testContext(ws.main).ctx);
    await Bun.write(join(envs(), "config.yml"), "history: true\n");
    await chmod(envs(), 0o755);
    for (const file of ["values.yml", "history.ndjson", "config.yml"]) await chmod(join(envs(), file), 0o644);
    await Bun.write(join(ws.main, ".env"), "A=2\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    expect(await mode(envs())).toBe(0o700);
    for (const file of ["values.yml", "history.ndjson", "config.yml"]) expect(await mode(join(envs(), file))).toBe(0o600);
    expect(await Bun.file(join(envs(), "lock")).exists()).toBe(false);
  });

  test("push creates a missing .env 600 and tightens an existing one to 600", async () => {
    await rm(join(ws.main, ".env"), { force: true });
    await Bun.write(join(ws.worktrees["feature-x"]!, ".env"), "B=1\n");
    await chmod(join(ws.worktrees["feature-x"]!, ".env"), 0o640);
    await Bun.write(join(envs(), "values.yml"), "defaults:\n  D: 1\n");
    expect(await run(["push"], testContext(ws.main).ctx)).toBe(0);
    expect(await mode(join(ws.main, ".env"))).toBe(0o600);
    expect(await mode(join(ws.worktrees["feature-x"]!, ".env"))).toBe(0o600);
  });
});

describe("secrets in the history and in the console", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: ["feature-x"] });
  });
  afterAll(() => ws.cleanup());

  const envs = () => join(ws.main, ".envs");
  const historyText = () => Bun.file(join(envs(), "history.ndjson")).text();
  const points = async () => (await historyText()).trim().split("\n").map((l) => JSON.parse(l));
  const dotenv = (dir = ws.main) => Bun.file(join(dir, ".env")).text();
  const project = async (dotenvText: string, options: { keepSecrets?: boolean } = {}) => {
    await rm(envs(), { recursive: true, force: true });
    await rm(join(ws.worktrees["feature-x"]!, ".env"), { force: true });
    await run(["init"], testContext(ws.main).ctx);
    if (options.keepSecrets) await run(["config", "set", "history.secrets", "true"], testContext(ws.main).ctx);
    await Bun.write(join(ws.main, ".env"), dotenvText);
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
  };

  test("secrets never reach the history: sensitive names and URLs with a password are stored as fingerprints", async () => {
    await project("PORT=3000\nAPI_TOKEN=tok-one\nDB_PASSWORD=pw-one\nDATABASE_URL=postgres://shop:urlpass@db.invalid/shop\nCALLBACK=https://x.invalid/cb?api_key=qs-secret&page=2\nSAFE_URL=https://example.com/a\n");
    const text = await historyText();
    for (const secret of ["tok-one", "pw-one", "urlpass", "qs-secret"]) expect(text).not.toContain(secret);
    expect(text).toContain("envs:redacted:");
    // What is not a secret stays readable.
    expect(text).toContain("https://example.com/a");
    expect(text).toContain('"to":3000');
    // values.yml is untouched: it still has the real values.
    expect(await Bun.file(join(envs(), "values.yml")).text()).toContain("tok-one");
  });

  test("a rotated secret is recorded as a change (its fingerprint differs) without ever being stored", async () => {
    await project("API_TOKEN=tok-one\n");
    const [first] = await points();
    const fingerprint = first.changes.find((c: any) => c.path.at(-2) === "API_TOKEN").to;
    await Bun.write(join(ws.main, ".env"), "API_TOKEN=tok-two\n");
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    const [, second, ...rest] = await points();
    expect(rest).toHaveLength(0);
    expect(second.changes).toEqual([
      { path: ["profiles", "default", "envs", "API_TOKEN", "main"], from: fingerprint, to: expect.stringMatching(/^envs:redacted:[0-9a-f]{16}$/) },
    ]);
    expect(second.changes[0].to).not.toBe(fingerprint);
    expect(await historyText()).not.toMatch(/tok-(one|two)/);
    // Pulling again with the same secret adds nothing: the fingerprint is stable.
    expect(await run(["pull"], testContext(ws.main).ctx)).toBe(0);
    expect(await points()).toHaveLength(2);
  });

  test("the key of the fingerprints is created 600 and nothing else needs it to replay the history", async () => {
    await project("API_TOKEN=tok-one\n");
    const key = join(envs(), "history.key");
    expect(await Bun.file(key).exists()).toBe(true);
    if (process.platform !== "win32") expect((await stat(key)).mode & 0o777).toBe(0o600);
    expect((await Bun.file(key).text()).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("restore keeps the current secrets and says so; it drops a secret the project no longer has", async () => {
    await project("PORT=3000\nAPI_TOKEN=tok-one\n");
    const [first] = await points();
    await Bun.write(join(ws.main, ".env"), "PORT=4000\nAPI_TOKEN=tok-two\nOLD_PASSWORD=gone-soon\n");
    await run(["pull"], testContext(ws.main).ctx);
    // Remove OLD_PASSWORD from values.yml and the .env, then restore the first point.
    const values = Bun.YAML.parse(await Bun.file(join(envs(), "values.yml")).text()) as any;
    delete values.profiles.default.envs.OLD_PASSWORD;
    await Bun.write(join(envs(), "values.yml"), Bun.YAML.stringify(values, null, 2));
    const { ctx, logs } = testContext(ws.main);
    expect(await run(["restore", first.hash], ctx)).toBe(0);
    const restored = Bun.YAML.parse(await Bun.file(join(envs(), "values.yml")).text()) as any;
    expect(restored.profiles.default.envs.PORT.main).toBe(3000);
    // The old token (tok-one) is not stored, so the current one (tok-two) stays.
    expect(restored.profiles.default.envs.API_TOKEN.main).toBe("tok-two");
    expect(logs.join("\n")).toContain("! API_TOKEN (default main): kept the current value, the history does not keep the old one");
    expect(logs.join("\n")).not.toMatch(/tok-(one|two)/);
  });

  test("history.secrets true keeps secrets in clear, and restore then restores them exactly", async () => {
    await project("API_TOKEN=tok-one\n", { keepSecrets: true });
    const [first] = await points();
    expect(await historyText()).toContain("tok-one");
    await Bun.write(join(ws.main, ".env"), "API_TOKEN=tok-two\n");
    await run(["pull"], testContext(ws.main).ctx);
    expect(await run(["restore", first.hash], testContext(ws.main).ctx)).toBe(0);
    expect(await dotenv()).toContain("API_TOKEN=tok-one");
    expect(await Bun.file(join(envs(), "history.key")).exists()).toBe(false);
  });

  test("`envs history redact` removes the secrets in clear from an old history and relinks its chain", async () => {
    await project("PORT=3000\nAPI_TOKEN=tok-one\n", { keepSecrets: true });
    await Bun.write(join(ws.main, ".env"), "PORT=3001\nAPI_TOKEN=tok-two\n");
    await run(["pull"], testContext(ws.main).ctx);
    expect(await historyText()).toMatch(/tok-one/);
    const before = await points();
    await run(["config", "set", "history.secrets", "false"], testContext(ws.main).ctx);

    const { ctx, logs } = testContext(ws.main);
    expect(await run(["history", "redact"], ctx)).toBe(0);
    expect(logs[0]).toContain("redacted 3 secret value(s)");
    expect(await historyText()).not.toMatch(/tok-(one|two)/);
    // Same points, same order and timestamps, a valid chain (restore does not complain).
    const after = await points();
    expect(after.map((p) => p.timestamp)).toEqual(before.map((p) => p.timestamp));
    expect(after[0].prev).toBeNull();
    expect(after[1].prev).toBe(after[0].hash);
    const restoreRun = testContext(ws.main);
    expect(await run(["restore", after[0].hash], restoreRun.ctx)).toBe(0);
    expect(restoreRun.errors).toEqual([]);
    // Nothing left to redact: a second run says so and does not touch the file.
    const text = await historyText();
    const again = testContext(ws.main);
    expect(await run(["history", "redact"], again.ctx)).toBe(0);
    expect(again.logs[0]).toContain("nothing to redact");
    expect(await historyText()).toBe(text);
    // And it refuses a history whose chain is broken.
    await Bun.write(join(envs(), "history.ndjson"), text.replace('"to":3001', '"to":9999'));
    const broken = testContext(ws.main);
    expect(await run(["history", "redact"], broken.ctx)).toBe(1);
    expect(await run(["history"], testContext(ws.main).ctx)).toBe(1);
  });

  test("push and restore never print a URL password, nor the values of sensitive variables", async () => {
    await project("DATABASE_URL=postgres://localhost/shop\nAPI_TOKEN=tok-one\n");
    await Bun.write(join(envs(), "values.yml"), (await Bun.file(join(envs(), "values.yml")).text()).replace("postgres://localhost/shop", "postgres://shop:urlpass@db.invalid/shop?sslmode=require&token=qs-secret"));
    const { ctx, logs } = testContext(ws.main);
    expect(await run(["push"], ctx)).toBe(0);
    const out = logs.join("\n");
    expect(out).not.toMatch(/urlpass|qs-secret|tok-one/);
    expect(out).toContain("postgres://shop:********@db.invalid/shop?sslmode=require&token=********");
    // The .env itself has the real value.
    expect(await dotenv()).toContain("urlpass");
  });
});

