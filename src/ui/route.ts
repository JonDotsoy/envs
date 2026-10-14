/**
 * The editor's two pages, kept in the URL hash so the browser's back button and a reload keep them:
 * `#/overview` (every worktree) and `#/worktree/<name>` (one worktree, a column per profile).
 * No React in here, so tests can use it directly.
 */
export type Route = { page: "overview" } | { page: "worktree"; worktree: string };

/** The hash of a route. Worktree names are branch names and may contain `/`, so they are encoded. */
export const routeHash = (route: Route): string =>
  route.page === "overview" ? "#/overview" : `#/worktree/${encodeURIComponent(route.worktree)}`;

/**
 * The route a hash names, among the known worktrees. An empty or unknown hash falls back to the
 * worktree the command was run from (`current`) when there is one, else to the overview.
 */
export function parseRoute(hash: string, worktrees: string[], current?: string): Route {
  const fallback: Route = current !== undefined && worktrees.includes(current) ? { page: "worktree", worktree: current } : { page: "overview" };
  if (hash === "#/overview") return { page: "overview" };
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
