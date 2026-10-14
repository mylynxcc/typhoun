/**
 * Stage 7 — CLI tests.
 *
 * Most cases call `main()` directly with captured streams (fast, precise).
 * One case spawns the real `bin/typhoun.js` executable to prove the shipped
 * entry point works end to end.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { main, EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "../../src/cli/cli.js";
import { fixture } from "../helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "..", "bin", "typhoun.js");

function runCli(argv) {
  const out = [];
  const err = [];
  const code = main(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("cli: version and help", () => {
  it("prints the version", () => {
    const { code, stdout } = runCli(["version"]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /Typhoun \d+\.\d+\.\d+/);
    assert.match(stdout, /\.typ/);
  });

  it("prints usage for help", () => {
    const { code, stdout } = runCli(["help"]);
    assert.equal(code, EXIT_OK);
    for (const command of ["run", "check", "tokens", "ast", "version", "help"]) {
      assert.ok(stdout.includes(command), `usage should mention '${command}'`);
    }
  });

  it("returns a usage exit code for unknown commands", () => {
    const { code, stderr } = runCli(["frobnicate"]);
    assert.equal(code, EXIT_USAGE);
    assert.match(stderr, /unknown command/);
  });

  it("rejects unknown options", () => {
    const { code } = runCli(["run", "--nope"]);
    assert.equal(code, EXIT_USAGE);
  });
});

describe("cli: run", () => {
  it("executes a program and prints its output", () => {
    const { code, stdout } = runCli(["run", "-q", fixture("programs", "hello.typ")]);
    assert.equal(code, EXIT_OK);
    assert.equal(stdout, "Hello, Typhoun!\n7\n");
  });

  it("reports a runtime failure with a nonzero exit code", () => {
    const { code, stderr } = runCli(["run", "-q", fixture("errors", "division_by_zero.typ")]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stderr, /error\[TYP4002\]/);
    assert.match(stderr, /Division by zero/);
  });

  it("reports semantic failures before execution", () => {
    const { code, stderr } = runCli(["run", "-q", fixture("errors", "undefined_variable.typ")]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stderr, /error\[TYP3001\]/);
    assert.match(stderr, /Undefined variable 'username'/);
  });

  it("stops an infinite loop via the step limit", () => {
    const { code, stderr } = runCli([
      "run",
      "-q",
      "--max-steps",
      "20000",
      fixture("errors", "infinite_loop.typ"),
    ]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stderr, /error\[TYP6001\]/);
  });

  it("stops runaway recursion via the depth limit", () => {
    const { code, stderr } = runCli([
      "run",
      "-q",
      "--max-depth",
      "64",
      fixture("errors", "deep_recursion.typ"),
    ]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stderr, /error\[TYP6002\]/);
  });

  it("fails cleanly when the file does not exist", () => {
    const { code, stderr } = runCli(["run", "-q", fixture("programs", "nope.typ")]);
    assert.equal(code, EXIT_USAGE);
    assert.match(stderr, /file not found/);
  });
});

describe("cli: check", () => {
  it("reports a clean file", () => {
    const { code, stdout } = runCli(["check", fixture("programs", "hello.typ")]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /no problems found/);
  });

  it("fails on a malformed program", () => {
    const { code, stderr } = runCli(["check", fixture("errors", "malformed_syntax.typ")]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stderr, /error\[TYP/);
  });

  it("emits JSON diagnostics on request", () => {
    const { code, stderr } = runCli(["check", "--json", fixture("errors", "undefined_variable.typ")]);
    assert.equal(code, EXIT_FAILURE);
    const parsed = JSON.parse(stderr);
    assert.equal(parsed[0].code, "TYP3001");
    assert.equal(parsed[0].phase, "semantic");
  });
});

describe("cli: tokens and ast", () => {
  it("prints tokens with positions", () => {
    const { code, stdout } = runCli(["tokens", fixture("programs", "hello.typ")]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /2:\s+1\s+CONST/);
    assert.match(stdout, /EOF/);
  });

  it("prints a readable AST", () => {
    const { code, stdout } = runCli(["ast", fixture("programs", "hello.typ")]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /^Program/);
    assert.match(stdout, /FnDecl|Call/);
  });
});

describe("cli: shipped executable", () => {
  it("runs through the real bin/typhoun.js entry point", () => {
    const stdout = execFileSync(process.execPath, [BIN, "run", "-q", fixture("programs", "hello.typ")], {
      encoding: "utf8",
    });
    assert.equal(stdout, "Hello, Typhoun!\n7\n");
  });

  it("returns a nonzero exit code through the real executable", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [BIN, "run", "-q", fixture("errors", "division_by_zero.typ")], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      status = err.status;
      assert.match(String(err.stderr), /TYP4002/);
    }
    assert.equal(status, 1);
  });
});
