/**
 * The editor's variable table: how a profile becomes rows of text cells and back.
 * No React in here, so tests can use the very same functions the page does.
 */
import { dict } from "../history";

export type Value = string | number | boolean;

export interface Profile {
  defaults: Record<string, Value>;
  envs: Record<string, Record<string, Value>>;
}

/**
 * What a cell shows for a variable that is set to the empty string (`FOO=`). An empty cell means
 * "not set" (it inherits the default), so the two need different text.
 */
export const EMPTY_VALUE = '""';

/** One variable of a profile: its default and its override per worktree (missing/empty cell = not set). */
export type VarRow = { key: string; def: string; byWorktree: Record<string, string> };

const toCell = (value: Value) => (String(value) === "" ? EMPTY_VALUE : String(value));
/** The value a cell holds, or undefined when it is empty (not set). */
const fromCell = (cell: string): string | undefined => (cell === EMPTY_VALUE ? "" : cell === "" ? undefined : cell);

export const toVarRows = (profile: Profile): VarRow[] => {
  const rows = new Map<string, VarRow>();
  const row = (key: string) => rows.get(key) ?? rows.set(key, { key, def: "", byWorktree: dict() }).get(key)!;
  for (const [key, value] of Object.entries(profile.defaults)) row(key).def = toCell(value);
  for (const [key, byWorktree] of Object.entries(profile.envs)) {
    for (const [wt, value] of Object.entries(byWorktree)) row(key).byWorktree[wt] = toCell(value);
  }
  return [...rows.values()];
};

export const fromVarRows = (rows: VarRow[]): Profile => {
  // Maps without a prototype: a variable called `__proto__` or `constructor` is just a name.
  const profile: Profile = { defaults: dict(), envs: dict() };
  for (const { key: raw, def, byWorktree } of rows) {
    const key = raw.trim();
    if (key === "") continue;
    const defaultValue = fromCell(def);
    if (defaultValue !== undefined) profile.defaults[key] = defaultValue;
    for (const [wt, cell] of Object.entries(byWorktree)) {
      const value = fromCell(cell);
      if (value !== undefined) (profile.envs[key] ??= dict())[wt] = value;
    }
  }
  return profile;
};

/*
 * The worktree page: one worktree, a column per profile. The editor keeps each profile's variables
 * as VarRow[] (the overview's shape); this page works on an aligned copy where every profile has the
 * same rows in the same order, so row `i` is the same variable in every profile and an edit never
 * moves a row. The rows a profile gets only to line up are empty, and fromVarRows drops them.
 */

/** Every profile's VarRow[], by profile name: the editor's state. */
export type VarsByProfile = Record<string, VarRow[]>;

const blank = (key: string): VarRow => ({ key, def: "", byWorktree: dict() });

/**
 * Every profile with the same rows in the same order: the union of their variables, in order of
 * first appearance (profiles in their order, rows in theirs), so rows do not move when another
 * profile is picked. The n-th row named `K` in one profile is the same variable as the n-th row named
 * `K` in another: blank rows being typed, and the rare duplicate name, line up instead of merging.
 * Returns the same object when the profiles are already aligned.
 */
export function alignProfiles(vars: VarsByProfile): VarsByProfile {
  const order: string[] = [];
  const known = new Set<string>();
  const byProfile = new Map<string, Map<string, VarRow>>();
  for (const [profile, list] of Object.entries(vars)) {
    const seen = new Map<string, number>();
    const rows = new Map<string, VarRow>();
    for (const row of list) {
      const n = seen.get(row.key) ?? 0;
      seen.set(row.key, n + 1);
      const id = `${n}:${row.key}`;
      if (!known.has(id)) {
        known.add(id);
        order.push(id);
      }
      rows.set(id, row);
    }
    byProfile.set(profile, rows);
  }
  const aligned = Object.entries(vars).every(
    ([profile, list]) => list.length === order.length && list.every((row, i) => byProfile.get(profile)!.get(order[i]!) === row),
  );
  if (aligned) return vars;
  return Object.fromEntries(
    Object.keys(vars).map((profile) => [profile, order.map((id) => byProfile.get(profile)!.get(id) ?? blank(id.slice(id.indexOf(":") + 1)))]),
  );
}

/** The variable names of an aligned table, one per row. */
export const tableKeys = (table: VarsByProfile): string[] => (Object.values(table)[0] ?? []).map((row) => row.key);

/** A worktree's own cell in a row ("" = not set: it inherits the profile's default). */
export const cellOf = (row: VarRow | undefined, worktree: string): string =>
  row && Object.hasOwn(row.byWorktree, worktree) ? row.byWorktree[worktree]! : "";

const patchAt = (table: VarsByProfile, profile: string, i: number, patch: (row: VarRow) => VarRow): VarsByProfile => ({
  ...table,
  [profile]: (table[profile] ?? []).map((row, j) => (j === i ? patch(row) : row)),
});

/** Sets the default of row `i` in one profile of an aligned table. */
export const setDefaultAt = (table: VarsByProfile, profile: string, i: number, cell: string): VarsByProfile =>
  patchAt(table, profile, i, (row) => ({ ...row, def: cell }));

/** Sets a worktree's own value of row `i` in one profile ("" clears it, so it inherits the default). */
export const setValueAt = (table: VarsByProfile, profile: string, i: number, worktree: string, cell: string): VarsByProfile =>
  patchAt(table, profile, i, (row) => ({ ...row, byWorktree: { ...row.byWorktree, [worktree]: cell } }));

/** Renames row `i` in every profile. */
export const renameAt = (table: VarsByProfile, i: number, key: string): VarsByProfile =>
  Object.fromEntries(Object.entries(table).map(([profile, list]) => [profile, list.map((row, j) => (j === i ? { ...row, key } : row))]));

/** Removes row `i` from every profile (its defaults and the values of every worktree). */
export const removeAt = (table: VarsByProfile, i: number): VarsByProfile =>
  Object.fromEntries(Object.entries(table).map(([profile, list]) => [profile, list.filter((_, j) => j !== i)]));

/** Adds a blank row at the end of every profile. */
export const addRow = (table: VarsByProfile): VarsByProfile =>
  Object.fromEntries(Object.entries(table).map(([profile, list]) => [profile, [...list, blank("")]]));

/**
 * Whether naming row `i` as `key` would give it the name of another variable: the two would become
 * one variable on save (one overwriting the other), so the page refuses the name instead.
 */
export const nameTaken = (keys: string[], i: number, key: string): boolean =>
  key.trim() !== "" && keys.some((other, j) => j !== i && other.trim() === key.trim());
