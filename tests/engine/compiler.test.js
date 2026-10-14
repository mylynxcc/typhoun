/**
 * Stage F₂ — Bytecode compiler tests.
 *
 * These assert on the emitted bytecode itself (via `Chunk.decode()`), which is
 * what makes the compiler reviewable: a change in code generation has to be
 * reflected here deliberately.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../../src/main/index.js";
import { BINDING_KINDS } from "../../src/bytecode/opcodes.js";
import { chunkStats } from "../../src/bytecode/chunk.js";

function compile(source) {
  return compileSource(source, "<compile-test>").proto;
}

/** Opcode names in order. */
function ops(source) {
  return compile(source)
    .decode()
    .map((instruction) => instruction.name);
}

/** Absolute jump targets, resolved the same way the VM resolves them. */
function jumpTargets(chunk) {
  return chunk
    .decode()
    .filter((instruction) => instruction.name.startsWith("JUMP") || instruction.name === "ITER_NEXT")
    .map((instruction) => ({
      from: instruction.offset,
      to: instruction.offset + instruction.size + instruction.operands[0],
    }));
}

describe("compiler: top level", () => {
  it("lowers let and const to global definitions with the declared kind", () => {
    const chunk = compile("let a = 1\nconst b = 2\n");
    const decoded = chunk.decode();
    assert.deepEqual(
      decoded.map((i) => i.name),
      ["CONST", "DEF_GLOBAL", "CONST", "DEF_GLOBAL", "NULL", "RETURN"],
    );
    assert.equal(chunk.constants[decoded[1].operands[0]], "a");
    assert.equal(BINDING_KINDS[decoded[1].operands[1]], "let");
    assert.equal(chunk.constants[decoded[3].operands[0]], "b");
    assert.equal(BINDING_KINDS[decoded[3].operands[1]], "const");
  });

  it("hoists function declarations ahead of the statements that call them", () => {
    const decoded = compile("print(f())\nfn f() { return 1 }\n").decode();
    const callIndex = decoded.findIndex((i) => i.name === "GET_GLOBAL" && i.operands[0] !== undefined);
    const hoistIndex = decoded.findIndex((i) => i.name === "HOIST_FN");
    assert.ok(hoistIndex !== -1, "expected a HOIST_FN instruction");
    assert.ok(hoistIndex < callIndex, "the function must exist before it is called");
  });

  it("interns repeated primitive constants", () => {
    const chunk = compile('print("x", "x", 1, 1)');
    assert.equal(chunk.constants.filter((c) => c === "x").length, 1);
    assert.equal(chunk.constants.filter((c) => c === 1).length, 1);
  });

  it("ends every chunk with an implicit null return", () => {
    assert.deepEqual(ops("let a = 1").slice(-2), ["NULL", "RETURN"]);
  });
});

describe("compiler: slots and scopes", () => {
  it("gives each function parameter its own slot and reserves the rest", () => {
    const fn = compile("fn f(a, b) { let c = 1 }\n").functions[0];
    const decoded = fn.decode();
    assert.deepEqual(fn.paramNames, ["a", "b"]);
    assert.equal(fn.arity, 2);
    assert.deepEqual(
      decoded.filter((i) => i.name === "RESERVE").map((i) => i.operands[0]),
      [1],
    );
    assert.deepEqual(
      decoded.filter((i) => i.name === "DEF_LOCAL").map((i) => i.operands[0]),
      [2],
    );
  });

  it("declares block locals up front so a hoisted function can see them", () => {
    const fn = compile("fn outer() {\n  fn g() { return x }\n  let x = 5\n  return g()\n}\n").functions[0];
    // Pass one declares function declarations first, then variables.
    assert.equal(fn.slotCount, 2);
    const g = fn.functions[0];
    assert.equal(g.upvalueCount, 1);
    assert.equal(g.upvalueNames[0], "x");
    assert.equal(g.upvalueIndex[0], 1, "x is declared after the hoisted function");
  });

  it("reuses slots across sibling blocks", () => {
    const fn = compile("fn f() {\n  { let a = 1 }\n  { let b = 2 }\n}\n").functions[0];
    assert.deepEqual(
      fn.decode()
        .filter((i) => i.name === "DEF_LOCAL")
        .map((i) => i.operands[0]),
      [0, 0],
    );
    assert.equal(fn.slotCount, 1, "only one slot is live at a time");
  });

  it("counts a function-expression self binding as a slot", () => {
    const fn = compile("let f = fn fact(n) { return n }\n").functions[0];
    assert.equal(fn.name, "fact");
    assert.deepEqual(
      fn.decode().map((i) => i.name).slice(0, 2),
      ["RESERVE", "SELF"],
    );
    assert.equal(fn.slotCount, 2, "one parameter plus the self binding");
  });
});

describe("compiler: closures and upvalues", () => {
  it("captures a local by slot", () => {
    const outer = compile("fn outer() {\n  let x = 7\n  fn inner() { return x }\n  return inner()\n}\n")
      .functions[0];
    const inner = outer.functions[0];
    assert.equal(inner.upvalueCount, 1);
    assert.deepEqual(inner.upvalueNames, ["x"]);
    assert.deepEqual(inner.upvalueFromLocal, [true]);
    assert.equal(inner.upvalueIndex[0], 1);
    assert.ok(
      outer.decode().some((i) => i.name === "CLOSURE"),
      "the enclosing function creates the closure",
    );
  });

  it("inherits an upvalue through an intervening function", () => {
    const a = compile(
      "fn a() {\n  let x = 1\n  fn b() {\n    fn c() { return x }\n    return c()\n  }\n  return b()\n}\n",
    ).functions[0];
    const b = a.functions[0];
    const c = b.functions[0];
    assert.deepEqual(b.upvalueFromLocal, [true]);
    assert.deepEqual(c.upvalueFromLocal, [false], "c inherits rather than capturing a local");
    assert.equal(c.upvalueIndex[0], 0, "it refers to b's first upvalue");
  });

  it("captures the same variable once, however often it is read", () => {
    const inner = compile("fn outer() {\n  let x = 1\n  fn inner() { return x + x }\n  return inner()\n}\n")
      .functions[0].functions[0];
    assert.equal(inner.upvalueCount, 1);
  });

  it("takes an upvalue for a parameter", () => {
    const inner = compile("fn outer(p) {\n  fn inner() { return p }\n  return inner()\n}\n").functions[0]
      .functions[0];
    assert.deepEqual(inner.upvalueFromLocal, [true]);
    assert.equal(inner.upvalueIndex[0], 0);
  });
});

describe("compiler: control flow", () => {
  it("targets instruction boundaries for every jump", () => {
    const chunk = compile(`
      let i = 0
      while i < 5 {
        if i == 2 { break }
        if i == 1 { continue }
        i += 1
      }
      for k in [1, 2] { print(k) }
      for (let j = 0; j < 2; j += 1) { print(j) }
      if i > 1 { print("big") } else { print("small") }
    `);
    const starts = new Set(chunk.decode().map((i) => i.offset));
    const targets = jumpTargets(chunk);
    assert.ok(targets.length >= 6, "expected several jumps");
    for (const { from, to } of targets) {
      assert.ok(to >= 0 && to <= chunk.code.length, `jump from ${from} left the chunk (${to})`);
      assert.ok(starts.has(to), `jump from ${from} did not land on an instruction boundary (${to})`);
    }
  });

  it("compiles a while loop as a backward jump to the test", () => {
    const chunk = compile("let i = 0\nwhile i < 3 { i += 1 }");
    const backward = jumpTargets(chunk).filter(({ from, to }) => to < from);
    assert.equal(backward.length, 1, "exactly one back edge");
  });

  it("short-circuits and/or while preserving the operand value", () => {
    assert.deepEqual(ops("let a = true and false").slice(0, 3), ["TRUE", "JUMP_IF_FALSE", "POP"]);
    assert.deepEqual(ops("let a = true or false").slice(0, 3), ["TRUE", "JUMP_IF_TRUE", "POP"]);
  });

  it("duplicates object and index for compound element assignment", () => {
    assert.ok(ops("let a = [1]\na[0] += 1").includes("DUP2"));
  });

  it("unwinds and closes slots when breaking out of a nested block", () => {
    const fn = compile(
      "fn f() {\n  while true {\n    let x = 1\n    fn g() { return x }\n    { if x == 1 { break } }\n  }\n  return 0\n}\n",
    ).functions[0];
    const names = fn.decode().map((i) => i.name);
    const closeIndex = names.indexOf("CLOSE_DOWN");
    assert.ok(closeIndex !== -1, "captured slots must be closed on the way out");
    assert.equal(names[closeIndex + 1], "DROP", "and the frame must be unwound");
  });

  it("compiles a continue in a for-in loop as a jump back to the iterator step", () => {
    const chunk = compile("for x in [1, 2] {\n  if x == 1 { continue }\n  print(x)\n}");
    const names = chunk.decode().map((i) => i.name);
    assert.ok(names.includes("ITER_PREP"));
    assert.ok(names.includes("ITER_NEXT"));
    assert.ok(names.includes("CLOSE_DOWN"), "the iterator slot is unwound at the end of the loop");
    const targets = jumpTargets(chunk);
    const toIteratorStep = targets.filter(({ from, to }) => to < from);
    assert.equal(toIteratorStep.length, 2, "continue and the loop back edge");
  });
});

describe("compiler: structure", () => {
  it("decodes exactly the bytes it emitted", () => {
    const chunk = compile("fn fib(n) {\n  if n < 2 { return n }\n  return fib(n - 1) + fib(n - 2)\n}\nprint(fib(5))\n");
    const decoded = chunk.decode();
    const covered = decoded.reduce((total, i) => total + i.size, 0);
    assert.equal(covered, chunk.code.length);
    assert.equal(
      decoded.reduce((max, i) => Math.max(max, i.offset + i.size), 0),
      chunk.code.length,
    );
  });

  it("reports a prototype tree summary", () => {
    const stats = chunkStats(compile("fn a() { return 1 }\nfn b() { return a() }\nprint(b())"));
    assert.equal(stats.chunks, 3);
    assert.ok(stats.instructions > 10);
    assert.equal(stats.bytes > 0, true);
  });

  it("compiles every node kind the parser can produce", () => {
    const programs = [
      "let a = 1",
      "const b = null",
      "let c = true",
      'let d = "s"',
      "let e = [1, 2, { \"k\": [null] }]",
      "let f = { \"k\": 1 }",
      "let g = -1",
      "let h = not true",
      "let i = 1 + 2 * 3 - 4 / 5 % 6",
      "let j = 1 < 2 and 3 >= 2 or 1 != 0",
      "let k = (1)",
      "let l = print",
      "fn m(x) { let y = x\n return y }",
      "let n = fn (x) { return x }",
      "let o = fn rec(x) { if x < 1 { return 0 }\n return rec(x - 1) }",
      "if 1 > 0 { print(1) } else if 2 > 1 { print(2) } else { print(3) }",
      "while false { break }",
      "for x in [1] { continue }",
      "for (let i = 0; i < 1; i += 1) { print(i) }",
      "let p = 0\np += 1\np -= 1\np *= 2\np /= 2",
      "let q = [1]\nq[0] = 2\nq[0] += 3",
      "print([1, 2][0])",
      "{\n  let inner = 1\n  print(inner)\n}",
      "assert(true)",
    ];
    for (const source of programs) {
      assert.doesNotThrow(() => compile(source), `failed to compile: ${source}`);
    }
  });
});

describe("compiler: try/catch", () => {
  /** Index of the first instruction with this name. */
  const at = (decoded, name) => decoded.findIndex((instruction) => instruction.name === name);

  it("wraps the guarded block in a region and jumps over the handler", () => {
    assert.deepEqual(ops("try { print(1) } catch err { print(2) }"), [
      "RESERVE",
      "TRY_BEGIN",
      "GET_GLOBAL",
      "CONST",
      "CALL",
      "POP",
      "TRY_END",
      "JUMP",
      "GET_GLOBAL",
      "CONST",
      "CALL",
      "POP",
      "CLOSE_DOWN",
      "DROP",
      "NULL",
      "RETURN",
    ]);
  });

  it("points TRY_BEGIN at the handler, which the normal path jumps over", () => {
    const chunk = compile("try { print(1) } catch err { print(2) }");
    const decoded = chunk.decode();
    const begin = decoded[at(decoded, "TRY_BEGIN")];
    const handler = begin.offset + begin.size + begin.operands[0];
    const jump = decoded[at(decoded, "JUMP")];

    assert.ok(
      decoded.some((instruction) => instruction.offset === handler),
      "the handler must start on an instruction boundary",
    );
    // The normal path leaves the region through the jump, which lands exactly
    // after the handler: falling into a handler must be impossible.
    assert.equal(jump.offset + jump.size, handler);
    const afterHandler = jump.offset + jump.size + jump.operands[0];
    assert.ok(afterHandler > handler, "the jump must clear the handler");
    assert.ok(afterHandler <= chunk.code.length);
  });

  it("reserves a frame slot for the caught error before opening the region", () => {
    const chunk = compile("try { print(1) } catch err { print(err) }");
    const decoded = chunk.decode();
    const reserve = at(decoded, "RESERVE");
    const begin = at(decoded, "TRY_BEGIN");
    assert.equal(reserve, begin - 1, "the slot must exist before the region opens");

    const slot = decoded[begin].operands[1];
    assert.ok(slot >= 0 && slot < chunk.slotCount, "the error needs a real frame slot");

    // The handler reads its name from exactly that slot, and nothing else in
    // the handler is given the same index by accident.
    const handler = decoded[begin].offset + decoded[begin].size + decoded[begin].operands[0];
    const inHandler = decoded.filter((instruction) => instruction.offset >= handler);
    assert.equal(inHandler[0].name, "GET_GLOBAL");
    assert.equal(inHandler[1].name, "GET_LOCAL");
    assert.equal(inHandler[1].operands[0], slot);
  });

  it("keeps the error slot separate from the locals of the guarded block", () => {
    const chunk = compile("try { let a = 1\n print(a) } catch err { print(err) }");
    const decoded = chunk.decode();
    const errorSlot = decoded.find((instruction) => instruction.name === "TRY_BEGIN").operands[1];
    const localSlot = decoded.find((instruction) => instruction.name === "DEF_LOCAL").operands[0];
    assert.notEqual(localSlot, errorSlot, "the caught error must not overwrite a local");
    assert.ok(chunk.slotCount >= 2, "the error and the local both need a slot");
    assert.ok(localSlot < chunk.slotCount && errorSlot < chunk.slotCount);
  });

  it("nests regions, opening and closing them in order", () => {
    const decoded = compile(
      "try { try { print(1) } catch inner { print(2) } } catch outer { print(3) }",
    ).decode();
    const names = decoded.map((instruction) => instruction.name);
    assert.equal(names.filter((name) => name === "TRY_BEGIN").length, 2);
    assert.equal(names.filter((name) => name === "TRY_END").length, 2);
    const begins = decoded.filter((i) => i.name === "TRY_BEGIN").map((i) => i.offset);
    const ends = decoded.filter((i) => i.name === "TRY_END").map((i) => i.offset);
    assert.ok(begins[0] < begins[1], "the outer region opens first");
    assert.ok(begins[1] < ends[0], "the inner region opens inside the outer one");
    assert.ok(ends[0] < ends[1], "the inner region closes first");
    // Two distinct slots: one error value per region.
    const slots = decoded
      .filter((i) => i.name === "TRY_BEGIN")
      .map((i) => i.operands[1]);
    assert.equal(new Set(slots).size, 2);
  });

  it("closes the region on every path that leaves it", () => {
    // The normal path emits its TRY_END, and a jump out of the region (a
    // `break`, `continue` or `return`) emits one more, so the runtime handler
    // chain is balanced however the statement is left.
    const looping = compile("while true { try { break } catch err { print(1) } }").decode();
    const loopNames = looping.map((i) => i.name);
    assert.equal(loopNames.filter((name) => name === "TRY_BEGIN").length, 1);
    assert.equal(loopNames.filter((name) => name === "TRY_END").length, 2);

    const returning = compile("fn f() { try { return 1 } catch err { return 2 } }").functions[0].decode();
    const returnNames = returning.map((i) => i.name);
    assert.equal(returnNames.filter((name) => name === "TRY_BEGIN").length, 1);
    assert.equal(returnNames.filter((name) => name === "TRY_END").length, 2);
  });

  it("evaluates a returned value inside the region, then leaves it", () => {
    const fn = compile("fn f() { try { return 1 / 0 } catch err { return 2 } }").functions[0];
    const names = fn.decode().map((instruction) => instruction.name);
    const end = names.indexOf("TRY_END");
    assert.deepEqual(names.slice(0, end + 2), ["RESERVE", "TRY_BEGIN", "CONST", "CONST", "DIV", "TRY_END", "RETURN"]);
  });

  it("keeps a try statement inside a loop body balanced across iterations", () => {
    const chunk = compile(
      "for n in [1, 0] {\n  try { print(10 / n) } catch err { print(err.code) }\n}",
    );
    const names = chunk.decode().map((i) => i.name);
    assert.equal(names.filter((name) => name === "TRY_BEGIN").length, 1);
    assert.equal(names.filter((name) => name === "TRY_END").length, 1);
  });
});
