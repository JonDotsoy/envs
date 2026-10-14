/** The overview page: every worktree's profile, and one profile's variables with a column per worktree. */
import { routeHash } from "./route";
import { EmptyHint, ProfileOptions } from "./shell";
import type { VarRow, VarsByProfile } from "./rows";

/** Variables × columns: the default value, then the selected worktree (or every worktree). */
function VarsEditor(props: { rows: VarRow[]; onChange(rows: VarRow[]): void; columns: string[]; worktrees: string[]; compact: boolean }) {
  const { rows, onChange, columns, worktrees, compact } = props;
  const set = (i: number, patch: (row: VarRow) => VarRow) =>
    onChange(rows.map((row, j) => (j === i ? patch(row) : row)));
  const add = () => onChange([...rows, { key: "", def: "", byWorktree: {} }]);
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No variables in this profile yet</p>
        <p>Add one here, or run <code>envs pull</code> to collect them from each worktree's <code>.env</code>.</p>
        <button className="ghost" onClick={add}>+ Add variable</button>
      </div>
    );
  }
  return (
    <>
      <div className={`table-scroll${compact ? " compact" : ""}`}>
        <table>
          <thead>
            <tr>
              <th scope="col">Variable</th>
              <th scope="col">Default</th>
              {columns.map((w) => (
                <th scope="col" key={w} className="wt"><span className="th-clip" title={w}>{w}</span></th>
              ))}
              <th><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td><input aria-label="Variable name" value={row.key} onChange={(e) => set(i, (r) => ({ ...r, key: e.target.value }))} /></td>
                <td>
                  <div className="with-action">
                    <input aria-label={`${row.key || "Variable"} default`} value={row.def} placeholder="—" onChange={(e) => set(i, (r) => ({ ...r, def: e.target.value }))} />
                    <button
                      className="apply-all"
                      title={row.def === "" ? "Set a default first" : "Apply this value to every worktree"}
                      aria-label={`Apply ${row.key || "variable"} default to all worktrees`}
                      disabled={row.def === ""}
                      onClick={() => set(i, (r) => ({ ...r, byWorktree: { ...r.byWorktree, ...Object.fromEntries(worktrees.map((w) => [w, r.def])) } }))}
                    >
                      → All
                    </button>
                  </div>
                </td>
                {columns.map((w) => (
                  <td key={w}>
                    <input
                      aria-label={`${row.key || "Variable"} in ${w}`}
                      value={row.byWorktree[w] ?? ""}
                      placeholder={row.def === "" ? "—" : row.def}
                      title={row.byWorktree[w] ? undefined : row.def === "" ? "Not set" : "Inherits the default"}
                      onChange={(e) => set(i, (r) => ({ ...r, byWorktree: { ...r.byWorktree, [w]: e.target.value } }))}
                    />
                  </td>
                ))}
                <td className="x"><button className="remove" title="Remove" aria-label={`Remove ${row.key || "variable"}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="ghost" onClick={add}>+ Add variable</button>
    </>
  );
}

export function OverviewPage(props: {
  worktrees: string[];
  current?: string;
  uses: Record<string, string>;
  setUses(uses: Record<string, string>): void;
  vars: VarsByProfile;
  setVars(vars: VarsByProfile): void;
  profile: string;
  setProfile(profile: string): void;
  worktree: string;
  setWorktree(worktree: string): void;
  compactChoice?: boolean;
  setCompactChoice(compact: boolean): void;
  onAddProfile(): void;
}) {
  const { worktrees, current, uses, setUses, vars, setVars, profile, setProfile, worktree, setWorktree, onAddProfile } = props;
  const profileNames = Object.keys(vars);
  const columns = worktree ? [worktree] : worktrees;
  const compact = props.compactChoice ?? columns.length > 6;
  return (
    <>
      <section className="card">
        <p className="eyebrow">Worktrees</p>
        <h2 id="page-title" tabIndex={-1}>Profile of each worktree</h2>
        <p className="lede">Each worktree's <code>.env</code> is written from the profile picked here. Open a worktree to see its values in every profile.</p>
        <ul className="wt-grid">
          {worktrees.map((w) => (
            <li key={w}>
              <a className="name" href={routeHash({ page: "worktree", worktree: w })} title={`Open ${w}`}>
                {w}
                {w === current && <span className="tag current-wt">current</span>}
              </a>
              <select aria-label={`Profile of ${w}`} value={uses[w] ?? "default"} onChange={(e) => setUses({ ...uses, [w]: e.target.value })}>
                <ProfileOptions names={profileNames} value={uses[w]} />
              </select>
            </li>
          ))}
        </ul>
      </section>

      <section className="card inset" aria-label="View">
        <p className="eyebrow">View</p>
        <div className="selectors">
          <label>
            Profile
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              <ProfileOptions names={profileNames} />
            </select>
          </label>
          <button className="ghost" onClick={onAddProfile}>+ Profile</button>
          <label>
            Worktree
            <select value={worktree} onChange={(e) => setWorktree(e.target.value)}>
              <option value="">All worktrees</option>
              {worktrees.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <button className="toggle" aria-pressed={compact} onClick={() => props.setCompactChoice(!compact)}>
            Compact
          </button>
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">Variables</p>
        <h2>{profile}{worktree && ` · ${worktree}`}</h2>
        <p className="lede">The default applies to every worktree unless the worktree sets its own value. Empty cells inherit the default; <EmptyHint />.</p>
        <VarsEditor
          rows={vars[profile] ?? []}
          onChange={(rows) => setVars({ ...vars, [profile]: rows })}
          columns={columns}
          worktrees={worktrees}
          compact={compact}
        />
      </section>
    </>
  );
}
