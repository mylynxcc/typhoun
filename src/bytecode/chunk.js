/**
 * Stage F₂ — Compiled code containers.
 *
 * A `Chunk` is both a compilation unit and a callable prototype: bytecode,
 * a constant pool, child prototypes and upvalue metadata. Keeping them in one
 * object mirrors the language's model (every chunk is a potential function
 * body) and keeps the VM's frame bookkeeping small.
 *
 * Bytecode is a flat `number[]` with a parallel `locs` array so a fault can be
 * reported against the exact source location that produced the instruction.
 * Jump offsets are relative to the instruction that follows the operand.
 */
import { OP_NAME, OP_OPERANDS } from "./opcodes.js";

export class Chunk {
  /**
   * @param {object} [init]
   * @param {string} [init.name]
   * @param {number} [init.arity]
   * @param {string[]} [init.paramNames]
   * @param {object|null} [init.loc]
   * @param {"script"|"function"} [init.type]
   */
  constructor(init = {}) {
    this.name = init.name ?? "<anonymous>";
    this.arity = init.arity ?? 0;
    this.paramNames = init.paramNames ?? [];
    this.loc = init.loc ?? null;
    this.type = init.type ?? "function";
    /** @type {number[]} */
    this.code = [];
    /** @type {Array<object|null>} */
    this.locs = [];
    /** @type {unknown[]} */
    this.constants = [];
    /** @type {Chunk[]} */
    this.functions = [];
    /** @type {string[]} */
    this.upvalueNames = [];
    /** @type {boolean[]} */
    this.upvalueFromLocal = [];
    /** @type {number[]} Source slot (local capture) or parent upvalue index. */
    this.upvalueIndex = [];
    this.upvalueCount = 0;
    /** High-water mark of simultaneously live slots, for reports. */
    this.slotCount = 0;
    /** @type {Map<string, number>} */
    this.constantIndex = new Map();
  }

  /**
   * Append an instruction.
   * @returns {number} the index of the opcode, for later jump patching.
   */
  emit(op, loc = null, ...operands) {
    const at = this.code.length;
    this.code.push(op);
    this.locs.push(loc ?? null);
    for (const operand of operands) {
      this.code.push(operand);
      this.locs.push(loc ?? null);
    }
    return at;
  }

  /** Emit an instruction whose single jump operand is patched later. */
  emitJump(op, loc = null) {
    return this.emit(op, loc, 0);
  }

  /**
   * Point a previously emitted jump at `target` (an absolute bytecode index).
   * Offsets are relative to the instruction that follows the jump operand, so
   * instructions carrying extra operands (e.g. ITER_NEXT) pass `nextIndex`.
   */
  patchJump(at, target, nextIndex = at + 2) {
    this.code[at + 1] = target - nextIndex;
  }

  /** The bytecode index a jump emitted at `at` currently resolves to. */
  jumpTarget(at, nextIndex = at + 2) {
    return this.code[at + 1] + nextIndex;
  }

  /** Intern a primitive constant, or append a fresh one. */
  addConstant(value) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const key = `${typeof value}:${String(value)}`;
      const existing = this.constantIndex.get(key);
      if (existing !== undefined) return existing;
      const index = this.constants.length;
      this.constants.push(value);
      this.constantIndex.set(key, index);
      return index;
    }
    this.constants.push(value);
    return this.constants.length - 1;
  }

  addFunction(proto) {
    this.functions.push(proto);
    return this.functions.length - 1;
  }

  /**
   * Record a captured variable.
   * @param {string} name
   * @param {boolean} fromLocal True when capturing a local of the enclosing
   *        function, false when inheriting an upvalue from it.
   * @param {number} index Slot in the enclosing frame, or index of the
   *        enclosing function's upvalue.
   */
  declareUpvalue(name, fromLocal, index) {
    this.upvalueNames.push(name);
    this.upvalueFromLocal.push(fromLocal);
    this.upvalueIndex.push(index);
    this.upvalueCount += 1;
    return this.upvalueCount - 1;
  }

  /** Total bytes of bytecode (useful for reports and tests). */
  get instructionBytes() {
    return this.code.length;
  }

  /**
   * Decode the stream into structured instructions. Used by the disassembler
   * and by tests that assert on emitted bytecode.
   * @returns {Array<{ offset: number, op: number, name: string, operands: number[], loc: object|null, size: number }>}
   */
  decode() {
    const out = [];
    let offset = 0;
    while (offset < this.code.length) {
      const op = this.code[offset];
      const operandCount = OP_OPERANDS[op];
      if (operandCount === undefined) {
        out.push({
          offset,
          op,
          name: `<invalid:${op}>`,
          operands: [],
          loc: this.locs[offset] ?? null,
          size: 1,
        });
        offset += 1;
        continue;
      }
      const operands = [];
      for (let i = 0; i < operandCount; i += 1) operands.push(this.code[offset + 1 + i]);
      const size = 1 + operandCount;
      out.push({
        offset,
        op,
        name: OP_NAME[op],
        operands,
        loc: this.locs[offset] ?? null,
        size,
      });
      offset += size;
    }
    return out;
  }
}

/** Walk a prototype tree, yielding every chunk including the root. */
export function walkChunks(chunk, visit, depth = 0) {
  visit(chunk, depth);
  for (const child of chunk.functions) walkChunks(child, visit, depth + 1);
}

/** Count prototypes, instructions and constants in a tree. */
export function chunkStats(root) {
  const stats = { chunks: 0, instructions: 0, bytes: 0, constants: 0, upvalues: 0, slots: 0 };
  walkChunks(root, (chunk) => {
    stats.chunks += 1;
    stats.instructions += chunk.decode().length;
    stats.bytes += chunk.instructionBytes;
    stats.constants += chunk.constants.length;
    stats.upvalues += chunk.upvalueCount;
    stats.slots += chunk.slotCount;
  });
  return stats;
}
