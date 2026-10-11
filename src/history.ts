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
}

const keys = (a?: object, b?: object) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];

/** Leaf-level differences between two normalized values (`uses`, then each profile's `defaults` and `envs`). */
export function diffValues(before: NormalizedValues, after: NormalizedValues): Change[] {
  const changes: Change[] = [];
  const compare = (path: string[], a?: Value, b?: Value) => {
    if (a !== b) changes.push({ path, ...(a !== undefined && { from: a }), ...(b !== undefined && { to: b }) });
  };
  for (const w of keys(before.uses, after.uses)) compare(["uses", w], before.uses[w], after.uses[w]);
  for (const p of keys(before.profiles, after.profiles)) {
    const a = before.profiles[p];
    const b = after.profiles[p];
    for (const k of keys(a?.defaults, b?.defaults)) {
      compare(["profiles", p, "defaults", k], a?.defaults[k], b?.defaults[k]);
    }
    for (const k of keys(a?.envs, b?.envs)) {
      for (const w of keys(a?.envs[k], b?.envs[k])) {
        compare(["profiles", p, "envs", k, w], a?.envs[k]?.[w], b?.envs[k]?.[w]);
      }
    }
  }
  return changes;
}

/** Applies a point's changes to a state: `to` sets the entry, a missing `to` removes it. */
export function applyChanges(state: NormalizedValues, changes: Change[]): void {
  for (const { path, to } of changes) {
    const [section, ...rest] = path;
    if (section === "uses") {
      const [worktree] = rest as [string];
      if (to === undefined) delete state.uses[worktree];
      else state.uses[worktree] = String(to);
      continue;
    }
    const [profileName, kind, variable, worktree] = rest as [string, string, string, string?];
    const profile = (state.profiles[profileName] ??= { defaults: {}, envs: {} });
    if (kind === "defaults") {
      if (to === undefined) delete profile.defaults[variable];
      else profile.defaults[variable] = to;
    } else {
      const byWorktree = (profile.envs[variable] ??= {});
      if (to === undefined) delete byWorktree[worktree!];
      else byWorktree[worktree!] = to;
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

/**
 * The state values.yml had right after `target`: the points applied in order up to it. `default`
 * always exists, and a profile in use that has no values is empty (not a copy of `default`).
 */
export function stateAfter(points: HistoryPoint[], target: HistoryPoint): NormalizedValues {
  const state: NormalizedValues = { uses: {}, profiles: {} };
  for (const point of points) {
    applyChanges(state, point.changes);
    if (point === target) break;
  }
  state.profiles[DEFAULT_PROFILE] ??= { defaults: {}, envs: {} };
  for (const name of Object.values(state.uses)) state.profiles[name] ??= { defaults: {}, envs: {} };
  return state;
}

/** The state after each point, in the same order as `points` (`stateAfter` for every point in one pass). */
export function statesAfterEach(points: HistoryPoint[]): NormalizedValues[] {
  const state: NormalizedValues = { uses: {}, profiles: {} };
  return points.map((point) => {
    applyChanges(state, point.changes);
    const copy = structuredClone(state);
    copy.profiles[DEFAULT_PROFILE] ??= { defaults: {}, envs: {} };
    for (const name of Object.values(copy.uses)) copy.profiles[name] ??= { defaults: {}, envs: {} };
    return copy;
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
  const uses = keys(current.uses, target.uses).map((w) => entry(w, current.uses[w], target.uses[w])).filter(present);
  const profiles: ProfileDiff[] = [];
  for (const name of keys(current.profiles, target.profiles)) {
    const a = current.profiles[name];
    const b = target.profiles[name];
    const defaults = keys(a?.defaults, b?.defaults).map((k) => entry(k, a?.defaults[k], b?.defaults[k])).filter(present);
    const envs = keys(a?.envs, b?.envs)
      .flatMap((k) => keys(a?.envs[k], b?.envs[k]).map((w) => entry(k, a?.envs[k]?.[w], b?.envs[k]?.[w], w)))
      .filter(present);
    const status = !b ? "removed" : !a ? "added" : undefined;
    if (defaults.length === 0 && envs.length === 0 && !status) continue;
    profiles.push({ name, ...(status && { status }), defaults, envs });
  }
  const count = uses.length + profiles.reduce((n, p) => n + p.defaults.length + p.envs.length, 0);
  return { uses, profiles, count, same: uses.length === 0 && profiles.length === 0 };
}
