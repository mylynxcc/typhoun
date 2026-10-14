/**
 * Security / sandbox tests.
 *
 * Typhoun programs are untrusted input. These tests assert the documented
 * boundaries: no host capabilities are exposed, imports cannot escape the
 * project root, and every resource limit actually fires.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Code } from "../../src/diagnostics/codes.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSource, runSource, runFile, ExecutionContext } from "../../src/main/index.js";
import { builtinNames } from "../../src/semantic/resolver.js";
import { firstDiagnostic } from "../helpers.js";

function attempt(source, options = {}) {
  const chunks = [];
  try {
    runSource(source, "<sandbox>", {
      limits: options.limits,
      context: new ExecutionContext({
        limits: options.limits,
        now: options.now,
        onOutput: (t) => chunks.push(t),
        onInput: options.onInput ?? (() => ""),
      }),
    });
    return { error: null, output: chunks.join("") };
  } catch (err) {
    return { error: err, output: chunks.join("") };
  }
}

describe("security: capability exposure", () => {
  const forbidden = [
    "eval",
    "require",
    "process",
    "globalThis",
    "Function",
    "system",
    "exec",
    "open",
    "readFile",
    "fetch",
    "http",
    "__proto__",
    "constructor",
  ];

  it("does not define any host capability as a global", () => {
    const globals = builtinNames();
    for (const name of forbidden) {
      assert.equal(globals.has(name), false, `'${name}' must not be a Typhoun global`);
    }
  });

  it("reports host identifiers as undefined variables", () => {
    for (const name of ["eval", "process", "require"]) {
      assert.equal(
        checkSource(`print(${name})`, "<sandbox>").diagnostics.items[0].code,
        Code.UNDEFINED_VARIABLE,
      );
    }
  });

  it("has no reflection or prototype access surface", () => {
    assert.equal(
      checkSource('print(1["constructor"])', "<sandbox>").diagnostics.hasErrors,
      false,
      "indexing a number parses; it must fail at runtime, not by exposing a prototype",
    );
    const { error } = attempt('print(1["constructor"])');
    assert.equal(firstDiagnostic(error).code, Code.TYPE_ERROR);
  });
});

describe("security: resource limits", () => {
  it("enforces the step limit", () => {
    const { error } = attempt("let i = 0\nwhile true { i += 1 }", { limits: { maxSteps: 3000 } });
    assert.equal(firstDiagnostic(error).code, Code.STEP_LIMIT);
  });

  it("enforces the recursion depth limit", () => {
    const { error } = attempt("fn f(n) { return f(n + 1) }\nf(0)", { limits: { maxCallDepth: 32 } });
    assert.equal(firstDiagnostic(error).code, Code.DEPTH_LIMIT);
  });

  it("enforces the output limit", () => {
    const { error } = attempt('while true { print("x") }', {
      limits: { maxOutputChars: 64, maxSteps: 1_000_000 },
    });
    assert.equal(firstDiagnostic(error).code, Code.OUTPUT_LIMIT);
  });

  it("enforces the collection size limit", () => {
    const { error } = attempt("let a = []\nwhile true { push(a, 1) }", {
      limits: { maxCollectionSize: 128, maxSteps: 100_000 },
    });
    assert.equal(firstDiagnostic(error).code, Code.COLLECTION_LIMIT);
  });

  it("enforces the source size limit through the module loader", () => {
    const dir = mkdtempSync(join(tmpdir(), "typhoun-sec-"));
    try {
      const path = join(dir, "big.typ");
      writeFileSync(path, 'print("' + "x".repeat(500) + '")\n');
      let error = null;
      try {
        runFile(path, {
          limits: { maxSourceBytes: 100 },
          context: new ExecutionContext({ onOutput: () => {} }),
        });
      } catch (err) {
        error = err;
      }
      assert.equal(firstDiagnostic(error).code, Code.SOURCE_LIMIT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables input when the host forbids it", () => {
    const { error } = attempt("input()", { limits: { allowInput: false } });
    assert.equal(firstDiagnostic(error).code, Code.BAD_NATIVE_ARGUMENT);
  });
});

describe("security: a handler cannot swallow the sandbox", () => {
  // `catch` recovers from runtime errors. It must not become a way to spend
  // past a limit, or to observe and hide a load failure: those are the floor
  // under an untrusted program, not part of its control flow.
  const guarded = {
    "the step limit": {
      source: 'try { let i = 0\nwhile true { i += 1 } } catch err { print("swallowed") }',
      limits: { maxSteps: 3000 },
      code: Code.STEP_LIMIT,
      quiet: true,
    },
    "the depth limit": {
      source: 'try { fn dive(n) { return dive(n + 1) }\ndive(0) } catch err { print("swallowed") }',
      limits: { maxCallDepth: 32 },
      code: Code.DEPTH_LIMIT,
      quiet: true,
    },
    "the output limit": {
      source: 'try { while true { print("x") } } catch err { print("swallowed") }',
      limits: { maxOutputChars: 64 },
      code: Code.OUTPUT_LIMIT,
    },
    "the collection limit": {
      source: 'try { let a = []\nwhile true { push(a, 1) } } catch err { print("swallowed") }',
      limits: { maxCollectionSize: 128, maxSteps: 100_000 },
      code: Code.COLLECTION_LIMIT,
      quiet: true,
    },
  };

  for (const [name, { source, limits, code, quiet }] of Object.entries(guarded)) {
    it(`passes ${name} straight through a try`, () => {
      const { error, output } = attempt(source, { limits });
      assert.equal(firstDiagnostic(error).code, code);
      assert.equal(output.includes("swallowed"), false, "the handler must not run for a limit");
      if (quiet) assert.equal(output, "", `${name} must stop before printing anything`);
    });
  }

  it("passes the wall-clock limit straight through a try", () => {
    let now = 0;
    const { error, output } = attempt(
      'try { let i = 0\nwhile true { i += 1 } } catch err { print("swallowed") }',
      {
        limits: { maxDurationMs: 50, maxSteps: 100_000_000 },
        now: () => (now += 10),
      },
    );
    assert.equal(firstDiagnostic(error).code, Code.TIME_LIMIT);
    assert.equal(output, "");
  });

  it("never hands a module failure to a handler", () => {
    const dir = mkdtempSync(join(tmpdir(), "typhoun-sec-try-"));
    try {
      const path = join(dir, "main.typ");
      writeFileSync(
        path,
        'try {\n    import "missing.typ"\n    print("inside")\n} catch err {\n    print("caught", err.code)\n}\nprint("after")\n',
        "utf8",
      );
      const chunks = [];
      let error = null;
      try {
        runFile(path, { context: new ExecutionContext({ onOutput: (t) => chunks.push(t) }) });
      } catch (err) {
        error = err;
      }
      assert.equal(firstDiagnostic(error).code, Code.MODULE_NOT_FOUND);
      assert.equal(chunks.join(""), "", "the handler must not see a load failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the handler Typhoun values, not host objects", () => {
    const { error, output } = attempt(
      'try { assert(false, "boom") } catch err { print(type(err), type(err.stack), type(err.location), type(err.help), type(err.phase), type(err.code), type(err.message)) }',
    );
    assert.equal(error, null);
    assert.equal(output, "map array map string string string string\n");
  });

  it("offers nothing more through a caught error than through a diagnostic", () => {
    const { error, output } = attempt(
      'try { let n = 1\nn() } catch err { print(keys(err), keys(err.location), len(err.stack)) }',
    );
    assert.equal(error, null);
    assert.equal(
      output,
      '[\"code\", \"message\", \"phase\", \"location\", \"help\", \"stack\"] [\"file\", \"line\", \"column\"] 0\n',
    );
  });
});

describe("security: nothing escapes as a host exception", () => {
  it("reports internal engine misuse as a Typhoun diagnostic, not a crash", () => {
    // Deeply nested but valid source must not overflow the host stack in the
    // parser for realistic depths.
    const depth = 100;
    const source = "print(" + "1 + ".repeat(depth) + "1)";
    const { output, error } = attempt(source);
    assert.equal(error, null);
    assert.equal(output, `${depth + 1}\n`);
  });
});
