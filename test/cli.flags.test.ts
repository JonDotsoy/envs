import { describe, expect, test } from "bun:test";
import { configParser, parser, editParser, historyParser, restoreParser, rootParser, simpleParser, useParser } from "../src/cli/flags";

describe("rootParser", () => {
  const cases: string[][] = [
    [],
    ["help"],
    ["-h"],
    ["--help"],
    ["help", "--help"],
    ["init"],
    ["pull"],
    ["push"],
    ["lint"],
    ["edit"],
    ["edit", "--ui"],
    ["edit", "--code"],
    ["use", "staging"],
    ["restore", "abc123", "--force"],
    ["history", "redact"],
    ["config", "set", "key", "value"],
  ];
  for (const args of cases) {
    test(JSON.stringify(args), () => {
      expect(rootParser.parse(args)).toMatchSnapshot();
    });
  }
});

describe("editParser", () => {
  for (const args of [[], ["-h"], ["--help"], ["--ui"], ["--ui", "--help"]]) {
    test(JSON.stringify(args), () => {
      expect(editParser.parse(args)).toMatchSnapshot();
    });
  }
});

describe("useParser", () => {
  for (const args of [[], ["-h"], ["staging"], ["staging", "--help"]]) {
    test(JSON.stringify(args), () => {
      expect(useParser.parse(args)).toMatchSnapshot();
    });
  }
});

describe("restoreParser", () => {
  for (const args of [[], ["-h"], ["abc123"], ["abc123", "--force"], ["--force", "abc123"]]) {
    test(JSON.stringify(args), () => {
      expect(restoreParser.parse(args)).toMatchSnapshot();
    });
  }
});

describe("historyParser", () => {
  for (const args of [[], ["-h"], ["redact"], ["redact", "--help"]]) {
    test(JSON.stringify(args), () => {
      expect(historyParser.parse(args)).toMatchSnapshot();
    });
  }
});

describe("configParser", () => {
  for (const args of [[], ["-h"], ["set", "key", "value"], ["get"], ["get", "key"], ["delete", "key"]]) {
    test(JSON.stringify(args), () => {
      expect(configParser.parse(args)).toMatchSnapshot();
    });
  }
});

describe("simpleParser", () => {
  const parser = simpleParser("pull", "Read each worktree's .env into .envs/values.yml");
  for (const args of [[], ["-h"], ["--help"]]) {
    test(JSON.stringify(args), () => {
      expect(parser.parse(args)).toMatchSnapshot();
    });
  }
});

test("help message", () => {
  expect(rootParser.helpMessage()).toMatchSnapshot();
});

describe("parser", () => {
  const cases: string[][] = [
    [], ["help"], ["-h"], ["--help"], ["nope"],
    ["init"], ["init", "--help"], ["pull"], ["pull", "-h"], ["push"], ["lint"],
    ["edit"], ["edit", "--help"], ["edit", "--ui"], ["edit", "--ui", "-h"], ["edit", "--code"],
    ["use"], ["use", "staging"], ["use", "--help"],
    ["restore"], ["restore", "abc123"], ["restore", "abc123", "--force"], ["restore", "--help"],
    ["history"], ["history", "redact"], ["history", "--help"],
    ["config"], ["config", "--help"], ["config", "set", "history", "false"], ["config", "set", "key"],
    ["config", "bogus"], ["config", "set"], ["config", "set", "key", "-h"], ["config", "set", "key", "a", "b"], ["config", "get", "-h"], ["config", "get"], ["config", "get", "key"], ["config", "delete"], ["config", "delete", "key"],
  ];
  for (const args of cases) {
    test(JSON.stringify(args), () => {
      expect(parser(args)).toMatchSnapshot();
    });
  }
});

describe("version", () => {
  for (const args of [["-V"], ["--version"], ["version"]]) {
    test(JSON.stringify(args), () => {
      expect(parser(args)).toEqual({ ok: true, action: "version" });
    });
  }
});
