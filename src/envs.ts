import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { stat } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFile, truncate } from "node:fs/promises";
import { $ } from "bun";
import { UnexpectedArgumentError } from "@jondotsoy/flags";
import { parser } from "./cli/flags";
import pkg from "../package.json" with { type: "json" };
import { dotenvProblem, hasSecretPattern, isSensitiveKey, rules, type LintContext } from "./lint-rules";
import {
  DEFAULT_PROFILE,
  cloneProfile,
  cloneState,
  REDACTED_PREFIX,
  dict,
  diffValues,
  isRedacted,
  findHistoryPoint,
  stateAfter,
  type Change,
  type HistoryPoint,
  type NormalizedValues,
  type ResolvedProfile,
  type Value,
} from "./history";

export { applyChanges, cloneState, compareStates, diffValues, emptyState, findHistoryPoint, stateAfter, statesAfterEach } from "./history";
export type { Change, HistoryPoint, NormalizedValues, StateDiff } from "./history";

export const HELP = `Usage: envs <command>

Commands:
  init    Create the .envs/ directory (.gitignore, values.yml)
  pull    Read each worktree's .env and write it into .envs/values.yml
  push    Write defaults and .envs/values.yml into the .env of each worktree
  lint    Warn about insecure values and unprotected secret files
  edit    Pull, open .envs/values.yml in VS Code (code -w), then push
          With --ui, serve a web editor instead; its Save button pushes
  use     Select the profile of the current worktree (envs use <profile>), or list them
  restore Restore values.yml to the state after a history point (envs restore <hash> [--force]), adding a new point
  history Manage the history (history redact: remove secrets in clear from an existing history)
  config  Read or change .envs/config.yml (config set <key> <value>, config get [key], config delete <key>)
  version Show the version
  help    Show this help message
`;

export interface Context {
  /** Directory the command runs from. */
  cwd: string;
  log(message: string): void;
  error(message: string): void;
  /** Opens a file in the editor and resolves with its exit code once closed. */
  openEditor(path: string): Promise<number>;
  /** Opens a URL in the default browser; rejects when it cannot (the caller then shows the URL).
   * May resolve with a function that removes what it left behind; the caller runs it once the URL is used. */
  openUrl?(url: string): Promise<void | (() => void)>;
  /** Resolves when the `--ui` server should stop (Ctrl+C by default). */
  waitForExit?(): Promise<void>;
  /** Clock used to timestamp history points (tests pin it so hashes are stable). */
  now?(): Date;
}

/** Colors are skipped when NO_COLOR (https://no-color.org) is set to a non-empty value. */
const colorsDisabled = () => Boolean(process.env.NO_COLOR);
/** Printed instead of the value of sensitive variables so secrets never reach stdout. */
const MASK = "********";
/** Sensitive per the lint rules, plus a bare KEY word (KEY_FOO, FOO_KEY). */
const isMaskedKey = (key: string) =>
  isSensitiveKey(key) || /(^|_)KEY(_|$)/i.test(key);
/** The password of a URL (`scheme://user:PASSWORD@host`) and the values of its sensitive query parameters, if it has any. */
const URL_SECRET = /^([a-z][a-z0-9+.-]*:\/\/[^\/\s:@]*:)([^@\/\s]+)(@)/i;
const hasUrlSecret = (value: string) => URL_SECRET.test(value) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && sensitiveQuery(value));
const sensitiveQuery = (value: string) =>
  [...value.matchAll(/[?&]([^=&\s#]+)=([^&\s#]*)/g)].some(([, name]) => isMaskedKey(name!.toUpperCase().replace(/[^A-Z0-9]+/g, "_")));
/** A value with the secrets of a URL hidden (everything else untouched). */
const maskUrlSecrets = (value: string) =>
  value.replace(URL_SECRET, `$1${MASK}$3`).replace(/([?&])([^=&\s#]+)=([^&\s#]*)/g, (all, sep: string, name: string) =>
    isMaskedKey(name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")) ? `${sep}${name}=${MASK}` : all,
  );
/** Whether a variable is a secret: by its name (as the console does) or because its value is a URL with a password. */
const isSecretEntry = (name: string, value: string) => isMaskedKey(name) || hasUrlSecret(value) || hasSecretPattern(value);
/** What the console shows for a variable: the value, or `********` for a secret; a URL keeps its host and hides only its secrets. */
const displayValue = (name: string, value: string) =>
  isMaskedKey(name) || hasSecretPattern(value) ? MASK : formatDotenvValue(maskUrlSecrets(value));
const paint = (code: number, text: string) =>
  colorsDisabled() ? text : `\x1b[${code}m${text}\x1b[0m`;
const green = (text: string) => paint(32, text);
const yellow = (text: string) => paint(33, text);
const red = (text: string) => paint(31, text);

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
  openUrl: async (url) => {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    // The opener's arguments are visible to every user in `ps`, so the URL (it carries the token)
    // never goes there: the opener gets a private local page that redirects to it.
    const dir = mkdtempSync(join(tmpdir(), "envs-"));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    try {
      const page = join(dir, "open.html");
      writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"><script>location.replace(${JSON.stringify(url)})</script>`, { mode: 0o600 });
      process.once("exit", cleanup);
      setTimeout(cleanup, 60_000).unref();
      const code = await Bun.spawn([opener, page], { stdio: ["ignore", "ignore", "ignore"] }).exited;
      if (code !== 0) throw new Error(`${opener} exited with code ${code}`);
      return cleanup;
    } catch (error) {
      cleanup();
      throw error;
    }
  },
  waitForExit: () =>
    new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
});

/** Values of one profile: `defaults` for every worktree and `envs.<VAR>.<worktree>` overrides. */
interface Profile {
  defaults?: Record<string, Value>;
  envs?: Record<string, Record<string, Value>>;
}

/** values.yml as written. Root-level `defaults`/`envs` are the legacy form of `profiles.default`. */
interface Values extends Profile {
  /** Profile of each worktree; worktrees that are not listed use `default`. */
  uses?: Record<string, string>;
  profiles?: Record<string, Profile>;
}

const hasProfile = (values: NormalizedValues, name: string) =>
  Object.hasOwn(values.profiles, name);

/** Folds root-level `defaults`/`envs` into `profiles.default` (an explicit `profiles.default` wins). */
export function normalizeValues(raw: Values): NormalizedValues {
  // Every map has no prototype: names come from files and requests (see `dict`).
  const profiles = dict<ResolvedProfile>();
  // A hand-written profile can be null (`dev:`) or lack a section; it always ends up with both.
  const add = (name: string, profile?: Profile | null) => {
    const target = (profiles[name] ??= { defaults: dict(), envs: dict() });
    Object.assign(target.defaults, profile?.defaults);
    for (const [key, byWorktree] of Object.entries(profile?.envs ?? {})) {
      Object.assign((target.envs[key] ??= dict()), byWorktree);
    }
  };
  add(DEFAULT_PROFILE, { defaults: raw.defaults, envs: raw.envs });
  for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
    add(name, profile);
  }
  const uses = dict<string>();
  for (const [worktree, profile] of Object.entries(raw.uses ?? {})) uses[worktree] = profile;
  return { uses, profiles };
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
    values.profiles[name] = cloneProfile(values.profiles[DEFAULT_PROFILE]!);
    created.push(name);
  }
  return created;
}

/** A state as the history stores it (secrets redacted): what to compare with a replay of the history. */
export async function redactForHistory(root: string, state: NormalizedValues): Promise<NormalizedValues> {
  return (await redactor(root)).state(state);
}

/** `envs config set history.secrets true` keeps secrets in the history in clear; by default they are redacted. */
async function keepsSecrets(root: string): Promise<boolean> {
  return (await readConfig(join(root, ".envs/config.yml")))["history.secrets"] === true;
}

/** The secret of this project's fingerprints (`.envs/history.key`, mode 600, created on first use). */
async function historyKey(root: string): Promise<string> {
  const path = join(root, ".envs/history.key");
  const read = async () => (await Bun.file(path).text()).trim();
  if (await Bun.file(path).exists()) return await read();
  await mkdir(join(root, ".envs"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return await read();
}

interface Redactor {
  /** The marker for a secret value of the variable `name`. */
  mark(name: string, value: string): string;
  /** A copy of a state where every secret value is its marker (values already redacted are kept). */
  state(state: NormalizedValues): NormalizedValues;
}

/**
 * How values are written to the history. A secret (a variable whose name looks sensitive, or a URL
 * with a password) is stored as `envs:redacted:<keyed fingerprint>`: the fingerprint changes when the
 * secret does, so the history still shows *that* it changed, but never holds it, not even after it
 * is rotated. With `history.secrets` set to true nothing is redacted.
 */
async function redactor(root: string): Promise<Redactor> {
  if (await keepsSecrets(root)) return { mark: (_, value) => value, state: (state) => cloneState(state) };
  const key = await historyKey(root);
  const mark = (name: string, value: string) =>
    REDACTED_PREFIX + createHmac("sha256", key).update(`${name}\0${value}`).digest("hex").slice(0, 16);
  const one = (name: string, value: Value): Value =>
    typeof value === "string" && isRedacted(value) ? value : isSecretEntry(name, String(value)) ? mark(name, String(value)) : value;
  return {
    mark,
    state(state) {
      const copy = cloneState(state);
      for (const profile of Object.values(copy.profiles)) {
        for (const [name, value] of Object.entries(profile.defaults)) profile.defaults[name] = one(name, value);
        for (const [name, byWorktree] of Object.entries(profile.envs)) {
          for (const [worktree, value] of Object.entries(byWorktree)) byWorktree[worktree] = one(name, value);
        }
      }
      return copy;
    },
  };
}

/**
 * Puts the current secrets back into a state rebuilt from the history, which only has their markers.
 * A secret keeps the value it has now (the old one is not stored); one the project no longer has
 * cannot be restored and is left out. Returns what could not be restored exactly.
 */
function unredact(restored: NormalizedValues, current: NormalizedValues, mark: Redactor["mark"]) {
  const notes: string[] = [];
  for (const [profileName, profile] of Object.entries(restored.profiles)) {
    const now = Object.hasOwn(current.profiles, profileName) ? current.profiles[profileName] : undefined;
    /** `key` is the entry of `map` to settle; `variable` is the variable it belongs to. */
    const settle = (map: Record<string, Value>, key: string, variable: string, where: string, currentValue: Value | undefined) => {
      const value = map[key];
      if (!isRedacted(value)) return;
      if (currentValue === undefined) {
        delete map[key];
        notes.push(`${variable} (${where}): not restored, the history does not keep its value`);
        return;
      }
      map[key] = currentValue;
      if (mark(variable, String(currentValue)) !== value) {
        notes.push(`${variable} (${where}): kept the current value, the history does not keep the old one`);
      }
    };
    for (const variable of Object.keys(profile.defaults)) {
      const nowValue = now && Object.hasOwn(now.defaults, variable) ? now.defaults[variable] : undefined;
      settle(profile.defaults, variable, variable, `${profileName} defaults`, nowValue);
    }
    for (const [variable, byWorktree] of Object.entries(profile.envs)) {
      const nowByWorktree = now && Object.hasOwn(now.envs, variable) ? now.envs[variable] : undefined;
      for (const worktree of Object.keys(byWorktree)) {
        const nowValue = nowByWorktree && Object.hasOwn(nowByWorktree, worktree) ? nowByWorktree[worktree] : undefined;
        settle(byWorktree, worktree, variable, `${profileName} ${worktree}`, nowValue);
      }
      if (Object.keys(byWorktree).length === 0) delete profile.envs[variable];
    }
  }
  return notes;
}

/**
 * Appends points to `.envs/history.ndjson`: `{prev, timestamp, changes, hash}` on one line each.
 * `prev` is the hash of the previous point (null for the first) and `hash` covers the rest of the
 * line, so the file is a hash chain. Nothing is written when nothing changed.
 *
 * The first point of a history always describes the whole state (it is the difference from
 * nothing), whatever command writes it: the points are replayed from an empty state, so a first
 * point holding only one change would make `restore` lose everything else.
 *
 * Replaying the points must always give back values.yml. When `before` (the values.yml this
 * operation started from) differs from the replayed history, something changed it outside the
 * history: a manual edit, or a period with `history` off. A *resync* point (`resync: true`) records
 * that difference first, so the chain stays faithful and `restore` does not undo it by accident.
 * Returns the hash of the point that records `before` → `after`.
 */
export async function recordHistory(
  root: string,
  before: NormalizedValues,
  after: NormalizedValues,
  now: () => Date = () => new Date(),
  warn: (message: string) => void = () => {},
): Promise<string | undefined> {
  // Reading the last point and appending the next must be one step, or two writers fork the chain.
  return await withLock(root, () => recordHistoryLocked(root, before, after, now, warn));
}

async function recordHistoryLocked(
  root: string,
  before: NormalizedValues,
  after: NormalizedValues,
  now: () => Date,
  warn: (message: string) => void,
): Promise<string | undefined> {
  if (!(await historyEnabled(root))) return undefined;
  const historyPath = join(root, ".envs/history.ndjson");
  // A damaged history never stops a command: unreadable lines are skipped, and the resync point
  // below records whatever the skipped points held, since values.yml is the truth.
  const scan = await scanHistory(root);
  if (scan.torn) warn(".envs/history.ndjson ended with an incomplete line (an interrupted write): it is ignored.");
  if (scan.damaged.length > 0) {
    warn(`.envs/history.ndjson has damaged lines (${scan.damaged.join(", ")}): they are ignored, so the history may be incomplete.`);
  }
  if (scan.broken.length > 0) {
    warn(`.envs/history.ndjson: the hash chain is broken at ${describeBroken(scan.broken)}. The history may have been altered; \`envs restore\` refuses until it is checked.`);
  }
  const points = scan.points;
  let prev: string | null = points.at(-1)?.hash ?? null;
  let repaired = false;
  const append = async (changes: Change[], extra: { resync?: true } = {}) => {
    if (!repaired) {
      repaired = true;
      // Never glue a point onto a partial line: drop the incomplete tail, or end the last line.
      if (scan.torn) await truncate(historyPath, Buffer.byteLength(scan.complete));
      else if (!scan.endsWithNewline) await appendFile(historyPath, "\n");
    }
    const point = { prev, timestamp: now().toISOString(), changes, ...extra };
    const hash = createHash("sha256").update(JSON.stringify(point)).digest("hex").slice(0, 12);
    // The history holds variable values, so it is created readable only by the owner.
    await appendFile(historyPath, JSON.stringify({ hash, ...point }) + "\n", { mode: 0o600 });
    prev = hash;
    return hash;
  };
  // Everything below works on redacted states, so the history never holds a secret.
  const { state: redact } = await redactor(root);
  const redactedBefore = redact(before);
  const redactedAfter = redact(after);
  if (points.length === 0) {
    const changes = diffValues({ uses: {}, profiles: {} }, redactedAfter);
    return changes.length === 0 ? undefined : await append(changes);
  }
  // (Points written before secrets were redacted still hold them in clear; they compare as redacted too.)
  const drift = diffValues(redact(stateAfter(points, points.at(-1)!)), redactedBefore);
  if (drift.length > 0) await append(drift, { resync: true });
  const changes = diffValues(redactedBefore, redactedAfter);
  return changes.length === 0 ? undefined : await append(changes);
}

/**
 * `envs history redact`: rewrites the history so it no longer holds any secret in clear (points
 * written before secrets were redacted), and relinks its hash chain. Nothing else changes; points
 * keep their order and timestamps, but their hashes do. Run it once on an existing history.
 */
async function redactHistory(ctx: Context): Promise<number> {
  const root = await findRoot(ctx.cwd);
  return await withLock(root, async () => {
    const scan = await scanHistory(root);
    if (scan.points.length === 0 && scan.damaged.length === 0) {
      ctx.log("There is no history to redact.");
      return 0;
    }
    if (scan.damaged.length > 0 || scan.broken.length > 0) {
      ctx.error(".envs/history.ndjson is damaged or its hash chain is broken: check it before rewriting it.");
      return 1;
    }
    const { mark } = await redactor(root);
    let redacted = 0;
    const redactValue = (variable: string, value: Value | undefined) => {
      if (value === undefined || isRedacted(value) || !isSecretEntry(variable, String(value))) return value;
      redacted++;
      return mark(variable, String(value));
    };
    let prev: string | null = null;
    const lines: string[] = [];
    for (const old of scan.points) {
      const changes = old.changes.map((change): Change => {
        const [section, , kind, variable] = change.path;
        if (section !== "profiles" || (kind !== "defaults" && kind !== "envs") || variable === undefined) return change;
        const from = redactValue(variable, change.from);
        const to = redactValue(variable, change.to);
        return { path: change.path, ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
      });
      const point: Omit<HistoryPoint, "hash"> = { prev, timestamp: old.timestamp, changes, ...(old.resync && { resync: true }) };
      const hash: string = createHash("sha256").update(JSON.stringify(point)).digest("hex").slice(0, 12);
      lines.push(JSON.stringify({ hash, ...point }));
      prev = hash;
    }
    if (redacted === 0) {
      ctx.log("No secrets in clear in the history: nothing to redact.");
      return 0;
    }
    // Write the new file next to the old one and swap it in: the history is never half written.
    const path = join(root, ".envs/history.ndjson");
    await writeFile(`${path}.tmp`, lines.join("\n") + "\n", { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    ctx.log(green(`✓ redacted ${redacted} secret value(s) in the history; its hash chain was rewritten (the hashes of its points changed)`));
    return 0;
  });
}

/** `envs history <redact>`. */
export async function historyCommand(ctx: Context, args: string[]): Promise<number> {
  if (args[0] === "redact") return await redactHistory(ctx);
  ctx.error("Usage: envs history redact");
  return 1;
}

/** `envs config set history false` turns the history off; it is on unless set to false. */
export async function historyEnabled(root: string): Promise<boolean> {
  return (await readConfig(join(root, ".envs/config.yml"))).history !== false;
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
  const entries = dict<string>();
  for (const name of new Set([DEFAULT_PROFILE, profile])) {
    const layer = values.profiles[name]!;
    for (const [key, value] of Object.entries(layer.defaults)) {
      entries[key] = String(value);
    }
    if (name === profile && !includeProfileEnvs) continue;
    for (const [key, byWorktree] of Object.entries(layer.envs)) {
      if (byWorktree && Object.hasOwn(byWorktree, worktree)) {
        entries[key] = String(byWorktree[worktree]);
      }
    }
  }
  return entries;
}

/** Whether every profile as written has both `defaults` and `envs` (so nothing needs rewriting). */
const hasCompleteProfiles = (raw: Values) =>
  Object.values(raw.profiles ?? {}).every(
    (profile) => typeof profile?.defaults === "object" && profile.defaults !== null && typeof profile.envs === "object" && profile.envs !== null,
  );

/** The text written to values.yml: only `uses` and `profiles`; every profile has `defaults` and `envs`. */
export function stringifyValues(values: NormalizedValues): string {
  const profiles = Object.fromEntries(
    Object.entries(values.profiles).map(([name, { defaults, envs }]) => {
      const kept = Object.fromEntries(
        Object.entries(envs).filter(([, byWorktree]) => Object.keys(byWorktree).length > 0),
      );
      return [name, { defaults, envs: kept }];
    }),
  );
  const out = Object.keys(values.uses).length > 0 ? { uses: values.uses, profiles } : { profiles };
  return SCHEMA_COMMENT + Bun.YAML.stringify(out, null, 2);
}

/** Modeline that makes the YAML language server validate values.yml against the published schema. */
const SCHEMA_COMMENT = "# yaml-language-server: $schema=https://jondotsoy.github.io/envs/schema.json\n";

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

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes (`"`, `'` or backtick) and `export`. */
export function parseDotenv(text: string): Record<string, string> {
  const result = dict<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.lastIndexOf(quote) > 0) {
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

/**
 * Quotes a value so a dotenv parser reads back exactly the same text. Double quotes expand `\n`, so they
 * are used only when the value has no `"` and no literal `\n`/`\r`; otherwise single quotes, then backticks.
 * `dotenvProblem` rejects the values none of them can hold.
 */
export function formatDotenvValue(value: string): string {
  if (value !== "" && !/[\s#"'`\\$]/.test(value)) return value;
  if (!value.includes('"') && !/\\[nr]/.test(value)) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `\`${value}\``;
}

/**
 * Sets KEY=VALUE for each entry, updating existing lines in place and appending new ones.
 * Lines whose key is in `remove` are dropped (a key that is also in `entries` is kept).
 */
export function updateDotenv(
  text: string,
  entries: Record<string, string>,
  remove: ReadonlySet<string> = new Set(),
): string {
  const pending = new Map(Object.entries(entries));
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const updated: string[] = [];
  for (const line of lines) {
    const key = line.trim().match(/^(?:export\s+)?([\w.-]+)\s*=/)?.[1];
    if (key !== undefined && remove.has(key) && !pending.has(key)) continue;
    if (key === undefined || !pending.has(key)) {
      updated.push(line);
      continue;
    }
    const value = pending.get(key)!;
    pending.delete(key);
    updated.push(`${key}=${formatDotenvValue(value)}`);
  }
  for (const [key, value] of pending) {
    updated.push(`${key}=${formatDotenvValue(value)}`);
  }
  return updated.length === 0 ? "" : updated.join("\n") + "\n";
}

/**
 * The variables `envs` manages: every name in any profile of values.yml plus every name that ever
 * appeared in the history. A variable of a `.env` that is in none of them was never managed.
 */
async function managedVariables(root: string, values: NormalizedValues): Promise<Set<string>> {
  const names = new Set<string>();
  for (const profile of Object.values(values.profiles)) {
    for (const key of Object.keys(profile.defaults)) names.add(key);
    for (const key of Object.keys(profile.envs)) names.add(key);
  }
  // A damaged history must not stop a push: its unreadable lines are skipped.
  const points = await readHistoryPoints(root);
  for (const { changes } of points) {
    for (const { path } of changes) {
      if (path[0] === "profiles" && (path[2] === "defaults" || path[2] === "envs") && path[3] !== undefined) {
        names.add(path[3]);
      }
    }
  }
  return names;
}

/**
 * `.envs/` holds every secret of the project, so only the owner may read it: the folder is 700 and
 * its files (values.yml, the history, the config) are 600. Applied on every command that writes, so a
 * project created before this, or by hand, is tightened too. Modes do not apply on Windows.
 */
async function hardenPermissions(root: string): Promise<void> {
  if (process.platform === "win32") return;
  const dir = join(root, ".envs");
  const tighten = async (path: string, mode: number) => {
    const current = await stat(path).catch(() => undefined);
    if (current && (current.mode & 0o777 & ~mode) !== 0) await chmod(path, mode).catch(() => {});
  };
  await tighten(dir, 0o700);
  for (const file of ["values.yml", "history.ndjson", "history.key", "config.yml"]) await tighten(join(dir, file), 0o600);
}

/** The lock of `.envs/` is held by another running `envs` command. */
class LockError extends Error {}

/** The roots whose lock the current async flow already holds (a command that calls another, e.g. `use` → `push`). */
const heldLocks = new AsyncLocalStorage<Set<string>>();

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Runs `fn` holding `.envs/lock`, so two `envs` processes (or two flows in one) never read, change
 * and write values.yml and the history at the same time. It waits up to 30 s for the lock; one left
 * by a process that died is taken over. Without a `.envs/` folder (before `init`) there is nothing to protect.
 */
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.has(root)) return await fn();
  const dir = join(root, ".envs");
  if (!(await Bun.file(join(dir, ".gitignore")).exists()) && !(await Bun.file(join(dir, "values.yml")).exists())) {
    return await fn();
  }
  await hardenPermissions(root);
  const path = join(dir, "lock");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const text = await Bun.file(path).text().catch(() => "");
      const pid = Number(text.split(" ")[0]);
      const age = Date.now() - ((await stat(path).catch(() => undefined))?.mtimeMs ?? Date.now());
      if ((Number.isInteger(pid) && pid > 0 && !processAlive(pid)) || age > 120_000) {
        await unlink(path).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new LockError(`.envs/lock is held by another envs command (pid ${Number.isInteger(pid) ? pid : "unknown"}). Wait for it, or remove .envs/lock if it is not running.`);
      }
      await Bun.sleep(15 + Math.random() * 35);
    }
  }
  try {
    return await heldLocks.run(new Set([...(held ?? []), root]), fn);
  } finally {
    await unlink(path).catch(() => {});
  }
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
  const files = { ".envs/.gitignore": "*\n", ".envs/values.yml": SCHEMA_COMMENT };
  await mkdir(join(root, ".envs"), { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    if (await Bun.file(path).exists()) {
      ctx.log(`${path} already exists`);
    } else {
      await Bun.write(path, content);
      ctx.log(`Created ${path}`);
    }
  }
  await hardenPermissions(root);
  return 0;
}

const CONFIG_USAGE = `Usage: envs config <set <key> <value> | get [key] | delete <key>>`;

/** Settings stored in .envs/config.yml: flat key -> scalar. */
type Config = Record<string, Value>;

async function readConfig(path: string): Promise<Config> {
  if (!(await Bun.file(path).exists())) return {};
  return (Bun.YAML.parse(await Bun.file(path).text()) ?? {}) as Config;
}

async function writeConfig(root: string, path: string, config: Config) {
  await mkdir(join(root, ".envs"), { recursive: true, mode: 0o700 });
  const gitignore = join(root, ".envs/.gitignore");
  if (!(await Bun.file(gitignore).exists())) await Bun.write(gitignore, "*\n");
  const sorted = Object.fromEntries(
    Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
  );
  await Bun.write(path, Object.keys(sorted).length ? Bun.YAML.stringify(sorted, null, 2) + "\n" : "", { mode: 0o600 });
  // `mode` only applies on creation; also tighten a file that already existed.
  await chmod(path, 0o600);
}

/** `envs config set|get|delete`: manages .envs/config.yml (created on first `set`). */
export async function config(ctx: Context, args: string[]): Promise<number> {
  const [action, key, ...rest] = args;
  const root = await findRoot(ctx.cwd);
  const path = join(root, ".envs/config.yml");
  const current = await readConfig(path);
  switch (action) {
    case "set": {
      if (!key || rest.length === 0) {
        ctx.error(`${CONFIG_USAGE}\n\nMissing key or value for \`config set\`.`);
        return 1;
      }
      current[key] = parseValue(rest.join(" "));
      await writeConfig(root, path, current);
      ctx.log(`${key}=${current[key]}`);
      return 0;
    }
    case "get": {
      if (!key) {
        for (const [k, v] of Object.entries(current)) ctx.log(`${k}=${v}`);
        return 0;
      }
      if (!(key in current)) {
        ctx.error(`Config key not found: ${key}`);
        return 1;
      }
      ctx.log(String(current[key]));
      return 0;
    }
    case "delete": {
      if (!key) {
        ctx.error(`${CONFIG_USAGE}\n\nMissing key for \`config delete\`.`);
        return 1;
      }
      if (!(key in current)) {
        ctx.error(`Config key not found: ${key}`);
        return 1;
      }
      delete current[key];
      await writeConfig(root, path, current);
      ctx.log(`Deleted ${key}`);
      return 0;
    }
    default:
      ctx.error(CONFIG_USAGE);
      return 1;
  }
}

export async function push(ctx: Context, only?: string): Promise<number> {
  return await withLock(await findRoot(ctx.cwd), () => pushLocked(ctx, only));
}

export async function pull(ctx: Context): Promise<number> {
  return await withLock(await findRoot(ctx.cwd), () => pullLocked(ctx));
}

export async function use(ctx: Context, profile?: string): Promise<number> {
  return await withLock(await findRoot(ctx.cwd), () => useLocked(ctx, profile));
}

export async function restore(ctx: Context, hash?: string, options: { force?: boolean } = {}): Promise<number> {
  return await withLock(await findRoot(ctx.cwd), () => restoreLocked(ctx, hash, options));
}

/** Writes the values of each worktree's profile to its `.env`; `only` limits it to one worktree. */
async function pushLocked(ctx: Context, only?: string): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const values = normalizeValues(read.values);
  const worktrees = (await listWorktrees(ctx.cwd)).filter(
    ({ name }) => only === undefined || name === only,
  );
  if (!checkProfiles(ctx, values, worktrees)) return 1;
  // Nothing is written unless every value can be: a name or value with a line break would start
  // another line in the .env, i.e. inject a different variable.
  let safe = true;
  for (const { name } of worktrees) {
    const profile = values.uses[name] ?? DEFAULT_PROFILE;
    for (const [key, value] of Object.entries(resolveEntries(values, name, profile))) {
      const problem = dotenvProblem(key, value);
      if (problem) {
        safe = false;
        ctx.error(`${JSON.stringify(key)} (${name}): ${problem}. Nothing was written.`);
      }
    }
  }
  if (!safe) return 1;
  const managed = await managedVariables(await findRoot(ctx.cwd), values);
  // Changed variables, grouped by `KEY=VALUE` so each log line lists every branch it changed in.
  const changes = new Map<string, string[]>();
  // Orphan variables removed from a .env, grouped by name.
  const removals = new Map<string, string[]>();
  for (const { name, path } of worktrees) {
    const profile = values.uses[name] ?? DEFAULT_PROFILE;
    const entries = resolveEntries(values, name, profile);
    // Worktrees on a profile other than `default` are labelled in the log.
    const label = profile === DEFAULT_PROFILE ? name : `${name} [${profile}]`;
    const dotenv = Bun.file(join(path, ".env"));
    const current = (await dotenv.exists()) ? await dotenv.text() : "";
    const existing = parseDotenv(current);
    // Orphans: managed by `envs` (they were in values.yml or its history) but no longer resolved for
    // this worktree, e.g. after a restore. Variables `envs` never managed stay untouched.
    const orphans = new Set(Object.keys(existing).filter((key) => managed.has(key) && !(key in entries)));
    if (Object.keys(entries).length === 0 && orphans.size === 0) continue;
    for (const [key, value] of Object.entries(entries)) {
      if (existing[key] === value) continue;
      const shown = displayValue(key, value);
      const line = `${key}=${shown}`;
      // Different secret values share a masked line, so group by what is printed.
      changes.set(line, [...(changes.get(line) ?? []), label]);
    }
    for (const key of orphans) removals.set(key, [...(removals.get(key) ?? []), label]);
    // The .env holds secrets: it is always left readable only by its owner.
    const dotenvPath = join(path, ".env");
    await writeFile(dotenvPath, updateDotenv(current, entries, orphans), { mode: 0o600 });
    // `mode` applies only on creation, so tighten a .env that already existed.
    await chmod(dotenvPath, 0o600).catch(() => {});
  }
  for (const [line, names] of changes) {
    ctx.log(yellow(`↻ ${line} → ${names.join(", ")}`));
  }
  for (const [key, names] of removals) {
    ctx.log(red(`✕ ${key} removed from ${names.join(", ")}`));
  }
  return 0;
}

async function pullLocked(ctx: Context): Promise<number> {
  const read = await readValues(ctx);
  if (!read) return 1;
  const values = normalizeValues(read.values);
  const before = cloneState(values);
  const worktrees = await listWorktrees(ctx.cwd);
  // A profile named in `uses` that does not exist yet starts as a copy of `default`.
  materializeProfiles(values);
  const missingDefaults = new Map<string, string[]>();
  const pulledNames: string[] = [];
  const pulledKeys = new Set<string>();
  for (const { name, path } of worktrees) {
    const profile = (values.uses[name] ??= DEFAULT_PROFILE);
    const dotenv = Bun.file(join(path, ".env"));
    if (!(await dotenv.exists())) continue;
    const parsed = parseDotenv(await dotenv.text());
    pulledNames.push(name);
    for (const key of Object.keys(parsed)) pulledKeys.add(key);
    // Variables the profile's defaults give every worktree but this .env lacks: a default cannot be
    // dropped for one worktree, so push would write them back. Say so instead of surprising later.
    for (const layer of new Set([DEFAULT_PROFILE, profile])) {
      for (const key of Object.keys(values.profiles[layer]!.defaults)) {
        if (!(key in parsed)) missingDefaults.set(key, [...(missingDefaults.get(key) ?? []), name]);
      }
    }
    const { envs } = values.profiles[profile]!;
    // Drop keys that are no longer in this worktree's .env, from every layer it resolves: its profile
    // and, for a profile other than `default`, the entries it also has under `default`.
    for (const layer of new Set([DEFAULT_PROFILE, profile])) {
      for (const [key, byWorktree] of Object.entries(values.profiles[layer]!.envs)) {
        if (!(key in parsed)) delete byWorktree[name];
      }
    }
    // What the worktree would get without its own entries in this profile.
    const base = resolveEntries(values, name, profile, false);
    for (const [key, value] of Object.entries(parsed)) {
      const parsedValue = parseValue(value);
      // A value equal to what the profile already provides needs no entry.
      if (key in base && base[key] === String(parsedValue)) {
        if (envs[key]) delete envs[key]![name];
      } else {
        (envs[key] ??= dict())[name] = parsedValue;
      }
    }
  }
  await Bun.write(read.path, stringifyValues(values));
  // What the pull changed (e.g. a manual edit of a .env) is recorded; with no history yet, the whole state.
  const root = await findRoot(ctx.cwd);
  await recordHistory(root, before, values, ctx.now, ctx.error);
  for (const [key, names] of missingDefaults) {
    ctx.log(
      yellow(
        `! ${key} is in the defaults but missing from the .env of ${names.join(", ")}: \`envs push\` writes it back. Remove it from the defaults to drop it from every worktree.`,
      ),
    );
  }
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
async function useLocked(ctx: Context, profile?: string): Promise<number> {
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
  const before = cloneState(values);
  for (const { name } of worktrees) values.uses[name] ??= DEFAULT_PROFILE;
  values.uses[current.name] = profile;
  await Bun.write(read.path, stringifyValues(values));
  await recordHistory(await findRoot(ctx.cwd), before, values, ctx.now, ctx.error);
  return await push(ctx, current.name);
}

/** What `.envs/history.ndjson` holds: its valid points and what could not be read. */
interface HistoryScan {
  points: HistoryPoint[];
  /** 1-based numbers of the complete lines that are not a valid point. */
  damaged: number[];
  /** The last line is incomplete (no newline and not a valid point): a write was interrupted. */
  torn: boolean;
  /** The file text up to and including its last newline (what a torn tail is cut back to). */
  complete: string;
  endsWithNewline: boolean;
  /** Points whose hash does not match their content, or whose `prev` is not the previous point: the chain is broken there. */
  broken: { hash: string; reason: "content" | "prev" }[];
}

const isHistoryPoint = (value: unknown): value is HistoryPoint => {
  const point = value as Partial<HistoryPoint> | null;
  return (
    typeof point === "object" &&
    point !== null &&
    typeof point.hash === "string" &&
    (typeof point.prev === "string" || point.prev === null) &&
    typeof point.timestamp === "string" &&
    Array.isArray(point.changes)
  );
};

async function scanHistory(root: string): Promise<HistoryScan> {
  const file = Bun.file(join(root, ".envs/history.ndjson"));
  const scan: HistoryScan = { points: [], damaged: [], torn: false, complete: "", endsWithNewline: true, broken: [] };
  if (!(await file.exists())) return scan;
  const text = await file.text();
  scan.endsWithNewline = text === "" || text.endsWith("\n");
  scan.complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (isHistoryPoint(value)) scan.points.push(value);
    // The last line without a newline is a write that never finished; any other bad line is damage.
    else if (i === lines.length - 1 && !scan.endsWithNewline) scan.torn = true;
    else scan.damaged.push(i + 1);
  });
  scan.broken = verifyChain(scan.points);
  return scan;
}

/** The hash a point must carry: the start of the sha256 of its line without the `hash` field. */
const hashOf = (point: HistoryPoint) => {
  const { hash: _, ...rest } = point;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 12);
};

/**
 * Checks the hash chain: every point's `hash` must match its content (so nothing in it was edited)
 * and its `prev` must be the previous point's hash (so none was removed, inserted or reordered).
 */
function verifyChain(points: HistoryPoint[]): HistoryScan["broken"] {
  const broken: HistoryScan["broken"] = [];
  let previous: string | null = null;
  for (const point of points) {
    if (hashOf(point) !== point.hash) broken.push({ hash: point.hash, reason: "content" });
    else if (point.prev !== previous) broken.push({ hash: point.hash, reason: "prev" });
    previous = point.hash;
  }
  return broken;
}

const describeBroken = (broken: HistoryScan["broken"]) =>
  broken
    .map(({ hash, reason }) => `${hash} (${reason === "content" ? "its content does not match its hash" : "it does not follow the previous point"})`)
    .join(", ");

/** The valid points of .envs/history.ndjson, oldest first (none when the file does not exist). */
export async function readHistoryPoints(root: string): Promise<HistoryPoint[]> {
  return (await scanHistory(root)).points;
}

/**
 * `envs restore <hash>`: rebuilds the state values.yml had after that history point (a unique
 * prefix of the hash is enough), writes it, records the difference as a new point and pushes.
 * Existing points are never removed or rewritten.
 */
async function restoreLocked(ctx: Context, hash?: string, options: { force?: boolean } = {}): Promise<number> {
  if (!hash) {
    ctx.error("Usage: envs restore <hash> [--force]");
    return 1;
  }
  const read = await readValues(ctx);
  if (!read) return 1;
  const root = await findRoot(ctx.cwd);
  if (!(await historyEnabled(root))) {
    // The web editor refuses too: a restore with the history off would not be recorded.
    ctx.error("The history is off, so a restore would not be recorded. Run `envs config set history true` first.");
    return 1;
  }
  const scan = await scanHistory(root);
  if (scan.damaged.length > 0) {
    // An exact state cannot be rebuilt around a missing point, so nothing is changed.
    ctx.error(
      `.envs/history.ndjson has damaged lines (${scan.damaged.join(", ")}), so the state of a point cannot be rebuilt exactly. Repair or remove those lines and try again.`,
    );
    return 1;
  }
  if (scan.broken.length > 0) {
    const message = `.envs/history.ndjson: the hash chain is broken at ${describeBroken(scan.broken)}. The history may have been altered, so the state of a point cannot be trusted.`;
    if (!options.force) {
      ctx.error(`${message} Check the file, or run \`envs restore ${hash} --force\` to restore anyway.`);
      return 1;
    }
    ctx.error(`${message} Restoring anyway (--force).`);
  }
  const points = scan.points;
  const found = findHistoryPoint(points, hash);
  if ("error" in found) {
    ctx.error(
      found.error === "none"
        ? `No history point matches "${hash}". Run \`envs restore\` with a hash from .envs/history.ndjson.`
        : `"${hash}" matches ${found.matches} history points; use more characters.`,
    );
    return 1;
  }
  const target = found.point;
  const restored = stateAfter(points, target);
  const current = normalizeValues(read.values);
  // The history keeps secrets only as fingerprints: they keep the value they have now.
  const notes = unredact(restored, current, (await redactor(root)).mark);
  await Bun.write(read.path, stringifyValues(restored));
  for (const note of notes) ctx.log(yellow(`! ${note}`));
  const added = await recordHistory(root, current, restored, ctx.now, ctx.error);
  ctx.log(
    added
      ? green(`↺ restored ${target.hash} - new history point ${added}`)
      : `Already at ${target.hash}: nothing to restore`,
  );
  return await push(ctx);
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
  const historyPath = join(root, ".envs/history.ndjson");
  const hasHistory = await Bun.file(historyPath).exists();
  const lintContext: LintContext = {
    values: read.values,
    root,
    valuesMode: await modeOf(read.path),
    hasHistory,
    historyMode: hasHistory ? await modeOf(historyPath) : undefined,
    worktrees: worktrees.map(({ name }) => name),
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

export async function edit(ctx: Context, options: { ui?: boolean } = {}): Promise<number> {
  const valuesPath = join(await findRoot(ctx.cwd), ".envs/values.yml");
  if (!(await Bun.file(valuesPath).exists())) await init(ctx);
  const pulled = await pull(ctx);
  if (pulled !== 0) return pulled;
  if (options.ui) {
    const { serveUi } = await import("./ui/server");
    return await serveUi(ctx);
  }
  const original = await Bun.file(valuesPath).text();
  const before = normalizeValues((Bun.YAML.parse(original) ?? {}) as Values);
  await Bun.write(valuesPath, EDIT_NOTICE + original);
  const code = await ctx.openEditor(valuesPath);
  // Drop the notice so it never lingers in the file (or reaches `push`).
  const edited = await Bun.file(valuesPath).text();
  if (code !== 0) {
    // A cancelled or failed edit changes nothing: values.yml goes back to what it was before.
    await Bun.write(valuesPath, original);
    return code;
  }
  if (edited.startsWith(EDIT_NOTICE)) {
    await Bun.write(valuesPath, edited.slice(EDIT_NOTICE.length));
  }
  // The editor ran without the lock (it can stay open for hours); what follows needs it.
  return await withLock(await findRoot(ctx.cwd), async () => {
    // A profile newly named in `uses` starts as a copy of `default`.
    const raw = (Bun.YAML.parse(await Bun.file(valuesPath).text()) ?? {}) as Values;
    const values = normalizeValues(raw);
    const created = materializeProfiles(values);
    // Rewrite only when something changed, so comments and formatting survive otherwise.
    if (created.length > 0 || !hasCompleteProfiles(raw)) {
      await Bun.write(valuesPath, stringifyValues(values));
    }
    if (created.length > 0) {
      ctx.log(green(`+ created ${created.join(", ")} from ${DEFAULT_PROFILE}`));
    }
    await recordHistory(await findRoot(ctx.cwd), before, values, ctx.now, ctx.error);
    return await push(ctx);
  });
}

/**
 * The worktree that contains `cwd` (the worktree itself or any folder inside it), or undefined.
 * Worktrees can live inside another one (`/repo/workspaces/tar` inside `/repo`): the deepest wins.
 * Paths are compared as given; resolve symlinks first (see {@link currentWorktree}).
 */
export function worktreeContaining(cwd: string, worktrees: Worktree[]): string | undefined {
  const inside = (path: string) => cwd === path || cwd.startsWith(path.endsWith(sep) ? path : path + sep);
  return worktrees
    .filter(({ path }) => inside(path))
    .sort((a, b) => b.path.length - a.path.length)[0]?.name;
}

/** The worktree `cwd` is in, comparing real paths (a symlinked folder or `/tmp` on macOS still matches). */
export async function currentWorktree(cwd: string, worktrees: Worktree[]): Promise<string | undefined> {
  const real = (path: string) => realpath(path).catch(() => path);
  const resolved = await Promise.all(worktrees.map(async ({ name, path }) => ({ name, path: await real(path) })));
  return worktreeContaining(await real(cwd), resolved);
}

/**
 * State the web editor shows: the normalized values, the worktree names and `current`, the worktree
 * the command was run from (the editor opens on its page; absent when the folder is in none).
 */
export async function loadUiState(ctx: Context) {
  const read = await readValues(ctx);
  if (!read) throw new Error("Run `envs init` first.");
  const listed = await listWorktrees(ctx.cwd);
  // The main workspace comes first, the rest in natural order (fix-2 before fix-10).
  const [main, ...others] = listed.map(({ name }) => name);
  others.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const worktrees = main === undefined ? [] : [main, ...others];
  const current = await currentWorktree(ctx.cwd, listed);
  return {
    ...normalizeValues(read.values),
    worktrees,
    current,
    version: valuesVersion(await Bun.file(read.path).text()),
  };
}

/** History the web editor shows: whether it is on and its points, oldest first (none while it is off). */
export async function loadUiHistory(
  ctx: Context,
): Promise<{ enabled: boolean; points: HistoryPoint[]; damaged?: number[]; broken?: string[] }> {
  const root = await findRoot(ctx.cwd);
  const enabled = await historyEnabled(root);
  if (!enabled) return { enabled, points: [] };
  const { points, damaged, broken } = await scanHistory(root);
  // `damaged` (line numbers that could not be read) and `broken` (hashes where the chain breaks) are only present when there are any.
  return {
    enabled,
    points,
    ...(damaged.length > 0 && { damaged }),
    ...(broken.length > 0 && { broken: broken.map(({ hash }) => hash) }),
  };
}

/** Writes values sent by the web editor to values.yml (creating profiles named in `uses`), then pushes. */
export async function saveUiState(
  ctx: Context,
  input: NormalizedValues,
  options: { base?: string } = {},
): Promise<{ created: string[]; code: number; conflict?: boolean }> {
  return await withLock(await findRoot(ctx.cwd), () => saveUiStateLocked(ctx, input, options));
}

async function saveUiStateLocked(
  ctx: Context,
  input: NormalizedValues,
  options: { base?: string } = {},
): Promise<{ created: string[]; code: number; conflict?: boolean }> {
  const root = await findRoot(ctx.cwd);
  const path = join(root, ".envs/values.yml");
  const currentText = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "";
  // The editor was loaded from an older values.yml: saving would silently overwrite what changed since.
  if (options.base !== undefined && options.base !== valuesVersion(currentText)) {
    ctx.error("values.yml changed after the editor was loaded (another command or editor saved it). Reload the editor and apply your changes again; nothing was saved.");
    return { created: [], code: 1, conflict: true };
  }
  const before = normalizeValues((Bun.YAML.parse(currentText) ?? {}) as Values);
  const values = normalizeValues({ uses: input.uses, profiles: input.profiles });
  // The editor sends every value as text. An unchanged value keeps the exact value (and type) it had;
  // anything else gets its type back as `pull` does (`3000` → number, `true` → boolean), so an untouched
  // value is never saved, or recorded in the history, as a change.
  const typed = (value: Value, previous: Value | undefined): Value =>
    typeof value !== "string" ? value : previous !== undefined && String(previous) === value ? previous : parseValue(value);
  for (const [name, profile] of Object.entries(values.profiles)) {
    const old = Object.hasOwn(before.profiles, name) ? before.profiles[name] : undefined;
    for (const [key, value] of Object.entries(profile.defaults)) {
      profile.defaults[key] = typed(value, old && Object.hasOwn(old.defaults, key) ? old.defaults[key] : undefined);
    }
    for (const [key, byWorktree] of Object.entries(profile.envs)) {
      const oldByWorktree = old && Object.hasOwn(old.envs, key) ? old.envs[key] : undefined;
      for (const [worktree, value] of Object.entries(byWorktree)) {
        byWorktree[worktree] = typed(value, oldByWorktree && Object.hasOwn(oldByWorktree, worktree) ? oldByWorktree[worktree] : undefined);
      }
    }
  }
  // Refuse before writing anything: push could not write these values to a .env.
  let safe = true;
  for (const [profileName, profile] of Object.entries(values.profiles)) {
    const check = (key: string, value: Value, where: string) => {
      const problem = dotenvProblem(key, String(value));
      if (!problem) return;
      safe = false;
      ctx.error(`${JSON.stringify(key)} (${where}): ${problem}. Nothing was saved.`);
    };
    for (const [key, value] of Object.entries(profile.defaults)) check(key, value, `${profileName} defaults`);
    for (const [key, byWorktree] of Object.entries(profile.envs)) {
      for (const [worktree, value] of Object.entries(byWorktree)) check(key, value, `${profileName} ${worktree}`);
    }
  }
  if (!safe) return { created: [], code: 1 };
  const created = materializeProfiles(values);
  await Bun.write(path, stringifyValues(values));
  await recordHistory(root, before, values, ctx.now, ctx.error);
  return { created, code: await push(ctx) };
}

/** A short fingerprint of values.yml: the web editor sends back the one it loaded, to detect a stale save. */
export function valuesVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
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
  try {
    return await dispatch(args, ctx);
  } catch (error) {
    if (!(error instanceof LockError)) throw error;
    ctx.error(error.message);
    return 1;
  }
}

async function dispatch(args: string[], ctx: Context): Promise<number> {
  const parsed = parser(args);
  if (!parsed.ok) {
    const { error } = parsed;
    const unknownCommand = error instanceof UnexpectedArgumentError && error.argument === args[0];
    ctx.error(`${unknownCommand ? `Unknown command: ${args[0]}` : (error instanceof Error ? error.message : String(error))}\n\n${HELP}`);
    return 1;
  }
  if (parsed.action === "version") {
    ctx.log(pkg.version);
    return 0;
  }
  if (parsed.action === "help" || parsed.help) {
    ctx.log(HELP);
    return 0;
  }
  switch (parsed.action) {
    case "init":
      return await init(ctx);
    case "push":
      return await push(ctx);
    case "pull":
      return await pull(ctx);
    case "lint":
      return await lint(ctx);
    case "edit":
      return await edit(ctx, { ui: parsed.ui });
    case "use":
      return await use(ctx, parsed.profile ?? undefined);
    case "history":
      return await historyCommand(ctx, parsed.redact ? ["redact"] : []);
    case "restore":
      return await restore(ctx, parsed.hash ?? undefined, { force: parsed.force });
    case "config.set":
      return await config(ctx, ["set", ...(parsed.key === null ? [] : [parsed.key]), ...(parsed.value ?? [])]);
    case "config.get":
      return await config(ctx, parsed.key === null ? ["get"] : ["get", parsed.key]);
    case "config.delete":
      return await config(ctx, parsed.key === null ? ["delete"] : ["delete", parsed.key]);
    default:
      return await config(ctx, []);
  }
}
