#!/usr/bin/env node
/**
 * Run every example program through the real engine and report the results.
 *
 * Usage: node tools/development/run-examples.js
 *
 * Exits with a nonzero status if any example fails to execute.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runFile, ExecutionContext } from "../../src/main/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "examples");

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (entry.endsWith(".typ")) out.push(full);
  }
  return out;
}

const files = collect(examplesDir).sort();
let failures = 0;

for (const file of files) {
  const chunks = [];
  try {
    runFile(file, {
      context: new ExecutionContext({ onOutput: (t) => chunks.push(t), onInput: () => "" }),
    });
    const lines = chunks.join("").trim().split("\n");
    process.stdout.write(`PASS  ${file}  (${lines.length} line(s) of output)\n`);
  } catch (err) {
    failures += 1;
    const message = err?.diagnostics?.[0]?.message ?? err?.message ?? String(err);
    process.stdout.write(`FAIL  ${file}  ${message}\n`);
  }
}

process.stdout.write(
  `\n${files.length - failures}/${files.length} example program(s) executed successfully\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
