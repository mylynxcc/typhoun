#!/usr/bin/env node
/**
 * Typhoun engine benchmark tool.
 *
 * Usage:
 *   node tools/development/benchmark.js [options] [file.typ ...]
 *
 * Options:
 *   --iterations <n>  Timed runs per program (default 5)
 *   --warmups <n>     Untimed runs per program (default 1)
 *   --json            Print the raw report as JSON instead of a table
 *   --out <dir>       Write benchmark.md and benchmark.json into <dir>
 *
 * Runs every program on both execution backends and reports measured wall-clock
 * times, step counts and whether the two engines produced identical output.
 *
 * Measured honestly, on purpose: the bytecode VM is *slower* than the
 * tree-walking interpreter in this host. The tool reports what it measures —
 * see docs/bytecode.md for the analysis and the numbers behind it.
 *
 * Exits nonzero if any program fails on either engine or the two engines
 * disagree. Being slower is not a failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  benchmarkAll,
  collectPrograms,
  formatMarkdown,
  formatReport,
} from "../../src/cli/bench.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const argv = process.argv.slice(2);
const options = { iterations: 5, warmups: 1, json: false, out: null };
const files = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  switch (arg) {
    case "--iterations":
      options.iterations = Number(argv[++i]);
      break;
    case "--warmups":
      options.warmups = Number(argv[++i]);
      break;
    case "--json":
      options.json = true;
      break;
    case "--out":
      options.out = argv[++i];
      break;
    default:
      files.push(resolve(arg));
  }
}

const targets = files.length > 0 ? files : collectPrograms(join(root, "benchmarks"));
if (targets.length === 0) {
  process.stderr.write("error: no benchmark programs found\n");
  process.exit(1);
}

const report = benchmarkAll(targets, options);

if (options.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  process.stdout.write(formatReport(report, { baseDir: root }) + "\n");
}

if (options.out) {
  const dir = resolve(options.out);
  mkdirSync(dir, { recursive: true });
  const markdownPath = join(dir, "benchmark.md");
  const jsonPath = join(dir, "benchmark.json");
  writeFileSync(markdownPath, formatMarkdown(report, { baseDir: root }) + "\n", "utf8");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(`\nwrote ${markdownPath}\nwrote ${jsonPath}\n`);
}

const broken = report.summary.errors > 0 || report.summary.mismatches > 0;
process.exitCode = broken ? 1 : 0;
