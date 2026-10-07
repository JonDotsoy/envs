#!/usr/bin/env bun
import { run } from "../envs";

process.exit(await run(Bun.argv.slice(2)));
