#!/usr/bin/env node
/**
 * Typhoun release helper.
 *
 * Usage: node tools/release/build-release.js [--no-archive]
 *
 * Steps:
 *   1. read VERSION
 *   2. run the automated test suite
 *   3. execute every example program
 *   4. write dist/release-report.md
 *   5. (optional) create dist/typhoun-<version>.tar.gz from the tracked files
 *
 * Exits nonzero if the tests or the examples fail, so it is safe to use as a
 * gate in CI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const distDir = join(root, "dist");

const version = readFileSync(join(root, "VERSION"), "utf8").trim();
const withArchive = !process.argv.includes("--no-archive");

function sh(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

const report = [];
report.push(`# Typhoun release report`);
report.push("");
report.push(`- version: **${version}**`);
report.push(`- generated: ${new Date().toISOString()}`);
report.push(`- node: ${process.version}`);
report.push(`- platform: ${process.platform} ${process.arch}`);
report.push("");

let failed = false;

// 1. Test suite ------------------------------------------------------------
report.push("## Automated tests");
report.push("");
let testOutput = "";
try {
  testOutput = sh(process.execPath, ["--test"]);
} catch (err) {
  testOutput = String(err.stdout ?? "") + String(err.stderr ?? "");
  failed = true;
}
const testTail = testOutput.trim().split("\n").slice(-8).join("\n");
report.push("```");
report.push(testTail || "(no output)");
report.push("```");
report.push("");
report.push(failed ? "**RESULT: tests failed.**" : "RESULT: tests passed.");
report.push("");

// 2. Examples --------------------------------------------------------------
report.push("## Example programs");
report.push("");
let examplesOutput = "";
try {
  examplesOutput = sh(process.execPath, [join("tools", "development", "run-examples.js")]);
} catch (err) {
  examplesOutput = String(err.stdout ?? "") + String(err.stderr ?? "");
  failed = true;
}
report.push("```");
report.push(examplesOutput.trim() || "(no output)");
report.push("```");
report.push("");

// 3. Write artifacts -------------------------------------------------------
mkdirSync(distDir, { recursive: true });
const reportPath = join(distDir, "release-report.md");
writeFileSync(reportPath, report.join("\n"), "utf8");
process.stdout.write(`wrote ${reportPath}\n`);

if (withArchive) {
  const archive = join(distDir, `typhoun-${version}.tar.gz`);
  const includes = [
    "bin",
    "src",
    "docs",
    "examples",
    "tools",
    "tests",
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "VERSION",
  ];
  try {
    sh("tar", ["-czf", archive, ...includes]);
    process.stdout.write(`wrote ${archive}\n`);
  } catch (err) {
    process.stdout.write(`archive skipped: ${err.message}\n`);
  }
}

process.stdout.write(failed ? "release gate: FAILED\n" : "release gate: OK\n");
process.exitCode = failed ? 1 : 0;
