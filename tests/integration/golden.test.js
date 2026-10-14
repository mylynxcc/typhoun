/**
 * Golden tests.
 *
 * Compares exact CLI output for tokens, AST rendering and diagnostics against
 * committed fixtures so formatting regressions are caught immediately.
 *
 * Regenerate with: node tools/development/update-goldens.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const goldenDir = join(here, "..", "fixtures", "golden");

const HELLO = join(root, "tests", "fixtures", "programs", "hello.typ");
const ERRORS = join(root, "tests", "fixtures", "errors");

function runCase(argv, stream) {
  const out = [];
  const err = [];
  main(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return (stream === "stdout" ? out : err).join("").split(root).join("<root>");
}

function golden(name) {
  return readFileSync(join(goldenDir, name), "utf8");
}

const CASES = [
  { name: "hello.tokens.txt", argv: ["tokens", HELLO], stream: "stdout" },
  { name: "hello.ast.txt", argv: ["ast", HELLO], stream: "stdout" },
  {
    name: "undefined_variable.diagnostic.txt",
    argv: ["run", "-q", join(ERRORS, "undefined_variable.typ")],
    stream: "stderr",
  },
  {
    name: "division_by_zero.diagnostic.txt",
    argv: ["run", "-q", join(ERRORS, "division_by_zero.typ")],
    stream: "stderr",
  },
  {
    name: "malformed_syntax.diagnostic.txt",
    argv: ["check", join(ERRORS, "malformed_syntax.typ")],
    stream: "stderr",
  },
];

describe("golden: CLI output", () => {
  for (const testCase of CASES) {
    it(`matches the committed golden file ${testCase.name}`, () => {
      assert.equal(runCase(testCase.argv, testCase.stream), golden(testCase.name));
    });
  }
});
