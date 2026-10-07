import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";

export interface CreateWorkspaceOptions {
  /** Name of the main workspace (used as temp dir prefix). Default: "main". */
  main?: string;
  /** Worktree names; each gets a branch of the same name in its own temp dir. */
  worktrees?: string[];
  /** Files (path -> content) committed on the main workspace before the worktrees are created. */
  files?: Record<string, string>;
}

export interface Workspace {
  /** Path of the main git workspace (temp dir). */
  main: string;
  /** Worktree paths by name, each living in its own temp dir. */
  worktrees: Record<string, string>;
  /** Removes every temp dir created by the fixture. */
  cleanup(): Promise<void>;
}

/**
 * Creates a temp git repo (main workspace) plus one worktree per given name,
 * each in its own temp dir. `files` are committed on main first, so every
 * worktree starts with them.
 *
 * @example
 * const ws = await createWorkspace({
 *   main: "main",
 *   worktrees: ["worktree-1", "wt-2"],
 *   files: { foo: "biz" },
 * });
 */
export async function createWorkspace(
  options: CreateWorkspaceOptions = {},
): Promise<Workspace> {
  const { main: mainName = "main", worktrees: names = [], files = {} } =
    options;
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

  for (const [path, content] of Object.entries(files)) {
    const file = join(main, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await $`git -C ${main} add -A`;
  await $`git -C ${main} commit -q --allow-empty -m init`;

  const worktrees: Record<string, string> = {};
  for (const name of names) {
    const dir = await mk(`envs-${name}`);
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
