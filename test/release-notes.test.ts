import { test, expect } from "bun:test";
import { renderNotes } from "../scripts/release-notes.ts";

const repoUrl = "https://github.com/o/r";

test("groups commits by type with PR links and a compare link", () => {
  const md = renderNotes({
    repoUrl,
    prev: "v0.1.12",
    tag: "v0.1.13",
    commits: [
      { hash: "cacaece", subject: "feat(ui): worktree page (#33)" },
      { hash: "bc23d17", subject: "ci(publish): attach envs.js (#32)" },
      { hash: "0c67390", subject: "chore: release v0.1.13" },
      { hash: "abc1234", subject: "Fix typo" },
    ],
  });
  expect(md).toContain("### ✨ Features\n- **ui**: worktree page ([#33](https://github.com/o/r/pull/33))");
  expect(md).toContain("### 🔧 Maintenance\n- **publish**: attach envs.js ([#32](https://github.com/o/r/pull/32))");
  expect(md).toContain("### Other changes\n- Fix typo ([abc1234](https://github.com/o/r/commit/abc1234))");
  expect(md).not.toContain("release v0.1.13");
  expect(md).toContain("[v0.1.12...v0.1.13](https://github.com/o/r/compare/v0.1.12...v0.1.13)");
});

test("lists breaking changes first and handles empty ranges", () => {
  const md = renderNotes({ repoUrl, prev: "v1.0.0", tag: "v2.0.0", commits: [{ hash: "a1", subject: "feat!: drop node (#1)" }] });
  expect(md.indexOf("Breaking changes")).toBeLessThan(md.indexOf("Features"));
  expect(renderNotes({ repoUrl, prev: "v1.0.0", tag: "v1.0.1", commits: [] })).toContain("No changes since v1.0.0.");
});
