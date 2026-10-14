/**
 * Cross-engine parity tests.
 *
 * Typhoun has two independent execution backends: the tree-walking interpreter
 * (Stage F) and the bytecode virtual machine (Stage F₂). A language with two
 * runtimes needs a contract that says they agree; these tests are that
 * contract. Every case is executed on both engines and the observable result —
 * standard output, and the diagnostic code, message and stack depth of a
 * failure — must be identical.
 *
 * The corpus deliberately mixes ordinary programs with every documented failure
 * mode, because "the two engines produce the same error" is as much a part of
 * the contract as "the two engines produce the same number".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ExecutionContext, runFile } from "../../src/main/index.js";
import { Code } from "../../src/diagnostics/codes.js";
import { fixture, runOnBothEngines } from "../helpers.js";

/** Assert both engines agree; returns the shared result. */
function agree(source, options = {}) {
  const results = runOnBothEngines(source, options);
  assert.deepEqual(
    results.vm,
    results.tree,
    `engines diverged for:\n${source}\n tree: ${JSON.stringify(results.tree)}\n   vm: ${JSON.stringify(results.vm)}`,
  );
  return results.tree;
}

function collect(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collect(full);
    return entry.endsWith(".typ") ? [full] : [];
  });
}

describe("parity: language semantics", () => {
  const programs = {
    "arithmetic and precedence": "print(2 + 3 * 4 - 6 / 2, (2 + 3) * 4, 7 % 3, -5)",
    "string concatenation": 'let a = "ty" + "phoun"\nprint(a, len(a))',
    "booleans and null": "print(true, false, null, bool(0), bool([]), type(null))",
    "deep equality": 'print([1, [2]] == [1, [2]], { "a": 1 } == { "a": 1 }, [1] == [2])',
    "logical operator values": 'print(false and 1, true or 2, null or "y", 0 and 7)',
    "if/else if/else": `
fn grade(n) {
  if n >= 90 { return "A" }
  else if n >= 70 { return "B" }
  else { return "C" }
}
print(grade(95), grade(80), grade(10))`,
    "while with break/continue": `
let i = 0
let seen = []
while i < 10 {
  i += 1
  if i % 2 != 0 { continue }
  if i > 6 { break }
  push(seen, i)
}
print(seen)`,
    "c-style for with continue": `
let out = ""
for (let i = 0; i < 6; i += 1) {
  if i == 3 { continue }
  out += str(i)
}
print(out)`,
    "for-in over every iterable": `
let out = ""
for a in [1, 2] { out += str(a) }
for ch in "xy" { out += ch }
for k in { "n": 1, "m": 2 } { out += k }
print(out)`,
    "nested loops with labeled unwinding": `
let hits = 0
for i in range(0, 3) {
  for j in range(0, 3) {
    if j == 1 { continue }
    if i == 2 { break }
    hits += 1
  }
}
print(hits)`,
    "arrays and maps": `
let a = [1, 2, 3]
a[1] += 10
let m = {}
m["k"] = 5
m[1] = "one"
m[true] = "yes"
m[null] = "nil"
print(a, m["k"], m[1], m[true], m[null], len(a))`,
    "nested collections": 'let g = { "rows": [[1, 2], [3, 4]] }\nprint(g["rows"][1][0])',
    "closures and counters": `
fn counter(start) {
  let n = start
  return fn (step) { n += step
    return n }
}
let c = counter(0)
let d = counter(100)
print(c(1), c(2), d(5), c(3))`,
    "per-iteration capture cells": `
let fns = []
for i in range(0, 4) {
  let doubled = i * 2
  push(fns, fn () { return doubled })
}
let out = []
for f in fns { push(out, f()) }
print(out)`,
    "capture across two levels": `
fn a() {
  let x = 7
  fn b() { fn c() { return x }
    return c() }
  return b()
}
print(a())`,
    "loop-variable capture": `
let fns = []
for i in range(0, 3) { push(fns, fn () { return i }) }
print(fns[0](), fns[1](), fns[2]())`,
    "hoisted function sees a later local": `
fn outer() {
  fn g() { return x }
  let x = 5
  return g()
}
print(outer())`,
    "mutual recursion": `
fn even(n) { if n == 0 { return true }
  return odd(n - 1) }
fn odd(n) { if n == 0 { return false }
  return even(n - 1) }
print(even(10), odd(7), even(7), odd(10))`,
    "named function expression recursion":
      "let f = fn fact(n) {\n  if n <= 1 { return 1 }\n  return n * fact(n - 1)\n}\nprint(f(6))",
    "function values passed around": `
fn apply(f, x) { return f(f(x)) }
fn inc(n) { return n + 1 }
print(apply(inc, 1), apply(fn (n) { return n * 2 }, 3))`,
    "block shadowing": `
let v = 1
{
  let v = 2
  { let v = 3
    print(v) }
  print(v)
}
print(v)`,
    "return from inside nested blocks": `
fn pick(a) {
  for x in a {
    if x > 1 {
      if x > 2 { return x }
      continue
    }
  }
  return -1
}
print(pick([0, 1, 2, 3]), pick([0, 1]))`,
    "standard library": `
print(len("abc"), len([1, 2]), len({ "a": 1 }))
print(type(1), type("s"), type(true), type(null), type([]), type({}), type(print))
print(str(12) + "!", num("42") + 1, bool(null))
print(range(1, 4), range(3))
let a = [1]
push(a, 2)
print(a, pop(a), a)
let m = { "x": 1, "y": 2 }
print(keys(m), values(m), has(m, "x"), has(m, "z"))
print(join(["a", "b"], "-"), split("a-b", "-"), upper("ab"), lower("AB"), trim("  x  "))
print(contains("hello", "ell"), contains([1, 2], 2))
print(abs(-3), floor(2.7), ceil(2.1), round(2.5), sqrt(16), pow(2, 10))
print(min(3, 1), max([4, 9]), min([5, 2]))`,
    "map iteration order follows insertion": `
let m = {}
m["z"] = 1
m["a"] = 2
m["m"] = 3
let order = []
for k in m { push(order, k) }
print(order, keys(m))`,
    "index mutation while iterating": `
let items = [1, 2, 3]
let seen = []
for x in items {
  push(seen, x)
  push(items, x + 10)
}
print(len(items), seen)`,
    "empty program": "",
    "only a comment": "// nothing to do\n",
  };

  for (const [name, source] of Object.entries(programs)) {
    it(`agrees on ${name}`, () => {
      agree(source);
    });
  }
});

describe("parity: failure modes", () => {
  const failures = {
    "division by zero": "let a = 1\na / a / (a - 1)",
    "modulo by zero": "print(5 % 0)",
    "type error in +": 'print(1 + "x")',
    "type error in comparison": 'print("a" < 1)',
    "unary minus on a string": 'print(-"a")',
    "index out of bounds": "let a = [1, 2]\nprint(a[5])",
    "negative index": "let a = [1]\nprint(a[-1])",
    "non-integer index": 'let a = [1]\nprint(a["x"])',
    "indexing a number": "let n = 5\nprint(n[0])",
    "assigning into a string": 'let s = "ab"\ns[0] = "z"',
    "assigning into a number": "let n = 1\nn[0] = 2",
    "iterating a number": "for x in 5 { print(x) }",
    "iterating null": "for x in null { print(x) }",
    "call null": "let f = null\nf()",
    "call a number": "let n = 1\nn()",
    "native arity": "print()",
    "user arity": "fn g(a, b) { return a }\nprint(g(1))",
    "assertion failure": 'assert(false, "boom")',
    "deep recursion": "fn r(n) { return r(n + 1) }\nr(0)",
    "runaway loop": "let i = 0\nwhile true { i += 1 }",
    "bad native argument": "print(len(1))",
    "unparsable number": 'print(num("abc"))',
    "map key of an array": "let m = {}\nm[[1]] = 2",
    "pop from empty array": "print(pop([]))",
    "read a missing map key through indexing": 'let m = {}\nprint(m["missing"] + 1)',
    "a failure after a handled one":
      'try { print(1 / 0) } catch err { print("caught", err.code) }\nprint(1 / 0)',
    "a limit that a try cannot catch":
      'try { let i = 0\nwhile true { i += 1 } } catch err { print("swallowed") }',
    "a failure escaping a handler":
      'try { try { assert(false, "inner") } catch e { assert(false, "outer") } } catch err { print("handled", err.message) }\nassert(false, "after")',
  };

  for (const [name, source] of Object.entries(failures)) {
    it(`agrees on ${name}`, () => {
      const shared = agree(source, { limits: { maxSteps: 200_000, maxCallDepth: 64 } });
      assert.equal(shared.ok, false, "expected the program to fail");
      assert.ok(shared.error.code, "the failure must carry a diagnostic code");
    });
  }
});

describe("parity: error handling", () => {
  const programs = {
    "catching a raised assertion": `
fn check(n) {
  assert(n > 0, "n must be positive, got " + str(n))
  return n * 2
}
print(check(3))
try { print(check(-1)) } catch err { print(err.code, err.message) }
print("done")`,
    "printing the whole error value": `
try {
  const items = [1]
  print(items[5])
} catch err {
  print(err)
  print(str(err))
  print(err == err, has(err, "code"), len(keys(err)))
}`,
    "reading the fields of the error value": `
try {
  const items = [1]
  print(items[5])
} catch err {
  print(err.code, err.phase, type(err), type(err.stack), type(err.location))
  print(err.location.line, err.location.column)
  print(err.message)
  print(err.help)
}`,
    "recording the call stack": `
fn inner(zero) { return 1 / zero }
fn outer() { return inner(0) }
try { outer() } catch err {
  print(len(err.stack))
  for frame in err.stack { print(frame) }
}`,
    "nesting handlers and re-failing": `
fn risky() { return 1 / 0 }
try {
  try { risky() } catch inner { print("inner", inner.code)
    risky() }
} catch outer { print("outer", outer.code) }
print("still running")`,
    "leaving a try with return and continue": `
fn pick(items) {
  for item in items {
    try {
      if item == 0 { continue }
      if item == 3 { return "saw 3" }
      print("body", 10 / item)
    } catch err { print("never") }
  }
  return "end"
}
print(pick([1, 0, 2, 3]))`,
    "keeping a loop going after failures": `
let total = 0
for n in [1, 0, 2, 0, 4] {
  try { total += 8 / n } catch err { print("skipped", err.code, n) }
}
print(total)`,
    "storing an error value and passing it on": `
fn describe(problem) { return problem.code + "@" + str(problem.location.line) }
let log = []
for n in [1, 0] {
  try { print(9 / n) } catch err { push(log, err) }
}
print(len(log), describe(log[0]), log[0]["phase"])`,
    "returning from a handler": `
fn attempt(values) {
  try { return values[0] } catch err { return "failed: " + err.code }
}
print(attempt([7]), attempt([]))`,
    "a try with nothing to catch": `
try { print("safe") } catch err { print("never") }
print("after")`,
    "mutating a closure from a handler": `
fn counter() {
  let n = 0
  return fn (fails) {
    try {
      n += 1
      if fails { return 1 / 0 }
      return "ok " + str(n)
    } catch err { return "recovered " + str(n) }
  }
}
let c = counter()
print(c(false), c(true), c(false))`,
    "a failure inside a callback": `
fn apply(f, value) { return f(value) }
try {
  print(apply(fn (n) { return n / 0 }, 3))
} catch err {
  print(err.code, len(err.stack))
}`,
  };

  for (const [name, source] of Object.entries(programs)) {
    it(`agrees on ${name}`, () => {
      agree(source);
    });
  }

  it("agrees that a limit is not catchable", () => {
    const shared = agree(
      'try { fn dive(n) { return dive(n + 1) }\ndive(0) } catch err { print("swallowed") }',
      { limits: { maxCallDepth: 32 } },
    );
    assert.equal(shared.ok, false, "the sandbox limit must stop the program");
    assert.equal(shared.error.code, Code.DEPTH_LIMIT);
    assert.equal(shared.output, "");
  });
});

describe("parity: staged diagnostics", () => {
  const rejected = {
    "undefined variable": "print(missing)",
    "duplicate declaration": "let a = 1\nlet a = 2",
    "return outside a function": "return 1",
    "break outside a loop": "break",
    "assign to a constant": "const c = 1\nc = 2",
    "assign to a function": "fn f() { return 1 }\nf = 2",
    "use before declaration": "print(x)\nlet x = 1",
    "duplicate parameter": "fn f(a, a) { return a }",
  };

  for (const [name, source] of Object.entries(rejected)) {
    it(`reports the same pre-execution diagnosis for ${name}`, () => {
      const shared = agree(source);
      assert.equal(shared.ok, false);
    });
  }
});

describe("parity: shipped programs", () => {
  const directories = [join(import.meta.dirname, "..", "..", "examples"), join(import.meta.dirname, "..", "..", "benchmarks")];
  const files = directories.flatMap((dir) => collect(dir)).sort();

  it("has example and benchmark programs to compare", () => {
    assert.ok(files.length >= 15, `expected a corpus, found ${files.length}`);
  });

  for (const file of files) {
    it(`agrees on ${file.split("/").slice(-2).join("/")}`, () => {
      const results = {};
      for (const engine of ["tree", "vm"]) {
        const chunks = [];
        try {
          runFile(file, {
            engine,
            context: new ExecutionContext({ onOutput: (t) => chunks.push(t), onInput: () => "" }),
          });
          results[engine] = { ok: true, output: chunks.join("") };
        } catch (err) {
          results[engine] = {
            ok: false,
            output: chunks.join(""),
            error: err && err.toDiagnostic ? err.toDiagnostic().code : "unknown",
          };
        }
      }
      assert.deepEqual(results.vm, results.tree, `engines diverged on ${file}`);
    });
  }
});

describe("parity: module loading", () => {
  it("runs the multi-file fixture identically on both engines", () => {
    const outputs = {};
    for (const engine of ["tree", "vm"]) {
      const chunks = [];
      runFile(fixture("modules", "app.typ"), {
        engine,
        context: new ExecutionContext({ onOutput: (t) => chunks.push(t) }),
      });
      outputs[engine] = chunks.join("");
    }
    assert.equal(outputs.vm, outputs.tree);
    assert.equal(outputs.tree, "hello from util\n42\n15\n8\n");
  });

  it("reports the same import policy violations", () => {
    for (const name of ["escape_import.typ", "import_cycle_a.typ", "missing_module.typ", "no_extension.typ"]) {
      const codes = {};
      for (const engine of ["tree", "vm"]) {
        try {
          runFile(fixture("errors", name), {
            engine,
            context: new ExecutionContext({ onOutput: () => {} }),
          });
          codes[engine] = "ran";
        } catch (err) {
          codes[engine] = err.diagnostics && err.diagnostics[0] ? err.diagnostics[0].code : String(err.message);
        }
      }
      assert.equal(codes.vm, codes.tree, `import handling diverged for ${name}`);
    }
  });
});
