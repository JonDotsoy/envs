import { argument, command, flag, flags } from "@jondotsoy/flags";

/** Per-command help, shown by `envs <command> --help` (or `-h`). */
export const COMMAND_HELP: Record<string, string> = {
  init: `Usage: envs init [--help|-h]

Create the .envs/ directory (.gitignore, values.yml).
`,
  pull: `Usage: envs pull [--help|-h]

Read each worktree's .env and write it into .envs/values.yml.
`,
  push: `Usage: envs push [--help|-h]

Write defaults and .envs/values.yml into the .env of each worktree.
`,
  lint: `Usage: envs lint [--help|-h]

Warn about insecure values and unprotected secret files.
`,
  edit: `Usage: envs edit [--ui] [--help|-h]

Pull, open .envs/values.yml in VS Code (code -w), then push.

Options:
  --ui    Serve a web editor instead; its Save button pushes
`,
  use: `Usage: envs use [<profile>] [--help|-h]

Select the profile of the current worktree, or list the profiles when none is given.
`,
  restore: `Usage: envs restore <hash> [--force] [--help|-h]

Restore values.yml to the state after a history point, adding a new point.

Options:
  --force    Restore even if the history hash chain is broken
`,
  history: `Usage: envs history <redact> [--help|-h]

Manage the history.

Subcommands:
  redact    Remove secrets in clear from an existing history
`,
  config: `Usage: envs config <set <key> <value> | get [key] | delete <key>> [--help|-h]

Read or change .envs/config.yml.
`,
};

export type ParsedCommand =
  | { name: "help"; topic?: string }
  | { name: "init" | "pull" | "push" | "lint" }
  | { name: "edit"; ui: boolean }
  | { name: "use"; profile?: string }
  | { name: "restore"; hash?: string; force: boolean }
  | { name: "history" | "config"; args: string[] };

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; error: string };

const help = () => flag("--help", "-h").boolean();

/** Picks the command; the arguments after it are parsed by that command's own parser. */
const root = flags({
  help: help(),
  helpCommand: command("help").restArgs(),
  init: command("init").restArgs(),
  pull: command("pull").restArgs(),
  push: command("push").restArgs(),
  lint: command("lint").restArgs(),
  edit: command("edit").restArgs(),
  use: command("use").restArgs(),
  restore: command("restore").restArgs(),
  history: command("history").restArgs(),
  config: command("config").restArgs(),
});

const editFlags = flags({ help: help(), ui: flag("--ui").boolean() });
const useFlags = flags({ help: help(), profile: argument().string() });
const restoreFlags = flags({ help: help(), force: flag("--force").boolean(), hash: argument().string() });

const COMMANDS = ["init", "pull", "push", "lint", "edit", "use", "restore", "history", "config"] as const;

/** Parses the CLI arguments into the command to run and its options. */
export function parseCommand(args: string[]): ParseResult {
  const [ok, error, parsed] = root.safeParse(args);
  if (!ok) {
    const unknown = args.find((arg) => !arg.startsWith("-"));
    return { ok: false, error: unknown ? `Unknown command: ${unknown}` : String((error as Error).message) };
  }
  // The command is the first word: a later word (`config set history ...`) may also look like one.
  const first = args.find((arg) => !arg.startsWith("-"));
  const name = COMMANDS.find((candidate) => candidate === first);
  if (!name) return { ok: true, command: { name: "help" } };
  if (parsed.help) return { ok: true, command: { name: "help", topic: name } };
  const rest = parsed[name] ?? [];
  switch (name) {
    case "init":
    case "pull":
    case "push":
    case "lint":
      return { ok: true, command: { name } };
    case "history":
    case "config":
      return { ok: true, command: { name, args: rest } };
    case "edit": {
      const [valid, err, out] = editFlags.safeParse(rest);
      if (!valid) return { ok: false, error: (err as Error).message };
      return { ok: true, command: { name, ui: out.ui } };
    }
    case "use": {
      const [valid, err, out] = useFlags.safeParse(rest);
      if (!valid) return { ok: false, error: (err as Error).message };
      return { ok: true, command: { name, profile: out.profile ?? undefined } };
    }
    case "restore": {
      const [valid, err, out] = restoreFlags.safeParse(rest);
      if (!valid) return { ok: false, error: (err as Error).message };
      return { ok: true, command: { name, hash: out.hash ?? undefined, force: out.force } };
    }
  }
}
