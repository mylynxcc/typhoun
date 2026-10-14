/**
 * Stage F₂ — Bytecode disassembler.
 *
 * Renders a prototype tree as human-readable text. This is the bytecode
 * counterpart of `printAst`: a development tool that shows exactly what the
 * compiler produced, including resolved constants, capture descriptors and
 * jump targets, so a miscompile is visible instead of mysterious.
 */
import { OP, OP_NAME, BINDING_KINDS } from "./opcodes.js";
import { toRepr } from "../runtime/values.js";

const NAME_WIDTH = 16;

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatConstant(value) {
  if (typeof value === "string") return JSON.stringify(value);
  return toRepr(value);
}

function describe(chunk, instruction) {
  const [first, second] = instruction.operands;
  switch (instruction.name) {
    case "CONST":
      return formatConstant(chunk.constants[first]);
    case "GET_GLOBAL":
    case "SET_GLOBAL":
    case "HOIST_FN":
      return String(chunk.constants[first]);
    case "DEF_GLOBAL":
      return `${chunk.constants[first]} (${BINDING_KINDS[second] ?? "let"})`;
    case "GET_UPVALUE":
    case "SET_UPVALUE":
      return `${first} (${chunk.upvalueNames[first] ?? "?"})`;
    case "CLOSURE": {
      const proto = chunk.functions[first];
      if (!proto) return `${first} <missing>`;
      const captures = proto.upvalueNames
        .map((name, i) => `${name}:${proto.upvalueFromLocal[i] ? "local" : "upval"}${proto.upvalueIndex[i]}`)
        .join(", ");
      const signature = `${proto.name}(${proto.paramNames.join(", ")})`;
      return captures ? `${first} ${signature} captures {${captures}}` : `${first} ${signature}`;
    }
    case "JUMP":
    case "JUMP_IF_FALSE":
    case "JUMP_IF_TRUE":
    case "JUMP_IF_FALSE_POP":
    case "JUMP_IF_TRUE_POP":
      return `-> ${pad(chunk.jumpTarget(instruction.offset), 5)}`;
    case "ITER_NEXT":
      return `-> ${pad(chunk.jumpTarget(instruction.offset, instruction.offset + 3), 5)} iter slot ${second}`;
    case "TRY_BEGIN":
      return `handler at ${pad(chunk.jumpTarget(instruction.offset, instruction.offset + 3), 5)} into slot ${second}`;
    case "TRY_END":
      return "leave region";
    case "IMPORT":
      return second >= 0
        ? `${JSON.stringify(chunk.constants[first])} as ${chunk.constants[second]}`
        : JSON.stringify(chunk.constants[first]);
    case "RESERVE":
      return `slots += ${first}`;
    case "DROP":
      return `slots -= ${first}`;
    case "CLOSE_DOWN":
      return `close >= slot ${first}`;
    case "ARRAY":
      return `${first} element(s)`;
    case "MAP":
      return `${first} pair(s)`;
    case "CALL":
      return `${first} arg(s)`;
    default:
      return first === undefined ? "" : String(first);
  }
}

/**
 * @param {import("./chunk.js").Chunk} chunk
 * @param {object} [options]
 * @returns {string}
 */
export function disassemble(chunk, options = {}) {
  const lines = [];
  const header =
    `== ${chunk.name} (${chunk.type}, arity ${chunk.arity}, ` +
    `${chunk.slotCount} slot(s), ${chunk.upvalueCount} upvalue(s)) ==`;
  lines.push(header);

  for (const instruction of chunk.decode()) {
    const offset = pad(instruction.offset, 5);
    const line = pad(instruction.loc ? instruction.loc.line : "-", 4);
    const name = pad(instruction.name, NAME_WIDTH);
    const note = describe(chunk, instruction);
    lines.push(`${offset} ${line}  ${name}${note ? ` ; ${note}` : ""}`);
  }
  if (chunk.code.length === 0) lines.push("(no instructions)");

  for (const child of chunk.functions) {
    lines.push("");
    lines.push(disassemble(child, options));
  }
  return lines.join("\n");
}

/** Disassemble plus a one-line summary, used by the CSV/JSON benchmark tooling. */
export function disassembleSummary(chunk) {
  const decoded = chunk.decode();
  const counts = new Map();
  for (const instruction of decoded) {
    counts.set(instruction.name, (counts.get(instruction.name) ?? 0) + 1);
  }
  return {
    name: chunk.name,
    instructions: decoded.length,
    bytes: chunk.code.length,
    constants: chunk.constants.length,
    functions: chunk.functions.length,
    opcodes: Object.fromEntries([...counts.entries()].sort()),
  };
}

export { OP, OP_NAME };
