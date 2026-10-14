/**
 * Stage C — Parser tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeType } from "../../src/ast/nodes.js";
import { Code } from "../../src/diagnostics/codes.js";
import { MAX_NESTING_DEPTH } from "../../src/parser/parser.js";
import { parse } from "../helpers.js";

function parseOk(source) {
  const { ast, diagnostics } = parse(source);
  assert.equal(
    diagnostics.hasErrors,
    false,
    diagnostics.items.map((d) => d.toCompactString()).join("; "),
  );
  return ast;
}

const first = (source) => parseOk(source).body[0];

describe("parser: declarations", () => {
  it("parses let and const declarations", () => {
    const ast = parseOk("let a = 1\nconst b = 2");
    assert.equal(ast.body.length, 2);
    assert.equal(ast.body[0].type, NodeType.VarDecl);
    assert.equal(ast.body[0].kind, "let");
    assert.equal(ast.body[1].kind, "const");
  });

  it("parses function declarations with parameters", () => {
    const fn = first("fn add(a, b) { return a + b }");
    assert.equal(fn.type, NodeType.FnDecl);
    assert.deepEqual(fn.params, ["a", "b"]);
    assert.equal(fn.body.type, NodeType.Block);
  });

  it("parses function expressions", () => {
    const decl = first("let f = fn (x) { return x }");
    assert.equal(decl.init.type, NodeType.FnExpr);
  });

  it("permits optional semicolons", () => {
    const ast = parseOk("let a = 1; let b = 2;");
    assert.equal(ast.body.length, 2);
  });
});

describe("parser: expressions and precedence", () => {
  it("binds * tighter than +", () => {
    const expr = first("1 + 2 * 3").expression;
    assert.equal(expr.operator, "+");
    assert.equal(expr.right.operator, "*");
  });

  it("groups with parentheses", () => {
    const expr = first("(1 + 2) * 3").expression;
    assert.equal(expr.operator, "*");
    assert.equal(expr.left.type, NodeType.GroupingExpr);
  });

  it("makes assignment right-associative", () => {
    const expr = first("a = b = 1").expression;
    assert.equal(expr.type, NodeType.AssignExpr);
    assert.equal(expr.value.type, NodeType.AssignExpr);
  });

  it("parses logical operators as a distinct node type", () => {
    const expr = first("a and b or c").expression;
    assert.equal(expr.type, NodeType.LogicalExpr);
    assert.equal(expr.operator, "or");
    assert.equal(expr.left.operator, "and");
  });

  it("parses unary operators", () => {
    const expr = first("not -a").expression;
    assert.equal(expr.operator, "not");
    assert.equal(expr.operand.operator, "-");
  });

  it("parses calls, indexing and member sugar", () => {
    const call = first("f(1)[0].key").expression;
    assert.equal(call.type, NodeType.IndexExpr);
    assert.equal(call.index.value, "key");
    assert.equal(call.object.type, NodeType.IndexExpr);
  });

  it("parses array and map literals", () => {
    const arr = first("[1, 2, 3]").expression;
    assert.equal(arr.elements.length, 3);
    const map = first("let m = { \"a\": 1, \"b\": 2 }").init;
    assert.equal(map.type, NodeType.MapLit);
    assert.equal(map.entries.length, 2);
  });
});

describe("parser: statements", () => {
  it("parses if / else if / else chains", () => {
    const stmt = first('if a { print(1) } else if b { print(2) } else { print(3) }');
    assert.equal(stmt.type, NodeType.IfStmt);
    assert.equal(stmt.alternate.type, NodeType.IfStmt);
    assert.equal(stmt.alternate.alternate.type, NodeType.Block);
  });

  it("parses while loops and for-in loops", () => {
    assert.equal(first("while a { break }").type, NodeType.WhileStmt);
    const forIn = first("for x in items { print(x) }");
    assert.equal(forIn.type, NodeType.ForInStmt);
    assert.equal(forIn.variable, "x");
  });

  it("parses C-style for loops", () => {
    const stmt = first("for (let i = 0; i < 3; i += 1) { print(i) }");
    assert.equal(stmt.type, NodeType.ForStmt);
    assert.equal(stmt.init.type, NodeType.VarDecl);
    assert.equal(stmt.test.operator, "<");
    assert.equal(stmt.update.operator, "+=");
  });

  it("parses import statements with and without an alias", () => {
    const plain = first('import "math.typ"');
    assert.equal(plain.type, NodeType.ImportStmt);
    assert.equal(plain.alias, null);
    const aliased = first('import "math.typ" as math');
    assert.equal(aliased.alias, "math");
  });

  it("parses nested blocks", () => {
    const ast = parseOk("{ let a = 1\n { let b = 2 } }");
    assert.equal(ast.body[0].type, NodeType.Block);
    assert.equal(ast.body[0].body[1].type, NodeType.Block);
  });
});

describe("parser: diagnostics", () => {
  it("reports a missing expression", () => {
    const { diagnostics } = parse("let x = 1 +");
    assert.ok(diagnostics.items.some((d) => d.code === Code.EXPECTED_EXPRESSION));
  });

  it("reports an unclosed block", () => {
    const { diagnostics } = parse("if true { print(1)");
    assert.ok(diagnostics.items.some((d) => d.code === Code.EXPECTED_TOKEN));
  });

  it("reports an invalid assignment target", () => {
    const { diagnostics } = parse("1 + 2 = 3");
    assert.ok(diagnostics.items.some((d) => d.code === Code.INVALID_ASSIGNMENT_TARGET));
  });

  it("recovers to report several syntax errors in one pass", () => {
    const { diagnostics } = parse("let a = 1 +\nlet b = 2 *\nlet c = 3");
    assert.ok(diagnostics.errors.length >= 2, `expected >=2 errors, got ${diagnostics.errors.length}`);
  });

  it("reports a missing initializer", () => {
    const { diagnostics } = parse("let x\n");
    assert.ok(diagnostics.items.some((d) => d.code === Code.EXPECTED_TOKEN));
  });
});

describe("parser: try/catch", () => {
  it("parses a guarded block and a handler", () => {
    const stmt = first("try { print(1) } catch err { print(err.code) }");
    assert.equal(stmt.type, NodeType.TryStmt);
    assert.equal(stmt.block.type, NodeType.Block);
    assert.equal(stmt.block.body.length, 1);
    assert.equal(stmt.handler.type, NodeType.Block);
    assert.equal(stmt.handler.body.length, 1);
  });

  it("binds the error name given after catch", () => {
    assert.equal(first("try { print(1) } catch problem { print(problem) }").param, "problem");
    assert.equal(first('try { print(1) } catch _ignored { print(1) }').param, "_ignored");
  });

  it("allows an empty guarded block or handler, and both empty", () => {
    const stmt = first("try {} catch err {}");
    assert.equal(stmt.block.body.length, 0);
    assert.equal(stmt.handler.body.length, 0);
    assert.equal(first("try {} catch err { print(err) }").block.body.length, 0);
    assert.equal(first("try { print(1) } catch err {}").handler.body.length, 0);
  });

  it("anchors the statement location at the try keyword", () => {
    const stmt = parseOk("let a = 1\ntry { print(1) } catch err { print(err) }").body[1];
    assert.equal(stmt.loc.line, 2);
    assert.equal(stmt.handler.loc.line, 2);
  });

  it("nests try statements, including a handler inside a guarded block", () => {
    const stmt = first(
      "try { try { print(1) } catch inner { print(inner) } } catch outer { print(outer) }",
    );
    assert.equal(stmt.param, "outer");
    assert.equal(stmt.block.body[0].type, NodeType.TryStmt);
    assert.equal(stmt.block.body[0].param, "inner");
  });

  it("accepts try inside a function body and a loop body", () => {
    const fn = first("fn guard() { try { return 1 } catch err { return 2 } }");
    assert.equal(fn.body.body[0].type, NodeType.TryStmt);
    const loop = first("while running { try { print(1) } catch err { break } }");
    assert.equal(loop.body.body[0].type, NodeType.TryStmt);
  });

  it("lets a line break fall between the handler and the catch keyword", () => {
    const ast = parseOk("try { print(1) }\ncatch err { print(err) }");
    assert.equal(ast.body.length, 1);
    assert.equal(ast.body[0].type, NodeType.TryStmt);
  });

  const malformed = {
    "a try block with no catch": "try { print(1) }",
    "a try with no block": "try print(1)",
    "a catch with no name": "try { print(1) } catch { print(2) }",
    "a catch name that is not an identifier": "try { print(1) } catch 1 { print(2) }",
    "a catch with no block": "try { print(1) } catch err",
    "a second catch clause": "try { print(1) } catch e { print(1) } catch f { print(2) }",
  };

  for (const [name, source] of Object.entries(malformed)) {
    it(`rejects ${name}`, () => {
      const { diagnostics } = parse(source);
      assert.equal(diagnostics.hasErrors, true, `expected ${source} to be rejected`);
      assert.ok(
        diagnostics.items.every((d) => d.code.startsWith("TYP2")),
        diagnostics.items.map((d) => d.toCompactString()).join("; "),
      );
    });
  }

  it("explains what is missing after the guarded block", () => {
    const { diagnostics } = parse("try { print(1) }");
    assert.ok(diagnostics.items.some((d) => d.code === Code.EXPECTED_TOKEN && /catch/.test(d.message)));
  });
});

describe("parser: nesting bound", () => {
  // Recursive descent spends host stack, so without a bound a small, valid-
  // looking source file can overflow the JavaScript stack and escape as a raw
  // `RangeError` instead of a diagnostic. These tests pin the guard down for
  // both shapes: source the parser recurses through, and source it does not.
  it("accepts ordinary nesting without complaint", () => {
    const depth = 40;
    const ast = parseOk("print(" + "(".repeat(depth) + "1" + ")".repeat(depth) + ")");
    assert.equal(ast.body.length, 1);
  });

  it("reports deeply nested parentheses as a diagnostic, not a crash", () => {
    const { diagnostics } = parse("print(" + "(".repeat(MAX_NESTING_DEPTH * 8) + "1" + ")".repeat(MAX_NESTING_DEPTH * 8) + ")");
    assert.equal(diagnostics.hasErrors, true);
    assert.equal(diagnostics.items[0].code, Code.NESTING_TOO_DEEP);
  });

  it("bounds a deep tree even when the parser built it with a loop", () => {
    // A long left-associative chain costs the parser no recursion depth, but
    // still produces a tree the later stages must walk recursively.
    const { diagnostics } = parse("print(1" + " + 1".repeat(MAX_NESTING_DEPTH * 8) + ")");
    assert.equal(diagnostics.items[0].code, Code.NESTING_TOO_DEEP);
  });

  it("bounds unary chains, which never pass through the expression entry", () => {
    const { diagnostics } = parse("print(" + "-".repeat(MAX_NESTING_DEPTH * 8) + "1)");
    assert.equal(diagnostics.items[0].code, Code.NESTING_TOO_DEEP);
  });
});
