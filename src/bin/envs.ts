#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";

export const HELP = `Usage: envs <command>

Commands:
  init    Create the .envs/ directory (.gitignore, values.yml)
  help    Show this help message
`;

const [command = "help"] = Bun.argv.slice(2);

switch (command) {
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  case "init": {
    const files = { ".envs/.gitignore": "*\n", ".envs/values.yml": "" };
    await mkdir(".envs", { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      if (await Bun.file(path).exists()) {
        console.log(`${path} already exists`);
      } else {
        await Bun.write(path, content);
        console.log(`Created ${path}`);
      }
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(1);
}
