import { expect, test } from "bun:test";
import Ajv from "ajv";
import schema from "../schema/values.schema.json";

const validate = new Ajv().compile(schema);

test("values.yml schema accepts envs.<env name>.<worktree name>: <value>", () => {
  const values = Bun.YAML.parse(`
envs:
  DATABASE_URL:
    main: postgres://localhost/main
    worktree-1: postgres://localhost/wt1
  PORT:
    main: "3000"
`);
  expect(validate(values)).toBe(true);
});

test("values.yml schema accepts an empty document", () => {
  expect(validate({})).toBe(true);
});

test("values.yml schema rejects invalid shapes", () => {
  expect(validate({ envs: { PORT: "3000" } })).toBe(false);
  expect(validate({ envs: { PORT: { main: { nested: "x" } } } })).toBe(false);
  expect(validate({ other: {} })).toBe(false);
});

test("values.yml schema accepts defaults alongside envs", () => {
  const values = Bun.YAML.parse(`
defaults:
  FOO: tar

envs:
  FOO:
    main: biz
`);
  expect(validate(values)).toBe(true);
  expect(validate({ defaults: { FOO: 1 } })).toBe(false);
});
