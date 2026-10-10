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

/** Rows of a key → value table; rows keep their order and tolerate duplicate/empty keys while editing. */
type Rows = [string, string][];
const toRows = (record: Record<string, Value>): Rows =>
  Object.entries(record).map(([k, v]) => [k, String(v)]);
const fromRows = (rows: Rows): Record<string, string> =>
  Object.fromEntries(rows.filter(([k]) => k.trim() !== "").map(([k, v]) => [k.trim(), v]));

function RowsEditor(props: {
  rows: Rows;
  onChange(rows: Rows): void;
  keyLabel: string;
  valueLabel: string;
  keyOptions?: string[];
}) {
  const { rows, onChange, keyLabel, valueLabel, keyOptions } = props;
  const set = (i: number, col: 0 | 1, text: string) =>
    onChange(rows.map((row, j) => (j === i ? (col === 0 ? [text, row[1]] : [row[0], text]) : row) as [string, string]));
  const listId = keyOptions ? `keys-${keyLabel}` : undefined;
  return (
    <>
      {keyOptions && (
        <datalist id={listId}>
          {keyOptions.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
      <table>
        <thead>
          <tr>
            <th>{keyLabel}</th>
            <th>{valueLabel}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i}>
              <td><input list={listId} value={k} onChange={(e) => set(i, 0, e.target.value)} /></td>
              <td><input value={v} onChange={(e) => set(i, 1, e.target.value)} /></td>
              <td className="x"><button title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => onChange([...rows, ["", ""]])}>+ Add</button>
    </>
  );
}

/** `envs.<VAR>.<worktree>` flattened to one row per override while editing. */
type EnvRow = { key: string; worktree: string; value: string };
const toEnvRows = (envs: Profile["envs"]): EnvRow[] =>
  Object.entries(envs).flatMap(([key, byWorktree]) =>
    Object.entries(byWorktree).map(([worktree, value]) => ({ key, worktree, value: String(value) })),
  );
const fromEnvRows = (rows: EnvRow[]): Profile["envs"] => {
  const envs: Profile["envs"] = {};
  for (const { key, worktree, value } of rows) {
    if (key.trim() === "" || worktree.trim() === "") continue;
    (envs[key.trim()] ??= {})[worktree.trim()] = value;
  }
  return envs;
};

function EnvsEditor(props: { rows: EnvRow[]; onChange(rows: EnvRow[]): void; worktrees: string[]; worktree: string }) {
  const { rows, onChange, worktrees, worktree } = props;
  const set = (i: number, patch: Partial<EnvRow>) =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <>
      <datalist id="worktrees">
        {worktrees.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <table>
        <thead>
          <tr><th>Variable</th><th>Worktree</th><th>Value</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (worktree === "" || row.worktree === worktree ? (
            <tr key={i}>
              <td><input value={row.key} onChange={(e) => set(i, { key: e.target.value })} /></td>
              <td><input list="worktrees" value={row.worktree} onChange={(e) => set(i, { worktree: e.target.value })} /></td>
              <td><input value={row.value} onChange={(e) => set(i, { value: e.target.value })} /></td>
              <td className="x"><button title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ) : null))}
        </tbody>
      </table>
      <button onClick={() => onChange([...rows, { key: "", worktree, value: "" }])}>+ Add</button>
    </>
  );
}

function App() {
  const [loaded, setLoaded] = useState<State>();
  const [uses, setUses] = useState<Rows>([]);
  const [defaults, setDefaults] = useState<Record<string, Rows>>({});
  const [envs, setEnvs] = useState<Record<string, EnvRow[]>>({});
  const [profile, setProfile] = useState("default");
  const [worktree, setWorktree] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | { ok: false; errors: string[]; logs: string[]; created: string[] }>();

  const load = (state: State) => {
    setLoaded(state);
    setUses(toRows(state.uses));
    setDefaults(Object.fromEntries(Object.entries(state.profiles).map(([n, p]) => [n, toRows(p.defaults)])));
    setEnvs(Object.fromEntries(Object.entries(state.profiles).map(([n, p]) => [n, toEnvRows(p.envs)])));
  };
  useEffect(() => {
    fetch("/api/values").then((r) => r.json() as Promise<State>).then(load);
  }, []);

  if (!loaded) return <main>Loading…</main>;

  const profileNames = Object.keys(defaults);
  const addProfile = () => {
    const name = prompt("New profile name (starts as a copy of default)")?.trim();
    if (!name || name in defaults) return;
    setDefaults({ ...defaults, [name]: structuredClone(defaults.default ?? []) });
    setEnvs({ ...envs, [name]: structuredClone(envs.default ?? []) });
    setProfile(name);
  };

  const save = async () => {
    setSaving(true);
    try {
      const profiles = Object.fromEntries(
        profileNames.map((n) => [n, { defaults: fromRows(defaults[n] ?? []), envs: fromEnvRows(envs[n] ?? []) }]),
      );
      const res = await fetch("/api/values", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uses: fromRows(uses), profiles }),
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
        <h1>envs · values.yml</h1>
        {result && (
          <span className={`status ${result.ok ? "ok" : "err"}`}>
            {result.ok ? "Saved and pushed" : "Save failed"}
          </span>
        )}
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>
      <main>
        <h2>Profile of each worktree (uses)</h2>
        <RowsEditor rows={uses} onChange={setUses} keyLabel="Worktree" valueLabel="Profile" keyOptions={loaded.worktrees} />

        <h2>View</h2>
        <div className="selectors">
          <label>
            Profile
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              {profileNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button onClick={addProfile}>+ Profile</button>
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

        <h2>Defaults (every worktree using “{profile}”)</h2>
        <RowsEditor
          rows={defaults[profile] ?? []}
          onChange={(rows) => setDefaults({ ...defaults, [profile]: rows })}
          keyLabel="Variable"
          valueLabel="Value"
        />

        <h2>Per-worktree values{worktree && ` · ${worktree}`}</h2>
        <EnvsEditor
          rows={envs[profile] ?? []}
          onChange={(rows) => setEnvs({ ...envs, [profile]: rows })}
          worktrees={loaded.worktrees}
          worktree={worktree}
        />

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
