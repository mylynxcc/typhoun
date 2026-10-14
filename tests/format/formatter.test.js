/**
 * Canonical formatter tests.
 *
 * The important properties are not "the output looks nice" but:
 *   1. idempotency — formatting twice equals formatting once;
 *   2. meaning preservation — the reformatted text parses to the same AST;
 *   3. nothing is lost — every comment survives;
 *   4. the shipped examples and benchmarks are already canonical.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatFile,
  formatSource,
  parseSource,
  DEFAULT_WIDTH,
  LINT_RULE_NAMES,
} from "../../src/main/index.js";

const ROOT = join(import.meta.dirname, "..", "..");

/** Format and require that the source was well formed to begin with. */
function format(source, options = {}) {
  const result = formatSource(source, options.name ?? "<test>", options);
  assert.equal(
    result.diagnostics.hasErrors,
    false,
    `unexpected diagnostics: ${result.diagnostics.items.map((d) => d.toCompactString()).join("; ")}`,
  );
  return result;
}

/**
 * Format, then format the result again and assert nothing changed. Returns the
 * first pass, so callers read `.code` like any other formatter result.
 */
function formatTwice(source, options) {
  const once = format(source, options);
  const twice = format(once.code, options);
  assert.equal(twice.code, once.code, `not idempotent for ${JSON.stringify(source)}`);
  return once;
}

/** Drop `loc` so two ASTs can be compared for meaning rather than position. */
function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc") out[key] = strip(value);
    }
    return out;
  }
  return node;
}

function astOf(source) {
  const { ast, diagnostics } = parseSource(source, "<test>");
  assert.equal(diagnostics.hasErrors, false);
  return strip(ast);
}

describe("fmt: canonical layout", () => {
  it("puts one statement per line with four-space indentation", () => {
    assert.equal(formatTwice("if a{b()}\n").code, "if a {\n    b()\n}\n");
    assert.equal(
      formatTwice("fn f(a){\nlet b=a\nreturn b\n}\n").code,
      "fn f(a) {\n    let b = a\n    return b\n}\n",
    );
  });

  it("drops semicolons", () => {
    assert.equal(formatTwice("let x = 1;\nprint(x);\n").code, "let x = 1\nprint(x)\n");
  });

  it("spaces operators and arguments consistently", () => {
    assert.equal(formatTwice("print(1+2*3, a  and  not b)\n").code, "print(1 + 2 * 3, a and not b)\n");
    assert.equal(formatTwice("let m = {\"k\":1}\n").code, "let m = { \"k\": 1 }\n");
    assert.equal(formatTwice("let a = [1,2]\n").code, "let a = [1, 2]\n");
  });

  it("collapses an empty block to one line", () => {
    assert.equal(formatTwice("fn f() {}\n").code, "fn f() {}\n");
    assert.equal(formatTwice("if a { } else { }\n").code, "if a {} else {}\n");
    assert.equal(formatTwice("let m = {}\n").code, "let m = {}\n");
  });

  it("keeps else-if chains on the closing brace", () => {
    assert.equal(
      formatTwice("if a { b() } else if c { d() } else { e() }\n").code,
      "if a {\n    b()\n} else if c {\n    d()\n} else {\n    e()\n}\n",
    );
  });

  it("normalizes the C-style for header", () => {
    assert.equal(formatTwice("for (;;) { break }\n").code, "for (;;) {\n    break\n}\n");
    assert.equal(
      formatTwice("for (; i < 3;) { i += 1 }\n").code,
      "for (; i < 3;) {\n    i += 1\n}\n",
    );
    assert.equal(
      formatTwice("for (let i=0;i<3;i+=1){ print(i) }\n").code,
      "for (let i = 0; i < 3; i += 1) {\n    print(i)\n}\n",
    );
  });

  it("keeps parentheses exactly as written", () => {
    assert.equal(formatTwice("print((1 + 2) * 3)\n").code, "print((1 + 2) * 3)\n");
    assert.equal(formatTwice("print((x))\n").code, "print((x))\n");
    assert.equal(formatTwice("print(- -x)\n").code, "print(- -x)\n");
  });

  it("prints member access as sugar when the key is an identifier", () => {
    assert.equal(formatTwice('print(u["language"])\n').code, "print(u.language)\n");
    assert.equal(formatTwice('print(u["first name"])\n').code, 'print(u["first name"])\n');
    assert.equal(formatTwice('print(u["if"])\n').code, 'print(u["if"])\n');
  });

  it("preserves literal notation exactly", () => {
    const source = 'print(1e3, 0.10, 10000000000000000000000, "\\u0041\\t")\n';
    assert.equal(formatTwice(source).code, source);
  });

  it("produces an empty string for an empty program", () => {
    assert.equal(format("").code, "");
    assert.equal(format("\n\n").code, "");
  });
});

describe("fmt: idempotency and meaning", () => {
  const samples = [
    "let x = 1\n",
    "fn f(a, b) { return a + b }\n",
    "if a { b() } else if c { d() } else { }\n",
    "while a < 10 { a += 1 }\n",
    "for item in xs { print(item) }\n",
    "for (let i = 0; i < 3; i += 1) { print(i) }\n",
    "let f = fn (n) { return n * 2 }\n",
    "let g = fn named(n) {\n    return n\n}\n",
    "let m = { \"a\": [1, 2], \"b\": { \"c\": 3 } }\n",
    "print(a and b or not c)\n",
    "import \"m.typ\" as m\n",
    "return\n",
    "{ let inner = 1\n  print(inner) }\n",
    'print("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r")\n',
  ];

  for (const sample of samples) {
    it(`is idempotent and preserves the tree: ${JSON.stringify(sample.slice(0, 32))}`, () => {
      const once = formatTwice(sample);
      assert.deepEqual(astOf(once.code), astOf(sample));
    });
  }

  it("reparses its own output without diagnostics", () => {
    for (const sample of samples) {
      const { code } = format(sample);
      const { diagnostics } = parseSource(code, "<reparse>");
      assert.equal(diagnostics.hasErrors, false, `output did not reparse: ${code}`);
    }
  });
});

describe("fmt: comments", () => {
  it("keeps a leading comment on its own line", () => {
    assert.equal(formatTwice("// why\nlet x = 1\n").code, "// why\nlet x = 1\n");
  });

  it("keeps a trailing comment two spaces after the code", () => {
    assert.equal(formatTwice("let x = 1      // why\n").code, "let x = 1  // why\n");
  });

  it("collapses runs of blank lines to one", () => {
    assert.equal(formatTwice("let a = 1\n\n\n\nlet b = 2\n").code, "let a = 1\n\nlet b = 2\n");
  });

  it("keeps block comments, including their relative indentation", () => {
    const source = "/* one\n   two\n     three */\nlet x = 1\n";
    assert.equal(formatTwice(source).code, source);
  });

  it("breaks a list that contains a comment", () => {
    const source = "let xs = [1, // first\n    2]\n";
    assert.equal(formatTwice(source).code, "let xs = [\n    1,  // first\n    2\n]\n");
  });

  it("keeps comments inside call arguments", () => {
    const source = "print(\n    a,  // first\n    b\n)\n";
    assert.equal(formatTwice(source).code, source);
  });

  it("never drops a comment", () => {
    const source = [
      "// top",
      "let a = 1 // after a",
      "",
      "/* block */",
      "fn f(x) { // after brace",
      "    return x // after return",
      "}",
      "// end",
      "",
    ].join("\n");
    const once = format(source).code;
    for (const comment of ["// top", "// after a", "/* block */", "// after brace", "// after return", "// end"]) {
      assert.ok(once.includes(comment), `missing ${comment} in:\n${once}`);
    }
    assert.equal(format(once).code, once);
  });
});

describe("fmt: line width", () => {
  const call = "print(\"aaaa\", \"bbbb\", \"cccc\", \"dddd\")\n";

  it("keeps a list on one line when it fits", () => {
    assert.equal(format(call, { width: 80 }).code, call);
  });

  it("breaks a list that exceeds the width, one item per line", () => {
    assert.equal(
      format(call, { width: 20 }).code,
      "print(\n    \"aaaa\",\n    \"bbbb\",\n    \"cccc\",\n    \"dddd\"\n)\n",
    );
  });

  it("breaks only the lists that do not fit", () => {
    const source = 'let xs = [["aaaa", "bbbb"], "cccc"]\n';
    // At 24 columns the outer list breaks and the inner one still fits.
    assert.equal(
      format(source, { width: 24 }).code,
      'let xs = [\n    ["aaaa", "bbbb"],\n    "cccc"\n]\n',
    );
    // Narrower than the inner list, so it breaks too.
    assert.equal(
      format(source, { width: 16 }).code,
      'let xs = [\n    [\n        "aaaa",\n        "bbbb"\n    ],\n    "cccc"\n]\n',
    );
  });

  it("respects the width on every line it can break", () => {
    const source = 'print("aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd")\n';
    for (const width of [30, 40, 60]) {
      const { code } = format(source, { width });
      for (const line of code.split("\n")) {
        assert.ok(line.length <= width, `line too long (${line.length} > ${width}): ${line}`);
      }
      assert.equal(format(code, { width }).code, code);
    }
  });

  it("defaults to 100 columns", () => {
    assert.equal(DEFAULT_WIDTH, 100);
  });
});

describe("fmt: refusing broken input", () => {
  it("returns the source untouched when it does not parse", () => {
    const broken = "let x = \n";
    const result = formatSource(broken, "<broken>");
    assert.equal(result.formatted, false);
    assert.equal(result.code, broken);
    assert.equal(result.diagnostics.hasErrors, true);
    assert.equal(result.ast, null);
  });

  it("reports lexical errors too", () => {
    const result = formatSource('let s = "unterminated\n', "<broken>");
    assert.equal(result.formatted, false);
    assert.equal(result.diagnostics.hasErrors, true);
  });
});

describe("fmt: file API", () => {
  it("formats a file on disk and reports whether it changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "typhoun-fmt-"));
    const path = join(dir, "program.typ");
    writeFileSync(path, "let x=1\n", "utf8");

    const first = formatFile(path);
    assert.equal(first.formatted, true);
    assert.equal(first.code, "let x = 1\n");
    assert.equal(first.path, path);

    writeFileSync(path, first.code, "utf8");
    const second = formatFile(path);
    assert.equal(second.formatted, false);
  });

  it("throws for a missing file", () => {
    assert.throws(() => formatFile(join(tmpdir(), "definitely-missing.typ")), /File not found/);
  });
});

describe("fmt: the shipped programs are canonical", () => {
  async function shippedPrograms() {
    const { collectPrograms } = await import("../../src/cli/bench.js");
    const files = [];
    for (const directory of [
      "examples",
      "benchmarks",
      "tests/fixtures/programs",
      "tests/fixtures/modules",
    ]) {
      files.push(...collectPrograms(join(ROOT, directory)));
    }
    return files;
  }

  it("formats every shipped program to itself", async () => {
    const files = await shippedPrograms();
    assert.ok(files.length >= 15, "expected to inspect the shipped programs");
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      const result = format(source, { name: path });
      assert.equal(result.formatted, false, `${path} is not canonical; run 'typhoun fmt' on it`);
    }
  });

  it("re-indents a mangled copy back to the canonical file", async () => {
    // The layout comes from the tree, not from the original whitespace, so
    // re-indenting a program must not survive formatting — and must not change
    // what the program means.
    for (const path of await shippedPrograms()) {
      const source = readFileSync(path, "utf8");
      const mangled = source
        .split("\n")
        .map((line) =>
          line.trim() === "" || line.trimStart().startsWith("//") ? line : `   ${line}`,
        )
        .join("\n");

      const result = formatTwice(mangled, { name: path });
      assert.equal(result.code, source, `${path} did not normalize back to its file`);
      assert.deepEqual(result.ast && strip(result.ast), astOf(source), `${path} changed meaning`);
    }
  });
});

describe("fmt: try/catch", () => {
  it("puts the handler on the closing line of the guarded block", () => {
    const result = formatTwice("try {\n    print(1)\n} catch err {\n    print(err.code)\n}\n");
    assert.equal(result.code, "try {\n    print(1)\n} catch err {\n    print(err.code)\n}\n");
  });

  it("normalizes a compactly written statement", () => {
    const result = formatTwice("try{print(1)}catch err{print(err.code)}");
    assert.equal(result.code, "try {\n    print(1)\n} catch err {\n    print(err.code)\n}\n");
  });

  it("keeps an empty handler on one line", () => {
    assert.equal(formatTwice("try {\n    print(1)\n} catch _ {\n}\n").code, "try {\n    print(1)\n} catch _ {}\n");
    assert.equal(formatTwice("try {\n} catch err {\n    print(err.code)\n}\n").code, "try {} catch err {\n    print(err.code)\n}\n");
  });

  it("indents a nested region by its level", () => {
    const source = [
      "fn guard() {",
      "    try {",
      "        try {",
      "            print(1)",
      "        } catch inner {",
      "            print(inner.code)",
      "        }",
      "    } catch outer {",
      "        print(outer.code)",
      "    }",
      "}",
      "",
    ].join("\n");
    assert.equal(formatTwice(source).code, source);
  });

  it("breaks the guarded block out of a single line", () => {
    const source = "let a = 1\nif a > 0 { try { print(a) } catch err { print(err.code) } }\n";
    assert.equal(
      formatTwice(source).code,
      "let a = 1\nif a > 0 {\n    try {\n        print(a)\n    } catch err {\n        print(err.code)\n    }\n}\n",
    );
  });

  it("keeps the comments that explain the statement", () => {
    const source = [
      "// Try the risky path, and keep going either way.",
      "try {",
      "    // The only call that may fail.",
      "    print(1)",
      "} catch err {",
      "    // Swallowing this is deliberate.",
      "    print(err.code)",
      "}",
      "",
    ].join("\n");
    const result = formatTwice(source);
    assert.equal(result.code, source);
  });

  it("preserves the meaning of the statement", () => {
    const source = "try { let a = 1\n  print(a) } catch err { print(err.code) }";
    const result = formatTwice(source);
    assert.deepEqual(strip(result.ast), astOf(source));
  });
});

describe("fmt: shared tooling surface", () => {
  it("exposes every lint rule name", () => {
    assert.ok(LINT_RULE_NAMES.length >= 12);
    assert.ok(LINT_RULE_NAMES.includes("unused-variable"));
  });
});
