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

/** The parsed arguments: a plain object whose keys are the command and its options. */
export type ParsedArgs =
  | { help: true; topic?: string }
  | { init: true }
  | { pull: true }
  | { push: true }
  | { lint: true }
  | { edit: true; ui: boolean }
  | { use: true; profile?: string }
  | { restore: true; hash?: string; force: boolean }
  | { history: true; args: string[] }
  | { config: true; args: string[] };

/** Thrown by `parseArgs` for an unknown command or an invalid option. */
export class ArgsError extends Error {}

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

/** Parses the CLI arguments into the command to run and its options; throws `ArgsError` when they are invalid. */
export function parseArgs(args: string[]): ParsedArgs {
  const [ok, error, parsed] = root.safeParse(args);
  if (!ok) {
    const unknown = args.find((arg) => !arg.startsWith("-"));
    throw new ArgsError(unknown ? `Unknown command: ${unknown}` : (error as Error).message);
  }
  // The command is the first word: a later word (`config set history ...`) may also look like one.
  const first = args.find((arg) => !arg.startsWith("-"));
  const name = COMMANDS.find((candidate) => candidate === first);
  if (!name) return { help: true };
  if (parsed.help) return { help: true, topic: name };
  const rest = parsed[name] ?? [];
  const parseRest = <T>(parser: { safeParse(args: string[]): [boolean, unknown, T | undefined] }): T => {
    const [valid, err, out] = parser.safeParse(rest);
    if (!valid) throw new ArgsError((err as Error).message);
    return out as T;
  };
  switch (name) {
    case "init":
      return { init: true };
    case "pull":
      return { pull: true };
    case "push":
      return { push: true };
    case "lint":
      return { lint: true };
    case "history":
      return { history: true, args: rest };
    case "config":
      return { config: true, args: rest };
    case "edit":
      return { edit: true, ui: parseRest(editFlags).ui };
    case "use": {
      const { profile } = parseRest(useFlags);
      return profile === null ? { use: true } : { use: true, profile };
    }
    case "restore": {
      const { hash, force } = parseRest(restoreFlags);
      return hash === null ? { restore: true, force } : { restore: true, hash, force };
    }
  }
}
