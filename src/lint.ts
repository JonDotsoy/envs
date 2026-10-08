export interface Finding {
  /** Stable identifier of the rule, e.g. `weak-secret`. */
  rule: string;
  /** Where the problem is: a values.yml path (`envs.PORT.main`) or a file. */
  location: string;
  message: string;
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

/** Checks one value; `location` and `key` describe where it came from. */
export function lintValue(
  key: string,
  value: unknown,
  location: string,
): Finding[] {
  const findings: Finding[] = [];
  const text = String(value);
  const add = (rule: string, message: string) =>
    findings.push({ rule, location, message });

  if (isSensitiveKey(key) && WEAK_VALUES.has(text.trim().toLowerCase())) {
    add("weak-secret", `${key} has an empty or easily guessed value.`);
  }
  for (const [pattern, name] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      add("secret-pattern", `${key} looks like ${name}.`);
    }
  }
  const url = text.match(/^([a-z][a-z0-9+.-]*):\/\/([^/\s]*)/i);
  if (url) {
    const [, scheme, authority] = url as unknown as [string, string, string];
    const host = authority.slice(authority.lastIndexOf("@") + 1);
    const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    const local = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/.test(
      hostname,
    );
    if (/^[^@]*:[^@]+@/.test(authority) && !local) {
      add("url-credentials", `${key} embeds a password in its URL.`);
    }
    if (["http", "ws", "ftp"].includes(scheme.toLowerCase()) && !local) {
      add("insecure-url", `${key} uses ${scheme}:// instead of an encrypted protocol.`);
    }
  }
  return findings;
}

interface ValuesLike {
  defaults?: Record<string, unknown>;
  envs?: Record<string, Record<string, unknown>>;
}

/** Checks every value of values.yml. */
export function lintValues(values: ValuesLike): Finding[] {
  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(values.defaults ?? {})) {
    findings.push(...lintValue(key, value, `defaults.${key}`));
    if (isSensitiveKey(key)) {
      findings.push({
        rule: "shared-secret",
        location: `defaults.${key}`,
        message: `${key} looks sensitive but is written to every worktree; set it per worktree under envs instead.`,
      });
    }
  }
  for (const [key, byWorktree] of Object.entries(values.envs ?? {})) {
    for (const [worktree, value] of Object.entries(byWorktree ?? {})) {
      findings.push(...lintValue(key, value, `envs.${key}.${worktree}`));
    }
  }
  return findings;
}
