/** What both pages share: the header (pages, status, History, Save), the history card and the Save/Restore log. */
import type { NormalizedValues } from "../history";
import { HistoryPanel, type HistoryState } from "./history-panel";
import { Logo } from "./logo";
import { routeHash, type Route } from "./route";
import { EMPTY_VALUE, type Profile } from "./rows";

/** GET /api/values. */
export interface State {
  uses: Record<string, string>;
  profiles: Record<string, Profile>;
  worktrees: string[];
  /** The worktree `envs edit --ui` was run from (absent when the folder is in none): the editor opens on its page. */
  current?: string;
  /** Fingerprint of the values.yml this state was read from; sent back on Save to detect a stale editor. */
  version: string;
}
export interface SaveResult {
  ok: boolean;
  created: string[];
  logs: string[];
  errors: string[];
}
/** The outcome of the last Save or Restore, shown in the status badge and the log. */
export type ActionResult = SaveResult & { action: "save" | "restore" };

/** The badge next to Save: failure first, then unsaved changes, then the last success. */
export function statusOf(busy: boolean, dirty: boolean, result?: ActionResult) {
  if (busy) return undefined;
  if (result && !result.ok) return { kind: "err", text: result.action === "restore" ? "Restore failed" : "Save failed" };
  if (dirty) return { kind: "dirty", text: "Unsaved changes" };
  if (result?.ok) return { kind: "ok", text: result.action === "restore" ? "Restored and pushed" : "Saved and pushed" };
  return undefined;
}

export function Header(props: {
  route: Route;
  /** The worktree the "worktree" tab opens: the one shown, the last one shown, or the current one. */
  worktree?: string;
  current?: string;
  busy: boolean;
  saving: boolean;
  dirty: boolean;
  result?: ActionResult;
  history?: HistoryState;
  onSave(): void;
}) {
  const { route, worktree, current, busy, saving, dirty, result, history, onSave } = props;
  const status = statusOf(busy, dirty, result);
  const onWorktree = route.page === "worktree";
  return (
    <header>
      <span className="brand"><Logo state={busy ? "saving" : result ? (result.ok ? "saved" : "error") : "idle"} />envs<span className="dim"> / values.yml</span></span>
      {worktree !== undefined && (
        <nav className="pages" aria-label="Pages">
          <a href={routeHash({ page: "worktree", worktree })} aria-current={onWorktree ? "page" : undefined} title={`Values of ${worktree} in each profile`}>
            {worktree === current && <span className="here" aria-hidden="true" />}
            <span className="clip">{worktree}</span>
            {worktree === current && <span className="sr-only"> (current worktree)</span>}
          </a>
          <a href={routeHash({ page: "overview" })} aria-current={onWorktree ? undefined : "page"} title="Every worktree, a column per worktree">
            All worktrees
          </a>
        </nav>
      )}
      <span role="status" className={`status ${status?.kind ?? ""}`}>
        {status?.text}
      </span>
      <button className="header-link" onClick={goToHistory} title={history?.enabled === false ? "The history is off" : "Go to the history panel"}>
        History
        {history?.enabled !== false && history && history.points.length > 0 && (
          <span className="count" aria-label={`${history.points.length} points`}>{history.points.length}</span>
        )}
      </button>
      <button className="primary" onClick={onSave} disabled={busy} aria-keyshortcuts="Control+S Meta+S" title="Save and push (Ctrl+S)">
        {saving ? "Saving…" : "Save"}
      </button>
    </header>
  );
}

/** Scrolls to the history card (below the variables) and moves focus there for keyboard and screen reader users. */
function goToHistory() {
  const card = document.getElementById("history");
  if (!card) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  document.getElementById("history-title")?.focus({ preventScroll: true });
}

export function HistoryCard(props: { history: HistoryState | undefined; current: NormalizedValues; dirty: boolean; busy: boolean; onRestore(hash: string): Promise<void> }) {
  return (
    <section className="card" id="history" aria-labelledby="history-title">
      <p className="eyebrow">History</p>
      <h2 id="history-title" tabIndex={-1}>Points of <code>.envs/history.ndjson</code></h2>
      <p className="lede">
        Hover or click a point to see what restoring it would change: <span className="key-removed">red</span> is removed,{" "}
        <span className="key-changed">green</span> is changed or added. Restoring adds a new point; none is ever deleted.
      </p>
      <HistoryPanel {...props} />
    </section>
  );
}

/** The output of the last Save or Restore, as an onyx terminal under the page. */
export function ActionLog({ result }: { result?: ActionResult }) {
  if (!result || (result.logs.length === 0 && result.errors.length === 0 && result.created.length === 0)) return null;
  return (
    <pre aria-label={result.action === "restore" ? "Restore log" : "Save log"}>
      {[...result.created.map((c) => `+ created ${c} from default`), ...result.logs, ...result.errors].join("\n")}
    </pre>
  );
}

/** How to type an empty value, said the same way on both pages. */
export const EmptyHint = () => (
  <>type <code>{EMPTY_VALUE}</code> to set an empty value</>
);

/** The profile picker: every profile, plus the profile in `value` if it is named but does not exist yet. */
export function ProfileOptions({ names, value }: { names: string[]; value?: string }) {
  const all = value !== undefined && !names.includes(value) ? [...names, value] : names;
  return (
    <>
      {all.map((n) => (
        <option key={n} value={n}>{n}</option>
      ))}
    </>
  );
}
