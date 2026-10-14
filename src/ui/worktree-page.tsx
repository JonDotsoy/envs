/**
 * The worktree page: one worktree, the profile it uses, and its variables with a column per profile.
 * Rows are every variable of every profile (see `profileRows` in rows.ts).
 */
import { useState } from "react";
import { routeHash } from "./route";
import {
  addRow,
  alignProfiles,
  cellOf,
  nameTaken,
  removeAt,
  renameAt,
  setDefaultAt,
  setValueAt,
  tableKeys,
  type VarsByProfile,
} from "./rows";
import { EmptyHint, ProfileOptions } from "./shell";

/**
 * A variable's name, renamed in every profile as it is typed. A name another variable already has is
 * kept only in the field (marked invalid) and dropped when the field loses focus, so two variables
 * never merge.
 */
function NameCell(props: { value: string; taken(name: string): boolean; onRename(name: string): void }) {
  const [draft, setDraft] = useState<string>();
  return (
    <input
      aria-label="Variable name"
      value={draft ?? props.value}
      aria-invalid={draft !== undefined || undefined}
      title={draft !== undefined ? `${draft.trim()} is already a variable: pick another name` : undefined}
      onChange={(e) => {
        const name = e.target.value;
        if (props.taken(name)) return setDraft(name);
        setDraft(undefined);
        props.onRename(name);
      }}
      onBlur={() => setDraft(undefined)}
    />
  );
}

function ProfileTable(props: {
  worktree: string;
  selected: string;
  onSelect(profile: string): void;
  vars: VarsByProfile;
  setVars(vars: VarsByProfile): void;
  compact: boolean;
}) {
  const { worktree, selected, onSelect, vars, setVars, compact } = props;
  // Every profile with the same rows: row i is one variable everywhere. Edits are made on this copy.
  const table = alignProfiles(vars);
  // The profile in use comes first, next to its defaults: what ends up in .env reads left to right.
  const profiles = [selected, ...Object.keys(table).filter((p) => p !== selected)].filter((p) => Object.hasOwn(table, p));
  const keys = tableKeys(table);
  const add = () => setVars(addRow(table));
  if (keys.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No variables in any profile yet</p>
        <p>Add one here, or run <code>envs pull</code> to collect them from each worktree's <code>.env</code>.</p>
        <button className="ghost" onClick={add}>+ Add variable</button>
      </div>
    );
  }
  return (
    <>
      <div className={`table-scroll by-profile${compact ? " compact" : ""}`}>
        <table>
          <thead>
            <tr>
              <th scope="col">Variable</th>
              <th scope="col" className="defaults">
                Defaults
                <span className="th-sub" title={`The defaults of ${selected}, the profile ${worktree} uses`}>{selected}</span>
              </th>
              {profiles.map((p) => (
                <th scope="col" key={p} className={`wt${p === selected ? " in-use" : ""}`}>
                  {p === selected ? (
                    <>
                      <span className="th-clip" title={p}>{p}</span>
                      <span className="in-use-tag">in use</span>
                    </>
                  ) : (
                    // One click on the header makes this the profile the worktree uses.
                    <button className="use-profile" title={`Use ${p} for ${worktree}`} aria-label={`Use profile ${p} for ${worktree}`} onClick={() => onSelect(p)}>
                      <span className="th-clip">{p}</span>
                      <span className="use-hint" aria-hidden="true">use</span>
                    </button>
                  )}
                </th>
              ))}
              <th><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key, i) => {
              const label = key || "Variable";
              const def = table[selected]?.[i]?.def ?? "";
              return (
                <tr key={i}>
                  <td>
                    <NameCell value={key} taken={(name) => nameTaken(keys, i, name)} onRename={(name) => setVars(renameAt(table, i, name))} />
                  </td>
                  <td>
                    <input
                      aria-label={`${label} default in ${selected}`}
                      value={def}
                      placeholder="—"
                      title={def === "" ? `No default in ${selected}` : undefined}
                      onChange={(e) => setVars(setDefaultAt(table, selected, i, e.target.value))}
                    />
                  </td>
                  {profiles.map((p) => {
                    const value = cellOf(table[p]![i], worktree);
                    const inherited = table[p]![i]!.def;
                    const inUse = p === selected;
                    return (
                      <td key={p} className={inUse ? "in-use" : undefined}>
                        <input
                          aria-label={`${label} for ${worktree} in ${p}`}
                          value={value}
                          placeholder={inherited === "" ? "—" : inherited}
                          title={
                            value !== ""
                              ? undefined
                              : inherited !== ""
                                ? `Inherits the default of ${p}`
                                : inUse
                                  ? `Not set: not written to the .env of ${worktree}`
                                  : "Not set"
                          }
                          onChange={(e) => setVars(setValueAt(table, p, i, worktree, e.target.value))}
                        />
                      </td>
                    );
                  })}
                  <td className="x">
                    <button className="remove" title="Remove from every profile" aria-label={`Remove ${key || "variable"} from every profile`} onClick={() => setVars(removeAt(table, i))}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="ghost" onClick={add}>+ Add variable</button>
    </>
  );
}

export function WorktreePage(props: {
  worktree: string;
  worktrees: string[];
  current?: string;
  uses: Record<string, string>;
  setUses(uses: Record<string, string>): void;
  vars: VarsByProfile;
  setVars(vars: VarsByProfile): void;
  compactChoice?: boolean;
  setCompactChoice(compact: boolean): void;
  onAddProfile(): void;
}) {
  const { worktree, worktrees, current, uses, setUses, vars, setVars } = props;
  const selected = uses[worktree] ?? "default";
  const profileNames = Object.keys(vars);
  const compact = props.compactChoice ?? profileNames.length > 6;
  return (
    <>
      <section className="card wt-hero" aria-labelledby="page-title">
        <div className="hero-top">
          <p className="eyebrow">Worktree{worktree === current && <span className="tag current-wt">current</span>}</p>
          {worktrees.length > 1 && (
            <label className="switch">
              <span>Switch to</span>
              <select aria-label="Switch to worktree" value={worktree} onChange={(e) => (location.hash = routeHash({ page: "worktree", worktree: e.target.value }))}>
                {worktrees.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <h2 id="page-title" tabIndex={-1} className="wt-title">{worktree}</h2>
        <p className="lede">Its <code>.env</code> is written from the profile picked here: this worktree's own value in that profile, or else the profile's default.</p>
        <div className="selectors">
          <label>
            Profile
            <select aria-label={`Profile of ${worktree}`} value={selected} onChange={(e) => setUses({ ...uses, [worktree]: e.target.value })}>
              <ProfileOptions names={profileNames} value={selected} />
            </select>
          </label>
          <button className="ghost" onClick={props.onAddProfile} title="New profile, a copy of default, used by this worktree">+ Profile</button>
          <button className="toggle" aria-pressed={compact} onClick={() => props.setCompactChoice(!compact)}>
            Compact
          </button>
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">Variables</p>
        <h2>{worktree} in each profile</h2>
        <p className="lede">
          <strong>Defaults</strong> are those of <code>{selected}</code>, the profile in use. Each profile column holds this worktree's
          own value in that profile; an empty cell inherits that profile's default, in grey. The <code>.env</code> gets the
          highlighted column, or Defaults where it is empty; click another profile's header to use it. Removing a variable removes it from every profile; <EmptyHint />.
        </p>
        <ProfileTable worktree={worktree} selected={selected} onSelect={(p) => setUses({ ...uses, [worktree]: p })} vars={vars} setVars={setVars} compact={compact} />
      </section>
    </>
  );
}
