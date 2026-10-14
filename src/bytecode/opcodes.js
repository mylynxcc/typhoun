/**
 * Stage F₂ — Bytecode instruction set.
 *
 * The compiler emits a flat array of integers: one opcode followed by its
 * inline operands. Opcodes start at 1 so that `0` (a plausible uninitialised
 * slot or a truncated stream) is always an invalid instruction and shows up in
 * the disassembler instead of silently decoding as something else.
 *
 * Operand kinds used below:
 *   - a constant index (into `chunk.constants`)
 *   - a slot index (a position inside the current call frame)
 *   - an upvalue index (inside the current closure)
 *   - a relative jump offset (always forward or backward from the *next*
 *     instruction, so a jump of 0 means "fall through")
 *   - a raw count
 */

/** @type {Array<[string, number]>} opcode name and inline operand count. */
const TABLE = [
  ["CONST", 1],
  ["NULL", 0],
  ["TRUE", 0],
  ["FALSE", 0],
  ["POP", 0],
  ["DUP2", 0],
  ["RESERVE", 1],
  ["DROP", 1],
  ["DEF_LOCAL", 1],
  ["SET_LOCAL", 1],
  ["GET_LOCAL", 1],
  ["DEF_GLOBAL", 2],
  ["HOIST_FN", 1],
  ["SET_GLOBAL", 1],
  ["GET_GLOBAL", 1],
  ["GET_UPVALUE", 1],
  ["SET_UPVALUE", 1],
  ["CLOSE_DOWN", 1],
  ["SELF", 1],
  ["CLOSURE", 1],
  ["CALL", 1],
  ["RETURN", 0],
  ["ADD", 0],
  ["SUB", 0],
  ["MUL", 0],
  ["DIV", 0],
  ["MOD", 0],
  ["NEG", 0],
  ["NOT", 0],
  ["EQ", 0],
  ["NEQ", 0],
  ["LT", 0],
  ["LE", 0],
  ["GT", 0],
  ["GE", 0],
  ["JUMP", 1],
  ["JUMP_IF_FALSE", 1],
  ["JUMP_IF_TRUE", 1],
  ["JUMP_IF_FALSE_POP", 1],
  ["JUMP_IF_TRUE_POP", 1],
  ["ARRAY", 1],
  ["MAP", 1],
  ["INDEX", 0],
  ["SET_INDEX", 0],
  ["ITER_PREP", 0],
  ["ITER_NEXT", 2],
  ["IMPORT", 2],
  ["TRY_BEGIN", 2],
  ["TRY_END", 0],
];

/** Opcode constants, e.g. `OP.GET_LOCAL`. */
export const OP = {};

/** Human-readable name per opcode, indexed by opcode number. */
export const OP_NAME = [];

/** Number of inline operands per opcode, indexed by opcode number. */
export const OP_OPERANDS = [];

for (let i = 0; i < TABLE.length; i += 1) {
  const [name, operands] = TABLE[i];
  const code = i + 1;
  OP[name] = code;
  OP_NAME[code] = name;
  OP_OPERANDS[code] = operands;
}

/** Highest valid opcode. */
export const OP_MAX = TABLE.length;

/** Binding kinds stored in the global environment, indexed by a compiler operand. */
export const BINDING_KINDS = Object.freeze(["let", "const", "fn", "param", "import"]);

export const KIND_INDEX = Object.freeze(
  Object.fromEntries(BINDING_KINDS.map((kind, index) => [kind, index])),
);

/** Groupings used by the disassembler and by tests. */
export const OPCODE_FAMILIES = Object.freeze({
  stack: ["CONST", "NULL", "TRUE", "FALSE", "POP", "DUP2", "RESERVE", "DROP"],
  variables: [
    "DEF_LOCAL",
    "SET_LOCAL",
    "GET_LOCAL",
    "DEF_GLOBAL",
    "HOIST_FN",
    "SET_GLOBAL",
    "GET_GLOBAL",
    "GET_UPVALUE",
    "SET_UPVALUE",
    "CLOSE_DOWN",
    "SELF",
  ],
  functions: ["CLOSURE", "CALL", "RETURN"],
  arithmetic: ["ADD", "SUB", "MUL", "DIV", "MOD", "NEG", "NOT", "EQ", "NEQ", "LT", "LE", "GT", "GE"],
  control: ["JUMP", "JUMP_IF_FALSE", "JUMP_IF_TRUE", "JUMP_IF_FALSE_POP", "JUMP_IF_TRUE_POP"],
  collections: ["ARRAY", "MAP", "INDEX", "SET_INDEX", "ITER_PREP", "ITER_NEXT"],
  modules: ["IMPORT"],
  errors: ["TRY_BEGIN", "TRY_END"],
});
