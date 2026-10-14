/**
 * Stage F₂ — Structurally verified bytecode.
 *
 * Rather than asserting on individual instruction sequences, these tests check
 * the *invariants* a valid chunk must satisfy, and they check them for every
 * program in the repository: the examples, the benchmarks and the test
 * fixtures. That is a much wider net than a handful of hand-written cases, and
 * it catches the class of bug that is hardest to see by reading code — a jump
 * that lands one byte off, a slot index that escapes its frame, an upvalue that
 * points at the wrong parent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFile, compileSource } from "../../src/main/index.js";
import { OP_NAME } from "../../src/bytecode/opcodes.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const SLOT_OPS = new Set(["GET_LOCAL", "SET_LOCAL", "DEF_LOCAL", "SELF"]);
const UPVALUE_OPS = new Set(["GET_UPVALUE", "SET_UPVALUE"]);
const GLOBAL_OPS = new Set(["GET_GLOBAL", "SET_GLOBAL", "HOIST_FN"]);
const JUMP_OPS = (name) => name.startsWith("JUMP") || name === "ITER_NEXT";

function collect(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collect(full);
    return entry.endsWith(".typ") ? [full] : [];
  });
}

/** Every `.typ` file shipped in the repository. */
const corpus = [
  ...collect(join(root, "examples")),
  ...collect(join(root, "benchmarks")),
  ...collect(join(root, "tests", "fixtures")),
].sort();

/**
 * Check every structural property a valid prototype tree must satisfy.
 * @returns {string[]} human-readable violations (empty when valid)
 */
function violations(rootChunk, label) {
  const problems = [];

  const visit = (chunk, parent) => {
    const decoded = chunk.decode();
    const starts = new Set(decoded.map((instruction) => instruction.offset));
    const where = `${label} :: ${chunk.name}`;

    const covered = decoded.reduce((total, instruction) => total + instruction.size, 0);
    if (covered !== chunk.code.length) {
      problems.push(`${where}: decoded ${covered} of ${chunk.code.length} bytes`);
    }

    for (const instruction of decoded) {
      const { name, operands, offset } = instruction;

      if (instruction.op === 0 || OP_NAME[instruction.op] === undefined) {
        problems.push(`${where}: invalid opcode ${instruction.op} at ${offset}`);
        continue;
      }

      if (JUMP_OPS(name)) {
        const target = offset + instruction.size + operands[0];
        if (target < 0 || target > chunk.code.length) {
          problems.push(`${where}: ${name} at ${offset} leaves the chunk (${target})`);
        } else if (!starts.has(target)) {
          problems.push(`${where}: ${name} at ${offset} lands mid-instruction (${target})`);
        }
      }

      if (name === "TRY_BEGIN") {
        // Operand 0 is the handler's offset, relative to the end of this
        // instruction, so the handler must start on a real instruction
        // boundary; operand 1 is the frame slot the caught error lands in.
        const target = offset + instruction.size + operands[0];
        if (target > chunk.code.length || !starts.has(target)) {
          problems.push(`${where}: TRY_BEGIN at ${offset} does not land on a handler (${target})`);
        }
        const slot = operands[1];
        if (slot < 0 || slot >= Math.max(1, chunk.slotCount)) {
          problems.push(`${where}: error slot ${slot} outside a frame of ${chunk.slotCount} at ${offset}`);
        }
      }
      if (name === "CONST" || name === "GET_GLOBAL" || name === "SET_GLOBAL" || name === "HOIST_FN") {
        if (operands[0] < 0 || operands[0] >= chunk.constants.length) {
          problems.push(`${where}: constant ${operands[0]} out of range at ${offset}`);
        }
      }
      if (name === "DEF_GLOBAL") {
        if (operands[0] < 0 || operands[0] >= chunk.constants.length) {
          problems.push(`${where}: global name constant out of range at ${offset}`);
        } else if (typeof chunk.constants[operands[0]] !== "string") {
          problems.push(`${where}: DEF_GLOBAL name is not a string at ${offset}`);
        }
      }
      if (name === "IMPORT") {
        if (operands[0] < 0 || operands[0] >= chunk.constants.length) {
          problems.push(`${where}: import path constant out of range at ${offset}`);
        }
        if (operands[1] >= chunk.constants.length) {
          problems.push(`${where}: import alias constant out of range at ${offset}`);
        }
      }
      if (SLOT_OPS.has(name)) {
        // A slot is an index, so the largest legal value is slotCount - 1.
        const slot = operands[0];
        if (slot < 0 || slot >= Math.max(1, chunk.slotCount)) {
          problems.push(`${where}: slot ${slot} outside a frame of ${chunk.slotCount} at ${offset}`);
        }
      }
      if (name === "CLOSE_DOWN") {
        // CLOSE_DOWN takes a count, not an index.
        const slot = operands[0];
        if (slot < 0 || slot > chunk.slotCount) {
          problems.push(`${where}: CLOSE_DOWN ${slot} outside a frame of ${chunk.slotCount} at ${offset}`);
        }
      }
      if (UPVALUE_OPS.has(name)) {
        const index = operands[0];
        if (index < 0 || index >= chunk.upvalueCount) {
          problems.push(`${where}: upvalue ${index} out of range at ${offset}`);
        }
      }
      if (name === "CLOSURE") {
        const child = chunk.functions[operands[0]];
        if (!child) {
          problems.push(`${where}: CLOSURE refers to a missing prototype`);
          continue;
        }
        for (let i = 0; i < child.upvalueCount; i += 1) {
          const index = child.upvalueIndex[i];
          const bound = child.upvalueFromLocal[i] ? Math.max(1, chunk.slotCount) : chunk.upvalueCount;
          if (index < 0 || index >= bound) {
            problems.push(
              `${where}: capture of ${child.upvalueNames[i]} uses ${index}, outside ${bound} (parent ${parent ? parent.name : "none"})`,
            );
          }
        }
      }
      if (name === "ARRAY" || name === "MAP" || name === "CALL" || name === "RESERVE") {
        if (operands[0] < 0) problems.push(`${where}: negative count operand at ${offset}`);
      }
    }

    if (chunk.arity !== chunk.paramNames.length) {
      problems.push(`${where}: arity ${chunk.arity} does not match ${chunk.paramNames.length} parameters`);
    }
    if (chunk.slotCount < chunk.arity) {
      problems.push(`${where}: slotCount ${chunk.slotCount} is below arity ${chunk.arity}`);
    }
    if (chunk.upvalueNames.length !== chunk.upvalueCount || chunk.upvalueIndex.length !== chunk.upvalueCount) {
      problems.push(`${where}: upvalue metadata arrays are inconsistent`);
    }
    const last = decoded[decoded.length - 1];
    if (!last || last.name !== "RETURN") {
      problems.push(`${where}: chunk does not end with RETURN`);
    }

    for (const child of chunk.functions) visit(child, chunk);
  };

  visit(rootChunk, null);
  return problems;
}

/**
 * Compile a file the way the CLI does, following its imports, and check every
 * prototype in the resulting graph. Files that are *supposed* to be rejected
 * (the error fixtures) must fail with a real diagnostic instead.
 */
function checkWholeProgram(path, label) {
  let compiled;
  try {
    compiled = compileFile(path);
  } catch (err) {
    assert.ok(
      Array.isArray(err.diagnostics) && err.diagnostics.length > 0,
      `${label} failed without a diagnostic: ${err.message}`,
    );
    return { rejected: true, modules: 0 };
  }
  for (const [absPath, proto] of compiled.protos) {
    const moduleLabel = `${label} [${absPath.slice(root.length + 1)}]`;
    assert.deepEqual(violations(proto, moduleLabel), []);
  }
  return { rejected: false, modules: compiled.protos.size };
}

describe("bytecode invariants: shipped programs", () => {
  it("has a corpus to check", () => {
    assert.ok(corpus.length >= 20, `expected a corpus, found ${corpus.length}`);
  });

  for (const file of corpus) {
    const label = file.slice(root.length + 1);
    it(`holds for ${label}`, () => {
      checkWholeProgram(file, label);
    });
  }
});

describe("bytecode invariants: nested constructs", () => {
  const programs = [
    "fn f() {\n  let a = 1\n  {\n    let b = 2\n    {\n      let c = 3\n      return a + b + c\n    }\n  }\n}\nprint(f())",
    "fn outer(a, b) {\n  fn middle() {\n    fn inner() { return a + b }\n    return inner\n  }\n  return middle()\n}\nprint(outer(1, 2)())",
    "let fns = []\nfor i in range(0, 6) {\n  let level = i\n  if i % 2 == 0 {\n    let doubled = level * 2\n    push(fns, fn () { return doubled })\n  } else {\n    push(fns, fn () { return level })\n  }\n}\nprint(len(fns))",
    "for (let i = 0; i < 4; i += 1) {\n  for (let j = 0; j < 4; j += 1) {\n    if j == 2 { break }\n    if i == 3 { continue }\n  }\n}",
    'while true {\n  let x = 1\n  fn g() { return x }\n  if g() > 0 { break }\n}\nprint("done")',
    'let m = { "a": [1, { "b": [2] }] }\nfor k in m { print(k, m[k]) }\nfor v in m["a"] { print(v) }',
    "fn any(items, pred) {\n  for item in items {\n    if pred(item) { return true }\n  }\n  return false\n}\nprint(any([1, 2], fn (x) { return x > 1 }))",
    "let a = 0\nfor x in [1, 2, 3] {\n  for y in [4, 5] {\n    if y == 5 { break }\n    a += x * y\n  }\n}\nprint(a)",
    "fn deep(n) {\n  if n <= 0 { return 0 }\n  let local = n\n  return local + deep(n - 1)\n}\nprint(deep(4))",
    'try {\n  let a = 1\n  print(a)\n} catch err {\n  print(err.code)\n}',
    'fn guarded(n) {\n  try {\n    if n == 0 { return 1 / 0 }\n    return n\n  } catch err {\n    return -1\n  }\n}\nprint(guarded(0), guarded(2))',
    'for n in [1, 0, 2] {\n  try {\n    print(10 / n)\n  } catch err {\n    print("skipped")\n  }\n}',
    'try {\n  try {\n    assert(false, "inner")\n  } catch inner {\n    assert(false, "outer")\n  }\n} catch outer {\n  print(outer.code)\n}',
    'while true {\n  try {\n    let x = 1\n    break\n  } catch err {\n    continue\n  }\n}',
    'fn make() {\n  let n = 0\n  let counter = fn () { n += 1\n    return n }\n  try {\n    counter()\n  } catch err {}\n  return counter\n}\nprint(make()())',
    'try {\n  let helper = fn (n) { return n / 0 }\n  print(helper(1))\n} catch err {\n  print(len(err.stack), err.location.line)\n}',
  ];

  for (const source of programs) {
    it("holds for a program with nested scopes", () => {
      const { proto } = compileSource(source, "<invariants>");
      assert.deepEqual(violations(proto, "<invariants>"), []);
    });
  }
});

describe("bytecode invariants: the checker itself", () => {
  const source = "while true {\n  let x = 1\n  if x > 0 { break }\n}";

  it("accepts a valid chunk", () => {
    const { proto } = compileSource(source, "<probe>");
    assert.deepEqual(violations(proto, "<probe>"), []);
  });

  it("rejects a jump beyond the end of the chunk", () => {
    const { proto } = compileSource(source, "<probe>");
    const jump = proto.decode().find((i) => i.name === "JUMP");
    const operand = jump.offset + 1;
    const saved = proto.code[operand];
    proto.code[operand] = 9999;
    assert.ok(
      violations(proto, "<probe>").some((problem) => /leaves the chunk/.test(problem)),
      "a runaway jump must be reported",
    );
    proto.code[operand] = saved;
  });

  it("rejects a jump that lands mid-instruction", () => {
    const { proto } = compileSource(source, "<probe>");
    const jump = proto.decode().find((i) => i.name === "JUMP");
    const operand = jump.offset + 1;
    const saved = proto.code[operand];
    // Aim one byte short of a real instruction boundary.
    proto.code[operand] = jump.operands[0] - 1;
    assert.ok(
      violations(proto, "<probe>").some((problem) => /mid-instruction/.test(problem)),
      "a misaligned jump must be reported",
    );
    proto.code[operand] = saved;
  });

  it("rejects a slot outside the frame", () => {
    const { proto } = compileSource(source, "<probe>");
    const local = proto.decode().find((i) => i.name === "GET_LOCAL");
    const saved = proto.code[local.offset + 1];
    proto.code[local.offset + 1] = saved + 99;
    assert.ok(violations(proto, "<probe>").some((problem) => /outside a frame/.test(problem)));
    proto.code[local.offset + 1] = saved;
  });

  it("rejects a chunk that does not return", () => {
    const { proto } = compileSource(source, "<probe>");
    proto.code.pop(); // remove the RETURN opcode
    assert.ok(violations(proto, "<probe>").some((problem) => /does not end with RETURN/.test(problem)));
  });
});
