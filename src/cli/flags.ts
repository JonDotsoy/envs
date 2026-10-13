import { argument, command, flag, flags } from "@jondotsoy/flags";

/** Parser for `envs <command>`: picks the subcommand and keeps its arguments for that command's parser. */
export const rootParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  init: command("init").restArgs().describe("Create the .envs/ directory"),
  pull: command("pull").restArgs().describe("Read each worktree's .env into .envs/values.yml"),
  push: command("push").restArgs().describe("Write defaults and .envs/values.yml into each worktree's .env"),
  lint: command("lint").restArgs().describe("Warn about insecure values and unprotected secret files"),
  edit: command("edit").restArgs().describe("Pull, edit .envs/values.yml, then push"),
  use: command("use").restArgs().describe("Select the profile of the current worktree, or list them"),
  restore: command("restore").restArgs().describe("Restore values.yml to a history point"),
  history: command("history").restArgs().describe("Manage the history"),
  config: command("config").restArgs().describe("Read or change .envs/config.yml"),
  helpCommand: command("help").boolean().describe("Show this help message"),
})
  .program("envs")
  .describe("Manage .env files per worktree");

/** `envs edit [--ui]` */
export const editParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  ui: flag("--ui").boolean().describe("Serve a web editor instead of opening VS Code"),
})
  .program("envs edit")
  .describe("Pull, edit .envs/values.yml, then push");

/** `envs use [profile]` */
export const useParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  profile: argument().string().describe("Profile to select; omit to list them"),
})
  .program("envs use")
  .describe("Select the profile of the current worktree, or list them");

/** `envs restore <hash> [--force]` */
export const restoreParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  force: flag("--force").boolean().describe("Restore even if the file fails validation"),
  hash: argument().string().describe("History point to restore"),
})
  .program("envs restore")
  .describe("Restore values.yml to the state after a history point");

/** `envs history [redact]` */
export const historyParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  redact: command("redact").boolean().describe("Remove secrets in clear from an existing history"),
})
  .program("envs history")
  .describe("Manage the history");

/** `envs config <set|get|delete>`: picks the subcommand and keeps its arguments for that subcommand's parser. */
export const configParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  set: command("set").restArgs().describe("config set <key> <value>"),
  get: command("get").restArgs().describe("config get [key]"),
  delete: command("delete").restArgs().describe("config delete <key>"),
})
  .program("envs config")
  .describe("Read or change .envs/config.yml");

/** `envs config set <key> <value...>` */
export const configSetParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  key: argument().string().describe("Key to set"),
  value: argument().strings().describe("Value to store"),
})
  .program("envs config set")
  .describe("Set a key in .envs/config.yml");

/** `envs config get [key]` */
export const configGetParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  key: argument().string().describe("Key to read; omit to list them all"),
})
  .program("envs config get")
  .describe("Read a key from .envs/config.yml");

/** `envs config delete <key>` */
export const configDeleteParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  key: argument().string().describe("Key to delete"),
})
  .program("envs config delete")
  .describe("Delete a key from .envs/config.yml");

/** Commands without options of their own (besides --help). */
export const simpleParser = (name: string, description: string) =>
  flags({ help: flag("-h", "--help").boolean().describe("Show this help message") })
    .program(`envs ${name}`)
    .describe(description);

/** `help` is true when `--help` was given; the other options are parsed as usual. */
export type CliAction =
  | { action: "help" }
  | { action: "unknown"; command: string }
  | { action: "init" | "pull" | "push" | "lint"; help: boolean }
  | { action: "edit"; help: boolean; ui: boolean }
  | { action: "use"; help: boolean; profile: string | null }
  | { action: "restore"; help: boolean; force: boolean; hash: string | null }
  | { action: "history"; help: boolean; redact: boolean }
  | { action: "config"; help: boolean }
  | { action: "config.set"; help: boolean; key: string | null; value: string[] | null }
  | { action: "config.get"; help: boolean; key: string | null }
  | { action: "config.delete"; help: boolean; key: string | null };

const simpleCommands = {
  init: "Create the .envs/ directory",
  pull: "Read each worktree's .env into .envs/values.yml",
  push: "Write defaults and .envs/values.yml into each worktree's .env",
  lint: "Warn about insecure values and unprotected secret files",
} as const;

const commandNames = ["init", "pull", "push", "lint", "edit", "use", "restore", "history", "config"] as const;

/**
 * Turns `process.argv.slice(2)` into the action to run, with its options already parsed.
 * `rootParser` only sees the first argument: its `restArgs()` commands would also match
 * command names inside the rest (`config set history false`), so the rest goes to the command's own parser.
 */
export function parser(args: string[]): CliAction {
  const [first, ...rest] = args;
  const [ok, , root] = rootParser.safeParse(first === undefined ? [] : [first]);
  if (!ok) return { action: "unknown", command: first ?? "" };

  const name = commandNames.find((name) => root[name] !== null);
  switch (name) {
    case "init":
    case "pull":
    case "push":
    case "lint":
      return { action: name, ...simpleParser(name, simpleCommands[name]).parse(rest) };
    case "edit":
      return { action: "edit", ...editParser.parse(rest) };
    case "use":
      return { action: "use", ...useParser.parse(rest) };
    case "restore":
      return { action: "restore", ...restoreParser.parse(rest) };
    case "history":
      return { action: "history", ...historyParser.parse(rest) };
    case "config":
      return parserConfig(rest);
    default:
      return { action: "help" };
  }
}

const configCommandNames = ["set", "get", "delete"] as const;

/** Same as `parser`, one level down: `configParser` sees only the subcommand. */
function parserConfig(args: string[]): CliAction {
  const [first, ...rest] = args;
  const [ok, , config] = configParser.safeParse(first === undefined ? [] : [first]);
  if (!ok) return { action: "unknown", command: `config ${first}` };

  const name = configCommandNames.find((name) => config[name] !== null);
  switch (name) {
    case "set":
      return { action: "config.set", ...configSetParser.parse(rest) };
    case "get":
      return { action: "config.get", ...configGetParser.parse(rest) };
    case "delete":
      return { action: "config.delete", ...configDeleteParser.parse(rest) };
    default:
      return { action: "config", help: true };
  }
}
