import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { $ } from "bun";
import { rules, type LintContext } from "./lint-rules";

export const HELP = `Usage: envs <command>

Commands:
  init    Create the .envs/ directory (.gitignore, values.yml)
  pull    Read each worktree's .env and write it into .envs/values.yml
  push    Write defaults and .envs/values.yml into the .env of each worktree
  lint    Warn about insecure values and unprotected secret files
  edit    Pull, open .envs/values.yml in VS Code (code -w), then push
  help    Show this help message
`;

export interface Context {
  /** Directory the command runs from. */
  cwd: string;
  log(message: string): void;
  error(message: string): void;
  /** Opens a file in the editor and resolves with its exit code once closed. */
  openEditor(path: string): Promise<number>;
}

export const defaultContext = (): Context => ({
  cwd: process.cwd(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  openEditor: async (path) => {
    const proc = Bun.spawn(["code", "-w", path], {
      env: { ...process.env },
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  },
});

/** YAML scalar accepted as a value; numbers and booleans are written to .env as their string form. */
type Value = string | number | boolean;

interface Values {
  defaults?: Record<string, Value>;
  envs?: Record<string, Record<string, Value>>;
}

export interface Worktree {
  name: string;
  path: string;
}

/** Root of the main git workspace; inside a worktree this is the parent repo. Falls back to cwd outside git. */
export async function findRoot(cwd: string): Promise<string> {
  const result = await $`git rev-parse --path-format=absolute --git-common-dir`
    .cwd(cwd)
    .nothrow()
    .quiet();
  if (result.exitCode !== 0) return cwd;
  return dirname(result.stdout.toString().trim());
}

/** Lists the main workspace and its worktrees; `name` is the branch (or dir name when detached). */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await $`git worktree list --porcelain`.cwd(cwd).text();
  return out
    .trim()
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))!.slice(9);
      const branch = lines.find((l) => l.startsWith("branch "));
      return {
        path,
        name: branch
          ? branch.slice("branch refs/heads/".length)
          : basename(path),
      };
    });
}

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes and `export`. */
export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    result[match[1]!] = value;
  }
  return result;
}

/** Turns "true"/"false" and canonical numbers ("3000", "0.5") into YAML scalars; anything else stays a string. */
export function parseValue(value: string): Value {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    // Keep strings that would not round-trip (leading zeros, huge ints).
    if (String(number) === value) return number;
  }
  return value;
}

export function formatDotenvValue(value: string): string {
  if (value !== "" && !/[\s#"'\\$]/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/** Sets KEY=VALUE for each entry, updating existing lines in place and appending new ones. */
export function updateDotenv(
  text: string,
  entries: Record<string, string>,
): string {
  const pending = new Map(Object.entries(entries));
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const updated = lines.map((line) => {
    const key = line.trim().match(/^(?:export\s+)?([\w.-]+)\s*=/)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${formatDotenvValue(value)}`;
  });
  for (const [key, value] of pending) {
    updated.push(`${key}=${formatDotenvValue(value)}`);
  }
  return updated.join("\n") + "\n";
}

/** Reads values.yml; returns undefined (after reporting) when `envs init` was not run. */
async function readValues(
  ctx: Context,
): Promise<{ path: string; values: Values } | undefined> {
  const path = join(await findRoot(ctx.cwd), ".envs/values.yml");
  if (!(await Bun.file(path).exists())) {
    ctx.error(`${path} not found. Run \`envs init\` first.`);
    return undefined;
  }
  const values = (Bun.YAML.parse(await Bun.file(path).text()) ?? {}) as Values;
  return { path, values };
}

export async function init(ctx: Context): Promise<number> {
  const root = await findRoot(ctx.cwd);
  const files = { ".envs/.gitignore": "*\n", ".envs/values.yml": "" };
  await mkdir(join(root, ".envs"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    if (await Bun.file(path).exists()) {
      ctx.log(`${path} already exists`);
    } else {
      await Bun.write(path, content);
      ctx.log(`Created ${path}`);
    }
  }
  return 0;
}

export async function push(ctx: Context): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const { values } = read;
  for (const { name, path } of await listWorktrees(ctx.cwd)) {
    // Defaults apply to every worktree; per-worktree values override them.
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(values.defaults ?? {})) {
      entries[key] = String(value);
    }
    for (const [key, byWorktree] of Object.entries(values.envs ?? {})) {
      if (name in byWorktree) entries[key] = String(byWorktree[name]);
    }
    if (Object.keys(entries).length === 0) continue;
    const dotenv = Bun.file(join(path, ".env"));
    const current = (await dotenv.exists()) ? await dotenv.text() : "";
    await Bun.write(dotenv, updateDotenv(current, entries));
    ctx.log(`Pushed ${name}`);
  }
  return 0;
}

export async function pull(ctx: Context): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const { path: valuesPath, values } = read;
  const envs = (values.envs ??= {});
  for (const { name, path } of await listWorktrees(ctx.cwd)) {
    const dotenv = Bun.file(join(path, ".env"));
    if (!(await dotenv.exists())) continue;
    const parsed = parseDotenv(await dotenv.text());
    // Drop keys that are no longer in this worktree's .env.
    for (const [key, byWorktree] of Object.entries(envs)) {
      if (!(key in parsed)) delete byWorktree[name];
    }
    for (const [key, value] of Object.entries(parsed)) {
      (envs[key] ??= {})[name] = parseValue(value);
    }
    ctx.log(`Pulled ${name}`);
  }
  for (const [key, byWorktree] of Object.entries(envs)) {
    if (Object.keys(byWorktree).length === 0) delete envs[key];
  }
  await Bun.write(valuesPath, Bun.YAML.stringify(values, null, 2));
  return 0;
}

/** Whether git ignores `file` inside `dir` (true when it would not be committed). */
async function isIgnored(dir: string, file: string): Promise<boolean> {
  const result = await $`git check-ignore -q ${file}`.cwd(dir).nothrow().quiet();
  return result.exitCode === 0;
}

/** Whether git tracks `file` inside `dir`. */
async function isTracked(dir: string, file: string): Promise<boolean> {
  const result = await $`git ls-files --error-unmatch ${file}`
    .cwd(dir)
    .nothrow()
    .quiet();
  return result.exitCode === 0;
}

/** Runs each rule of lint-rules.ts one by one and prints a warning per violation. */
export async function lint(ctx: Context): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const root = await findRoot(ctx.cwd);
  const worktrees = await listWorktrees(ctx.cwd);
  const dotenvs: Worktree[] = [];
  for (const worktree of worktrees) {
    if (await Bun.file(join(worktree.path, ".env")).exists()) dotenvs.push(worktree);
  }
  const lintContext: LintContext = {
    values: read.values,
    root,
    valuesMode:
      process.platform === "win32" ? undefined : (await stat(read.path)).mode,
    dotenvs,
    isTracked,
    isIgnored,
  };

  let count = 0;
  for (const rule of rules) {
    for (const { location, message } of await rule.check(lintContext)) {
      ctx.error(`warning [${rule.id}] ${location}: ${message}`);
      count++;
    }
  }
  if (count === 0) {
    ctx.log("No security problems found.");
    return 0;
  }
  ctx.error(`\n${count} warning(s) found.`);
  return 1;
}

export async function edit(ctx: Context): Promise<number> {
  const pulled = await pull(ctx);
  if (pulled !== 0) return pulled;
  const valuesPath = join(await findRoot(ctx.cwd), ".envs/values.yml");
  const code = await ctx.openEditor(valuesPath);
  if (code !== 0) return code;
  return await push(ctx);
}

/** Runs a command; resolves with the process exit code. */
export async function run(
  args: string[],
  ctx: Context = defaultContext(),
): Promise<number> {
  const [command = "help"] = args;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      ctx.log(HELP);
      return 0;
    case "init":
      return await init(ctx);
    case "push":
      return await push(ctx);
    case "pull":
      return await pull(ctx);
    case "lint":
      return await lint(ctx);
    case "edit":
      return await edit(ctx);
    default:
      ctx.error(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}
