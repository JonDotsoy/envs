/**
 * The editor's pages, kept in the URL hash so the browser's back button and a reload keep them:
 * `#/overview` (every worktree), `#/worktree/<name>` (one worktree, a column per profile) and
 * `#/settings` (auto-save and where the files are).
 * No React in here, so tests can use it directly.
 */
export type Route = { page: "overview" } | { page: "settings" } | { page: "worktree"; worktree: string };

/** The hash of a route. Worktree names are branch names and may contain `/`, so they are encoded. */
export const routeHash = (route: Route): string =>
  route.page === "worktree" ? `#/worktree/${encodeURIComponent(route.worktree)}` : `#/${route.page}`;

/**
 * The route a hash names, among the known worktrees. An empty or unknown hash falls back to the
 * worktree the command was run from (`current`) when there is one, else to the overview.
 */
export function parseRoute(hash: string, worktrees: string[], current?: string): Route {
  const fallback: Route = current !== undefined && worktrees.includes(current) ? { page: "worktree", worktree: current } : { page: "overview" };
  if (hash === "#/overview") return { page: "overview" };
  if (hash === "#/settings") return { page: "settings" };
  const match = /^#\/worktree\/(.+)$/.exec(hash);
  if (!match) return fallback;
  let name: string;
  try {
    name = decodeURIComponent(match[1]!);
  } catch {
    return fallback;
  }
  return worktrees.includes(name) ? { page: "worktree", worktree: name } : fallback;
}
