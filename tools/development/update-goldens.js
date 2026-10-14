#!/usr/bin/env node
/**
 * Regenerate the golden fixtures used by tests/integration/golden.test.js.
 *
 * Usage: node tools/development/update-goldens.js
 *
 * Golden files capture the *exact* observable output of the CLI so that any
 * accidental change to tokens, AST rendering or diagnostic formatting is
 * caught by the test suite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const goldenDir = join(root, "tests", "fixtures", "golden");

const CASES = [
  { file: "hello.tokens.txt", argv: ["tokens", join(root, "tests/fixtures/programs/hello.typ")], stream: "stdout" },
  { file: "hello.ast.txt", argv: ["ast", join(root, "tests/fixtures/programs/hello.typ")], stream: "stdout" },
  {
    file: "undefined_variable.diagnostic.txt",
    argv: ["run", "-q", join(root, "tests/fixtures/errors/undefined_variable.typ")],
    stream: "stderr",
  },
  {
    file: "division_by_zero.diagnostic.txt",
    argv: ["run", "-q", join(root, "tests/fixtures/errors/division_by_zero.typ")],
    stream: "stderr",
  },
  {
    file: "malformed_syntax.diagnostic.txt",
    argv: ["check", join(root, "tests/fixtures/errors/malformed_syntax.typ")],
    stream: "stderr",
  },
];

mkdirSync(goldenDir, { recursive: true });

for (const testCase of CASES) {
  const out = [];
  const err = [];
  main(testCase.argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  // Normalize the machine-specific project path so goldens are portable.
  const content = (testCase.stream === "stdout" ? out : err).join("").split(root).join("<root>");
  writeFileSync(join(goldenDir, testCase.file), content, "utf8");
  process.stdout.write(`wrote ${testCase.file} (${content.length} bytes)\n`);
}
