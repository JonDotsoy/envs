/**
 * The settings page: the editor's own options (auto-save) and where its files are on this machine.
 * Values are edited on the other pages; nothing here touches values.yml.
 */
import { useState } from "react";

/** GET /api/settings. */
export interface Settings {
  autosave: boolean;
  paths: { project: string; values: string; history: string; config: string };
}

/** How long after the last change auto-save waits before saving, so a word being typed is saved once. */
export const AUTOSAVE_DELAY_MS = 1500;

/** An absolute path, selectable as a whole, with a button that copies it. */
function PathRow(props: { label: string; hint: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (an older or locked-down browser): the path can still be selected by hand.
    }
  };
  return (
    <div className="path-row">
      <dt>
        {props.label}
        <span className="path-hint">{props.hint}</span>
      </dt>
      <dd>
        <code className="path" title={props.path}>{props.path}</code>
        <button className="ghost copy" onClick={copy} aria-label={`Copy the path of ${props.label}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
    </div>
  );
}

export function SettingsPage(props: { settings?: Settings; error?: string; onAutosave(on: boolean): void; savingSettings: boolean }) {
  const { settings, error, onAutosave, savingSettings } = props;
  return (
    <>
      <section className="card" aria-labelledby="page-title">
        <p className="eyebrow">Settings</p>
        <h2 id="page-title" tabIndex={-1}>Editor settings</h2>
        <p className="lede">
          Kept in <code>.envs/config.yml</code>, so they apply the next time you run <code>envs edit --ui</code> too.
        </p>
        <div className="setting">
          <div className="setting-text">
            <h3 id="autosave-title">Auto-save</h3>
            <p id="autosave-help">
              Saves and pushes on its own {AUTOSAVE_DELAY_MS / 1000} seconds after your last change, as <strong>Save</strong> does: each save
              writes <code>values.yml</code>, the <code>.env</code> files, and a history point. A save that fails is not retried until you change
              something else. Same as <code>envs config set ui.autosave true</code>.
            </p>
          </div>
          <button
            className="switch-toggle"
            role="switch"
            aria-checked={settings?.autosave ?? false}
            aria-labelledby="autosave-title"
            aria-describedby="autosave-help"
            disabled={!settings || savingSettings}
            onClick={() => settings && onAutosave(!settings.autosave)}
          >
            <span className="knob" aria-hidden="true" />
            <span className="switch-label">{settings?.autosave ? "On" : "Off"}</span>
          </button>
        </div>
        {error && <p className="setting-error" role="alert">{error}</p>}
      </section>

      <section className="card" aria-labelledby="info-title">
        <p className="eyebrow">Information</p>
        <h2 id="info-title">Where the files are</h2>
        <p className="lede">Absolute paths on this machine. Every worktree shares the same <code>.envs/</code> folder, in the main workspace.</p>
        {settings ? (
          <dl className="paths">
            <PathRow label="Project" hint="the main workspace, which holds .envs/" path={settings.paths.project} />
            <PathRow label="Values" hint="values.yml, the source of every .env" path={settings.paths.values} />
            <PathRow label="History" hint="history.ndjson, the points listed under History" path={settings.paths.history} />
            <PathRow label="Config" hint="config.yml, where these settings are kept" path={settings.paths.config} />
          </dl>
        ) : (
          <p className="lede" aria-busy="true">Loading…</p>
        )}
      </section>
    </>
  );
}
