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
