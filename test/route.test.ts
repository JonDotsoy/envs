import { describe, expect, test } from "bun:test";
import { parseRoute, routeHash } from "../src/ui/route";

const worktrees = ["main", "feature/checkout", "fix-login"];

describe("the editor's pages in the URL hash", () => {
  test("without a hash it opens on the worktree it was run from, else on the overview", () => {
    expect(parseRoute("", worktrees, "fix-login")).toEqual({ page: "worktree", worktree: "fix-login" });
    expect(parseRoute("", worktrees)).toEqual({ page: "overview" });
    // A current worktree the list does not know (it was just removed) is not a page.
    expect(parseRoute("", worktrees, "gone")).toEqual({ page: "overview" });
  });

  test("the hash names the page, whatever the current worktree", () => {
    expect(parseRoute("#/overview", worktrees, "fix-login")).toEqual({ page: "overview" });
    expect(parseRoute("#/worktree/main", worktrees, "fix-login")).toEqual({ page: "worktree", worktree: "main" });
  });

  test("worktree names with / round-trip through the hash", () => {
    const hash = routeHash({ page: "worktree", worktree: "feature/checkout" });
    expect(hash).toBe("#/worktree/feature%2Fcheckout");
    expect(parseRoute(hash, worktrees)).toEqual({ page: "worktree", worktree: "feature/checkout" });
    expect(routeHash({ page: "overview" })).toBe("#/overview");
  });

  test("an unknown worktree or a malformed hash falls back", () => {
    expect(parseRoute("#/worktree/nope", worktrees, "main")).toEqual({ page: "worktree", worktree: "main" });
    expect(parseRoute("#/worktree/%E0%A4%A", worktrees)).toEqual({ page: "overview" });
    expect(parseRoute("#/elsewhere", worktrees)).toEqual({ page: "overview" });
  });
});
