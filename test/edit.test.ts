import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

const bin = join(import.meta.dir, "../src/bin/envs.ts");

let ws: Workspace;
let fakeBin: string;
let argsFile: string;
beforeAll(async () => {
  ws = await createWorkspace({ worktrees: ["one"], files: {} });
  // Fake `code` first in PATH: records how it was called.
  fakeBin = await mkdtemp(join(tmpdir(), "envs-fakebin-"));
  argsFile = join(fakeBin, "args.txt");
  const code = join(fakeBin, "code");
  await Bun.write(code, `#!/bin/sh\necho "$@" >> "${argsFile}"\n`);
  await chmod(code, 0o755);
});
afterAll(async () => {
  await ws.cleanup();
  await rm(fakeBin, { recursive: true, force: true });
});

const valuesPath = () => join(ws.main, ".envs/values.yml");
const codeCalls = async () => ((await Bun.file(argsFile).exists()) ? (await Bun.file(argsFile).text()).trim() : "");

/** Runs `envs edit ...` with the fake `code` in PATH. A server is stopped with SIGINT once its address is printed. */
async function edit(args: string[]) {
  await rm(argsFile, { force: true });
  const proc = Bun.spawn(["bun", bin, "edit", ...args], {
    cwd: ws.main,
    // BROWSER=true: the address is "opened" by a no-op instead of a real browser.
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BROWSER: "true", TERM_PROGRAM: "vscode" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let serving = false;
  const stop = () => {
    serving = true;
    proc.kill("SIGINT");
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
    if (!serving && /Web editor running at \S+/.test(out)) stop();
  }
  await proc.exited;
  clearTimeout(timeout);
  return { out, serving, code: proc.exitCode };
}

const setUiConfig = (value: string) => Bun.spawn(["bun", bin, "config", "set", "edit.ui", value], { cwd: ws.main }).exited;

describe("envs edit", () => {
  test("serves the web editor by default, prints the values.yml path and does not call code", async () => {
    const { out, serving } = await edit([]);
    expect(serving).toBe(true);
    expect(out).toContain(valuesPath());
    expect(out).toMatch(/Web editor running at http:\/\/127\.0\.0\.1:\d+\//);
    expect(await codeCalls()).toBe("");
  });

  test("with edit.ui false only prints the values.yml path: no server, no code", async () => {
    await setUiConfig("false");
    const { out, serving, code } = await edit([]);
    expect(code).toBe(0);
    expect(serving).toBe(false);
    expect(out).toContain(valuesPath());
    expect(out).not.toContain("Web editor running");
    expect(await codeCalls()).toBe("");
    await Bun.spawn(["bun", bin, "config", "delete", "edit.ui"], { cwd: ws.main }).exited;
  });

  test("--ui prints the values.yml path and the address even with edit.ui false", async () => {
    await setUiConfig("false");
    const { out, serving } = await edit(["--ui"]);
    expect(serving).toBe(true);
    expect(out).toContain(valuesPath());
    expect(out).toMatch(/Web editor running at http:\/\/127\.0\.0\.1:\d+\//);
    expect(await codeCalls()).toBe("");
    await Bun.spawn(["bun", bin, "config", "delete", "edit.ui"], { cwd: ws.main }).exited;
  });

  test("--code opens values.yml with code and starts no server", async () => {
    const { out, serving, code } = await edit(["--code"]);
    expect(code).toBe(0);
    expect(serving).toBe(false);
    expect(out).not.toContain("Web editor running");
    expect(await codeCalls()).toBe(`-w ${valuesPath()}`);
  });

  test("--ui and --code together are refused", async () => {
    const { code } = await edit(["--ui", "--code"]);
    expect(code).toBe(1);
    expect(await codeCalls()).toBe("");
  });
});
