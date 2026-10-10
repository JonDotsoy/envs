import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { $ } from "bun";
import { isSensitiveKey, rules, type LintContext } from "./lint-rules";

export const HELP = `Usage: envs <command>

Commands:
  init    Create the .envs/ directory (.gitignore, values.yml)
  pull    Read each worktree's .env and write it into .envs/values.yml
  push    Write defaults and .envs/values.yml into the .env of each worktree
  lint    Warn about insecure values and unprotected secret files
  edit    Pull, open .envs/values.yml in VS Code (code -w), then push
  use     Select the profile of the current worktree (envs use <profile>), or list them
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

/** Colors are skipped when NO_COLOR (https://no-color.org) is set to a non-empty value. */
const colorsDisabled = () => Boolean(process.env.NO_COLOR);
/** Printed instead of the value of sensitive variables so secrets never reach stdout. */
const MASK = "********";
/** Sensitive per the lint rules, plus a bare KEY word (KEY_FOO, FOO_KEY). */
const isMaskedKey = (key: string) =>
  isSensitiveKey(key) || /(^|_)KEY(_|$)/i.test(key);
const paint = (code: number, text: string) =>
  colorsDisabled() ? text : `\x1b[${code}m${text}\x1b[0m`;
const green = (text: string) => paint(32, text);
const yellow = (text: string) => paint(33, text);

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

/** Values of one profile: `defaults` for every worktree and `envs.<VAR>.<worktree>` overrides. */
interface Profile {
  defaults?: Record<string, Value>;
  envs?: Record<string, Record<string, Value>>;
}

/** values.yml as written. Root-level `defaults`/`envs` are the legacy form of `profiles.default`. */
interface Values extends Profile {
  /** Profile of each worktree; worktrees that are not listed use `default`. */
  uses?: Record<string, string>;
  profiles?: Record<string, Profile | null>;
}

interface ResolvedProfile {
  defaults: Record<string, Value>;
  envs: Record<string, Record<string, Value>>;
}

/** values.yml with the legacy form folded into `profiles.default`; `default` always exists. */
export interface NormalizedValues {
  uses: Record<string, string>;
  profiles: Record<string, ResolvedProfile>;
}

const DEFAULT_PROFILE = "default";
const hasProfile = (values: NormalizedValues, name: string) =>
  Object.hasOwn(values.profiles, name);

/** Folds root-level `defaults`/`envs` into `profiles.default` (an explicit `profiles.default` wins). */
export function normalizeValues(raw: Values): NormalizedValues {
  const profiles: Record<string, ResolvedProfile> = {};
  const add = (name: string, profile?: Profile | null) => {
    const target = (profiles[name] ??= { defaults: {}, envs: {} });
    Object.assign(target.defaults, profile?.defaults);
    for (const [key, byWorktree] of Object.entries(profile?.envs ?? {})) {
      Object.assign((target.envs[key] ??= {}), byWorktree);
    }
  };
  add(DEFAULT_PROFILE, { defaults: raw.defaults, envs: raw.envs });
  for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
    add(name, profile);
  }
  return { uses: { ...raw.uses }, profiles };
}

/**
 * Creates every profile named in `uses` that does not exist yet as a copy of `default`.
 * A profile exists as soon as its key is in `profiles`, even if it is empty.
 * Returns the names of the created profiles.
 */
export function materializeProfiles(values: NormalizedValues): string[] {
  const created: string[] = [];
  for (const name of Object.values(values.uses).map(String)) {
    if (hasProfile(values, name)) continue;
    values.profiles[name] = structuredClone(values.profiles[DEFAULT_PROFILE]!);
    created.push(name);
  }
  return created;
}

/**
 * The variables a worktree receives. Precedence, lowest first: `default` defaults,
 * `default` envs, the profile's defaults, the profile's envs.
 * `includeProfileEnvs: false` leaves out the last layer (what `pull` compares against).
 */
export function resolveEntries(
  values: NormalizedValues,
  worktree: string,
  profile: string,
  includeProfileEnvs = true,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of new Set([DEFAULT_PROFILE, profile])) {
    const layer = values.profiles[name]!;
    for (const [key, value] of Object.entries(layer.defaults)) {
      entries[key] = String(value);
    }
    if (name === profile && !includeProfileEnvs) continue;
    for (const [key, byWorktree] of Object.entries(layer.envs)) {
      if (byWorktree && worktree in byWorktree) {
        entries[key] = String(byWorktree[worktree]);
      }
    }
  }
  return entries;
}

/** The text written to values.yml: only `uses` and `profiles`, without empty `envs`. */
function stringifyValues(values: NormalizedValues): string {
  const profiles = Object.fromEntries(
    Object.entries(values.profiles).map(([name, { defaults, envs }]) => {
      const kept = Object.fromEntries(
        Object.entries(envs).filter(([, byWorktree]) => Object.keys(byWorktree).length > 0),
      );
      return [name, Object.keys(kept).length > 0 ? { defaults, envs: kept } : { defaults }];
    }),
  );
  const out = Object.keys(values.uses).length > 0 ? { uses: values.uses, profiles } : { profiles };
  return Bun.YAML.stringify(out, null, 2);
}

/** Reports every worktree whose profile does not exist; true when all are known. */
function checkProfiles(
  ctx: Context,
  values: NormalizedValues,
  worktrees: Worktree[],
): boolean {
  let ok = true;
  for (const { name } of worktrees) {
    const profile = values.uses[name] ?? DEFAULT_PROFILE;
    if (hasProfile(values, profile)) continue;
    ok = false;
    ctx.error(
      `Unknown profile "${profile}" for worktree ${name}. Available: ${Object.keys(values.profiles).join(", ")}. Run \`envs edit\` to create it.`,
    );
  }
  return ok;
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

/** Writes the values of each worktree's profile to its `.env`; `only` limits it to one worktree. */
export async function push(ctx: Context, only?: string): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const values = normalizeValues(read.values);
  const worktrees = (await listWorktrees(ctx.cwd)).filter(
    ({ name }) => only === undefined || name === only,
  );
  if (!checkProfiles(ctx, values, worktrees)) return 1;
  // Changed variables, grouped by `KEY=VALUE` so each log line lists every branch it changed in.
  const changes = new Map<string, string[]>();
  for (const { name, path } of worktrees) {
    const profile = values.uses[name] ?? DEFAULT_PROFILE;
    const entries = resolveEntries(values, name, profile);
    if (Object.keys(entries).length === 0) continue;
    // Worktrees on a profile other than `default` are labelled in the log.
    const label = profile === DEFAULT_PROFILE ? name : `${name} [${profile}]`;
    const dotenv = Bun.file(join(path, ".env"));
    const current = (await dotenv.exists()) ? await dotenv.text() : "";
    const existing = parseDotenv(current);
    for (const [key, value] of Object.entries(entries)) {
      if (existing[key] === value) continue;
      const shown = isMaskedKey(key) ? MASK : formatDotenvValue(value);
      const line = `${key}=${shown}`;
      // Different secret values share a masked line, so group by what is printed.
      changes.set(line, [...(changes.get(line) ?? []), label]);
    }
    await Bun.write(dotenv, updateDotenv(current, entries));
  }
  for (const [line, names] of changes) {
    ctx.log(yellow(`↻ ${line} → ${names.join(", ")}`));
  }
  return 0;
}

export async function pull(ctx: Context): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const values = normalizeValues(read.values);
  const worktrees = await listWorktrees(ctx.cwd);
  // A profile named in `uses` that does not exist yet starts as a copy of `default`.
  materializeProfiles(values);
  const pulledNames: string[] = [];
  const pulledKeys = new Set<string>();
  for (const { name, path } of worktrees) {
    const profile = (values.uses[name] ??= DEFAULT_PROFILE);
    const dotenv = Bun.file(join(path, ".env"));
    if (!(await dotenv.exists())) continue;
    const parsed = parseDotenv(await dotenv.text());
    pulledNames.push(name);
    for (const key of Object.keys(parsed)) pulledKeys.add(key);
    const { envs } = values.profiles[profile]!;
    // Drop keys that are no longer in this worktree's .env.
    for (const [key, byWorktree] of Object.entries(envs)) {
      if (!(key in parsed)) delete byWorktree[name];
    }
    // What the worktree would get without its own entries in this profile.
    const base = resolveEntries(values, name, profile, false);
    for (const [key, value] of Object.entries(parsed)) {
      const parsedValue = parseValue(value);
      // A value equal to what the profile already provides needs no entry.
      if (key in base && base[key] === String(parsedValue)) {
        if (envs[key]) delete envs[key]![name];
      } else {
        (envs[key] ??= {})[name] = parsedValue;
      }
    }
  }
  await Bun.write(read.path, stringifyValues(values));
  if (pulledNames.length > 0) {
    ctx.log(
      green(
        `↓ pulling ${pulledNames.join(", ")} - ${pulledKeys.size} variables`,
      ),
    );
  }
  return 0;
}

/** Selects the profile of the current worktree and pushes it; without a profile, lists the profile of each worktree. */
export async function use(ctx: Context, profile?: string): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const values = normalizeValues(read.values);
  const worktrees = await listWorktrees(ctx.cwd);
  if (profile === undefined) {
    for (const { name } of worktrees) {
      ctx.log(`${name}: ${values.uses[name] ?? DEFAULT_PROFILE}`);
    }
    return 0;
  }
  if (!hasProfile(values, profile)) {
    ctx.error(
      `Unknown profile "${profile}". Available: ${Object.keys(values.profiles).join(", ")}. Add it in \`envs edit\` first.`,
    );
    return 1;
  }
  const top = await $`git rev-parse --show-toplevel`.cwd(ctx.cwd).nothrow().quiet();
  const current = worktrees.find(
    ({ path }) => path === top.stdout.toString().trim(),
  );
  if (!current) {
    ctx.error("Run `envs use` inside a git worktree.");
    return 1;
  }
  for (const { name } of worktrees) values.uses[name] ??= DEFAULT_PROFILE;
  values.uses[current.name] = profile;
  await Bun.write(read.path, stringifyValues(values));
  return await push(ctx, current.name);
}

/** Whether git ignores `file` inside `dir` (true when it would not be committed). */
async function isIgnored(dir: string, file: string): Promise<boolean> {
  const result = await $`git check-ignore -q ${file}`
    .cwd(dir)
    .nothrow()
    .quiet();
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
  const modeOf = async (path: string) =>
    process.platform === "win32" ? undefined : (await stat(path)).mode;
  const dotenvs: LintContext["dotenvs"] = [];
  for (const worktree of worktrees) {
    const path = join(worktree.path, ".env");
    if (await Bun.file(path).exists()) {
      dotenvs.push({ ...worktree, mode: await modeOf(path) });
    }
  }
  const lintContext: LintContext = {
    values: read.values,
    root,
    valuesMode: await modeOf(read.path),
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
  const valuesPath = join(await findRoot(ctx.cwd), ".envs/values.yml");
  if (!(await Bun.file(valuesPath).exists())) await init(ctx);
  const pulled = await pull(ctx);
  if (pulled !== 0) return pulled;
  const original = await Bun.file(valuesPath).text();
  await Bun.write(valuesPath, EDIT_NOTICE + original);
  const code = await ctx.openEditor(valuesPath);
  // Drop the notice so it never lingers in the file (or reaches `push`).
  const edited = await Bun.file(valuesPath).text();
  if (edited.startsWith(EDIT_NOTICE)) {
    await Bun.write(valuesPath, edited.slice(EDIT_NOTICE.length));
  }
  if (code !== 0) return code;
  // A profile newly named in `uses` starts as a copy of `default`.
  const values = normalizeValues(
    (Bun.YAML.parse(await Bun.file(valuesPath).text()) ?? {}) as Values,
  );
  const created = materializeProfiles(values);
  if (created.length > 0) {
    await Bun.write(valuesPath, stringifyValues(values));
    ctx.log(green(`+ created ${created.join(", ")} from ${DEFAULT_PROFILE}`));
  }
  return await push(ctx);
}

/** Instructions placed at the top of values.yml while `envs edit` waits for the editor. */
const EDIT_NOTICE = `# ──────────────────────────────────────────────────────────────
# Close this file when your changes are ready, then they are pushed.
# To cancel the edit, press Ctrl+C in the terminal and then close this file.
# ──────────────────────────────────────────────────────────────
`;

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
    case "use":
      return await use(ctx, args[1]);
    default:
      ctx.error(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}
