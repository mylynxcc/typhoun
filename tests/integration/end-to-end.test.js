/**
 * End-to-end tests.
 *
 * Every program listed in the release requirements is executed by the real
 * interpreter. Example programs must succeed and produce meaningful output;
 * error programs must fail with the documented diagnostic code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Code } from "../../src/diagnostics/codes.js";
import { runFixture, firstDiagnostic } from "../helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(here, "..", "..", "examples");

function run(path, options) {
  try {
    return { ...runFixture(path, options), error: null };
  } catch (err) {
    return { output: "", error: err };
  }
}

describe("end-to-end: example programs", () => {
  it("1. hello world", () => {
    const { output, error } = run(join(EXAMPLES, "hello.typ"));
    assert.equal(error, null);
    assert.match(output, /Hello, World!/);
    assert.match(output, /Hello, Typhoun!/);
    assert.match(output, /2 \+ 3 \* 4 = 14/);
  });

  it("2. arithmetic calculator", () => {
    const { output, error } = run(join(EXAMPLES, "calculator.typ"));
    assert.equal(error, null);
    assert.match(output, /a \+ b = 17/);
    assert.match(output, /a \/ b = 2\.4/);
    assert.match(output, /average -> 8\.5/);
  });

  it("3. FizzBuzz", () => {
    const { output, error } = run(join(EXAMPLES, "fizzbuzz.typ"));
    assert.equal(error, null);
    const lines = output.trim().split("\n");
    assert.equal(lines[0], "1");
    assert.equal(lines[2], "Fizz");
    assert.equal(lines[4], "Buzz");
    assert.equal(lines[14], "FizzBuzz");
  });

  it("4. factorial using recursion", () => {
    const { output, error } = run(join(EXAMPLES, "factorial.typ"));
    assert.equal(error, null);
    assert.match(output, /factorial\(5\) = 120/);
    assert.match(output, /assertion check: true/);
  });

  it("5. Fibonacci", () => {
    const { output, error } = run(join(EXAMPLES, "fibonacci.typ"));
    assert.equal(error, null);
    assert.match(output, /recursive: \[0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89\]/);
    assert.match(output, /f\(40\) iteratively is 102334155/);
  });

  it("6. array iteration", () => {
    const { output, error } = run(join(EXAMPLES, "arrays.typ"));
    assert.equal(error, null);
    assert.match(output, /length: 3/);
    assert.match(output, /sum of 1\.\.5 = 15/);
    assert.match(output, /grid\[2\]\[1\] = 6/);
  });

  it("7. map access", () => {
    const { output, error } = run(join(EXAMPLES, "maps.typ"));
    assert.equal(error, null);
    assert.match(output, /name: Jay/);
    assert.match(output, /missing key: null/);
    assert.match(output, /updated level: 8/);
  });

  it("8. closure demonstration", () => {
    const { output, error } = run(join(EXAMPLES, "functions.typ"));
    assert.equal(error, null);
    assert.match(output, /^11\n13\n18\n19\n101\n/m);
    assert.match(output, /isEven\(10\): true/);
  });

  it("9. multi-file module import", () => {
    const { output, error } = run(join(EXAMPLES, "modules", "main.typ"));
    assert.equal(error, null);
    assert.match(output, /add\(10, 20\) = 30/);
    assert.match(output, /via namespace: 42/);
  });

  it("10. runtime error handling with try/catch", () => {
    const { output, error } = run(join(EXAMPLES, "error-handling.typ"));
    assert.equal(error, null, "a caught failure must not end the program");
    // A failure the program raised itself, and one the runtime detected.
    assert.match(output, /between 3: 4/);
    assert.match(output, /caught TYP4010: cannot split 12 between 0 people/);
    assert.match(output, /caught TYP4005: Index 4 is out of bounds for length 3/);
    assert.match(output, /help: Valid indices are 0 through 2\./);
    // The handler decides, and the loop continues with the next row.
    assert.match(output, /doubled: 8\nskipped a row: TYP4001\ndoubled: 18/);
    // A failure inside a handler belongs to the handler around it.
    assert.match(output, /inner caught TYP4010: the inner failure/);
    assert.match(output, /outer caught TYP4010: the inner failure/);
    // The error value carries the call stack, innermost frame first.
    assert.match(output, /2 frame\(s\)/);
    assert.match(output, / - toNumber \(\S*error-handling\.typ:\d+:\d+\)/);
    assert.match(output, / - sum \(\S*error-handling\.typ:\d+:\d+\)/);
    assert.match(output, /^done$/m);
  });
});

describe("end-to-end: failure programs", () => {
  it("11. deliberately malformed syntax", () => {
    const { error } = run(join(here, "..", "fixtures", "errors", "malformed_syntax.typ"));
    const diagnostic = firstDiagnostic(error);
    assert.ok(diagnostic, "expected a diagnostic");
    assert.ok(diagnostic.code.startsWith("TYP2"), `expected a syntax code, got ${diagnostic.code}`);
  });

  it("12. undefined-variable error", () => {
    const { error } = run(join(here, "..", "fixtures", "errors", "undefined_variable.typ"));
    const diagnostic = firstDiagnostic(error);
    assert.equal(diagnostic.code, Code.UNDEFINED_VARIABLE);
    assert.equal(diagnostic.location.line, 3);
    assert.equal(diagnostic.location.column, 7);
    assert.match(diagnostic.message, /username/);
  });

  it("13. division-by-zero error", () => {
    const { error } = run(join(here, "..", "fixtures", "errors", "division_by_zero.typ"));
    assert.equal(firstDiagnostic(error).code, Code.DIVISION_BY_ZERO);
  });

  it("14. infinite-loop limit test", () => {
    const { error } = run(join(here, "..", "fixtures", "errors", "infinite_loop.typ"), {
      limits: { maxSteps: 10_000 },
    });
    assert.equal(firstDiagnostic(error).code, Code.STEP_LIMIT);
  });

  it("15. sandbox restriction test — imports cannot escape the root", () => {
    const { error } = run(join(here, "..", "fixtures", "errors", "escape_import.typ"));
    assert.equal(firstDiagnostic(error).code, Code.MODULE_OUT_OF_BOUNDS);
  });
});
