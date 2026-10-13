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

/** `envs config <set|get|delete> [key] [value]` */
export const configParser = flags({
  help: flag("-h", "--help").boolean().describe("Show this help message"),
  set: command("set").restArgs().describe("config set <key> <value>"),
  get: command("get").restArgs().describe("config get [key]"),
  delete: command("delete").restArgs().describe("config delete <key>"),
})
  .program("envs config")
  .describe("Read or change .envs/config.yml");

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
  | { action: "config.set"; key: string | null; value: string | null }
  | { action: "config.get"; key: string | null }
  | { action: "config.delete"; key: string | null }
  | { action: "config"; help: true };

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
    case "config": {
      const options = configParser.parse(rest);
      if (options.help) return { action: "config", help: true };
      if (options.set !== null) {
        const [key = null, ...value] = options.set;
        return { action: "config.set", key, value: value.length ? value.join(" ") : null };
      }
      if (options.get !== null) return { action: "config.get", key: options.get[0] ?? null };
      if (options.delete !== null) return { action: "config.delete", key: options.delete[0] ?? null };
      return { action: "config", help: true };
    }
    default:
      return { action: "help" };
  }
}
