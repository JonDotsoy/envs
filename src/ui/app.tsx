import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Value = string | number | boolean;
interface Profile {
  defaults: Record<string, Value>;
  envs: Record<string, Record<string, Value>>;
}
interface State {
  uses: Record<string, string>;
  profiles: Record<string, Profile>;
  worktrees: string[];
}
interface SaveResult {
  ok: boolean;
  created: string[];
  logs: string[];
  errors: string[];
}

/** One variable of a profile: its default and its override per worktree (missing/empty = not set). */
type VarRow = { key: string; def: string; byWorktree: Record<string, string> };
const toVarRows = (profile: Profile): VarRow[] => {
  const rows = new Map<string, VarRow>();
  const row = (key: string) => rows.get(key) ?? rows.set(key, { key, def: "", byWorktree: {} }).get(key)!;
  for (const [key, value] of Object.entries(profile.defaults)) row(key).def = String(value);
  for (const [key, byWorktree] of Object.entries(profile.envs)) {
    for (const [wt, value] of Object.entries(byWorktree)) row(key).byWorktree[wt] = String(value);
  }
  return [...rows.values()];
};
const fromVarRows = (rows: VarRow[]): Profile => {
  const profile: Profile = { defaults: {}, envs: {} };
  for (const { key: raw, def, byWorktree } of rows) {
    const key = raw.trim();
    if (key === "") continue;
    if (def !== "") profile.defaults[key] = def;
    for (const [wt, value] of Object.entries(byWorktree)) {
      if (value !== "") (profile.envs[key] ??= {})[wt] = value;
    }
  }
  return profile;
};

/** Variables × columns: the default value, then the selected worktree (or every worktree). */
function VarsEditor(props: { rows: VarRow[]; onChange(rows: VarRow[]): void; columns: string[]; worktrees: string[] }) {
  const { rows, onChange, columns, worktrees } = props;
  const set = (i: number, patch: (row: VarRow) => VarRow) =>
    onChange(rows.map((row, j) => (j === i ? patch(row) : row)));
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Default</th>
              {columns.map((w) => (
                <th key={w}><span className="th-clip" title={w}>{w}</span></th>
              ))}
              <th />
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
                      title="Apply this value to every worktree"
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
                      placeholder={row.def === "" ? "—" : "default"}
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
      <button className="ghost" onClick={() => onChange([...rows, { key: "", def: "", byWorktree: {} }])}>+ Add variable</button>
    </>
  );
}

function App() {
  const [loaded, setLoaded] = useState<State>();
  const [uses, setUses] = useState<Record<string, string>>({});
  const [vars, setVars] = useState<Record<string, VarRow[]>>({});
  const [profile, setProfile] = useState("default");
  const [worktree, setWorktree] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | { ok: false; errors: string[]; logs: string[]; created: string[] }>();

  const load = (state: State) => {
    setLoaded(state);
    setUses(state.uses);
    setVars(Object.fromEntries(Object.entries(state.profiles).map(([n, p]) => [n, toVarRows(p)])));
  };
  useEffect(() => {
    fetch("/api/values").then((r) => r.json() as Promise<State>).then(load);
  }, []);

  if (!loaded) return <main>Loading…</main>;

  const profileNames = Object.keys(vars);
  const addProfile = () => {
    const name = prompt("New profile name (starts as a copy of default)")?.trim();
    if (!name || name in vars) return;
    setVars({ ...vars, [name]: structuredClone(vars.default ?? []) });
    setProfile(name);
  };

  const save = async () => {
    setSaving(true);
    try {
      const profiles = Object.fromEntries(
        profileNames.map((n) => [n, fromVarRows(vars[n] ?? [])]),
      );
      const res = await fetch("/api/values", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uses, profiles }),
      });
      const body = (await res.json()) as SaveResult & { error?: string };
      setResult(res.ok ? body : { ok: false, created: [], logs: [], errors: body.errors ?? [body.error ?? "Save failed"] });
      if (res.ok) load((await (await fetch("/api/values")).json()) as State);
    } catch (error) {
      setResult({ ok: false, created: [], logs: [], errors: [String(error)] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header>
        <span className="brand"><span className="mosaic" aria-hidden="true" />envs<span className="dim"> / values.yml</span></span>
        <span role="status" className={`status ${result?.ok ? "ok" : "err"}`}>
          {result && (result.ok ? "Saved and pushed" : "Save failed")}
        </span>
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>
      <main>
        <section className="card">
          <p className="eyebrow">Worktrees</p>
          <h2>Profile of each worktree</h2>
          <ul className="wt-grid">
            {loaded.worktrees.map((w) => (
              <li key={w}>
                <span className="name" title={w}>{w}</span>
                <select aria-label={`Profile of ${w}`} value={uses[w] ?? "default"} onChange={(e) => setUses({ ...uses, [w]: e.target.value })}>
                  {profileNames.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>

        <section className="card inset">
          <p className="eyebrow">View</p>
          <div className="selectors">
            <label>
              Profile
              <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                {profileNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <button className="ghost" onClick={addProfile}>+ Profile</button>
            <label>
              Worktree
              <select value={worktree} onChange={(e) => setWorktree(e.target.value)}>
                <option value="">All worktrees</option>
                {loaded.worktrees.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="card">
          <p className="eyebrow">Variables</p>
          <h2>{profile}{worktree && ` · ${worktree}`}</h2>
          <VarsEditor
            rows={vars[profile] ?? []}
            onChange={(rows) => setVars({ ...vars, [profile]: rows })}
            columns={worktree ? [worktree] : loaded.worktrees}
            worktrees={loaded.worktrees}
          />
        </section>

        {result && (result.logs.length > 0 || result.errors.length > 0 || result.created.length > 0) && (
          <pre>
            {[
              ...result.created.map((c) => `+ created ${c} from default`),
              ...result.logs,
              ...result.errors,
            ].join("\n")}
          </pre>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
