/**
 * Stage F — Collection indexing semantics, shared by every execution engine.
 *
 * Indexing rules (bounds checking, index types, map key types) live here so
 * the tree-walking interpreter and the bytecode VM cannot drift apart.
 */
import { RuntimeFault } from "./errors.js";
import { Code } from "../diagnostics/codes.js";
import { NULL, TArray, TMap, typeOf, TypeName } from "./values.js";

const MAP_KEY_TYPES = [TypeName.STRING, TypeName.NUMBER, TypeName.BOOLEAN, TypeName.NULL];

/** Validate an array/string index, returning it unchanged. */
export function normalizeArrayIndex(index, length, loc) {
  if (typeof index !== "number" || !Number.isInteger(index)) {
    throw new RuntimeFault(
      Code.INVALID_INDEX_TYPE,
      `Index must be an integer, received '${typeOf(index)}'`,
      loc,
      "Indices are whole numbers starting at 0.",
    );
  }
  if (index < 0 || index >= length) {
    throw new RuntimeFault(
      Code.INDEX_OUT_OF_BOUNDS,
      `Index ${index} is out of bounds for length ${length}`,
      loc,
      `Valid indices are 0 through ${Math.max(0, length - 1)}.`,
    );
  }
  return index;
}

/** Read `object[index]` with full bounds and type checking. */
export function getIndexValue(object, index, loc) {
  if (object instanceof TArray) {
    const i = normalizeArrayIndex(index, object.items.length, loc);
    return object.items[i];
  }
  if (object instanceof TMap) {
    const entry = object.get(index);
    return entry ? entry.value : NULL;
  }
  if (typeof object === "string") {
    const i = normalizeArrayIndex(index, object.length, loc);
    return object[i];
  }
  throw new RuntimeFault(
    Code.TYPE_ERROR,
    `Value of type '${typeOf(object)}' cannot be indexed`,
    loc,
    "Only arrays, maps and strings support indexing.",
  );
}

/** Write `object[index] = value` with full bounds and type checking. */
export function setIndexValue(object, index, value, loc) {
  if (object instanceof TArray) {
    const i = normalizeArrayIndex(index, object.items.length, loc);
    object.items[i] = value;
    return;
  }
  if (object instanceof TMap) {
    const keyType = typeOf(index);
    if (!MAP_KEY_TYPES.includes(keyType)) {
      throw new RuntimeFault(
        Code.INVALID_INDEX_TYPE,
        `Map keys must be strings, numbers, booleans or null; got '${keyType}'`,
        loc,
      );
    }
    object.set(index, value);
    return;
  }
  if (typeof object === "string") {
    throw new RuntimeFault(Code.TYPE_ERROR, "Strings are immutable", loc, "Build a new string instead.");
  }
  throw new RuntimeFault(
    Code.TYPE_ERROR,
    `Cannot assign into a value of type '${typeOf(object)}'`,
    loc,
    "Only array elements and map entries can be assigned.",
  );
}

/** Snapshot the elements a `for ... in` loop should visit. */
export function iterableItems(value, loc) {
  if (value instanceof TArray) return value.items.slice();
  if (value instanceof TMap) return value.keys();
  if (typeof value === "string") return [...value];
  throw new RuntimeFault(
    Code.TYPE_ERROR,
    `Cannot iterate over value of type '${typeOf(value)}'`,
    loc,
    "Iterate over an array, map or string.",
  );
}
