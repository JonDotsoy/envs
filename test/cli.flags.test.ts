import { expect, test } from "bun:test";
import { parseCommand } from "../src/cli/flags";

test("parseCommand with no arguments", () => {
  expect(parseCommand([])).toMatchSnapshot();
});
