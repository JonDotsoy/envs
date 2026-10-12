/**
 * Pure history helpers shared by the CLI (src/envs.ts) and the web editor (src/ui/app.tsx).
 * Nothing here touches the file system, so the browser bundle can import it.
 */

/** YAML scalar accepted as a value; numbers and booleans are written to .env as their string form. */
export type Value = string | number | boolean;

export interface ResolvedProfile {
  defaults: Record<string, Value>;
  envs: Record<string, Record<string, Value>>;
}

/** values.yml with the legacy form folded into `profiles.default`; `default` always exists. */
export interface NormalizedValues {
  uses: Record<string, string>;
  profiles: Record<string, ResolvedProfile>;
}

export const DEFAULT_PROFILE = "default";

/**
 * A map keyed by names that come from files and requests (variables, profiles, worktrees). It has
 * no prototype, so `__proto__`, `constructor` or `toString` are plain names: they cannot reach
 * `Object.prototype` and are not mistaken for inherited members.
 */
export const dict = <T>(): Record<string, T> => Object.create(null);

/** The value of an own key (never an inherited one, whatever the object's prototype). */
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined =>
  map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

/** Sets an own key even if it is `__proto__` (a plain assignment would change the prototype instead). */
const put = <T>(map: Record<string, T>, key: string, value: T) =>
  void Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });

const emptyProfile = (): ResolvedProfile => ({ defaults: dict(), envs: dict() });
export const emptyState = (): NormalizedValues => ({ uses: dict(), profiles: dict() });

/** A deep copy of a profile whose maps have no prototype (`structuredClone` would give them one). */
export function cloneProfile(profile: ResolvedProfile): ResolvedProfile {
  const copy = emptyProfile();
  for (const [key, value] of Object.entries(profile.defaults)) put(copy.defaults, key, value);
  for (const [key, byWorktree] of Object.entries(profile.envs)) {
    const target = dict<Value>();
    for (const [worktree, value] of Object.entries(byWorktree)) put(target, worktree, value);
    put(copy.envs, key, target);
  }
  return copy;
}

/** A deep copy of a state whose maps have no prototype. */
export function cloneState(state: NormalizedValues): NormalizedValues {
  const copy = emptyState();
  for (const [worktree, profile] of Object.entries(state.uses)) put(copy.uses, worktree, profile);
  for (const [name, profile] of Object.entries(state.profiles)) put(copy.profiles, name, cloneProfile(profile));
  return copy;
}

/** One difference between two versions of values.yml; `from`/`to` are absent when the entry was added/removed. */
export interface Change {
  path: string[];
  from?: Value;
  to?: Value;
}

/** A line of .envs/history.ndjson. */
export interface HistoryPoint {
  hash: string;
  prev: string | null;
  timestamp: string;
  changes: Change[];
  /** A point that records changes made outside the history (a manual edit, or a period with the history off). */
  resync?: boolean;
}

const keys = (a?: object, b?: object) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];

/** Leaf-level differences between two normalized values (`uses`, then each profile's `defaults` and `envs`). */
export function diffValues(before: NormalizedValues, after: NormalizedValues): Change[] {
  const changes: Change[] = [];
  const compare = (path: string[], a?: Value, b?: Value) => {
    if (a !== b) changes.push({ path, ...(a !== undefined && { from: a }), ...(b !== undefined && { to: b }) });
  };
  for (const w of keys(before.uses, after.uses)) compare(["uses", w], own(before.uses, w), own(after.uses, w));
  for (const p of keys(before.profiles, after.profiles)) {
    const a = own(before.profiles, p);
    const b = own(after.profiles, p);
    for (const k of keys(a?.defaults, b?.defaults)) {
      compare(["profiles", p, "defaults", k], own(a?.defaults, k), own(b?.defaults, k));
    }
    for (const k of keys(a?.envs, b?.envs)) {
      const ea = own(a?.envs, k);
      const eb = own(b?.envs, k);
      for (const w of keys(ea, eb)) compare(["profiles", p, "envs", k, w], own(ea, w), own(eb, w));
    }
  }
  return changes;
}

/**
 * Applies a point's changes to a state: `to` sets the entry, a missing `to` removes it. Names come
 * from the history file, so every access is by own key and the new maps have no prototype: a
 * variable, profile or worktree called `__proto__` or `constructor` cannot pollute `Object.prototype`.
 */
export function applyChanges(state: NormalizedValues, changes: Change[]): void {
  for (const { path, to } of changes) {
    const [section, ...rest] = path;
    if (section === "uses") {
      const [worktree] = rest as [string];
      if (to === undefined) delete state.uses[worktree];
      else put(state.uses, worktree, String(to));
      continue;
    }
    const [profileName, kind, variable, worktree] = rest as [string, string, string, string?];
    let profile = own(state.profiles, profileName);
    if (!profile) put(state.profiles, profileName, (profile = emptyProfile()));
    if (kind === "defaults") {
      if (to === undefined) delete profile.defaults[variable];
      else put(profile.defaults, variable, to);
    } else {
      let byWorktree = own(profile.envs, variable);
      if (!byWorktree) put(profile.envs, variable, (byWorktree = dict()));
      if (to === undefined) delete byWorktree[worktree!];
      else put(byWorktree, worktree!, to);
      if (Object.keys(byWorktree).length === 0) delete profile.envs[variable];
    }
  }
}

/** The point whose hash starts with `hash`, or why there is not exactly one. */
export function findHistoryPoint(
  points: HistoryPoint[],
  hash: string,
): { point: HistoryPoint } | { error: "none" | "ambiguous"; matches: number } {
  const matches = hash === "" ? [] : points.filter((point) => point.hash.startsWith(hash));
  if (matches.length === 1) return { point: matches[0]! };
  return { error: matches.length === 0 ? "none" : "ambiguous", matches: matches.length };
}

/** `default` always exists, and a profile in use that has no values is empty (not a copy of `default`). */
function withDefaults(state: NormalizedValues): NormalizedValues {
  for (const name of [DEFAULT_PROFILE, ...Object.values(state.uses)]) {
    if (!own(state.profiles, name)) put(state.profiles, name, emptyProfile());
  }
  return state;
}

/**
 * The state values.yml had right after `target`: the points applied in order up to it. `default`
 * always exists, and a profile in use that has no values is empty (not a copy of `default`).
 */
export function stateAfter(points: HistoryPoint[], target: HistoryPoint): NormalizedValues {
  const state = emptyState();
  for (const point of points) {
    applyChanges(state, point.changes);
    if (point === target) break;
  }
  withDefaults(state);
  return state;
}

/** The state after each point, in the same order as `points` (`stateAfter` for every point in one pass). */
export function statesAfterEach(points: HistoryPoint[]): NormalizedValues[] {
  const state = emptyState();
  return points.map((point) => {
    applyChanges(state, point.changes);
    return withDefaults(cloneState(state));
  });
}

/**
 * How one entry would change when going from the current state to another one:
 * `removed` (only in the current state), `changed` (in both, different value) or `added` (only in the other).
 */
export type DiffKind = "removed" | "changed" | "added";

export interface DiffEntry {
  kind: DiffKind;
  /** Variable name (`defaults`/`envs`) or worktree name (`uses`). */
  key: string;
  /** Worktree of an `envs` entry. */
  worktree?: string;
  current?: Value;
  target?: Value;
}

export interface ProfileDiff {
  name: string;
  /** Set when the whole profile exists on one side only. */
  status?: "removed" | "added";
  defaults: DiffEntry[];
  envs: DiffEntry[];
}

/** The differences between two states, grouped for display: worktree profiles, then each profile. */
export interface StateDiff {
  uses: DiffEntry[];
  profiles: ProfileDiff[];
  /** Number of entries in every group (a profile that only appears or disappears, empty, has none). */
  count: number;
  /** True when both states are the same. */
  same: boolean;
}

/**
 * What would change if `target` replaced `current`. Values are compared as the text a `.env`
 * gets, so `3000` and `"3000"` are equal (the web editor holds every value as a string).
 */
export function compareStates(current: NormalizedValues, target: NormalizedValues): StateDiff {
  const asText = (v?: Value) => (v === undefined ? undefined : String(v));
  const entry = (key: string, a?: Value, b?: Value, worktree?: string): DiffEntry | undefined => {
    if (asText(a) === asText(b)) return undefined;
    const kind: DiffKind = b === undefined ? "removed" : a === undefined ? "added" : "changed";
    return {
      kind,
      key,
      ...(worktree !== undefined && { worktree }),
      ...(a !== undefined && { current: a }),
      ...(b !== undefined && { target: b }),
    };
  };
  const present = (e: DiffEntry | undefined): e is DiffEntry => e !== undefined;
  const uses = keys(current.uses, target.uses).map((w) => entry(w, own(current.uses, w), own(target.uses, w))).filter(present);
  const profiles: ProfileDiff[] = [];
  for (const name of keys(current.profiles, target.profiles)) {
    const a = own(current.profiles, name);
    const b = own(target.profiles, name);
    const defaults = keys(a?.defaults, b?.defaults).map((k) => entry(k, own(a?.defaults, k), own(b?.defaults, k))).filter(present);
    const envs = keys(a?.envs, b?.envs)
      .flatMap((k) => {
        const ea = own(a?.envs, k);
        const eb = own(b?.envs, k);
        return keys(ea, eb).map((w) => entry(k, own(ea, w), own(eb, w), w));
      })
      .filter(present);
    const status = !b ? "removed" : !a ? "added" : undefined;
    if (defaults.length === 0 && envs.length === 0 && !status) continue;
    profiles.push({ name, ...(status && { status }), defaults, envs });
  }
  const count = uses.length + profiles.reduce((n, p) => n + p.defaults.length + p.envs.length, 0);
  return { uses, profiles, count, same: uses.length === 0 && profiles.length === 0 };
}
