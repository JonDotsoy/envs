import { describe, expect, test } from "bun:test";
import {
  compareStates,
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
