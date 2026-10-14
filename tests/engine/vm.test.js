/**
 * Stage F₂ — Virtual machine tests.
 *
 * These drive the bytecode backend directly (not through the CLI) so they can
 * assert on VM-specific behaviour: frame reuse after a fault, closure cells,
 * the cross-engine guard and the replay surface the module loader relies on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Code } from "../../src/diagnostics/codes.js";
import {
  ExecutionContext,
  Environment,
  Lexer,
  Parser,
  Resolver,
  SourceManager,
  TFunction,
  VirtualMachine,
  builtinNames,
  compileProgram,
  parseSource,
  runFile,
} from "../../src/main/index.js";
import { fixture } from "../helpers.js";

/** A VM plus a buffer of everything it printed. */
function makeHarness(options = {}) {
  const chunks = [];
  const context = new ExecutionContext({
    limits: options.limits,
    now: options.now,
    onOutput: (text) => chunks.push(text),
    onInput: options.onInput ?? (() => ""),
  });
  const vm = new VirtualMachine({ sourceManager: new SourceManager(), context });
  const output = () => chunks.join("");
  return { vm, context, chunks, output };
}

/** Compile and run `source` on a fresh VM. */
function run(source, options = {}) {
  const harness = makeHarness(options);
  const { ast } = parseSource(source, "<vm-test>");
  const env = harness.vm.createGlobalEnvironment();
  harness.vm.executeChunk(compileProgram(ast, { name: "<vm-test>" }), env);
  return harness;
}

function failure(source, options = {}) {
  try {
    run(source, options);
    return null;
  } catch (err) {
    return err;
  }
}

describe("vm: core execution", () => {
  it("evaluates arithmetic, variables and output", () => {
    const harness = run("let a = 6\nlet b = 7\nprint(a * b, a - b, a / b, a % b)");
    assert.equal(harness.output(), "42 -1 0.8571428571428571 6\n");
  });

  it("runs local variables inside functions", () => {
    const harness = run("fn add(a, b) {\n  let sum = a + b\n  return sum\n}\nprint(add(2, 3))");
    assert.equal(harness.output(), "5\n");
  });

  it("supports recursion and mutual recursion", () => {
    const harness = run(`
fn fib(n) { if n < 2 { return n }
  return fib(n - 1) + fib(n - 2) }
fn even(n) { if n == 0 { return true }
  return odd(n - 1) }
fn odd(n) { if n == 0 { return false }
  return even(n - 1) }
print(fib(18), even(10), odd(7))
`);
    assert.equal(harness.output(), "2584 true true\n");
  });

  it("runs the standard library", () => {
    const harness = run('print(len("abc"), upper("ab"), join(["a", "b"], "-"), sqrt(9))');
    assert.equal(harness.output(), "3 AB a-b 3\n");
  });

  it("reads input through the input channel", () => {
    const harness = run('let name = input("who? ")\nprint("hi " + name)', { onInput: () => "Jay" });
    assert.equal(harness.output(), "who? hi Jay\n");
  });
});

describe("vm: closures and capture", () => {
  it("keeps a private cell per closure", () => {
    const harness = run(`
fn counter(start) {
  let n = start
  return fn (step) { n += step
    return n }
}
let c = counter(0)
let d = counter(100)
print(c(1), c(2), d(5), c(3))
`);
    assert.equal(harness.output(), "1 3 105 6\n");
  });

  it("gives each loop iteration a fresh captured cell", () => {
    const harness = run(`
let fns = []
for i in range(0, 4) {
  let doubled = i * 2
  push(fns, fn () { return doubled })
}
for f in fns { print(f()) }
`);
    assert.equal(harness.output(), "0\n2\n4\n6\n");
  });

  it("captures across two function levels", () => {
    const harness = run(`
fn a() {
  let x = 7
  fn b() { fn c() { return x }
    return c() }
  return b()
}
print(a())
`);
    assert.equal(harness.output(), "7\n");
  });

  it("sees a local declared after a hoisted function", () => {
    const harness = run(`
fn outer() {
  fn g() { return x }
  let x = 5
  return g()
}
print(outer())
`);
    assert.equal(harness.output(), "5\n");
  });

  it("closes captured cells when a break leaves a nested block", () => {
    const harness = run(`
fn run() {
  let captured = null
  let i = 0
  while i < 5 {
    let y = i * 100
    if i == 2 { break }
    { captured = fn () { return y } }
    i += 1
  }
  let reused = 999
  return captured() + reused
}
print(run())
`);
    assert.equal(harness.output(), "1099\n");
  });

  it("supports named function expressions referring to themselves", () => {
    const harness = run(
      "let f = fn fact(n) {\n  if n <= 1 { return 1 }\n  return n * fact(n - 1)\n}\nprint(f(5))",
    );
    assert.equal(harness.output(), "120\n");
  });

  it("mutates a captured variable through an upvalue", () => {
    const harness = run(`
fn make() {
  let total = 0
  return fn (n) { total += n
    return total }
}
let add = make()
print(add(5), add(5), add(5))
`);
    assert.equal(harness.output(), "5 10 15\n");
  });
});

describe("vm: control flow and collections", () => {
  it("runs while, continue and break", () => {
    const harness = run(`
let i = 0
let seen = []
while i < 10 {
  i += 1
  if i % 2 != 0 { continue }
  if i > 6 { break }
  push(seen, i)
}
print(seen)
`);
    assert.equal(harness.output(), "[2, 4, 6]\n");
  });

  it("iterates arrays, maps and strings", () => {
    const harness = run(`
let out = ""
for item in ["a", "b"] { out += item }
for ch in "xy" { out += ch }
for k in { "n": 1, "m": 2 } { out += k }
print(out)
`);
    assert.equal(harness.output(), "abxynm\n");
  });

  it("snapshots the sequence before iterating", () => {
    const harness = run(`
let items = [1, 2, 3]
let seen = []
for x in items {
  push(seen, x)
  push(items, x + 10)
}
print(len(items), seen)
`);
    assert.equal(harness.output(), "6 [1, 2, 3]\n");
  });

  it("moves the iterator slot out of the way on continue", () => {
    const harness = run(`
let total = 0
for x in range(0, 6) {
  if x % 2 == 0 { continue }
  total += x
}
print(total)
`);
    assert.equal(harness.output(), "9\n");
  });

  it("runs C-style for loops with update expressions", () => {
    const harness = run("for (let i = 3; i > 0; i -= 1) { print(i) }");
    assert.equal(harness.output(), "3\n2\n1\n");
  });

  it("indexes, mutates and bounds-checks collections", () => {
    const harness = run(`
let a = [1, 2, 3]
a[1] += 10
let m = { "k": 1 }
m["k"] *= 4
print(a[1], m["k"], len(a), has(m, "k"))
`);
    assert.equal(harness.output(), "12 4 3 true\n");
  });

  it("returns from inside a loop", () => {
    const harness = run(`
fn find(items, target) {
  for x in items { if x == target { return x } }
  return -1
}
print(find([4, 5, 6], 5), find([1], 9))
`);
    assert.equal(harness.output(), "5 -1\n");
  });
});

describe("vm: failures", () => {
  it("reports division by zero with a call stack", () => {
    const err = failure("fn inner() { return 1 / 0 }\nfn outer() { return inner() }\nprint(outer())");
    assert.equal(err.name, "RuntimeFault");
    assert.equal(err.toDiagnostic().code, Code.DIVISION_BY_ZERO);
    assert.ok(err.typhounStack.some((frame) => frame.startsWith("inner")));
  });

  it("reports an out-of-bounds index", () => {
    assert.equal(failure("let a = [1]\nprint(a[9])").toDiagnostic().code, Code.INDEX_OUT_OF_BOUNDS);
  });

  it("reports a type error with the same wording as the tree-walker", () => {
    const err = failure('print(1 + "1")');
    assert.equal(err.message, "Operator '+' requires two strings or two numbers, got 'number' and 'string'");
  });

  it("reports an arity mismatch for user functions", () => {
    assert.equal(failure("fn one(a) { return a }\nprint(one())").toDiagnostic().code, Code.ARITY_MISMATCH);
  });

  it("reports calling a non-function", () => {
    assert.equal(failure("let x = 1\nprint(x())").toDiagnostic().code, Code.NOT_CALLABLE);
  });

  it("enforces the call-depth limit", () => {
    const err = failure("fn dive(n) { return dive(n + 1) }\nprint(dive(0))", {
      limits: { maxCallDepth: 32 },
    });
    assert.equal(err.toDiagnostic().code, Code.DEPTH_LIMIT);
  });

  it("enforces the step limit", () => {
    const err = failure("let i = 0\nwhile true { i += 1 }", { limits: { maxSteps: 20000 } });
    assert.equal(err.toDiagnostic().code, Code.STEP_LIMIT);
  });

  it("enforces the output limit", () => {
    const err = failure('while true { print("x") }', {
      limits: { maxOutputChars: 200, maxSteps: 1_000_000 },
    });
    assert.equal(err.toDiagnostic().code, Code.OUTPUT_LIMIT);
  });

  it("enforces the wall clock limit", () => {
    let now = 0;
    const err = failure("let i = 0\nwhile true { i += 1 }", {
      limits: { maxDurationMs: 50, maxSteps: 100_000_000 },
      // The VM reads the clock through the shared context.
      now: () => (now += 10),
    });
    assert.equal(err.toDiagnostic().code, Code.TIME_LIMIT);
  });

  it("refuses to run a closure built for the tree-walking engine", () => {
    const harness = makeHarness();
    const env = harness.vm.createGlobalEnvironment();
    env.set("foreign", new TFunction("foreign", [], { type: "Block", body: [] }, env, null), "fn");
    const { ast } = parseSource("print(foreign())", "<vm-test>");
    assert.throws(
      () => harness.vm.executeChunk(compileProgram(ast, { name: "<vm-test>" }), env),
      (err) => err.toDiagnostic().code === Code.NOT_CALLABLE && /tree-walker/.test(err.message),
    );
  });
});

describe("vm: engine reuse", () => {
  it("unwinds cleanly so the same instance can run again after a fault", () => {
    const harness = makeHarness({ limits: { maxCallDepth: 16 } });
    const failing = parseSource("fn dive(n) { return dive(n + 1) }\ndive(0)", "<fault>").ast;
    assert.throws(() =>
      harness.vm.executeChunk(compileProgram(failing, { name: "<fault>" }), harness.vm.createGlobalEnvironment()),
    );

    // Stack, frame list, call depth and open cells must all be back to clean.
    assert.deepEqual(harness.vm.frames, []);
    assert.equal(harness.vm.sp, 0);
    assert.equal(harness.vm.callDepth, 0);
    assert.equal(harness.vm.openUpvalues.size, 0);

    const ok = parseSource("fn f() { return 41 + 1 }\nprint(f())", "<ok>").ast;
    harness.vm.executeChunk(compileProgram(ok, { name: "<ok>" }), harness.vm.createGlobalEnvironment());
    assert.equal(harness.output(), "42\n");
  });

  it("evaluates a single expression for the REPL", () => {
    const harness = makeHarness();
    const env = harness.vm.createGlobalEnvironment();
    const { ast } = parseSource('1 + 2 * 3\n"typhoun"\n', "<repl>");
    assert.equal(harness.vm.evaluate(ast.body[0].expression, env), 7);
    assert.equal(harness.vm.evaluate(ast.body[1].expression, env), "typhoun");
  });

  it("keeps a module namespace separate from its parent scope", () => {
    const harness = makeHarness();
    const moduleEnv = new Environment(harness.vm.createGlobalEnvironment());
    const { ast } = parseSource("let hidden = 41\nprint(hidden + 1)", "<mod>");
    harness.vm.executeStatements(ast.body, moduleEnv);
    assert.equal(moduleEnv.lookup("hidden").value, 41);
    assert.equal(harness.vm.sp, 0);
    assert.equal(harness.output(), "42\n");
  });

  it("leaves no runtime state behind after a successful run", () => {
    const harness = run("let a = [1, 2, 3]\nprint(len(a))");
    assert.equal(harness.output(), "3\n");
    assert.equal(harness.vm.sp, 0);
    assert.deepEqual(harness.vm.frames, []);
    assert.equal(harness.vm.callDepth, 0);
  });
});

describe("vm: modules through the real loader", () => {
  it("runs the multi-file fixture with the module loader", () => {
    const chunks = [];
    const result = runFile(fixture("modules", "app.typ"), {
      engine: "vm",
      context: new ExecutionContext({ onOutput: (t) => chunks.push(t) }),
    });
    assert.equal(chunks.join(""), "hello from util\n42\n15\n8\n");
    assert.equal(result.loader.cache.size, 1, "the shared module runs once");
    assert.equal(result.engine.constructor.name, "VirtualMachine");
  });

  it("keeps module globals out of the importing program", () => {
    const chunks = [];
    const result = runFile(fixture("modules", "app.typ"), {
      engine: "vm",
      context: new ExecutionContext({ onOutput: (t) => chunks.push(t) }),
    });
    const entry = result.loader.graph.get(result.loader.order[0]);
    assert.ok(entry.ast);
    // The entry module's own environment is a child of the loader's base scope.
    const base = result.loader.baseEnv;
    assert.equal(base.lookup("double"), null, "module exports are not hoisted into base");
  });
});

describe("vm: front-end integration", () => {
  it("executes a program produced by the full front end", () => {
    const manager = new SourceManager();
    const file = manager.add("<pipeline>", "let x = 2\nprint(x * 21)\n");
    const tokens = new Lexer(file).tokenize();
    const ast = new Parser(tokens).parse();
    const bag = new Resolver({ globals: builtinNames() }).resolve(ast);
    assert.equal(bag.hasErrors, false);
    const vm = new VirtualMachine({
      sourceManager: manager,
      context: new ExecutionContext({ onOutput: () => {} }),
    });
    vm.executeChunk(compileProgram(ast, { name: "<pipeline>" }), vm.createGlobalEnvironment());
    assert.equal(vm.sp, 0);
  });
});

describe("vm: try/catch", () => {
  it("catches a fault raised in a deeper frame and resumes the caller", () => {
    const harness = run(`fn risky() { return 1 / 0 }
fn safe() {
  try { return risky() } catch err { return "caught " + err.code }
}
print(safe())
print("after")`);
    assert.equal(harness.output(), "caught TYP4002\nafter\n");
  });

  it("unwinds the abandoned frames and leaves the engine clean", () => {
    const harness = run(`fn deeper() { return 1 / 0 }
fn risky() { return deeper() }
fn safe() {
  try {
    risky()
  } catch err {
    print(err.code, len(err.stack))
  }
}
safe()
print("clean")`);
    assert.equal(harness.output(), "TYP4002 3\nclean\n");
    // The two frames between the fault and its handler are gone, and nothing
    // about the catch (frames, value stack, depth, open upvalues) survives it.
    assert.deepEqual(harness.vm.frames, []);
    assert.equal(harness.vm.sp, 0);
    assert.equal(harness.vm.callDepth, 0);
    assert.equal(harness.vm.openUpvalues.size, 0);
  });

  it("closes the upvalues of frames the fault abandoned", () => {
    // The closure outlives the frame that created it, so catching the fault
    // must leave it pointing at a real cell rather than a dead stack slot.
    const harness = run(`let saved = null
fn boom() {
  let n = 0
  saved = fn () { n += 1
    return n }
  return 1 / 0
}
try { boom() } catch err { print("caught", err.code) }
print(saved(), saved())`);
    assert.equal(harness.output(), "caught TYP4002\n1 2\n");
    assert.equal(harness.vm.openUpvalues.size, 0);
  });

  it("runs the innermost handler first and hands an inner failure outward", () => {
    const harness = run(`fn risky() { return 1 / 0 }
try {
  try { risky() } catch inner { print("inner:", inner.code)
    risky() }
} catch outer { print("outer:", outer.code) }
print("still running")`);
    assert.equal(harness.output(), "inner: TYP4002\nouter: TYP4002\nstill running\n");
  });

  it("recovers inside a loop and keeps iterating", () => {
    const harness = run(`let total = 0
for n in [1, 0, 2, 0] {
  try { total += 10 / n } catch err { print("skipped", err.code) }
}
print(total)`);
    assert.equal(harness.output(), "skipped TYP4002\nskipped TYP4002\n15\n");
  });

  it("passes return, break and continue out of the statement untouched", () => {
    const harness = run(`fn pick(items) {
  for item in items {
    try {
      if item == 2 { continue }
      if item == 4 { return "stopped at " + str(item) }
      print("body", item)
    } catch err { print("never") }
  }
  return "end"
}
print(pick([1, 2, 3, 4, 5]))`);
    assert.equal(harness.output(), "body 1\nbody 3\nstopped at 4\n");
  });

  it("does not catch the sandbox's limits", () => {
    const step = failure('try { let i = 0\nwhile true { i += 1 } } catch err { print("swallowed") }', {
      limits: { maxSteps: 20000 },
    });
    assert.equal(step.toDiagnostic().code, Code.STEP_LIMIT);

    const depth = failure(
      'try { fn dive(n) { return dive(n + 1) }\ndive(0) } catch err { print("swallowed") }',
      { limits: { maxCallDepth: 32 } },
    );
    assert.equal(depth.toDiagnostic().code, Code.DEPTH_LIMIT);
  });

  it("does not leave a region armed once the guarded block finishes", () => {
    const err = failure('try { print(1) } catch e { print("no") }\nprint(1 / 0)');
    assert.equal(err.toDiagnostic().code, Code.DIVISION_BY_ZERO);
    assert.equal(err.toDiagnostic().location.line, 2);
  });

  it("returns the engine to a usable state after an uncatchable fault in a region", () => {
    const harness = makeHarness({ limits: { maxCallDepth: 32 } });
    const stopped = parseSource(
      'try { fn dive(n) { return dive(n + 1) }\ndive(0) } catch err { print("swallowed") }',
      "<stopped>",
    ).ast;
    assert.throws(
      () =>
        harness.vm.executeChunk(
          compileProgram(stopped, { name: "<stopped>" }),
          harness.vm.createGlobalEnvironment(),
        ),
      (err) => err.toDiagnostic().code === Code.DEPTH_LIMIT,
    );
    assert.deepEqual(harness.vm.frames, []);
    assert.equal(harness.vm.sp, 0);
    assert.equal(harness.vm.callDepth, 0);
    assert.equal(harness.output(), "", "the handler must not have run");

    // The same instance still runs a fresh program, handler and all.
    const again = parseSource('try { print(1 / 0) } catch err { print(err.code) }', "<again>").ast;
    harness.vm.executeChunk(compileProgram(again, { name: "<again>" }), harness.vm.createGlobalEnvironment());
    assert.equal(harness.output(), "TYP4002\n");
  });
});
