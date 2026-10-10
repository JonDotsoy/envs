/** A problem found by a rule; `envs lint` prints it as `warning [rule id] location: message`. */
export interface Violation {
  /** Where the problem is: a values.yml path (`envs.PORT.main`) or a file. */
  location: string;
  message: string;
}

export interface LintContext {
  /** Parsed values.yml. */
  values: {
    defaults?: Record<string, unknown>;
    envs?: Record<string, Record<string, unknown>>;
    /** Profile of each worktree. */
    uses?: Record<string, string>;
    profiles?: Record<
      string,
      {
        defaults?: Record<string, unknown>;
        envs?: Record<string, Record<string, unknown>>;
      } | null
    >;
  };
  /** Root of the main workspace, where `.envs/` lives. */
  root: string;
  /** File mode of values.yml (`stat().mode`); undefined where modes do not apply. */
  valuesMode?: number;
  /** Worktrees that have a `.env` file, with its file mode (undefined where modes do not apply). */
  dotenvs: { name: string; path: string; mode?: number }[];
  isTracked(dir: string, file: string): Promise<boolean>;
  isIgnored(dir: string, file: string): Promise<boolean>;
}

export interface Rule {
  /** Stable identifier, shown in the warning, e.g. `weak-secret`. */
  id: string;
  description: string;
  check(ctx: LintContext): Violation[] | Promise<Violation[]>;
}

const SENSITIVE_KEY =
  /(^|_)(SECRET|PASSWORD|PASSWD|PWD|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|AUTH|SALT|SIGNING)(_|$)/i;

const WEAK_VALUES = new Set([
  "",
  "changeme",
  "change-me",
  "change_me",
  "password",
  "passw0rd",
  "secret",
  "admin",
  "root",
  "test",
  "default",
  "example",
  "123456",
  "12345678",
  "qwerty",
  "todo",
  "xxx",
]);

/** Well-known secret formats; the message never includes the matched value. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, "a GitHub token"],
  [/sk-[A-Za-z0-9_-]{20,}/, "an API secret key"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

interface Entry {
  key: string;
  text: string;
  location: string;
  shared: boolean;
}

/** Every value of values.yml: the legacy root, then each profile; defaults first, then each worktree's. */
function entries({ values }: LintContext): Entry[] {
  const result: Entry[] = [];
  const collect = (
    prefix: string,
    section?: { defaults?: Record<string, unknown>; envs?: Record<string, Record<string, unknown>> } | null,
  ) => {
    for (const [key, value] of Object.entries(section?.defaults ?? {})) {
      result.push({ key, text: String(value), location: `${prefix}defaults.${key}`, shared: true });
    }
    for (const [key, byWorktree] of Object.entries(section?.envs ?? {})) {
      for (const [worktree, value] of Object.entries(byWorktree ?? {})) {
        result.push({
          key,
          text: String(value),
          location: `${prefix}envs.${key}.${worktree}`,
          shared: false,
        });
      }
    }
  };
  collect("", values);
  for (const [name, profile] of Object.entries(values.profiles ?? {})) {
    collect(`profiles.${name}.`, profile);
  }
  return result;
}

/** Splits `scheme://[user:pass@]host[:port]/...`; undefined when text is not a URL. */
function parseUrl(text: string) {
  const match = text.match(/^([a-z][a-z0-9+.-]*):\/\/([^/\s]*)/i);
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  const hostname = authority
    .slice(authority.lastIndexOf("@") + 1)
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  return {
    scheme,
    hasPassword: /^[^@]*:[^@]+@/.test(authority),
    local: /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/.test(hostname),
  };
}

const valuesFile = ".envs/values.yml";

/** values.yml and every worktree's .env with their file modes. */
function envFiles(ctx: LintContext) {
  return [
    { location: valuesFile, mode: ctx.valuesMode },
    ...ctx.dotenvs.map((d) => ({ location: `${d.name}/.env`, mode: d.mode })),
  ];
}

/** The rules `envs lint` runs, one by one, in this order. */
export const rules: Rule[] = [
  {
    id: "tracked-values",
    description: "values.yml is tracked by git.",
    async check(ctx) {
      if (!(await ctx.isTracked(ctx.root, valuesFile))) return [];
      return [
        {
          location: valuesFile,
          message:
            "values.yml is tracked by git, so its secrets are in the history. Run `git rm --cached .envs/values.yml`.",
        },
      ];
    },
  },
  {
    id: "unignored-values",
    description: "values.yml is neither tracked nor ignored by git.",
    async check(ctx) {
      if (await ctx.isTracked(ctx.root, valuesFile)) return [];
      if (await ctx.isIgnored(ctx.root, valuesFile)) return [];
      return [
        {
          location: valuesFile,
          message:
            "values.yml is not ignored by git and could be committed by accident. Add `*` to .envs/.gitignore.",
        },
      ];
    },
  },
  {
    id: "open-permissions",
    description: "values.yml is readable by other users.",
    check({ valuesMode }) {
      if (valuesMode === undefined || (valuesMode & 0o077) === 0) return [];
      return [
        {
          location: valuesFile,
          message: `values.yml is readable by other users (mode ${(valuesMode & 0o777).toString(8)}). Run \`chmod 600 .envs/values.yml\`.`,
        },
      ];
    },
  },
  {
    id: "executable-files",
    description: "values.yml or a worktree's .env has execute permission.",
    check: (ctx) =>
      envFiles(ctx)
        .filter((f) => f.mode !== undefined && (f.mode & 0o111) !== 0)
        .map((f) => ({
          location: f.location,
          message: `The file is executable (mode ${(f.mode! & 0o777).toString(8)}); env files are data and must not be. Run \`chmod -x\` on it.`,
        })),
  },
  {
    id: "writable-files",
    description: "values.yml or a worktree's .env is writable by other users.",
    check: (ctx) =>
      envFiles(ctx)
        .filter((f) => f.mode !== undefined && (f.mode & 0o022) !== 0)
        .map((f) => ({
          location: f.location,
          message: `The file is writable by group or other users (mode ${(f.mode! & 0o777).toString(8)}), who could change your environment. Run \`chmod go-w\` on it.`,
        })),
  },
  {
    id: "tracked-dotenv",
    description: "A worktree's .env is tracked by git.",
    async check(ctx) {
      const found: Violation[] = [];
      for (const { name, path } of ctx.dotenvs) {
        if (!(await ctx.isTracked(path, ".env"))) continue;
        found.push({
          location: `${name}/.env`,
          message:
            "The .env is tracked by git. Run `git rm --cached .env` and add it to .gitignore.",
        });
      }
      return found;
    },
  },
  {
    id: "unignored-dotenv",
    description: "A worktree's .env is neither tracked nor ignored by git.",
    async check(ctx) {
      const found: Violation[] = [];
      for (const { name, path } of ctx.dotenvs) {
        if (await ctx.isTracked(path, ".env")) continue;
        if (await ctx.isIgnored(path, ".env")) continue;
        found.push({
          location: `${name}/.env`,
          message: "The .env is not ignored by git. Add `.env` to .gitignore.",
        });
      }
      return found;
    },
  },
  {
    id: "weak-secret",
    description: "A sensitive variable is empty or has an easily guessed value.",
    check: (ctx) =>
      entries(ctx)
        .filter((e) => isSensitiveKey(e.key) && WEAK_VALUES.has(e.text.trim().toLowerCase()))
        .map((e) => ({
          location: e.location,
          message: `${e.key} has an empty or easily guessed value.`,
        })),
  },
  {
    id: "shared-secret",
    description: "A sensitive variable is in defaults, so it goes to every worktree using that profile.",
    check: (ctx) =>
      entries(ctx)
        .filter((e) => e.shared && isSensitiveKey(e.key))
        .map((e) => ({
          location: e.location,
          message: `${e.key} looks sensitive but is written to every worktree; set it per worktree under envs instead.`,
        })),
  },
  {
    id: "secret-pattern",
    description: "A value has the format of a well-known secret.",
    check: (ctx) =>
      entries(ctx).flatMap((e) =>
        SECRET_PATTERNS.filter(([pattern]) => pattern.test(e.text)).map(([, name]) => ({
          location: e.location,
          message: `${e.key} looks like ${name}.`,
        })),
      ),
  },
  {
    id: "url-credentials",
    description: "A remote URL embeds a password.",
    check: (ctx) =>
      entries(ctx)
        .filter((e) => {
          const url = parseUrl(e.text);
          return url?.hasPassword && !url.local;
        })
        .map((e) => ({
          location: e.location,
          message: `${e.key} embeds a password in its URL.`,
        })),
  },
  {
    id: "insecure-url",
    description: "A remote URL uses an unencrypted protocol.",
    check: (ctx) =>
      entries(ctx)
        .filter((e) => {
          const url = parseUrl(e.text);
          return url && !url.local && ["http", "ws", "ftp"].includes(url.scheme);
        })
        .map((e) => ({
          location: e.location,
          message: `${e.key} uses ${parseUrl(e.text)!.scheme}:// instead of an encrypted protocol.`,
        })),
  },
  {
    id: "unknown-profile",
    description: "A worktree uses a profile that is not defined.",
    check: ({ values }) =>
      Object.entries(values.uses ?? {})
        .filter(
          ([, profile]) =>
            profile !== "default" && !Object.hasOwn(values.profiles ?? {}, profile),
        )
        .map(([worktree, profile]) => ({
          location: `uses.${worktree}`,
          message: `Profile "${profile}" is not defined under profiles; \`envs edit\` creates it from default.`,
        })),
  },
];
