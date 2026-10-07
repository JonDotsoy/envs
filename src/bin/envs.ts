#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";

export const HELP = `Usage: envs <command>

Commands:
  init    Create the .envs/ directory (.gitignore, values.yml)
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
