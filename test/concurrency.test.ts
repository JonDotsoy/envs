import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { applyChanges, emptyState, readHistoryPoints, type NormalizedValues } from "../src/envs";
import { createWorkspace, type Workspace } from "./fixtures/workspace";

const CLI = join(import.meta.dir, "../src/bin/envs.ts");

/** Runs the real CLI as a separate process. */
const envs = (cwd: string, ...args: string[]) =>
  Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
const finished = async (proc: ReturnType<typeof envs>) => ({
  code: await proc.exited,
  err: await new Response(proc.stderr).text(),
});

describe("several envs processes at the same time", () => {
  let ws: Workspace;
  const names = ["feature-a", "feature-b", "feature-c"];
  const dirs = () => [ws.main, ...names.map((n) => ws.worktrees[n]!)];
  const valuesPath = () => join(ws.main, ".envs/values.yml");

  beforeAll(async () => {
    ws = await createWorkspace({ worktrees: names });
    for (const dir of dirs()) await Bun.write(join(dir, ".env"), "BASE=1\n");
    expect(await envs(ws.main, "init").exited).toBe(0);
    expect(await envs(ws.main, "pull").exited).toBe(0);
  });
  afterAll(() => ws.cleanup());

  test("concurrent pulls keep one linear chain, the history matches values.yml, and no change is lost", async () => {
    const rounds = 3;
    for (let round = 0; round < rounds; round++) {
      for (const [i, dir] of dirs().entries()) await appendFile(join(dir, ".env"), `RACE_${round}_${i}=v${i}\n`);
      const results = await Promise.all(dirs().flatMap((dir) => [envs(dir, "pull"), envs(dir, "pull")]).map(finished));
      for (const { code, err } of results) {
        expect(err).toBe("");
        expect(code).toBe(0);
      }
    }
    const points = await readHistoryPoints(ws.main);
    // One linear chain: every prev is the previous hash, and no hash repeats.
    points.forEach((point, i) => expect(point.prev).toBe(i === 0 ? null : points[i - 1]!.hash));
    expect(new Set(points.map((p) => p.hash)).size).toBe(points.length);
    // Replaying the whole history gives values.yml back, and every variable written is in it.
    const replay = emptyState();
    for (const point of points) applyChanges(replay, point.changes);
    const values = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    for (let round = 0; round < rounds; round++) {
      for (const [i, dir] of dirs().entries()) {
        const worktree = i === 0 ? "main" : names[i - 1]!;
        expect(replay.profiles.default!.envs[`RACE_${round}_${i}`]?.[worktree]).toBe(`v${i}`);
        expect(values.profiles.default.envs[`RACE_${round}_${i}`][worktree]).toBe(`v${i}`);
        expect(await Bun.file(join(dir, ".env")).text()).toContain(`RACE_${round}_${i}=v${i}`);
      }
    }
    expect(Object.keys((replay as NormalizedValues).profiles.default!.envs).length).toBe(Object.keys(values.profiles.default.envs).length);
    expect(await Bun.file(join(ws.main, ".envs/lock")).exists()).toBe(false);
  }, 120_000);

  test("concurrent `use` of different worktrees keeps every selection", async () => {
    const y = Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any;
    y.profiles.dev = { defaults: {}, envs: {} };
    await Bun.write(valuesPath(), Bun.YAML.stringify(y, null, 2));
    // Ten rounds: before the lock, 7 in 10 lost a selection.
    for (let round = 0; round < 10; round++) {
      await Promise.all(names.map((n) => finished(envs(ws.worktrees[n]!, "use", "default"))));
      const results = await Promise.all(names.map((n) => finished(envs(ws.worktrees[n]!, "use", "dev"))));
      for (const { code, err } of results) {
        expect(err).toBe("");
        expect(code).toBe(0);
      }
      const uses = (Bun.YAML.parse(await Bun.file(valuesPath()).text()) as any).uses;
      for (const n of names) expect(uses[n]).toBe("dev");
    }
  }, 180_000);

  test("a lock left by a process that died is taken over, and the lock is released afterwards", async () => {
    await Bun.write(join(ws.main, ".envs/lock"), "999999 0\n"); // no such process
    const { code, err } = await finished(envs(ws.main, "pull"));
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(await Bun.file(join(ws.main, ".envs/lock")).exists()).toBe(false);
  });

  test("a lock held by a live process makes the command wait, then proceed when it is released", async () => {
    const holder = Bun.spawn(["sleep", "30"]);
    await Bun.write(join(ws.main, ".envs/lock"), `${holder.pid} ${Date.now()}\n`);
    const waiting = envs(ws.main, "pull");
    await Bun.sleep(600);
    // Still waiting: it has not finished while the lock is held.
    expect(waiting.exitCode).toBeNull();
    await rm(join(ws.main, ".envs/lock"));
    expect((await finished(waiting)).code).toBe(0);
    holder.kill();
  }, 60_000);

  test("without .envs (before init) no lock is created and commands report the usual error", async () => {
    const bare = await createWorkspace({ worktrees: [] });
    try {
      const { code, err } = await finished(envs(bare.main, "pull"));
      expect(code).toBe(1);
      expect(err).toContain("Run `envs init` first.");
      expect(await Bun.file(join(bare.main, ".envs")).exists()).toBe(false);
    } finally {
      await bare.cleanup();
    }
  });
});
