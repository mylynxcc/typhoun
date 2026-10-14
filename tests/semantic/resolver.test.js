/**
 * Stage E — Semantic analysis tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Code } from "../../src/diagnostics/codes.js";
import { NodeType } from "../../src/ast/nodes.js";
import { check, codes, checkSource } from "../helpers.js";

const has = (source) => new Set(codes(source));

describe("semantic: name resolution", () => {
  it("accepts a well-formed program with no diagnostics", () => {
    const bag = check(`
      let a = 1
      const b = 2
      fn add(x, y) { return x + y }
      print(add(a, b))
    `);
    assert.equal(bag.length, 0, bag.items.map((d) => d.toCompactString()).join("; "));
  });

  it("reports undefined variables", () => {
    assert.ok(has("print(nope)").has(Code.UNDEFINED_VARIABLE));
  });

  it("accepts built-in names", () => {
    assert.equal(check("print(len([1,2]))").length, 0);
  });

  it("allows shadowing a built-in with a local declaration", () => {
    assert.equal(check("let print = 1\nprint + 1").length, 0);
  });

  it("allows hoisted function use before its declaration", () => {
    assert.equal(check("print(later(1))\nfn later(n) { return n }").length, 0);
  });

  it("rejects self-referential initializers", () => {
    assert.ok(has("let x = x").has(Code.USED_BEFORE_DECLARATION));
  });

  it("rejects reading a variable in its temporal dead zone", () => {
    assert.ok(has("let a = b\nlet b = 1").has(Code.USED_BEFORE_DECLARATION));
  });

  // Both execution engines must agree on what an assignment means. The
  // tree-walker looks a name up dynamically, so it cannot see a `let` that has
  // not run yet; the bytecode compiler reserves the slot up front. The
  // resolver settles the question before either of them runs, which is the
  // only way `x = 1` before `let x` can have one meaning instead of two.
  it("rejects assigning to a variable in its temporal dead zone", () => {
    assert.ok(has("{\n  x = 1\n  let x = 2\n}").has(Code.USED_BEFORE_DECLARATION));
  });

  it("rejects compound assignment to a variable in its temporal dead zone", () => {
    assert.ok(has("{\n  x += 1\n  let x = 2\n}").has(Code.USED_BEFORE_DECLARATION));
  });

  it("rejects an assignment aimed at a binding a later declaration shadows", () => {
    assert.ok(
      has("let x = 1\n{\n  x = 5\n  let x = 2\n  print(x)\n}").has(Code.USED_BEFORE_DECLARATION),
    );
  });

  it("still lets a closure assign to a binding declared later in its block", () => {
    assert.equal(check("fn set() { later = 1 }\nlet later = 0\nset()\nprint(later)").length, 0);
  });

  it("records binding information on identifiers", () => {
    const bag = check("let a = 1\na = 2");
    assert.equal(bag.length, 0);
  });
});

describe("semantic: declarations and scope", () => {
  it("rejects duplicate declarations in the same scope", () => {
    assert.ok(has("let a = 1\nlet a = 2").has(Code.DUPLICATE_DECLARATION));
  });

  it("allows shadowing in a nested scope", () => {
    assert.equal(check("let a = 1\n{ let a = 2\n print(a) }").length, 0);
  });

  it("rejects duplicate parameters", () => {
    assert.ok(has("fn f(a, a) { return a }").has(Code.DUPLICATE_PARAMETER));
  });

  it("rejects declaring a variable that collides with a parameter", () => {
    assert.ok(has("fn f(a) { let a = 1\n return a }").has(Code.DUPLICATE_DECLARATION));
  });

  it("does not leak block-scoped names outward", () => {
    assert.ok(has("{ let inner = 1 }\nprint(inner)").has(Code.UNDEFINED_VARIABLE));
  });
});

describe("semantic: assignment rules", () => {
  it("rejects assigning to a const", () => {
    assert.ok(has("const a = 1\na = 2").has(Code.CONST_REASSIGNMENT));
  });

  it("allows assigning to a let", () => {
    assert.equal(check("let a = 1\na = 2\na += 3").length, 0);
  });

  it("rejects assigning to a function binding", () => {
    assert.ok(has("fn f() { return 1 }\nf = 2").has(Code.CONST_REASSIGNMENT));
  });

  it("allows assigning into array elements and map entries", () => {
    assert.equal(check("let a = [1]\na[0] = 2\nlet m = { \"k\": 1 }\nm[\"k\"] = 2").length, 0);
  });

  it("infers const-ness through closures", () => {
    assert.ok(has("const x = 1\nfn f() { x = 2 }").has(Code.CONST_REASSIGNMENT));
  });
});

describe("semantic: control flow placement", () => {
  it("rejects return outside a function", () => {
    assert.ok(has("return 1").has(Code.RETURN_OUTSIDE_FUNCTION));
  });

  it("rejects break outside a loop", () => {
    assert.ok(has("break").has(Code.CONTROL_OUTSIDE_LOOP));
  });

  it("rejects continue outside a loop", () => {
    assert.ok(has("fn f() { continue }").has(Code.CONTROL_OUTSIDE_LOOP));
  });

  it("accepts break inside a loop nested in a function", () => {
    assert.equal(check("fn f() { while true { break } }").length, 0);
  });

  it("accepts return inside a nested block of a function", () => {
    assert.equal(check("fn f() { if true { return 1 } return 2 }").length, 0);
  });
});

describe("semantic: resolver annotations", () => {
  it("annotates resolved identifiers with binding information", () => {
    const { ast } = checkSource("let total = 1\nprint(total)", "<test>");
    const printCall = ast.body[1].expression;
    assert.equal(printCall.args[0].binding.kind, "let");
    assert.equal(printCall.callee.binding.kind, "global");
  });

  it("produces a Program node with one statement per declaration", () => {
    const { ast } = checkSource("let a = 1", "<test>");
    assert.equal(ast.type, NodeType.Program);
    assert.equal(ast.body.length, 1);
  });
});

describe("semantic: try/catch", () => {
  it("binds the caught error inside the handler only", () => {
    assert.equal(check("try { print(1) } catch err { print(err.code) }").length, 0);
    assert.ok(has("try { print(1) } catch err { print(1) }\nprint(err)").has(Code.UNDEFINED_VARIABLE));
  });

  it("annotates the caught error as an ordinary 'let' binding", () => {
    const { ast, diagnostics } = checkSource("try { print(1) } catch err { print(err) }", "<test>");
    assert.equal(diagnostics.hasErrors, false);
    const reference = ast.body[0].handler.body[0].expression.args[0];
    assert.equal(reference.binding.kind, "let");
    assert.equal(reference.binding.name, "err");
  });

  it("keeps the guarded block a scope of its own in both directions", () => {
    // Nothing declared while trying leaks into the handler…
    assert.ok(has("try { let x = 1 } catch err { print(x) }").has(Code.UNDEFINED_VARIABLE));
    // …and nothing the handler declares leaks past the statement.
    assert.ok(
      has("try { print(1) } catch err { let saved = err.code\n print(saved) }\nprint(saved)").has(
        Code.UNDEFINED_VARIABLE,
      ),
    );
  });

  it("reports undefined names anywhere inside the statement", () => {
    assert.ok(has("try { print(missing) } catch err { print(1) }").has(Code.UNDEFINED_VARIABLE));
    assert.ok(has("try { print(1) } catch err { print(missing) }").has(Code.UNDEFINED_VARIABLE));
  });

  it("does not confine break, continue or return to the try statement", () => {
    // A handler finishes the statement, not the loop or the function, so the
    // enclosing context is unchanged: the same rules that apply elsewhere apply
    // inside the guarded block and inside the handler.
    assert.ok(has("fn f() { try { break } catch err { print(1) } }").has(Code.CONTROL_OUTSIDE_LOOP));
    assert.ok(has("try { return 1 } catch err { print(1) }").has(Code.RETURN_OUTSIDE_FUNCTION));
    assert.equal(check("while true { try { print(1) } catch err { break } }").length, 0);
    assert.equal(check("fn f() { try { return 1 } catch err { return 2 } }").length, 0);
  });

  it("allows the error name to shadow an outer binding, and assigns to it freely", () => {
    assert.equal(check("let err = 1\ntry { print(err) } catch err { print(err.code) }").length, 0);
    assert.equal(check("try { print(1) } catch err { err = 2\n print(err) }").length, 0);
  });

  it("lets a nested handler reuse the enclosing handler's error name", () => {
    const source =
      "try { print(1) } catch err { try { print(2) } catch err { print(err.code) } }";
    assert.equal(check(source).length, 0);
  });

  it("sees enclosing bindings from inside a handler", () => {
    assert.equal(
      check("let seen = []\ntry { print(1) } catch err { push(seen, err.code) }\nprint(seen)").length,
      0,
    );
  });

  it("keeps the temporal-dead-zone rules inside the statement", () => {
    assert.ok(
      has("try { print(later) } catch err { print(1) }\nlet later = 1").has(
        Code.USED_BEFORE_DECLARATION,
      ),
    );
  });
});
