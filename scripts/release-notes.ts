/**
 * Builds the "What's changed" section of a GitHub release from the commits since the previous tag.
 *
 * Usage (from the publish workflow): VERSION=0.1.14 PREV=v0.1.13 REPO_URL=https://github.com/o/r bun scripts/release-notes.ts
 */

type Commit = { hash: string; subject: string };

const GROUPS: { title: string; types: string[] }[] = [
  { title: "✨ Features", types: ["feat"] },
  { title: "🐛 Fixes", types: ["fix", "perf"] },
  { title: "📚 Documentation", types: ["docs"] },
  { title: "🔧 Maintenance", types: ["ci", "build", "chore", "refactor", "test", "style"] },
];

const SUBJECT = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;

export function renderNotes(opts: { commits: Commit[]; repoUrl: string; prev?: string; tag: string }): string {
  const { repoUrl, prev, tag } = opts;
  const commits = opts.commits.filter((c) => !/^chore: release v/.test(c.subject));

  const line = (c: Commit, text: string, scope?: string) => {
    const pr = c.subject.match(PR_SUFFIX)?.[1];
    const ref = pr ? `([#${pr}](${repoUrl}/pull/${pr}))` : `([${c.hash}](${repoUrl}/commit/${c.hash}))`;
    return `- ${scope ? `**${scope}**: ` : ""}${text.replace(PR_SUFFIX, "")} ${ref}`;
  };

  const breaking: string[] = [];
  const groups = new Map<string, string[]>();
  for (const c of commits) {
    const m = c.subject.match(SUBJECT);
    const type = m?.[1].toLowerCase();
    const title = GROUPS.find((g) => type && g.types.includes(type))?.title ?? "Other changes";
    const entry = m ? line(c, m[4], m[2]) : line(c, c.subject);
    if (m?.[3]) breaking.push(entry);
    groups.set(title, [...(groups.get(title) ?? []), entry]);
  }

  const out = ["## What's changed", ""];
  if (commits.length === 0) out.push(prev ? `No changes since ${prev}.` : "No changes.", "");
  if (breaking.length) out.push("### ⚠️ Breaking changes", ...breaking, "");
  for (const title of [...GROUPS.map((g) => g.title), "Other changes"]) {
    if (groups.has(title)) out.push(`### ${title}`, ...groups.get(title)!, "");
  }
  if (prev) out.push(`**Full changelog**: [${prev}...${tag}](${repoUrl}/compare/${prev}...${tag})`, "");
  return out.join("\n");
}

if (import.meta.main) {
  const { VERSION, PREV, REPO_URL } = process.env;
  if (!VERSION || !REPO_URL) throw new Error("VERSION and REPO_URL are required");
  const tag = `v${VERSION}`;
  const range = PREV ? `${PREV}..${tag}` : tag;
  const log = await Bun.$`git log --no-merges --reverse --format=%h%x09%s ${range}`.text();
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, ...rest] = l.split("\t");
      return { hash: hash!, subject: rest.join("\t") };
    });
  process.stdout.write(renderNotes({ commits, repoUrl: REPO_URL, prev: PREV || undefined, tag }));
}
