/**
 * Module system tests — resolution, caching, exports, cycles and boundaries.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Code } from "../../src/diagnostics/codes.js";
import { checkFile, runFile, ExecutionContext } from "../../src/main/index.js";
import { fixture, firstDiagnostic, runFixture } from "../helpers.js";

function runCatching(path, options) {
  try {
    return { ...runFixture(path, options), error: null };
  } catch (err) {
    return { output: "", error: err };
  }
}

describe("modules: import forms", () => {
  it("merges exports for a bare import and binds a namespace for `as`", () => {
    const { output, error } = runCatching(fixture("modules", "app.typ"));
    assert.equal(error, null);
    assert.equal(
      output,
      "hello from util\n42\n15\n8\n",
    );
  });

  it("executes a shared module only once", () => {
    const chunks = [];
    const result = runFile(fixture("modules", "app.typ"), {
      context: new ExecutionContext({ onOutput: (t) => chunks.push(t) }),
    });
    // Both imports resolve to the same absolute path.
    assert.equal(result.loader.cache.size, 1);
  });

  it("exposes module exports for tooling", () => {
    const { loader } = runFile(fixture("modules", "app.typ"), {
      context: new ExecutionContext({ onOutput: () => {} }),
    });
    const exports = loader.exportsOf(fixture("modules", "util.typ"));
    assert.deepEqual(exports.sort(), ["GREETING", "double", "makeAdder"]);
  });

  it("allows a module to be checked without executing it", () => {
    const { ok, diagnostics } = checkFile(fixture("modules", "app.typ"));
    assert.equal(ok, true);
    assert.equal(diagnostics.length, 0);
  });
});

describe("modules: safety", () => {
  it("rejects imports that escape the project root", () => {
    const { error } = runCatching(fixture("errors", "escape_import.typ"));
    assert.equal(firstDiagnostic(error).code, Code.MODULE_OUT_OF_BOUNDS);
  });

  it("detects import cycles", () => {
    const { error } = runCatching(fixture("errors", "import_cycle_a.typ"));
    assert.equal(firstDiagnostic(error).code, Code.IMPORT_CYCLE);
  });

  it("requires the .typ extension on import specifiers", () => {
    const { error } = runCatching(fixture("errors", "no_extension.typ"));
    const diagnostic = firstDiagnostic(error);
    assert.equal(diagnostic.code, Code.MODULE_NOT_FOUND);
    assert.match(diagnostic.message, /\.typ/);
  });

  it("reports a module that does not exist", () => {
    const { error } = runCatching(fixture("errors", "missing_module.typ"));
    assert.equal(firstDiagnostic(error).code, Code.MODULE_NOT_FOUND);
  });
});
