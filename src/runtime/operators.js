/**
 * Stage F — Operator semantics, shared by every execution engine.
 *
 * The tree-walking interpreter and the bytecode VM must agree on operator
 * behaviour down to the diagnostic code and wording, otherwise swapping the
 * backend would silently change program meaning. Both engines call these
 * functions, so there is exactly one definition of what `+` or `<` means.
 */
import { RuntimeFault } from "./errors.js";
import { Code } from "../diagnostics/codes.js";
import { typeOf } from "./values.js";

export function requireNumber(value, loc, contextLabel) {
  if (typeof value !== "number") {
    throw new RuntimeFault(
      Code.TYPE_ERROR,
      `${contextLabel} requires a number, got '${typeOf(value)}'`,
      loc,
      "Convert the value with num() first.",
    );
  }
  return value;
}

export function requireNumbers(left, right, loc, operator) {
  if (typeof left !== "number" || typeof right !== "number") {
    throw new RuntimeFault(
      Code.TYPE_ERROR,
      `Operator '${operator}' requires two numbers, got '${typeOf(left)}' and '${typeOf(right)}'`,
      loc,
      "Typhoun does not coerce types: convert with num() or str() first.",
    );
  }
}

/**
 * Apply a binary operator to two runtime values.
 * @param {string} op One of + - * / % < <= > >=
 */
export function applyBinaryOperator(op, left, right, loc) {
  switch (op) {
    case "+":
      if (typeof left === "string" || typeof right === "string") {
        if (typeof left === "string" && typeof right === "string") return left + right;
        throw new RuntimeFault(
          Code.TYPE_ERROR,
          `Operator '+' requires two strings or two numbers, got '${typeOf(left)}' and '${typeOf(right)}'`,
          loc,
          "Typhoun never coerces silently: convert explicitly with str().",
        );
      }
      requireNumbers(left, right, loc, "+");
      return left + right;
    case "-":
      requireNumbers(left, right, loc, "-");
      return left - right;
    case "*":
      requireNumbers(left, right, loc, "*");
      return left * right;
    case "/":
      requireNumbers(left, right, loc, "/");
      if (right === 0) {
        throw new RuntimeFault(
          Code.DIVISION_BY_ZERO,
          "Division by zero",
          loc,
          "Guard the divisor before dividing.",
        );
      }
      return left / right;
    case "%":
      requireNumbers(left, right, loc, "%");
      if (right === 0) {
        throw new RuntimeFault(
          Code.DIVISION_BY_ZERO,
          "Modulo by zero",
          loc,
          "Guard the divisor before using '%'.",
        );
      }
      return left % right;
    case "<":
      requireNumbers(left, right, loc, "<");
      return left < right;
    case "<=":
      requireNumbers(left, right, loc, "<=");
      return left <= right;
    case ">":
      requireNumbers(left, right, loc, ">");
      return left > right;
    case ">=":
      requireNumbers(left, right, loc, ">=");
      return left >= right;
    default:
      throw new RuntimeFault(Code.UNCAUGHT_ERROR, `Unknown binary operator '${op}'`, loc);
  }
}

/** Apply a unary operator to a runtime value. */
export function applyUnaryOperator(op, value, loc) {
  if (op === "-") {
    requireNumber(value, loc, "unary '-'");
    return -value;
  }
  throw new RuntimeFault(Code.UNCAUGHT_ERROR, `Unknown unary operator '${op}'`, loc);
}
