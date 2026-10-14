import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fromVarRows, toVarRows, type VarRow } from "./rows";
import type { HistoryState } from "./history-panel";
import { OverviewPage } from "./overview";
import { parseRoute, routeHash, type Route } from "./route";
import { ActionLog, Header, HistoryCard, type ActionResult, type SaveResult, type State } from "./shell";
import { WorktreePage } from "./worktree-page";

/** JSON with sorted keys, so two states compare equal regardless of key order. */
const stable = (v: unknown): string =>
  typeof v !== "object" || v === null
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
/** What Save would write, normalized: used to tell whether there are unsaved changes. */
const snapshot = (uses: Record<string, string>, vars: Record<string, VarRow[]>, worktrees: string[]) =>
  stable({
    uses: { ...uses, ...Object.fromEntries(worktrees.map((w) => [w, uses[w] ?? "default"])) },
    profiles: Object.fromEntries(Object.entries(vars).map(([n, rows]) => [n, fromVarRows(rows)])),
  });

function App() {
  const [loaded, setLoaded] = useState<State>();
  const [uses, setUses] = useState<Record<string, string>>({});
  const [vars, setVars] = useState<Record<string, VarRow[]>>({});
  const [route, setRoute] = useState<Route>({ page: "overview" });
  /** The worktree the header's worktree tab opens while the overview is shown. */
  const [lastWorktree, setLastWorktree] = useState<string>();
  // Overview view state, kept here so it survives a visit to a worktree page.
  const [profile, setProfile] = useState("default");
  const [worktree, setWorktree] = useState("");
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<ActionResult>();
  const [history, setHistory] = useState<HistoryState>();
  const [baseline, setBaseline] = useState("");
  const [compactChoice, setCompactChoice] = useState<boolean>();

  const load = (state: State) => {
    const rows = Object.fromEntries(Object.entries(state.profiles).map(([n, p]) => [n, toVarRows(p)]));
    setLoaded(state);
    setUses(state.uses);
    setVars(rows);
    setBaseline(snapshot(state.uses, rows, state.worktrees));
  };
  const loadHistory = () =>
    fetch("/api/history")
      .then((r) => r.json() as Promise<HistoryState>)
      .then(setHistory)
      .catch(() => setHistory({ enabled: true, points: [] }));
  useEffect(() => {
    fetch("/api/values").then((r) => r.json() as Promise<State>).then(load);
    loadHistory();
  }, []);

  // The page follows the URL hash. Without one, the editor opens on the worktree it was run from.
  const worktrees = loaded?.worktrees;
  const current = loaded?.current;
  useEffect(() => {
    if (!worktrees) return;
    const follow = (moved: boolean) => {
      const next = parseRoute(location.hash, worktrees, current);
      // Name the page in the URL (replacing, so Back does not bounce between two URLs of one page).
      if (location.hash !== routeHash(next)) window.history.replaceState(null, "", routeHash(next));
      setRoute(next);
      if (next.page === "worktree") setLastWorktree(next.worktree);
      if (moved) {
        // A new page: start at its top, with focus on its title for keyboard and screen reader users.
        scrollTo(0, 0);
        requestAnimationFrame(() => document.getElementById("page-title")?.focus({ preventScroll: true }));
      }
    };
    follow(false);
    const onHash = () => follow(true);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [worktrees, current]);

  /** The editor's values as Save would send them: what the history panel compares each point with. */
  const editorValues = useMemo(
    () => ({ uses, profiles: Object.fromEntries(Object.entries(vars).map(([n, rows]) => [n, fromVarRows(rows)])) }),
    [uses, vars],
  );

  const dirty = loaded !== undefined && snapshot(uses, vars, loaded.worktrees) !== baseline;
  // Warn before closing the tab with unsaved changes; Ctrl/Cmd+S saves.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (!loaded) return <main className="loading" aria-busy="true">Loading…</main>;

  const profileNames = Object.keys(vars);
  /** Asks for a name and adds a profile that starts as a copy of default; returns its name. */
  const addProfile = (): string | undefined => {
    const name = prompt("New profile name (starts as a copy of default)")?.trim();
    if (!name || name in vars) return;
    setVars({ ...vars, [name]: structuredClone(vars.default ?? []) });
    return name;
  };

  const busy = saving || restoring;
  const save = async () => {
    if (busy) return;
    setSaving(true);
    try {
      const profiles = Object.fromEntries(
        profileNames.map((n) => [n, fromVarRows(vars[n] ?? [])]),
      );
      const res = await fetch("/api/values", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uses, profiles, version: loaded?.version }),
      });
      const body = (await res.json()) as SaveResult & { error?: string };
      setResult(res.ok ? { ...body, action: "save" } : { action: "save", ok: false, created: [], logs: body.logs ?? [], errors: body.errors ?? [body.error ?? "Save failed"] });
      if (res.ok) load((await (await fetch("/api/values")).json()) as State);
    } catch (error) {
      setResult({ action: "save", ok: false, created: [], logs: [], errors: [String(error)] });
    } finally {
      setSaving(false);
      loadHistory();
    }
  };

  /** Restores a history point on the server (a new point is added), then reloads the editor and the history. */
  const restorePoint = async (hash: string) => {
    if (busy) return;
    setRestoring(true);
    try {
      const res = await fetch("/api/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash }),
      });
      const body = (await res.json()) as SaveResult & { error?: string };
      setResult(res.ok ? { ...body, action: "restore" } : { action: "restore", ok: false, created: [], logs: body.logs ?? [], errors: body.errors ?? [body.error ?? "Restore failed"] });
      // Even a failed push may have written values.yml, so the editor always reloads.
      load((await (await fetch("/api/values")).json()) as State);
    } catch (error) {
      setResult({ action: "restore", ok: false, created: [], logs: [], errors: [String(error)] });
    } finally {
      setRestoring(false);
      loadHistory();
    }
  };

  saveRef.current = save;

  return (
    <>
      <Header
        route={route}
        worktree={route.page === "worktree" ? route.worktree : (lastWorktree ?? loaded.current)}
        current={loaded.current}
        busy={busy}
        saving={saving}
        dirty={dirty}
        result={result}
        history={history}
        onSave={save}
      />
      <main>
        {route.page === "worktree" ? (
          <WorktreePage
            key={route.worktree}
            worktree={route.worktree}
            worktrees={loaded.worktrees}
            current={loaded.current}
            uses={uses}
            setUses={setUses}
            vars={vars}
            setVars={setVars}
            compactChoice={compactChoice}
            setCompactChoice={setCompactChoice}
            onAddProfile={() => {
              const name = addProfile();
              if (name) setUses({ ...uses, [route.worktree]: name });
            }}
          />
        ) : (
          <OverviewPage
            worktrees={loaded.worktrees}
            current={loaded.current}
            uses={uses}
            setUses={setUses}
            vars={vars}
            setVars={setVars}
            profile={profile}
            setProfile={setProfile}
            worktree={worktree}
            setWorktree={setWorktree}
            compactChoice={compactChoice}
            setCompactChoice={setCompactChoice}
            onAddProfile={() => {
              const name = addProfile();
              if (name) setProfile(name);
            }}
          />
        )}
        <HistoryCard history={history} current={editorValues} dirty={dirty} busy={busy} onRestore={restorePoint} />
        <ActionLog result={result} />
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
