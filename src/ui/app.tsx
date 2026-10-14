import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fromVarRows, toVarRows, type VarRow } from "./rows";
import type { HistoryState } from "./history-panel";
import { OverviewPage } from "./overview";
import { parseRoute, routeHash, type Route } from "./route";
import { ActionLog, Header, HistoryCard, type ActionResult, type SaveResult, type State } from "./shell";
import { AUTOSAVE_DELAY_MS, SettingsPage, type Settings } from "./settings-page";
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
  const [settings, setSettings] = useState<Settings>();
  const [settingsError, setSettingsError] = useState<string>();
  const [savingSettings, setSavingSettings] = useState(false);
  /** The editor's state as last saved and failed: auto-save does not retry it until something changes. */
  const [failedSnapshot, setFailedSnapshot] = useState<string>();

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
    fetch("/api/settings")
      .then((r) => r.json() as Promise<Settings>)
      .then(setSettings)
      .catch(() => setSettingsError("Could not read the settings."));
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

  const editorSnapshot = loaded === undefined ? "" : snapshot(uses, vars, loaded.worktrees);
  const dirty = loaded !== undefined && editorSnapshot !== baseline;
  // What the editor holds right now, for a save that finishes after more edits were made.
  const latest = useRef({ snapshot: editorSnapshot });
  latest.current.snapshot = editorSnapshot;
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

  // Auto-save: a moment after the last change, save what the editor holds (unless that very state just failed).
  const busyNow = saving || restoring;
  const autosave = settings?.autosave === true;
  useEffect(() => {
    if (!autosave || !dirty || busyNow || editorSnapshot === failedSnapshot) return;
    const timer = setTimeout(() => saveRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autosave, dirty, busyNow, editorSnapshot, failedSnapshot]);

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
    const sent = editorSnapshot;
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
      setFailedSnapshot(res.ok ? undefined : sent);
      if (res.ok) {
        const state = (await (await fetch("/api/values")).json()) as State;
        if (latest.current.snapshot === sent) load(state);
        else {
          // Edits made while saving stay in the editor (still unsaved); only the saved state becomes the baseline.
          setLoaded(state);
          setBaseline(snapshot(state.uses, Object.fromEntries(Object.entries(state.profiles).map(([n, p]) => [n, toVarRows(p)])), state.worktrees));
        }
      }
    } catch (error) {
      setResult({ action: "save", ok: false, created: [], logs: [], errors: [String(error)] });
      setFailedSnapshot(sent);
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

  /** Turns auto-save on or off on the server (it is kept in .envs/config.yml). */
  const setAutosave = async (on: boolean) => {
    setSavingSettings(true);
    setSettingsError(undefined);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autosave: on }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const saved = (await res.json()) as Pick<Settings, "autosave">;
      setSettings((s) => s && { ...s, autosave: saved.autosave });
    } catch {
      setSettingsError("Could not change auto-save.");
    } finally {
      setSavingSettings(false);
    }
  };

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
        autosave={autosave}
        onSave={save}
      />
      <main>
        {route.page === "settings" ? (
          <SettingsPage settings={settings} error={settingsError} onAutosave={setAutosave} savingSettings={savingSettings} />
        ) : route.page === "worktree" ? (
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
        {route.page !== "settings" && <HistoryCard history={history} current={editorValues} dirty={dirty} busy={busy} onRestore={restorePoint} />}
        <ActionLog result={result} />
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
