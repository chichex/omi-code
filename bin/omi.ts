#!/usr/bin/env node
import { run } from "../src/cli/main.ts";
import { processIo } from "../src/cli/io.ts";

process.exitCode = await run(process.argv.slice(2), processIo());
