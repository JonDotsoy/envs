import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

export interface Workspace {
  /** Path of the main git workspace (temp dir). */
  main: string;
  /** Worktrees by name, each living in its own temp dir. */
  worktrees: Record<string, string>;
  /** Removes every temp dir created by the fixture. */
  cleanup(): Promise<void>;
}

/**
 * Creates a temp git repo (main workspace) plus one worktree per given name,
 * each in its own temp dir.
 *
 * @example
 * const ws = await CreateWorkspace("main", "worktree-1", "wt-2");
 */
export async function CreateWorkspace(
  ...names: string[]
): Promise<Workspace> {
  const [mainName = "main", ...worktreeNames] = names;
  const dirs: string[] = [];
  const mk = async (prefix: string) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)));
    dirs.push(dir);
    return dir;
  };

  const main = await mk(`envs-${mainName}`);
  await $`git init -q -b main ${main}`;
  await $`git -C ${main} config user.email test@example.com`;
  await $`git -C ${main} config user.name Test`;
  await $`git -C ${main} commit -q --allow-empty -m init`;

  const worktrees: Record<string, string> = {};
  for (const name of worktreeNames) {
    const dir = await mk(`envs-${name}`);
    // mkdtemp already created the dir; git requires it to be empty, which it is.
    await $`git -C ${main} worktree add -q -b ${name} ${dir}`;
    worktrees[name] = dir;
  }

  return {
    main,
    worktrees,
    cleanup: async () => {
      await Promise.all(
        dirs.map((d) => rm(d, { recursive: true, force: true })),
      );
    },
  };
}
