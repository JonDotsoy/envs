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

export type CliAction =
  | { action: "help" }
  | { action: "unknown"; command: string }
  | { action: "init" | "pull" | "push" | "lint" }
  | { action: "init.help" | "pull.help" | "push.help" | "lint.help" }
  | { action: "edit"; ui: boolean }
  | { action: "edit.help" }
  | { action: "use"; profile: string | null }
  | { action: "use.help" }
  | { action: "restore"; hash: string | null; force: boolean }
  | { action: "restore.help" }
  | { action: "history.redact" }
  | { action: "history.help" }
  | { action: "config.set"; key: string | null; value: string | null }
  | { action: "config.get"; key: string | null }
  | { action: "config.delete"; key: string | null }
  | { action: "config.help" };

const simpleCommands = {
  init: "Create the .envs/ directory",
  pull: "Read each worktree's .env into .envs/values.yml",
  push: "Write defaults and .envs/values.yml into each worktree's .env",
  lint: "Warn about insecure values and unprotected secret files",
} as const;

/** Turns `process.argv.slice(2)` into the action to run, with its options already parsed. */
export function parser(args: string[]): CliAction {
  const [ok, , root] = rootParser.safeParse(args);
  if (!ok) return { action: "unknown", command: args[0] ?? "" };

  for (const name of ["init", "pull", "push", "lint"] as const) {
    const rest = root[name];
    if (rest === null) continue;
    const options = simpleParser(name, simpleCommands[name]).parse(rest);
    return options.help ? { action: `${name}.help` } : { action: name };
  }

  if (root.edit !== null) {
    const options = editParser.parse(root.edit);
    return options.help ? { action: "edit.help" } : { action: "edit", ui: options.ui };
  }

  if (root.use !== null) {
    const options = useParser.parse(root.use);
    return options.help ? { action: "use.help" } : { action: "use", profile: options.profile };
  }

  if (root.restore !== null) {
    const options = restoreParser.parse(root.restore);
    return options.help ? { action: "restore.help" } : { action: "restore", hash: options.hash, force: options.force };
  }

  if (root.history !== null) {
    const options = historyParser.parse(root.history);
    return options.redact && !options.help ? { action: "history.redact" } : { action: "history.help" };
  }

  if (root.config !== null) {
    const options = configParser.parse(root.config);
    if (options.help) return { action: "config.help" };
    if (options.set !== null) {
      const [key = null, ...value] = options.set;
      return { action: "config.set", key, value: value.length ? value.join(" ") : null };
    }
    if (options.get !== null) return { action: "config.get", key: options.get[0] ?? null };
    if (options.delete !== null) return { action: "config.delete", key: options.delete[0] ?? null };
    return { action: "config.help" };
  }

  return { action: "help" };
}
