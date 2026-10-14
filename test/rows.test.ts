import { describe, expect, test } from "bun:test";
import {
  addRow,
  alignProfiles,
  cellOf,
  EMPTY_VALUE,
  fromVarRows,
  nameTaken,
  removeAt,
  renameAt,
  setDefaultAt,
  setValueAt,
  tableKeys,
  toVarRows,
  type Profile,
  type VarsByProfile,
} from "../src/ui/rows";

const profile = (defaults: Profile["defaults"], envs: Profile["envs"] = {}): Profile => ({ defaults, envs });
const plain = (p: Profile) => JSON.parse(JSON.stringify(p));

describe("the editor's variable table", () => {
  test("an empty-string value is shown as \"\" and comes back as an empty string, not as unset", () => {
    const rows = toVarRows(profile({ FLAG: "" }, { OPT: { main: "", one: "x" } }));
    expect(rows).toEqual([
      { key: "FLAG", def: EMPTY_VALUE, byWorktree: {} },
      { key: "OPT", def: "", byWorktree: { main: EMPTY_VALUE, one: "x" } },
    ]);
    expect(plain(fromVarRows(rows))).toEqual({ defaults: { FLAG: "" }, envs: { OPT: { main: "", one: "x" } } });
  });

  test("a really empty cell is unset (it inherits the default) and is dropped", () => {
    const rows = [{ key: "A", def: "", byWorktree: { main: "", one: "1" } }];
    expect(plain(fromVarRows(rows))).toEqual({ defaults: {}, envs: { A: { one: "1" } } });
  });

  test("a round trip keeps every value as text, whatever its type", () => {
    const original = profile({ N: 3000, B: true, S: "text", E: "" }, { P: { main: 1, one: false, two: "" } });
    expect(plain(fromVarRows(toVarRows(original)))).toEqual({
      defaults: { N: "3000", B: "true", S: "text", E: "" },
      envs: { P: { main: "1", one: "false", two: "" } },
    });
  });

  test("blank variable names are skipped and names are trimmed", () => {
    const rows = [
      { key: "  ", def: "x", byWorktree: {} },
      { key: " NAME ", def: "v", byWorktree: {} },
    ];
    expect(plain(fromVarRows(rows))).toEqual({ defaults: { NAME: "v" }, envs: {} });
  });
});

describe("the worktree page's table (a column per profile)", () => {
  /** The editor's state for two profiles, as toVarRows builds it from values.yml (values as text). */
  const sample = (): VarsByProfile => ({
    default: toVarRows(profile({ PORT: "3000", LOG: "info" }, { PORT: { main: "8080" } })),
    staging: toVarRows(profile({ PORT: "3000", URL: "https://staging" }, { LOG: { "fix-login": "" } })),
  });
  /** What Save sends for each profile. */
  const saved = (vars: VarsByProfile): Record<string, Profile> =>
    plain(Object.fromEntries(Object.entries(vars).map(([n, rows]) => [n, fromVarRows(rows)])) as any);

  test("every profile gets the same rows: the union of the variables, in order of first appearance", () => {
    const table = alignProfiles(sample());
    expect(tableKeys(table)).toEqual(["PORT", "LOG", "URL"]);
    expect(table.staging!.map((r) => r.key)).toEqual(["PORT", "LOG", "URL"]);
    // The rows added only to line up are empty, so the saved values do not change.
    expect(saved(table)).toEqual(saved(sample()));
    // An aligned table is returned as is (no new state on every render).
    expect(alignProfiles(table)).toBe(table);
  });

  test("a cell is the worktree's own value in that profile; empty means not set", () => {
    const table = alignProfiles(sample());
    expect(cellOf(table.default![0], "main")).toBe("8080");
    expect(cellOf(table.staging![0], "main")).toBe("");
    expect(table.staging![0]!.def).toBe("3000");
    // An empty value set on purpose is shown as "", unlike a cell that is not set.
    expect(cellOf(table.staging![1], "fix-login")).toBe(EMPTY_VALUE);
    expect(table.default![2]!.def).toBe("");
    // Worktrees named like Object properties are plain names.
    expect(cellOf(table.default![0], "constructor")).toBe("");
    expect(cellOf(table.default![0], "__proto__")).toBe("");
  });

  test("editing a cell changes only that profile and never moves a row", () => {
    const vars = sample();
    const table = alignProfiles(vars);
    const next = setValueAt(table, "default", 2, "main", "http://localhost");
    expect(saved(next).default).toEqual({ defaults: { PORT: "3000", LOG: "info" }, envs: { PORT: { main: "8080" }, URL: { main: "http://localhost" } } });
    expect(saved(next).staging).toEqual(saved(vars).staging);
    expect(tableKeys(alignProfiles(next))).toEqual(["PORT", "LOG", "URL"]);
    // The previous state is untouched.
    expect(saved(vars).default!.envs).toEqual({ PORT: { main: "8080" } });

    expect(saved(setDefaultAt(next, "default", 2, "http://dev")).default!.defaults.URL).toBe("http://dev");
  });

  test("clearing a cell unsets it (it inherits); \"\" keeps an empty value", () => {
    const table = alignProfiles(sample());
    expect(saved(setValueAt(table, "default", 0, "main", "")).default!.envs).toEqual({});
    expect(saved(setValueAt(table, "default", 1, "main", EMPTY_VALUE)).default!.envs).toEqual({ PORT: { main: "8080" }, LOG: { main: "" } });
  });

  test("renaming and removing act on every profile", () => {
    const table = alignProfiles(sample());
    const renamed = renameAt(table, 0, "HTTP_PORT");
    expect(tableKeys(alignProfiles(renamed))).toEqual(["HTTP_PORT", "LOG", "URL"]);
    expect(saved(renamed).default!.envs).toEqual({ HTTP_PORT: { main: "8080" } });
    expect(saved(renamed).staging!.defaults).toEqual({ HTTP_PORT: "3000", URL: "https://staging" });

    const removed = removeAt(table, 0);
    expect(tableKeys(alignProfiles(removed))).toEqual(["LOG", "URL"]);
    expect(saved(removed).staging).toEqual({ defaults: { URL: "https://staging" }, envs: { LOG: { "fix-login": "" } } });
  });

  test("a new variable is a blank row at the end of every profile, and saves nothing until it has a name", () => {
    const table = addRow(addRow(alignProfiles(sample())));
    expect(tableKeys(alignProfiles(table))).toEqual(["PORT", "LOG", "URL", "", ""]);
    expect(saved(table)).toEqual(saved(sample()));

    const named = setValueAt(renameAt(table, 3, "NEW"), "staging", 3, "main", "x");
    expect(saved(named).staging!.envs.NEW).toEqual({ main: "x" });
    // Naming it does not move it.
    expect(tableKeys(alignProfiles(named))).toEqual(["PORT", "LOG", "URL", "NEW", ""]);
  });

  test("a row added in the overview to one profile lines up with the others", () => {
    const vars = sample();
    vars.staging = [...vars.staging!, { key: "", def: "", byWorktree: {} }, { key: "EXTRA", def: "1", byWorktree: {} }];
    const table = alignProfiles(vars);
    expect(tableKeys(table)).toEqual(["PORT", "LOG", "URL", "", "EXTRA"]);
    expect(table.default!.map((r) => r.key)).toEqual(["PORT", "LOG", "URL", "", "EXTRA"]);
  });

  test("a name another variable has is taken (blank names never are)", () => {
    const keys = ["PORT", "LOG", "URL", ""];
    expect(nameTaken(keys, 2, "PORT")).toBe(true);
    expect(nameTaken(keys, 2, " PORT ")).toBe(true);
    expect(nameTaken(keys, 0, "PORT")).toBe(false);
    expect(nameTaken(keys, 0, "")).toBe(false);
    expect(nameTaken(keys, 3, "URLS")).toBe(false);
  });

  test("variables named like Object properties are plain names", () => {
    const vars: VarsByProfile = { default: toVarRows(JSON.parse('{"defaults":{"constructor":"1"},"envs":{"__proto__":{"main":"2"}}}')) };
    expect(tableKeys(alignProfiles(vars)).sort()).toEqual(["__proto__", "constructor"]);
  });
});
