#!/usr/bin/env bun

export const HELP = `Usage: envs <command>

Commands:
  help    Show this help message
`;

const [command = "help"] = Bun.argv.slice(2);

switch (command) {
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(1);
}
