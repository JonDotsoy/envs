import { describe, expect, test } from "bun:test";
import { EMPTY_VALUE, fromVarRows, toVarRows, type Profile } from "../src/ui/rows";

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
