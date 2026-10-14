#!/usr/bin/env node
/**
 * The `typhoun` executable.
 *
 * A thin wrapper: all logic lives in src/cli/cli.js so it can be unit-tested
 * without spawning a process.
 */
import process from "node:process";
import { main } from "../src/cli/cli.js";

// Exit quietly when a downstream consumer (e.g. `head`) closes the pipe.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
});

const code = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

process.exitCode = code;
