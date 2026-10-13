import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli/flags";

test("parseArgs with no arguments", () => {
  expect(parseArgs([])).toMatchSnapshot();
});

test("parseArgs with an unknown command", () => {
  expect(() => parseArgs(["hekp"])).toThrow("Unknown command: hekp");
});

test("parseArgs with the help command", () => {
  expect(parseArgs(["help"])).toMatchSnapshot();
});

test("parseArgs gives each command its own flags profile", () => {
  expect(parseArgs(["push"])).toEqual({ push: true });
  expect(() => parseArgs(["push", "--nope"])).toThrow();
  expect(parseArgs(["history", "redact"])).toEqual({ history: true, args: ["redact"] });
  expect(parseArgs(["config", "set", "history", "false"])).toEqual({ config: true, args: ["set", "history", "false"] });
  expect(parseArgs(["config", "get"])).toEqual({ config: true, args: ["get"] });
  expect(parseArgs(["config"])).toEqual({ config: true, args: [] });
});
