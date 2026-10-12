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
