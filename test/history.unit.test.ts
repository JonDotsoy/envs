import { describe, expect, test } from "bun:test";
import {
  applyChanges,
  cloneState,
  compareStates,
  diffValues,
  emptyState,
  findHistoryPoint,
  stateAfter,
  statesAfterEach,
  type HistoryPoint,
  type NormalizedValues,
} from "../src/history";

const point = (hash: string, changes: HistoryPoint["changes"]): HistoryPoint => ({
  hash,
  prev: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  changes,
});

/** The initial state, then PORT changes in main, LOG is removed and a `dev` profile appears. */
const points: HistoryPoint[] = [
  point("aaaa00000001", [
    { path: ["uses", "main"], to: "default" },
    { path: ["profiles", "default", "defaults", "LOG"], to: "info" },
    { path: ["profiles", "default", "envs", "PORT", "main"], to: 3000 },
  ]),
  point("aaaa00000002", [{ path: ["profiles", "default", "envs", "PORT", "main"], from: 3000, to: 4000 }]),
  point("bbbb00000003", [
    { path: ["profiles", "default", "defaults", "LOG"], from: "info" },
    { path: ["uses", "main"], from: "default", to: "dev" },
  ]),
];

describe("findHistoryPoint", () => {
  test("matches a whole hash or a unique prefix", () => {
    expect(findHistoryPoint(points, "aaaa00000002")).toEqual({ point: points[1]! });
    expect(findHistoryPoint(points, "bb")).toEqual({ point: points[2]! });
  });

  test("reports no match, an ambiguous prefix and an empty hash", () => {
    expect(findHistoryPoint(points, "cc")).toEqual({ error: "none", matches: 0 });
    expect(findHistoryPoint(points, "aaaa")).toEqual({ error: "ambiguous", matches: 2 });
    expect(findHistoryPoint(points, "")).toEqual({ error: "none", matches: 0 });
  });
});

describe("stateAfter", () => {
  test("applies the points in order up to the target", () => {
    expect(stateAfter(points, points[0]!)).toEqual({
      uses: { main: "default" },
      profiles: { default: { defaults: { LOG: "info" }, envs: { PORT: { main: 3000 } } } },
    });
    expect(stateAfter(points, points[1]!).profiles.default!.envs.PORT).toEqual({ main: 4000 });
  });

  test("a profile in use without values exists and is empty", () => {
    expect(stateAfter(points, points[2]!)).toEqual({
      uses: { main: "dev" },
      profiles: {
        default: { defaults: {}, envs: { PORT: { main: 4000 } } },
        dev: { defaults: {}, envs: {} },
      },
    });
  });
});

test("statesAfterEach matches stateAfter for every point", () => {
  expect(statesAfterEach(points)).toEqual(points.map((p) => stateAfter(points, p)));
  expect(statesAfterEach([])).toEqual([]);
});

describe("compareStates", () => {
  const current: NormalizedValues = {
    uses: { main: "default", "feature-x": "default" },
    profiles: {
      default: {
        defaults: { LOG: "debug", TOKEN: "abc" },
        envs: { PORT: { main: "3000", "feature-x": "3001" } },
      },
      staging: { defaults: { URL: "https://staging" }, envs: {} },
    },
  };
  const target: NormalizedValues = {
    uses: { main: "default", "feature-x": "dev" },
    profiles: {
      default: {
        defaults: { LOG: "info", DEBUG: true },
        envs: { PORT: { main: 3000 } },
      },
      dev: { defaults: {}, envs: {} },
    },
  };

  test("groups removed, changed and added entries by uses and profile", () => {
    const diff = compareStates(current, target);
    expect(diff.uses).toEqual([{ kind: "changed", key: "feature-x", current: "default", target: "dev" }]);
    expect(diff.profiles).toEqual([
      {
        name: "default",
        defaults: [
          { kind: "changed", key: "LOG", current: "debug", target: "info" },
          { kind: "removed", key: "TOKEN", current: "abc" },
          { kind: "added", key: "DEBUG", target: true },
        ],
        // "3000" and 3000 are the same .env value: only feature-x differs.
        envs: [{ kind: "removed", key: "PORT", worktree: "feature-x", current: "3001" }],
      },
      {
        name: "staging",
        status: "removed",
        defaults: [{ kind: "removed", key: "URL", current: "https://staging" }],
        envs: [],
      },
      // An empty profile that only exists at the point still shows up as added.
      { name: "dev", status: "added", defaults: [], envs: [] },
    ]);
    expect(diff.count).toBe(6);
    expect(diff.same).toBe(false);
  });

  test("the same state has no differences", () => {
    const diff = compareStates(current, structuredClone(current));
    expect(diff).toEqual({ uses: [], profiles: [], count: 0, same: true });
  });
});

describe("names that look like prototype members", () => {
  const ODD = ["__proto__", "constructor", "toString", "hasOwnProperty", "prototype"];
  const clean = () => {
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).x).toBeUndefined();
  };

  test("applyChanges keeps them as plain names, on a plain or a prototype-less state, without touching Object.prototype", () => {
    for (const state of [{ uses: {}, profiles: {} } as NormalizedValues, emptyState()]) {
      const changes: HistoryPoint["changes"] = [];
      for (const name of ODD) {
        changes.push(
          { path: ["uses", name], to: name },
          { path: ["profiles", name, "defaults", name], to: "d" },
          { path: ["profiles", "default", "envs", name, name], to: "v" },
          { path: ["profiles", "default", "envs", name, "main"], to: "polluted" },
        );
      }
      applyChanges(state, changes);
      clean();
      for (const name of ODD) {
        expect(Object.hasOwn(state.uses, name)).toBe(true);
        expect(Object.hasOwn(state.profiles, name)).toBe(true);
        expect(Object.hasOwn(state.profiles[name]!.defaults, name)).toBe(true);
        expect(Object.hasOwn(state.profiles.default!.envs, name)).toBe(true);
        expect(Object.hasOwn(state.profiles.default!.envs[name]!, name)).toBe(true);
      }
      // Removing works the same way and drops the emptied variable.
      applyChanges(state, ODD.flatMap((name) => [
        { path: ["profiles", "default", "envs", name, name], from: "v" },
        { path: ["profiles", "default", "envs", name, "main"], from: "polluted" },
      ]));
      expect(Object.keys(state.profiles.default?.envs ?? {})).toEqual([]);
    }
  });

  test("diffValues, stateAfter, statesAfterEach and compareStates round-trip them", () => {
    const first = point("aaaa00000001", [
      { path: ["uses", "__proto__"], to: "constructor" },
      { path: ["profiles", "constructor", "defaults", "toString"], to: "x" },
      { path: ["profiles", "default", "envs", "__proto__", "constructor"], to: 1 },
    ]);
    const second = point("aaaa00000002", [{ path: ["profiles", "default", "envs", "__proto__", "constructor"], from: 1, to: 2 }]);
    const states = statesAfterEach([first, second]);
    const after = stateAfter([first, second], second);
    expect(diffValues(states[0]!, states[1]!)).toEqual(second.changes);
    // Three changes plus the creation of the `constructor` profile.
    expect(diffValues(emptyState(), after)).toContainEqual({ path: ["profiles", "constructor"], to: true });
    expect(diffValues(emptyState(), after).length).toBe(4);
    expect(Object.hasOwn(after.uses, "__proto__")).toBe(true);
    const diff = compareStates(states[0]!, states[1]!);
    expect(diff.count).toBe(1);
    expect(diff.profiles[0]!.envs[0]).toMatchObject({ kind: "changed", key: "__proto__", worktree: "constructor" });
    // Inherited members are never mistaken for entries.
    expect(diffValues({ uses: {}, profiles: {} }, { uses: {}, profiles: {} })).toEqual([]);
    expect(compareStates({ uses: {}, profiles: {} }, { uses: {}, profiles: {} }).same).toBe(true);
    clean();
  });

  test("cloneState copies them without a prototype", () => {
    const state = emptyState();
    applyChanges(state, [{ path: ["profiles", "default", "envs", "__proto__", "constructor"], to: 1 }]);
    const copy = cloneState(state);
    expect(Object.getPrototypeOf(copy.profiles)).toBeNull();
    expect(Object.getPrototypeOf(copy.profiles.default!.envs)).toBeNull();
    expect(copy.profiles.default!.envs["__proto__"]!["constructor"]).toBe(1);
    clean();
  });
});

describe("profiles are part of the history even when empty", () => {
  const profile = (defaults = {}) => ({ defaults, envs: {} });
  const state = (profiles: Record<string, any>): NormalizedValues => ({ uses: {}, profiles: { default: profile(), ...profiles } });

  test("diffValues records the creation and the removal of a profile, `default` aside", () => {
    expect(diffValues(state({}), state({ qa: profile() }))).toEqual([{ path: ["profiles", "qa"], to: true }]);
    expect(diffValues(state({ qa: profile() }), state({}))).toEqual([{ path: ["profiles", "qa"], from: true }]);
    // A profile with values: creation first, then its values; on removal, its values first, then the profile.
    expect(diffValues(state({}), state({ qa: profile({ A: 1 }) }))).toEqual([
      { path: ["profiles", "qa"], to: true },
      { path: ["profiles", "qa", "defaults", "A"], to: 1 },
    ]);
    expect(diffValues(state({ qa: profile({ A: 1 }) }), state({}))).toEqual([
      { path: ["profiles", "qa", "defaults", "A"], from: 1 },
      { path: ["profiles", "qa"], from: true },
    ]);
  });

  test("replaying creation and removal gives back the same profiles", () => {
    const states = [state({}), state({ qa: profile() }), state({ qa: profile({ A: 1 }), dev: profile() }), state({ dev: profile() })];
    const replay = emptyState();
    states.slice(1).forEach((next, i) => {
      applyChanges(replay, diffValues(states[i]!, next));
      expect(Object.keys(replay.profiles).filter((p) => p !== "default").sort()).toEqual(Object.keys(next.profiles).filter((p) => p !== "default").sort());
    });
    expect(Object.keys(replay.profiles)).not.toContain("qa");
  });

  test("histories written before this still replay (profiles appear through their values)", () => {
    const old: HistoryPoint["changes"] = [{ path: ["profiles", "qa", "defaults", "A"], to: 1 }];
    const replay = emptyState();
    applyChanges(replay, old);
    expect(Object.keys(replay.profiles)).toEqual(["qa"]);
  });
});

describe("redacted secrets in comparisons", () => {
  const state = (value: string | undefined): NormalizedValues => ({
    uses: {},
    profiles: { default: { defaults: {}, envs: value === undefined ? {} : { API_TOKEN: { main: value } } } },
  });
  const MARK = "envs:redacted:0123456789abcdef";

  test("a redacted value in the target is not a difference when the editor has the variable", () => {
    expect(compareStates(state("tok"), state(MARK)).same).toBe(true);
    expect(compareStates(state("other"), state(MARK)).same).toBe(true);
  });

  test("but a variable the editor lacks is an addition, and the target's absence is still a removal", () => {
    expect(compareStates(state(undefined), state(MARK)).profiles[0]!.envs[0]).toMatchObject({ kind: "added", key: "API_TOKEN", target: MARK });
    expect(compareStates(state("tok"), state(undefined)).profiles[0]!.envs[0]).toMatchObject({ kind: "removed" });
  });
});

