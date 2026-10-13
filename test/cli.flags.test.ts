import { expect, test } from "bun:test";
import { parseCommand } from "../src/cli/flags";

test("parseCommand with no arguments", () => {
  expect(parseCommand([])).toMatchSnapshot();
});

test("parseCommand with an unknown command", () => {
  expect(parseCommand(["hekp"])).toMatchSnapshot();
});

test("parseCommand with the help command", () => {
  expect(parseCommand(["help"])).toMatchSnapshot();
});
