/**
 * Lint tests.
 *
 * Every rule has a case that must fire and a case that must stay silent — a
 * linter that reports things it should not is worse than no linter at all. The
 * last suites assert that the repository's own programs are clean and that the
 * analysis is exposed through the same public API the CLI uses.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINT_RULE_CODES,
  LINT_RULE_NAMES,
  lintFile,
  lintSource,
  parseSource,
} from "../../src/main/index.js";
import { collectPrograms } from "../../src/cli/bench.js";

const ROOT = join(import.meta.dirname, "..", "..");
const RULES = LINT_RULE_CODES;

function lint(source, options = {}) {
  const result = lintSource(source, options.name ?? "<test>", options);
  assert.equal(
    result.diagnostics.errors.length,
    0,
    `unexpected errors: ${result.diagnostics.errors.map((d) => d.toCompactString()).join("; ")}`,
  );
  return result;
}

/** Warning codes reported for a source, in order. */
function codesFor(source, options) {
  return lint(source, options).warnings.map((d) => d.code);
}

function tempFile(name, text) {
  const dir = mkdtempSync(join(tmpdir(), "typhoun-lint-"));
  const path = join(dir, name);
  writeFileSync(path, text, "utf8");
  return path;
}

describe("lint: unused bindings", () => {
  it("reports a binding that is never read", () => {
    const [warning] = lint("let unused = 1\n").warnings;
    assert.equal(warning.code, RULES["unused-variable"]);
    assert.equal(warning.severity, "warning");
    assert.equal(warning.phase, "lint");
    assert.equal(warning.location.line, 1);
    assert.match(warning.location.file, /<test>/);
    assert.match(warning.help, /underscore|_/);
  });

  it("stays silent when the binding is read, or named with an underscore", () => {
    assert.deepEqual(codesFor("const used = 1\nprint(used)\n"), []);
    assert.deepEqual(codesFor("let _ignored = 1\n"), []);
    assert.deepEqual(codesFor("let counted = 0\ncounted += 1\nprint(counted)\n"), []);
  });

  it("reports an unused parameter, but not one that is read", () => {
    const warnings = lint("fn f(used, unused) { return used }\nprint(f(1, 2))\n").warnings;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, RULES["unused-parameter"]);
    assert.deepEqual(codesFor("fn f(a, b) { return a + b }\nprint(f(1, 2))\n"), []);
    assert.deepEqual(codesFor("fn f(_a) { return 1 }\nprint(f(1))\n"), []);
  });

  it("reports a loop variable that is never read", () => {
    assert.deepEqual(codesFor("for key in [1, 2] { print(key) }\n"), []);
    assert.deepEqual(codesFor("for key in [1, 2] { print(\"tick\") }\n"), [
      RULES["unused-loop-variable"],
    ]);
    assert.deepEqual(codesFor("for _ in [1, 2] { print(\"tick\") }\n"), []);
  });

  it("reports an uncalled top-level function, including its help text", () => {
    const warnings = lint("fn never() { return 1 }\nprint(\"ready\")\n").warnings;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, RULES["unused-function"]);
    assert.match(warnings[0].help, /library/);
  });

  it("treats a file that only declares things as a library", () => {
    // Its top-level functions are the module's public surface, so "never
    // called here" says nothing about whether they are used.
    assert.deepEqual(codesFor("fn exported(value) { return value * 2 }\n"), []);
    assert.deepEqual(codesFor("const LIMIT = 10\nfn twice(n) { return n * 2 }\n"), []);
  });

  it("does not call a called function unused, or a recursive one", () => {
    assert.deepEqual(codesFor("fn f() { return 1 }\nprint(f())\n"), []);
    assert.deepEqual(
      codesFor("fn fib(n) { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nprint(fib(5))\n"),
      [],
    );
    assert.deepEqual(
      codesFor("fn isEven(n) { return isOdd(n) }\nfn isOdd(n) { return isEven(n) }\nprint(isEven(1))\n"),
      [],
    );
  });
});

describe("lint: shadowing and constness", () => {
  it("reports an inner binding that hides an outer one", () => {
    const source = "const value = 1\nfn f() {\n    const value = 2\n    return value\n}\nprint(value, f())\n";
    const warnings = lint(source).warnings;
    assert.deepEqual(
      warnings.map((d) => d.code),
      [RULES["shadowed-variable"]],
    );
    assert.equal(warnings[0].location.line, 3);
  });

  it("reports a parameter that hides an outer binding", () => {
    const source = "const value = 1\nfn f(value) { return value }\nprint(value, f(2))\n";
    assert.deepEqual(codesFor(source), [RULES["shadowed-variable"]]);
  });

  it("stays silent for distinct names and separate scopes", () => {
    assert.deepEqual(codesFor("const a = 1\nfn f() {\n    const b = 2\n    return b\n}\nprint(a, f())\n"), []);
  });

  it("suggests const for a binding that is never reassigned", () => {
    const warnings = lint("let total = 1\nprint(total)\n").warnings;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, RULES["prefer-const"]);
    assert.match(warnings[0].message, /const/);
    assert.match(warnings[0].help, /cannot change/);
  });

  it("stays silent for reassigned bindings, loop variables and parameters", () => {
    assert.deepEqual(codesFor("let counter = 0\ncounter += 1\nprint(counter)\n"), []);
    assert.deepEqual(codesFor("for i in [1] { print(i) }\n"), []);
    assert.deepEqual(codesFor("fn f(a) { return a }\nprint(f(1))\n"), []);
    assert.deepEqual(codesFor("const fixed = 1\nprint(fixed)\n"), []);
  });

  it("counts an indexed or field assignment as a write of the binding", () => {
    // `items[0] = 2` mutates the value `items` holds; suggesting `const` there
    // would be advice the reader cannot act on.
    assert.deepEqual(codesFor("let items = [1]\nitems[0] = 2\nprint(items)\n"), []);
    assert.deepEqual(codesFor("let user = { \"level\": 1 }\nuser.level += 1\nprint(user)\n"), []);
  });
});

describe("lint: dead and misleading code", () => {
  it("reports statements after a return", () => {
    const source = "fn f() {\n    return 1\n    print(\"dead\")\n}\nprint(f())\n";
    const warnings = lint(source).warnings;
    assert.deepEqual(
      warnings.map((d) => d.code),
      [RULES["unreachable-code"]],
    );
    assert.equal(warnings[0].location.line, 3);
  });

  it("reports statements after break and continue", () => {
    assert.deepEqual(codesFor("while true {\n    break\n    print(1)\n}\n"), [
      RULES["unreachable-code"],
    ]);
    assert.deepEqual(codesFor("for i in [1] {\n    continue\n    print(i)\n}\n"), [
      RULES["unreachable-code"],
    ]);
  });

  it("does not treat a conditional return as the end of a block", () => {
    assert.deepEqual(
      codesFor("fn f(x) { if x { return 1 }\n  print(2)\n  return 3 }\nprint(f(1))\n"),
      [],
    );
  });

  it("reports a literal condition", () => {
    assert.deepEqual(codesFor("if true { print(1) }\n"), [RULES["constant-condition"]]);
    assert.deepEqual(codesFor("if false { print(1) }\n"), [RULES["constant-condition"]]);
    assert.deepEqual(codesFor("while false { print(1) }\n"), [RULES["constant-condition"]]);
    assert.deepEqual(codesFor("if 0 { print(1) }\n"), [RULES["constant-condition"]]);
  });

  it("allows the idiomatic `while true` and real conditions", () => {
    assert.deepEqual(
      codesFor("let i = 0\nwhile true {\n    i += 1\n    if i > 2 { break }\n}\nprint(i)\n"),
      [],
    );
    assert.deepEqual(codesFor("let i = 0\nwhile i < 3 { i += 1 }\nprint(i)\n"), []);
  });

  it("reports an empty control-flow body, but not one a comment explains", () => {
    assert.deepEqual(codesFor("fn ready() { return true }\nif ready() { }\n"), [
      RULES["empty-block"],
    ]);
    assert.deepEqual(codesFor("fn ready() { return false }\nwhile ready() {\n    // deliberately nothing yet\n}\n"), []);
  });

  it("does not report an empty function body", () => {
    assert.deepEqual(codesFor("fn stub() {}\nprint(stub())\n"), []);
  });

  it("reports an assignment of a value to itself", () => {
    assert.deepEqual(codesFor("let x = 1\nx = x\nprint(x)\n"), [RULES["self-assignment"]]);
  });

  it("does not report a compound or different-name assignment", () => {
    assert.deepEqual(codesFor("let x = 1\nconst y = 2\nx += x\nprint(x, y)\n"), []);
    // `x = y` is not a self-assignment. The `dead-store` warning the sample
    // earns is a different finding — `1` is never read — so it is asserted here
    // by name rather than expected away.
    assert.deepEqual(codesFor("let x = 1\nconst y = 2\nx = y\nprint(x)\n"), [
      RULES["dead-store"],
    ]);
  });
});

describe("lint: dead stores", () => {
  it("reports a value that is overwritten before anything reads it", () => {
    const [warning] = lint("let total = 0\ntotal = 1\nprint(total)\n").warnings;
    assert.equal(warning.code, RULES["dead-store"]);
    assert.equal(warning.severity, "warning");
    assert.equal(warning.phase, "lint");
    assert.equal(warning.location.line, 1, "the report points at the store that dies");
    assert.match(warning.message, /overwritten before it is ever read/);
    assert.match(warning.help, /Delete this assignment/);
  });

  it("reports a value that goes out of scope unread", () => {
    const warnings = lint("let seen = 1\nprint(seen)\nseen = 2\n").warnings;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, RULES["dead-store"]);
    assert.equal(warnings[0].location.line, 3);
    assert.match(warnings[0].message, /never read/);
  });

  it("reports a dead store inside a function and inside a block", () => {
    assert.deepEqual(
      codesFor("fn f() {\n    let x = 1\n    x = 2\n    return x\n}\nprint(f())\n"),
      [RULES["dead-store"]],
    );
    assert.deepEqual(codesFor("let x = 1\n{ x = 2 }\nprint(x)\n"), [RULES["dead-store"]]);
  });

  it("reports each write on a chain of straight-line overwrites", () => {
    assert.deepEqual(codesFor("let x = 1\nx = 2\nx = 3\nprint(x)\n"), [
      RULES["dead-store"],
      RULES["dead-store"],
    ]);
  });

  it("stays silent when the replaced value is read first", () => {
    assert.deepEqual(codesFor("let out = 1\nout = out * 2\nprint(out)\n"), []);
    assert.deepEqual(codesFor("let a = 1\nconst b = a\na = 2\nprint(a, b)\n"), []);
    assert.deepEqual(codesFor("let x = 1\nprint(x)\nx = 2\nprint(x)\n"), []);
  });

  it("stays silent when a conditional write might be the one that is read", () => {
    assert.deepEqual(
      codesFor('const n = 3\nlet label = "odd"\nif n % 2 == 0 { label = "even" }\nprint(label)\n'),
      [],
    );
    assert.deepEqual(
      codesFor("fn f(c) {\n    let x = 1\n    if c { x = 2 } else { print(x) }\n    print(x)\n}\nprint(f(true))\n"),
      [],
    );
    assert.deepEqual(
      codesFor("const c = true\nlet x = 1\nif c { print(x) } else { print(x) }\nx = 2\nprint(x)\n"),
      [],
    );
  });

  it("stays silent about a binding a loop or a nested function can read", () => {
    // The next iteration reads what the last one wrote.
    assert.deepEqual(
      codesFor("let x = 0\nwhile true {\n    print(x)\n    x = 1\n}\n"),
      [],
    );
    // The closure may run at any point, so the overwrite cannot be dated.
    assert.deepEqual(codesFor("let x = 1\nfn f() { print(x) }\nx = 2\nprint(f())\n"), []);
    // Here the closure survives the overwrite, and the store it keeps alive is
    // the one the rule refuses to judge.
    assert.deepEqual(
      codesFor("fn f() {\n    let x = 1\n    fn g() { return x }\n    x = 2\n    return g()\n}\nprint(f())\n"),
      [],
    );
  });

  it("leaves a binding nothing reads to `unused-variable`", () => {
    assert.deepEqual(codesFor("let x = 1\nx = 2\n"), [RULES["unused-variable"]]);
  });

  it("does not count a mutation, a self-assignment or unreachable code", () => {
    assert.deepEqual(codesFor("let rows = [1]\nrows[0] = 2\nprint(rows)\n"), []);
    assert.deepEqual(codesFor("let x = 1\nx = x\nprint(x)\n"), [RULES["self-assignment"]]);
    assert.deepEqual(codesFor("fn f() {\n    let x = 1\n    return x\n    x = 2\n}\nprint(f())\n"), [
      RULES["unreachable-code"],
    ]);
  });

  it("reports an overwritten value whose only reader is on the other path", () => {
    // Both arms overwrite, so neither initial value is ever read.
    assert.deepEqual(
      codesFor(
        "fn risky() { return 1 }\nlet value = null\ntry { value = risky() } catch err { value = 0 }\nprint(value)\n",
      ),
      [RULES["dead-store"]],
    );
  });

  it("is selectable like any other rule", () => {
    const source = "let x = 1\nx = 2\nprint(x)\n";
    assert.deepEqual(codesFor(source, { rules: ["dead-store"] }), [RULES["dead-store"]]);
    assert.deepEqual(codesFor(source, { disable: ["dead-store"] }), []);
  });

  it("reports parentheses that change nothing", () => {
    assert.deepEqual(codesFor("print((1))\n"), [RULES["redundant-parentheses"]]);
    assert.deepEqual(codesFor("const x = 1\nprint((x))\n"), [RULES["redundant-parentheses"]]);
    assert.deepEqual(codesFor("print(((1 + 2)))\n"), [RULES["redundant-parentheses"]]);
  });

  it("does not report parentheses that change precedence", () => {
    assert.deepEqual(codesFor("print((1 + 2) * 3)\n"), []);
    assert.deepEqual(codesFor("print((1 + 2) / 3)\n"), []);
  });

  it("reports division by a literal zero", () => {
    assert.deepEqual(codesFor("print(10 / 0)\n"), [RULES["division-by-zero"]]);
    assert.deepEqual(codesFor("print(10 % 0)\n"), [RULES["division-by-zero"]]);
    assert.deepEqual(codesFor("const n = 0\nprint(10 / n)\n"), []);
  });
});

describe("lint: rule selection", () => {
  const source = "let unused = 1\nif true { print(2) }\n";

  it("runs every rule by default", () => {
    assert.ok(LINT_RULE_NAMES.length >= 13);
    assert.ok(LINT_RULE_NAMES.includes("unused-variable"));
  });

  it("runs only the allow-listed rules", () => {
    assert.equal(codesFor(source).length, 2);
    assert.deepEqual(codesFor(source, { rules: ["unused-variable"] }), [
      RULES["unused-variable"],
    ]);
  });

  it("removes disabled rules from the default set", () => {
    assert.deepEqual(codesFor(source, { disable: ["unused-variable"] }), [
      RULES["constant-condition"],
    ]);
    assert.deepEqual(
      codesFor(source, { rules: ["unused-variable"], disable: ["unused-variable"] }),
      [],
    );
  });

  it("gives every registered rule a TYP7xxx code", () => {
    for (const name of LINT_RULE_NAMES) {
      assert.match(RULES[name], /^TYP7\d{3}$/, `rule '${name}' needs a TYP7xxx code`);
    }
    assert.equal(new Set(Object.values(RULES)).size, LINT_RULE_NAMES.length);
  });

  it("lets every registered rule fire", () => {
    const kitchenSink = [
      "let unused = 1",
      "let frozen = 2",
      "print(frozen)",
      "fn helper(a, ignored) { return a }",
      "fn neverCalled() { return 1 }",
      "let outer = 3",
      "fn shade(outer) { return outer }",
      "print(outer, shade(4))",
      "for key in [1] { print(\"tick\") }",
      "fn dead() {",
      "    return 1",
      "    print(2)",
      "}",
      "print(dead())",
      "if true { print(5) }",
      "fn ready() { return true }",
      "if ready() { }",
      "let same = 6",
      "same = same",
      "print((same))",
      "let stale = 7",
      "stale = 8",
      "print(stale)",
      "print(10 / 0)",
      "print(helper(1, 2))",
      "",
    ].join("\n");
    const fired = new Set(codesFor(kitchenSink));
    for (const [name, code] of Object.entries(RULES)) {
      assert.ok(fired.has(code), `rule '${name}' (${code}) never fired in the kitchen-sink source`);
    }
  });
});

describe("lint: errors are reported, not swallowed", () => {
  it("reports semantic errors alongside warnings", () => {
    const result = lintSource("let unused = 1\nprint(undefinedName)\n", "<test>");
    assert.ok(result.errors.length >= 1);
    assert.equal(result.errors[0].code, "TYP3001");
    assert.ok(result.warnings.some((d) => d.code === RULES["unused-variable"]));
  });

  it("reports syntax errors and produces no warnings or AST", () => {
    const result = lintSource("let x = \n", "<test>");
    assert.equal(result.ast, null);
    assert.equal(result.warnings.length, 0);
    assert.ok(result.errors.length >= 1);
  });

  it("sorts diagnostics by source position", () => {
    const result = lintSource("let first = 1\nlet second = 2\n", "<test>");
    assert.equal(result.warnings.length, 2);
    const offsets = result.warnings.map((d) => d.location.offset);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  });
});

describe("lint: files and imports", () => {
  it("knows the names a module brings in", () => {
    const entry = tempFile(
      "main.typ",
      'import "math.typ" as math\n\nprint(math.area(2))\n',
    );
    writeFileSync(
      join(entry, "..", "math.typ"),
      "const PI = 3.14159\n\nfn area(r) {\n    return PI * r * r\n}\n",
      "utf8",
    );

    const result = lintFile(entry);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.path, entry);
  });

  it("lints the entry file of a multi-module program", () => {
    const result = lintFile(join(ROOT, "examples", "modules", "main.typ"));
    assert.deepEqual(result.diagnostics.items, []);
  });

  it("reports a missing module as an import error", () => {
    const entry = tempFile("broken.typ", 'import "nope.typ"\n');
    const result = lintFile(entry);
    assert.equal(result.errors[0].code, "TYP5001");
  });

  it("throws for a file that does not exist", () => {
    assert.throws(() => lintFile("/definitely/not/here.typ"), /File not found/);
  });
});

describe("lint: the shipped programs are clean", () => {
  it("reports nothing for examples and benchmarks", () => {
    let inspected = 0;
    for (const directory of ["examples", "benchmarks"]) {
      for (const path of collectPrograms(join(ROOT, directory))) {
        inspected += 1;
        const result = lintFile(path);
        assert.deepEqual(
          result.diagnostics.items.map((d) => d.toCompactString()),
          [],
          `${path} has lint findings`,
        );
      }
    }
    assert.ok(inspected >= 15, "expected to inspect the shipped programs");
  });

  it("reports nothing for the runnable test fixtures", () => {
    // `tests/fixtures/errors` is excluded on purpose: those files exist to be
    // broken.
    for (const directory of ["programs", "modules"]) {
      for (const path of collectPrograms(join(ROOT, "tests", "fixtures", directory))) {
        const result = lintFile(path);
        assert.deepEqual(
          result.diagnostics.items.map((d) => d.toCompactString()),
          [],
          `${path} has lint findings`,
        );
      }
    }
  });
});

describe("lint: try/catch", () => {
  it("reports a guarded block that guards nothing", () => {
    assert.deepEqual(codesFor("try {} catch err { print(err.code) }\n"), [RULES["empty-block"]]);
  });

  it("stays silent about an empty guarded block that explains itself", () => {
    assert.deepEqual(
      codesFor("try {\n    // Nothing here can fail yet.\n} catch err { print(err.code) }\n"),
      [],
    );
  });

  it("never reports an empty handler, because ignoring the error is the point", () => {
    assert.deepEqual(codesFor("try { print(1) } catch _ {}\n"), []);
    assert.deepEqual(codesFor('try { print(1) } catch err {}\n'), []);
  });

  it("never reports the caught error as unused", () => {
    assert.deepEqual(codesFor('try { print(1) } catch err { print("ignored") }\n'), []);
    assert.deepEqual(codesFor('try { print(1) } catch problem { print("ignored") }\n'), []);
  });

  it("still reports an unused local declared inside either part", () => {
    assert.deepEqual(codesFor("try { let unused = 1 } catch err { print(err.code) }\n"), [
      RULES["unused-variable"],
    ]);
    assert.deepEqual(codesFor("try { print(1) } catch err { let unused = 2 }\n"), [
      RULES["unused-variable"],
    ]);
  });

  it("reports a handler name that hides an outer binding", () => {
    assert.deepEqual(
      codesFor('const err = "outer"\ntry { print(err) } catch err { print(err.code) }\n'),
      [RULES["shadowed-variable"]],
    );
    // The convention for "I know, and I want the outer one" is the underscore.
    assert.deepEqual(
      codesFor('const err = "outer"\ntry { print(err) } catch _err { print("ignored") }\n'),
      [],
    );
  });

  it("reads the error value as a use, so a handler that inspects it is clean", () => {
    const source = [
      "const rows = [{ \"amount\": 1 }, { \"amount\": null }]",
      "for row in rows {",
      "try { print(row.amount * 2) } catch err { print(err.code, err.location.line) }",
      "}",
    ].join("\n");
    assert.deepEqual(codesFor(`${source}\n`), []);
  });
});

describe("lint: the analysis is available to tooling", () => {
  it("returns the parsed AST for a clean file", () => {
    const source = "const x = 1\nprint(x)\n";
    const result = lintSource(source, "<test>");
    const parsed = parseSource(source, "<test>").ast;
    assert.equal(result.ast.type, parsed.type);
    assert.equal(result.ast.body.length, parsed.body.length);
  });
});
