import { useMemo, useState } from "react";
import {
  compareStates,
  statesAfterEach,
  type DiffEntry,
  type HistoryPoint,
  type NormalizedValues,
  type StateDiff,
  type Value,
} from "../history";

/** GET /api/history: whether the history is on and its points, oldest first. */
export interface HistoryState {
  enabled: boolean;
  points: HistoryPoint[];
  /** Numbers of the lines of history.ndjson that could not be read (absent when there are none). */
  damaged?: number[];
  /** Hashes of the points where the hash chain is broken (absent when it is intact). */
  broken?: string[];
}

const short = (hash: string) => hash.slice(0, 7);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
const show = (v?: Value) => (v === "" ? '""' : String(v));

const KIND_LABEL = { removed: "removed", changed: "changed", added: "added" } as const;
const SIGN = { removed: "−", changed: "~", added: "+" } as const;

/** One entry: red when the point would remove it, green when it would change or add it. */
function DiffRow({ entry }: { entry: DiffEntry }) {
  const { kind, key, worktree, current, target } = entry;
  return (
    <li className={`d-row ${kind}`}>
      <span className="d-sign" aria-hidden="true">{SIGN[kind]}</span>
      <span className="d-key">
        {key}
        {worktree !== undefined && <span className="d-wt"> @ {worktree}</span>}
      </span>
      <span className="d-values">
        {kind === "removed" && <del>{show(current)}</del>}
        {kind === "changed" && (
          <>
            <span className="d-from">{show(current)}</span>
            <span className="d-arrow" aria-label="becomes"> → </span>
            <ins>{show(target)}</ins>
          </>
        )}
        {kind === "added" && <ins>{show(target)}</ins>}
      </span>
      <span className="d-tag">{KIND_LABEL[kind]}</span>
    </li>
  );
}

function DiffGroup({ title, entries }: { title: string; entries: DiffEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="d-group">
      <p className="d-sub">{title}</p>
      <ul className="d-list">
        {entries.map((e) => (
          <DiffRow key={`${e.key}\u0000${e.worktree ?? ""}`} entry={e} />
        ))}
      </ul>
    </div>
  );
}

/** The differences between the editor and a point, grouped by worktree profiles, then by profile. */
function DiffView({ diff }: { diff: StateDiff }) {
  if (diff.same) {
    return <p className="d-same">No differences: the editor already has this state.</p>;
  }
  const counts = { removed: 0, changed: 0, added: 0 };
  for (const e of [...diff.uses, ...diff.profiles.flatMap((p) => [...p.defaults, ...p.envs])]) counts[e.kind]++;
  return (
    <>
      <p className="d-legend">
        {counts.removed > 0 && <span className="d-count removed">{counts.removed} removed</span>}
        {counts.changed > 0 && <span className="d-count changed">{counts.changed} changed</span>}
        {counts.added > 0 && <span className="d-count added">{counts.added} added</span>}
      </p>
      {diff.uses.length > 0 && (
        <section className="d-section" aria-label="Worktree profiles">
          <h3>Worktree profiles</h3>
          <DiffGroup title="uses" entries={diff.uses} />
        </section>
      )}
      {diff.profiles.map((p) => (
        <section className="d-section" key={p.name} aria-label={`Profile ${p.name}`}>
          <h3>
            Profile <code>{p.name}</code>
            {p.status && <span className={`d-badge ${p.status}`}>{p.status === "removed" ? "profile removed" : "profile added"}</span>}
          </h3>
          <DiffGroup title="defaults" entries={p.defaults} />
          <DiffGroup title="envs" entries={p.envs} />
          {p.defaults.length === 0 && p.envs.length === 0 && <p className="d-note">Empty profile.</p>}
        </section>
      ))}
    </>
  );
}

/**
 * The history points, newest first. Hovering a point previews, clicking selects it (never restores):
 * the right pane shows what would change in the editor if that point were restored. Restore asks
 * for an inline confirmation and warns when the editor has unsaved changes.
 */
export function HistoryPanel(props: {
  history: HistoryState | undefined;
  current: NormalizedValues;
  dirty: boolean;
  busy: boolean;
  onRestore(hash: string): Promise<void>;
}) {
  const { history, current, dirty, busy, onRestore } = props;
  const [selected, setSelected] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const points = history?.points ?? [];
  const states = useMemo(() => statesAfterEach(points), [points]);
  const diffs = useMemo(() => states.map((state) => compareStates(current, state)), [states, current]);

  if (!history) return <p className="loading">Loading history…</p>;
  if (!history.enabled || points.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">{history.enabled ? "No history points yet" : "The history is off"}</p>
        <p>
          {history.enabled ? (
            <>Saving here, <code>envs pull</code>, <code>envs edit</code> or <code>envs use</code> adds a point to <code>.envs/history.ndjson</code>.</>
          ) : (
            <>Run <code>envs config set history true</code> to record changes again.</>
          )}
        </p>
      </div>
    );
  }

  const order = points.map((_, i) => i).reverse();
  const shownHash = hovered ?? selected;
  const shownIndex = points.findIndex((p) => p.hash === shownHash);
  const shown = shownIndex === -1 ? undefined : points[shownIndex]!;

  return (
    <div className="history">
      {history.broken && history.broken.length > 0 && (
        <p className="damaged" role="alert">
          The hash chain of <code>.envs/history.ndjson</code> is broken at {history.broken.map(short).join(", ")}: the file may have been
          altered. Restore is refused until it is checked (<code>envs restore &lt;hash&gt; --force</code> overrides it from the terminal).
        </p>
      )}
      {history.damaged && history.damaged.length > 0 && (
        <p className="damaged" role="alert">
          {plural(history.damaged.length, "line")} of <code>.envs/history.ndjson</code> could not be read (line {history.damaged.join(", ")}).
          The points shown may be incomplete, and Restore is refused until the file is repaired.
        </p>
      )}
      <ol className="points" aria-label="History points, newest first" onMouseLeave={() => setHovered(undefined)}>
        {order.map((i) => {
          const point = points[i]!;
          const diff = diffs[i]!;
          const isSelected = point.hash === selected;
          return (
            <li
              key={point.hash}
              className={`point${isSelected ? " selected" : ""}${point.hash === hovered ? " hovered" : ""}`}
              onMouseEnter={() => setHovered(point.hash)}
            >
              <div className="point-row">
                <button
                  className="point-main"
                  aria-pressed={isSelected}
                  title="Compare with the editor"
                  onClick={() => {
                    // A click is an explicit choice: it wins over a stale hover (touch screens, scrolling).
                    setSelected(isSelected ? undefined : point.hash);
                    setHovered(undefined);
                  }}
                >
                  <span className="point-head">
                    <code className="hash" title={point.hash}>{short(point.hash)}</code>
                    {i === points.length - 1 && <span className="tag">latest</span>}
                    {i === 0 && <span className="tag">initial</span>}
                    {point.resync && (
                      <span className="tag external" title="Changes made outside the history (a manual edit of values.yml, or while the history was off)">
                        external
                      </span>
                    )}
                    {diff.same && <span className="tag current">in editor</span>}
                  </span>
                  <span className="point-meta">
                    <time dateTime={point.timestamp} title={point.timestamp}>{formatTime(point.timestamp)}</time>
                    <span aria-hidden="true"> · </span>
                    {plural(point.changes.length, "change")}
                  </span>
                </button>
                <button
                  className="restore"
                  disabled={busy || diff.same}
                  title={diff.same ? "The editor already has this state" : "Restore values.yml to this point"}
                  aria-label={`Restore ${short(point.hash)}`}
                  aria-expanded={confirming === point.hash}
                  onClick={() => setConfirming(confirming === point.hash ? undefined : point.hash)}
                >
                  Restore
                </button>
              </div>
              {confirming === point.hash && (
                <div className="confirm" role="alertdialog" aria-label={`Confirm restore of ${short(point.hash)}`}>
                  <p>
                    Restore <code>values.yml</code> to <code>{short(point.hash)}</code>? A new history point is added and the <code>.env</code> files are pushed.
                  </p>
                  {dirty && <p className="warn">Your unsaved changes in the editor will be lost.</p>}
                  <div className="confirm-actions">
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={async () => {
                        setConfirming(undefined);
                        await onRestore(point.hash);
                        // The rows under the pointer changed: start again from no preview.
                        setSelected(undefined);
                        setHovered(undefined);
                      }}
                    >
                      {dirty ? "Discard changes and restore" : "Restore"}
                    </button>
                    <button className="ghost" onClick={() => setConfirming(undefined)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="diff" aria-live="polite" aria-label="Differences with the editor">
        {shown ? (
          <>
            <p className="eyebrow">
              <code>{short(shown.hash)}</code> vs editor{dirty && " (with unsaved changes)"}
            </p>
            <DiffView diff={diffs[shownIndex]!} />
          </>
        ) : (
          <div className="d-hint">
            <p className="empty-title">Compare a point</p>
            <p>Hover a point, or click it to keep it, to see what restoring it would change in the editor.</p>
          </div>
        )}
      </div>
    </div>
  );
}
