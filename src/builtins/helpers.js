/**
 * Stage G — Built-in argument helpers.
 *
 * Built-ins never trust their arguments. Each helper raises a structured
 * `RuntimeFault` (TYP4012) naming the offending parameter instead of letting
 * a host error escape.
 */
import { RuntimeFault } from "../runtime/errors.js";
import { Code } from "../diagnostics/codes.js";
import {
  NULL,
  TArray,
  TMap,
  TFunction,
  TNativeFunction,
  TClosure,
  typeOf,
  TypeName,
  isCallable,
} from "../runtime/values.js";

function fault(fnName, paramName, expected, received, loc, help = null) {
  return new RuntimeFault(
    Code.BAD_NATIVE_ARGUMENT,
    `${fnName}() expected ${expected} for '${paramName}', got '${received}'`,
    loc,
    help,
  );
}

export function expectNumber(fnName, paramName, value, loc) {
  if (typeof value !== "number") {
    throw fault(fnName, paramName, "a number", typeOf(value), loc, "Convert it with num() first.");
  }
  return value;
}

export function expectInteger(fnName, paramName, value, loc) {
  expectNumber(fnName, paramName, value, loc);
  if (!Number.isInteger(value)) {
    throw fault(fnName, paramName, "an integer", String(value), loc);
  }
  return value;
}

export function expectString(fnName, paramName, value, loc) {
  if (typeof value !== "string") {
    throw fault(fnName, paramName, "a string", typeOf(value), loc, "Convert it with str() first.");
  }
  return value;
}

export function expectBool(fnName, paramName, value, loc) {
  if (typeof value !== "boolean") {
    throw fault(fnName, paramName, "a boolean", typeOf(value), loc);
  }
  return value;
}

export function expectArray(fnName, paramName, value, loc) {
  if (!(value instanceof TArray)) {
    throw fault(fnName, paramName, "an array", typeOf(value), loc, "Pass an array value.");
  }
  return value;
}

export function expectMap(fnName, paramName, value, loc) {
  if (!(value instanceof TMap)) {
    throw fault(fnName, paramName, "a map", typeOf(value), loc, "Pass a map value.");
  }
  return value;
}

export function expectFunction(fnName, paramName, value, loc) {
  if (!isCallable(value)) {
    throw fault(fnName, paramName, "a function", typeOf(value), loc);
  }
  return value;
}

export function expectKeyValue(fnName, paramName, value, loc) {
  const t = typeOf(value);
  if (
    t !== TypeName.STRING &&
    t !== TypeName.NUMBER &&
    t !== TypeName.BOOLEAN &&
    t !== TypeName.NULL
  ) {
    throw fault(
      fnName,
      paramName,
      "a string, number, boolean or null key",
      t,
      loc,
      "Maps are keyed by scalar values.",
    );
  }
  return value;
}

export function isNull(value) {
  return value === NULL;
}

export { NULL, TArray, TMap, TFunction, TNativeFunction, TClosure };
