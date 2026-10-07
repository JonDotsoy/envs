#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";

export const HELP = `Usage: envs <command>

Commands:
  init    Create the .envs/ directory (.gitignore, values.yml)
  pull    Read each worktree's .env and write it into .envs/values.yml
  edit    Open .envs/values.yml in VS Code and wait (code -w)
  help    Show this help message
`;

/** Root of the main git workspace; inside a worktree this is the parent repo. Falls back to cwd outside git. */
async function findRoot(): Promise<string> {
  const result =
    await $`git rev-parse --path-format=absolute --git-common-dir`.nothrow().quiet();
  if (result.exitCode !== 0) return process.cwd();
  return dirname(result.stdout.toString().trim());
}

interface Worktree {
  name: string;
  path: string;
}

/** Lists the main workspace and its worktrees; `name` is the branch (or dir name when detached). */
async function listWorktrees(): Promise<Worktree[]> {
  const out = await $`git worktree list --porcelain`.text();
  return out
    .trim()
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))!.slice(9);
      const branch = lines.find((l) => l.startsWith("branch "));
      return {
        path,
        name: branch ? branch.slice("branch refs/heads/".length) : basename(path),
      };
    });
}

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes and `export`. */
function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    result[match[1]!] = value;
  }
  return result;
}

const [command = "help"] = Bun.argv.slice(2);

switch (command) {
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  case "init": {
    const root = await findRoot();
    const files = { ".envs/.gitignore": "*\n", ".envs/values.yml": "" };
    await mkdir(join(root, ".envs"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      if (await Bun.file(path).exists()) {
        console.log(`${path} already exists`);
      } else {
        await Bun.write(path, content);
        console.log(`Created ${path}`);
      }
    }
    break;
  }
  case "pull": {
    const valuesPath = join(await findRoot(), ".envs/values.yml");
    if (!(await Bun.file(valuesPath).exists())) {
      console.error(`${valuesPath} not found. Run \`envs init\` first.`);
      process.exit(1);
    }
    const values = (Bun.YAML.parse(await Bun.file(valuesPath).text()) ?? {}) as {
      envs?: Record<string, Record<string, string>>;
    };
    const envs = (values.envs ??= {});
    for (const { name, path } of await listWorktrees()) {
      const dotenv = Bun.file(join(path, ".env"));
      if (!(await dotenv.exists())) continue;
      const parsed = parseDotenv(await dotenv.text());
      // Drop keys that are no longer in this worktree's .env.
      for (const [key, byWorktree] of Object.entries(envs)) {
        if (!(key in parsed)) delete byWorktree[name];
      }
      for (const [key, value] of Object.entries(parsed)) {
        (envs[key] ??= {})[name] = value;
      }
      console.log(`Synced ${name}`);
    }
    for (const [key, byWorktree] of Object.entries(envs)) {
      if (Object.keys(byWorktree).length === 0) delete envs[key];
    }
    await Bun.write(valuesPath, Bun.YAML.stringify(values, null, 2));
    break;
  }
  case "edit": {
    const path = join(await findRoot(), ".envs/values.yml");
    if (!(await Bun.file(path).exists())) {
      console.error(`${path} not found. Run \`envs init\` first.`);
      process.exit(1);
    }
    const proc = Bun.spawn(["code", "-w", path], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    process.exit(await proc.exited);
  }
  default:
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(1);
}
