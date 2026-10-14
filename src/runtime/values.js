/**
 * Stage F — Runtime value representation.
 *
 * Typhoun values are explicit and never confused with host values:
 *  - Number  → host `number` (IEEE-754 double precision)
 *  - String  → host `string` (UTF-8 text; indexed by UTF-16 code unit)
 *  - Boolean → host `boolean`
 *  - Null    → the singleton `NULL`, distinct from host null/undefined
 *  - Array   → `TArray` wrapping a host array
 *  - Map     → `TMap` wrapping a host Map with tagged keys
 *  - Function→ `TFunction` (Typhoun) or `TNativeFunction` (built-in)
 */

export const TypeName = Object.freeze({
  NUMBER: "number",
  STRING: "string",
  BOOLEAN: "boolean",
  NULL: "null",
  ARRAY: "array",
  MAP: "map",
  FUNCTION: "function",
});

/** The single Typhoun `null` value. */
export const NULL = Object.freeze({ __typhoun: "null" });

export class TArray {
  /** @param {unknown[]} [items] */
  constructor(items = []) {
    this.items = items;
  }
}

export class TMap {
  constructor() {
    /** @type {Map<string, { key: unknown, value: unknown }>} */
    this.entries = new Map();
  }

  static fromPairs(pairs) {
    const map = new TMap();
    for (const [key, value] of pairs) map.set(key, value);
    return map;
  }

  set(key, value) {
    this.entries.set(keyOf(key), { key, value });
  }

  get(key) {
    return this.entries.get(keyOf(key));
  }

  has(key) {
    return this.entries.has(keyOf(key));
  }

  delete(key) {
    return this.entries.delete(keyOf(key));
  }

  get size() {
    return this.entries.size;
  }

  keys() {
    return [...this.entries.values()].map((e) => e.key);
  }

  values() {
    return [...this.entries.values()].map((e) => e.value);
  }
}

/** Typhoun user function (closure). */
export class TFunction {
  /**
   * @param {string} name
   * @param {string[]} params
   * @param {object} body Block AST node
   * @param {import("./environment.js").Environment} closure
   * @param {object} loc
   */
  constructor(name, params, body, closure, loc) {
    this.name = name;
    this.params = params;
    this.body = body;
    this.closure = closure;
    this.loc = loc;
  }
}

/**
 * A closure produced by the bytecode compiler (`src/bytecode/`).
 *
 * `proto` is the compiled function prototype, `upvalues` are the captured
 * cells and `globals` is the environment used to resolve free (global) names,
 * which is what keeps module scopes separate on the VM backend.
 */
export class TClosure {
  constructor(proto, upvalues = [], globals = null) {
    this.proto = proto;
    this.upvalues = upvalues;
    this.globals = globals;
  }

  get name() {
    return this.proto.name;
  }

  get params() {
    return this.proto.paramNames;
  }

  get arity() {
    return this.proto.arity;
  }

  get loc() {
    return this.proto.loc;
  }
}

/** Typhoun built-in function. */
export class TNativeFunction {
  /**
   * @param {string} name
   * @param {number|null} arity Minimum arity (null = variadic).
   * @param {(args: unknown[], ctx: object, callLoc: object|null) => unknown} fn
   * @param {object} [meta]
   */
  constructor(name, arity, fn, meta = {}) {
    this.name = name;
    this.arity = arity;
    this.fn = fn;
    this.minArgs = meta.minArgs ?? arity ?? 0;
    this.maxArgs = meta.maxArgs ?? null;
    this.doc = meta.doc ?? "";
  }
}

// ------------------------------------------------------------------- helpers

/** Normalize a Typhoun value into a tagged map key string. */
export function keyOf(value) {
  switch (typeof value) {
    case "number":
      if (Number.isNaN(value)) return "n:NaN";
      return `n:${value}`;
    case "string":
      return `s:${value}`;
    case "boolean":
      return `b:${value}`;
    default:
      if (value === NULL) return "z:null";
      return `o:${String(value)}`;
  }
}

/** Typhoun type name of a value. */
export function typeOf(value) {
  if (value === NULL) return TypeName.NULL;
  if (value instanceof TArray) return TypeName.ARRAY;
  if (value instanceof TMap) return TypeName.MAP;
  if (
    value instanceof TFunction ||
    value instanceof TNativeFunction ||
    value instanceof TClosure
  ) {
    return TypeName.FUNCTION;
  }
  switch (typeof value) {
    case "number":
      return TypeName.NUMBER;
    case "string":
      return TypeName.STRING;
    case "boolean":
      return TypeName.BOOLEAN;
    default:
      return "unknown";
  }
}

/** Truthiness: only `false` and `null` are falsy. Everything else is truthy. */
export function isTruthy(value) {
  if (value === NULL) return false;
  if (value === false) return false;
  return true;
}

export function isCallable(value) {
  return (
    value instanceof TFunction ||
    value instanceof TNativeFunction ||
    value instanceof TClosure
  );
}

/** Deep structural equality per the documented rules. */
export function equals(a, b) {
  if (a === NULL || b === NULL) return a === b;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return false;
  switch (ta) {
    case TypeName.NUMBER:
    case TypeName.STRING:
    case TypeName.BOOLEAN:
      return a === b;
    case TypeName.ARRAY: {
      if (a.items.length !== b.items.length) return false;
      for (let i = 0; i < a.items.length; i += 1) {
        if (!equals(a.items[i], b.items[i])) return false;
      }
      return true;
    }
    case TypeName.MAP: {
      if (a.size !== b.size) return false;
      for (const [key, entry] of a.entries) {
        const other = b.entries.get(key);
        if (!other) return false;
        if (!equals(entry.value, other.value)) return false;
      }
      return true;
    }
    case TypeName.FUNCTION:
      return a === b;
    default:
      return false;
  }
}

function formatNumber(n) {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (Object.is(n, -0)) return "-0";
  return String(n);
}

/** Display form for top-level printing (strings unquoted). */
export function toDisplay(value) {
  return repr(value, false);
}

/** Representation form (strings quoted) used for nested values and REPL. */
export function toRepr(value) {
  return repr(value, true);
}

function repr(value, quoteStrings) {
  if (value === NULL) return "null";
  if (value instanceof TArray) {
    return `[${value.items.map((v) => repr(v, true)).join(", ")}]`;
  }
  if (value instanceof TMap) {
    const parts = [...value.entries.values()].map(
      (e) => `${repr(e.key, true)}: ${repr(e.value, true)}`,
    );
    return `{${parts.join(", ")}}`;
  }
  if (value instanceof TFunction || value instanceof TClosure) {
    return `<fn ${value.name || "anonymous"}>`;
  }
  if (value instanceof TNativeFunction) return `<builtin ${value.name}>`;
  switch (typeof value) {
    case "number":
      return formatNumber(value);
    case "string":
      return quoteStrings ? JSON.stringify(value) : value;
    case "boolean":
      return String(value);
    default:
      return String(value);
  }
}
