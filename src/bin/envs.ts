#!/usr/bin/env bun

export const HELP = `Usage: envs <command>

Commands:
  init    Create an empty .env file if it does not exist
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
    const env = Bun.file(".env");
    if (await env.exists()) {
      console.log(".env already exists");
    } else {
      await Bun.write(env, "");
      console.log("Created .env");
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(1);
}
