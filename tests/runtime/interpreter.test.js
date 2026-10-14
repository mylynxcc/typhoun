/**
 * Stage F — Runtime / interpreter tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Code } from "../../src/diagnostics/codes.js";
import { outputOf, expectFailure, firstDiagnostic, execute, runSource } from "../helpers.js";

describe("runtime: arithmetic", () => {
  it("evaluates the four operations and remainder", () => {
    assert.equal(outputOf("print(7 + 3, 7 - 3, 7 * 3, 7 / 2, 7 % 3)"), "10 4 21 3.5 1\n");
  });

  it("respects precedence and parentheses", () => {
    assert.equal(outputOf("print(2 + 3 * 4, (2 + 3) * 4)"), "14 20\n");
  });

  it("uses IEEE-754 double precision", () => {
    assert.equal(outputOf("print(0.1 + 0.2)"), "0.30000000000000004\n");
  });

  it("supports unary negation", () => {
    assert.equal(outputOf("let a = 5\nprint(-a)"), "-5\n");
  });

  it("rejects arithmetic on mismatched types", () => {
    const err = expectFailure('print(1 + "1")');
    assert.equal(firstDiagnostic(err).code, Code.TYPE_ERROR);
  });

  it("refuses to silently coerce strings in comparisons", () => {
    assert.equal(outputOf('print(1 == "1")'), "false\n");
  });

  it("joins two strings with +", () => {
    assert.equal(outputOf('print("a" + "b")'), "ab\n");
  });

  it("raises a runtime error on division by zero", () => {
    const err = expectFailure("print(1 / 0)");
    assert.equal(firstDiagnostic(err).code, Code.DIVISION_BY_ZERO);
  });

  it("raises a runtime error on modulo by zero", () => {
    const err = expectFailure("print(1 % 0)");
    assert.equal(firstDiagnostic(err).code, Code.DIVISION_BY_ZERO);
  });
});

describe("runtime: values and truthiness", () => {
  it("prints every type distinctly", () => {
    assert.equal(
      outputOf('print(1, 1.5, "s", true, false, null, [1, "a"], { "k": 1 })'),
      '1 1.5 s true false null [1, "a"] {"k": 1}\n',
    );
  });

  it("treats only false and null as falsy", () => {
    assert.equal(
      outputOf('print(bool(0), bool(""), bool([]), bool(null), bool(false))'),
      "true true true false false\n",
    );
  });

  it("returns null for a missing map key", () => {
    assert.equal(outputOf('let m = {}\nprint(m["nope"])'), "null\n");
  });

  it("distinguishes Typhoun null from an absent value", () => {
    assert.equal(outputOf("print(type(null))"), "null\n");
  });

  it("compares arrays and maps structurally", () => {
    assert.equal(outputOf("print([1, [2]] == [1, [2]], [1] == [2])"), "true false\n");
  });

  it("does not call two distinct functions equal", () => {
    assert.equal(outputOf("fn a() { return 1 }\nfn b() { return 1 }\nprint(a == b, a == a)"), "false true\n");
  });
});

describe("runtime: control flow", () => {
  it("runs if / else if / else", () => {
    const source = `
      fn grade(n) {
        if n >= 90 { return "A" }
        else if n >= 70 { return "B" }
        else { return "C" }
      }
      print(grade(95), grade(80), grade(10))
    `;
    assert.equal(outputOf(source), "A B C\n");
  });

  it("short-circuits logical operators", () => {
    const source = `
      fn boom() { assert(false, "should not run") }
      print(false and boom())
      print(true or boom())
    `;
    assert.equal(outputOf(source), "false\ntrue\n");
  });

  it("returns the operand value from logical operators", () => {
    assert.equal(outputOf('print(null or "fallback", "first" and "second")'), "fallback second\n");
  });

  it("supports while with break and continue", () => {
    const source = `
      let i = 0
      let evens = []
      while i < 10 {
        i += 1
        if i % 2 != 0 { continue }
        if i > 6 { break }
        push(evens, i)
      }
      print(evens)
    `;
    assert.equal(outputOf(source), "[2, 4, 6]\n");
  });

  it("iterates arrays, strings and map keys with for-in", () => {
    const source = `
      let out = ""
      for item in ["a", "b"] { out += item }
      for ch in "xy" { out += ch }
      for k in { "n": 1 } { out += k }
      print(out)
    `;
    assert.equal(outputOf(source), "abxyn\n");
  });

  it("runs C-style for loops", () => {
    assert.equal(outputOf("for (let i = 3; i > 0; i -= 1) { print(i) }"), "3\n2\n1\n");
  });
});

describe("runtime: scoping and closures", () => {
  it("uses block scope", () => {
    const source = `
      let a = 1
      { let a = 2
        print(a) }
      print(a)
    `;
    assert.equal(outputOf(source), "2\n1\n");
  });

  it("captures lexical environments in closures", () => {
    const source = `
      fn counter(start) {
        let n = start
        return fn (step) { n += step
          return n }
      }
      let c = counter(0)
      print(c(1), c(2), c(3))
      let d = counter(100)
      print(c(1), d(1))
    `;
    assert.equal(outputOf(source), "1 3 6\n7 101\n");
  });

  it("supports recursion and mutual recursion", () => {
    const source = `
      fn fib(n) { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }
      fn even(n) { if n == 0 { return true } return odd(n - 1) }
      fn odd(n) { if n == 0 { return false } return even(n - 1) }
      print(fib(15), even(10), odd(7))
    `;
    assert.equal(outputOf(source), "610 true true\n");
  });

  it("enforces argument counts", () => {
    const err = expectFailure("fn one(a) { return a }\nprint(one())");
    assert.equal(firstDiagnostic(err).code, Code.ARITY_MISMATCH);
  });

  it("fails when calling a non-function", () => {
    const err = expectFailure("let x = 1\nprint(x())");
    assert.equal(firstDiagnostic(err).code, Code.NOT_CALLABLE);
  });

  it("reports a call stack for nested failures", () => {
    const err = expectFailure(
      'fn inner() { return 1 / 0 }\nfn outer() { return inner() }\nprint(outer())',
    );
    const diagnostic = firstDiagnostic(err);
    assert.equal(diagnostic.code, Code.DIVISION_BY_ZERO);
    assert.ok(diagnostic.stack.length >= 1, "expected a Typhoun call stack");
    assert.ok(diagnostic.stack.some((f) => f.startsWith("inner")));
  });
});

describe("runtime: collections", () => {
  it("indexes arrays from zero and reports bounds errors", () => {
    assert.equal(outputOf("let a = [10, 20]\nprint(a[0], a[1])"), "10 20\n");
    const err = expectFailure("let a = [1]\nprint(a[5])");
    assert.equal(firstDiagnostic(err).code, Code.INDEX_OUT_OF_BOUNDS);
  });

  it("rejects non-integer and negative indices", () => {
    assert.equal(firstDiagnostic(expectFailure('let a = [1]\nprint(a["0"])')).code, Code.INVALID_INDEX_TYPE);
    assert.equal(firstDiagnostic(expectFailure("let a = [1]\nprint(a[-1])")).code, Code.INDEX_OUT_OF_BOUNDS);
  });

  it("mutates arrays and maps through indexing", () => {
    assert.equal(outputOf('let a = [1, 2]\na[0] = 9\nlet m = {}\nm["k"] = 5\nprint(a, m)'), '[9, 2] {"k": 5}\n');
  });

  it("supports compound assignment on elements", () => {
    assert.equal(outputOf("let a = [1]\na[0] += 4\nprint(a[0])"), "5\n");
  });

  it("indexes strings", () => {
    assert.equal(outputOf('print("typhoun"[0], len("typhoun"))'), "t 7\n");
  });

  it("refuses to mutate strings", () => {
    const err = expectFailure('let s = "abc"\ns[0] = "z"');
    assert.equal(firstDiagnostic(err).code, Code.TYPE_ERROR);
  });

  it("nests arrays and maps", () => {
    assert.equal(
      outputOf('let g = { "rows": [[1, 2], [3, 4]] }\nprint(g["rows"][1][0])'),
      "3\n",
    );
  });
});

describe("runtime: built-ins", () => {
  it("implements the core standard library", () => {
    const source = `
      print(len("abc"), len([1,2,3]), len({ "a": 1 }))
      print(type(1), type("s"), type(true), type(null), type([]), type({}), type(print))
      print(str(12) + "!", num("42") + 1, bool(null))
      let r = range(1, 4)
      print(r, range(3))
      let a = [1]
      push(a, 2)
      print(a, pop(a), a)
      let m = { "x": 1, "y": 2 }
      print(keys(m), values(m), has(m, "x"), has(m, "z"))
      remove(m, "x")
      print(keys(m))
    `;
    assert.equal(
      outputOf(source),
      "3 3 1\nnumber string boolean null array map function\n12! 43 false\n[1, 2, 3] [0, 1, 2]\n[1] 2 [1]\n[\"x\", \"y\"] [1, 2] true false\n[\"y\"]\n",
    );
  });

  it("implements string and math helpers", () => {
    const source = `
      print(join(["a","b"], "-"), split("a-b", "-"), upper("ab"), lower("AB"), trim("  x  "))
      print(contains("hello", "ell"), contains([1,2], 2))
      print(abs(-3), floor(2.7), ceil(2.1), round(2.5), sqrt(16), pow(2, 10))
      print(min(3, 1), max([4, 9]), min([5, 2]))
    `;
    assert.equal(
      outputOf(source),
      "a-b [\"a\", \"b\"] AB ab x\ntrue true\n3 2 3 3 4 1024\n1 9 2\n",
    );
  });

  it("produces a pseudo-random number in range", () => {
    const out = outputOf("print(random() >= 0 and random() < 1)");
    assert.equal(out, "true\n");
  });

  it("validates built-in argument types", () => {
    assert.equal(firstDiagnostic(expectFailure("print(len(1))")).code, Code.BAD_NATIVE_ARGUMENT);
    assert.equal(firstDiagnostic(expectFailure('print(num("abc"))')).code, Code.BAD_NATIVE_ARGUMENT);
    assert.equal(firstDiagnostic(expectFailure("print(pop([]))")).code, Code.BAD_NATIVE_ARGUMENT);
  });

  it("captures input through the input channel", () => {
    const { output } = execute('let name = input("who? ")\nprint("hi " + name)', {
      onInput: () => "Jay",
    });
    assert.equal(output, "who? hi Jay\n");
  });

  it("rejects input when it is disabled", () => {
    const err = expectFailure("input()", { limits: { allowInput: false } });
    assert.equal(firstDiagnostic(err).code, Code.BAD_NATIVE_ARGUMENT);
  });
});

describe("runtime: resource limits", () => {
  it("stops a runaway loop at the step limit", () => {
    const err = expectFailure("let i = 0\nwhile true { i += 1 }", { limits: { maxSteps: 5000 } });
    assert.equal(firstDiagnostic(err).code, Code.STEP_LIMIT);
  });

  it("stops runaway recursion at the depth limit", () => {
    const err = expectFailure("fn dive(n) { return dive(n + 1) }\nprint(dive(0))", {
      limits: { maxCallDepth: 64 },
    });
    assert.equal(firstDiagnostic(err).code, Code.DEPTH_LIMIT);
  });

  it("stops excessive output at the output limit", () => {
    const err = expectFailure('while true { print("x") }', {
      limits: { maxOutputChars: 100, maxSteps: 1_000_000 },
    });
    assert.equal(firstDiagnostic(err).code, Code.OUTPUT_LIMIT);
  });

  it("enforces the wall-clock limit", () => {
    let now = 0;
    const err = expectFailure("let i = 0\nwhile true { i += 1 }", {
      limits: { maxDurationMs: 50, maxSteps: 100_000_000 },
      now: () => (now += 10),
    });
    assert.equal(firstDiagnostic(err).code, Code.TIME_LIMIT);
  });
});

describe("runtime: try/catch", () => {
  it("runs the guarded block and skips the handler when nothing fails", () => {
    assert.equal(outputOf('try { print("ok") } catch err { print("boom") }'), "ok\n");
  });

  it("catches a failure and carries on after the statement", () => {
    assert.equal(
      outputOf('try { print(1 / 0) } catch err { print("caught") }\nprint("after")'),
      "caught\nafter\n",
    );
  });

  it("binds the failure as a map, so the program can inspect it", () => {
    const source = [
      "try {",
      "const a = [1]",
      "print(a[3])",
      "} catch err {",
      "print(type(err), type(err.location), type(err.stack))",
      'print(err.code, err.phase, has(err, "message"))',
      "print(err.location.line, err.location.column)",
      'print(err.message, "|", err.help)',
      "}",
    ].join("\n");
    assert.equal(
      outputOf(source),
      "map map array\n" +
        "TYP4005 runtime true\n" +
        "3 7\n" +
        "Index 3 is out of bounds for length 1 | Valid indices are 0 through 0.\n",
    );
  });

  it("carries the code and message of the diagnostic that would have been reported", () => {
    const diagnostic = firstDiagnostic(expectFailure("let a = [1]\nprint(a[3])"));
    assert.equal(
      outputOf(
        'try { let a = [1]\nprint(a[3]) } catch err { print(err.code + ": " + err.message) }',
      ),
      `${diagnostic.code}: ${diagnostic.message}\n`,
    );
  });

  it("records the call stack innermost first", () => {
    const source = [
      "fn c() { return 1 / 0 }",
      "fn b() { return c() }",
      "fn a() { return b() }",
      "try { a() } catch err {",
      "print(len(err.stack))",
      "for frame in err.stack { print(frame) }",
      "}",
    ].join("\n");
    // Each frame names where its call was written; the innermost call sits in
    // `b`, so `c` reports the line of `c()`.
    assert.equal(outputOf(source), "3\nc (<test>:2:17)\nb (<test>:3:17)\na (<test>:4:7)\n");
  });

  it("catches every runtime error family", () => {
    const cases = {
      [Code.DIVISION_BY_ZERO]: "try { print(1 / 0) } catch err { print(err.code) }",
      [Code.TYPE_ERROR]: 'try { print(1 + "x") } catch err { print(err.code) }',
      [Code.INDEX_OUT_OF_BOUNDS]: "try { let a = [1]\nprint(a[9]) } catch err { print(err.code) }",
      [Code.NOT_CALLABLE]: "try { let n = 1\nn() } catch err { print(err.code) }",
      [Code.ARITY_MISMATCH]: "fn one(a) { return a }\ntry { one() } catch err { print(err.code) }",
      [Code.BAD_NATIVE_ARGUMENT]: "try { print(len(1)) } catch err { print(err.code) }",
      [Code.UNCAUGHT_ERROR]: 'try { assert(false, "no") } catch err { print(err.code) }',
    };
    for (const [code, source] of Object.entries(cases)) {
      assert.equal(outputOf(source), `${code}\n`, source);
    }
  });

  it("runs the innermost handler, and lets an outer one take what the inner re-fails", () => {
    const source = [
      "fn risky() { return 1 / 0 }",
      "try {",
      'try { risky() } catch inner { print("inner:", inner.code)',
      "risky() }",
      '} catch outer { print("outer:", outer.code) }',
      'print("still running")',
    ].join("\n");
    assert.equal(
      outputOf(source),
      "inner: TYP4002\nouter: TYP4002\nstill running\n",
    );
  });

  it("abandons the failing call stack but keeps the state it already changed", () => {
    const source = [
      "let seen = []",
      "try {",
      "push(seen, 1)",
      'assert(false, "stop")',
      "push(seen, 2)",
      "} catch err {",
      "print(len(err.stack))",
      "push(seen, 3)",
      "}",
      "print(seen)",
    ].join("\n");
    // A failure at the top level has no calls to report.
    assert.equal(outputOf(source), "0\n[1, 3]\n");
  });

  it("passes return, break and continue out of the statement untouched", () => {
    assert.equal(
      outputOf('fn f() { try { return "from try" } catch err { return "from catch" } }\nprint(f())'),
      "from try\n",
    );
    assert.equal(
      outputOf(
        'let out = []\nfor i in [1, 2, 3, 4] {\n  try {\n    if i == 2 { continue }\n    if i == 4 { break }\n    push(out, i)\n  } catch err { print("never") }\n}\nprint(out)',
      ),
      "[1, 3]\n",
    );
  });

  it("keeps going round the loop after a failure", () => {
    const source = [
      "let total = 0",
      "for n in [1, 0, 2] {",
      'try { total += 10 / n } catch err { print("skipped:", err.code) }',
      "}",
      "print(total)",
    ].join("\n");
    assert.equal(outputOf(source), "skipped: TYP4002\n15\n");
  });

  it("stores the error value in collections and passes it to functions", () => {
    const source = [
      "fn describe(problem) { return problem.code + \" at line \" + str(problem.location.line) }",
      "let log = []",
      "for n in [1, 0] {",
      "try { print(10 / n) } catch err { push(log, err) }",
      "}",
      'print(len(log), describe(log[0]), len(keys(log[0])))',
    ].join("\n");
    assert.equal(outputOf(source), "10\n1 TYP4002 at line 4 6\n");
  });

  it("does not catch the sandbox's own limits", () => {
    const chunks = [];
    let step = null;
    try {
      runSource('try { let i = 0\nwhile true { i += 1 } } catch err { print("swallowed") }', "<test>", {
        limits: { maxSteps: 5000 },
        onOutput: (text) => chunks.push(text),
      });
    } catch (err) {
      step = err;
    }
    assert.equal(firstDiagnostic(step).code, Code.STEP_LIMIT);
    assert.equal(chunks.join(""), "", "a limit must not reach the handler");

    const depth = expectFailure(
      'try { fn dive(n) { return dive(n + 1) }\ndive(0) } catch err { print("swallowed") }',
      { limits: { maxCallDepth: 64 } },
    );
    assert.equal(firstDiagnostic(depth).code, Code.DEPTH_LIMIT);

    const output = expectFailure('try { while true { print("x") } } catch err { print("swallowed") }', {
      limits: { maxOutputChars: 100, maxSteps: 1_000_000 },
    });
    assert.equal(firstDiagnostic(output).code, Code.OUTPUT_LIMIT);
  });

  it("does not leave a handler armed for a later failure", () => {
    const err = expectFailure(
      'try { print(1 / 0) } catch e { print("caught") }\nprint(1 / 0)',
    );
    assert.equal(firstDiagnostic(err).code, Code.DIVISION_BY_ZERO);
    assert.equal(firstDiagnostic(err).location.line, 2);
  });
});
