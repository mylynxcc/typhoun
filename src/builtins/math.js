/**
 * Stage G — Mathematical built-ins.
 *
 * `random()` uses the host PRNG. It is *not* cryptographically secure and is
 * intentionally the only source of nondeterminism in the standard library.
 */
import { TNativeFunction, TArray } from "../runtime/values.js";
import { RuntimeFault } from "../runtime/errors.js";
import { Code } from "../diagnostics/codes.js";
import { expectArray, expectNumber } from "./helpers.js";

function native(name, meta, fn) {
  return new TNativeFunction(name, meta.minArgs, fn, meta);
}

export function installMathBuiltins(env) {
  env.set("abs", native("abs", { minArgs: 1, maxArgs: 1, doc: "abs(number) — absolute value." }, (args, ctx, loc) => Math.abs(expectNumber("abs", "number", args[0], loc))), "fn");

  env.set("floor", native("floor", { minArgs: 1, maxArgs: 1, doc: "floor(number) — largest integer <= value." }, (args, ctx, loc) => Math.floor(expectNumber("floor", "number", args[0], loc))), "fn");

  env.set("ceil", native("ceil", { minArgs: 1, maxArgs: 1, doc: "ceil(number) — smallest integer >= value." }, (args, ctx, loc) => Math.ceil(expectNumber("ceil", "number", args[0], loc))), "fn");

  env.set("round", native("round", { minArgs: 1, maxArgs: 1, doc: "round(number) — nearest integer." }, (args, ctx, loc) => Math.round(expectNumber("round", "number", args[0], loc))), "fn");

  env.set("sqrt", native("sqrt", { minArgs: 1, maxArgs: 1, doc: "sqrt(number) — square root. Fails on negative input." }, (args, ctx, loc) => {
    const n = expectNumber("sqrt", "number", args[0], loc);
    if (n < 0) {
      throw new RuntimeFault(Code.BAD_NATIVE_ARGUMENT, "sqrt() is undefined for negative numbers", loc);
    }
    return Math.sqrt(n);
  }), "fn");

  env.set("pow", native("pow", { minArgs: 2, maxArgs: 2, doc: "pow(base, exponent) — base raised to exponent." }, (args, ctx, loc) => Math.pow(expectNumber("pow", "base", args[0], loc), expectNumber("pow", "exponent", args[1], loc))), "fn");

  env.set("min", native("min", { minArgs: 1, maxArgs: null, doc: "min(a, b, ...) or min(array) — the smallest number." }, (args, ctx, loc) => {
    const numbers = collectNumbers("min", args, loc);
    if (numbers.length === 0) {
      throw new RuntimeFault(Code.BAD_NATIVE_ARGUMENT, "min() needs at least one number", loc);
    }
    return Math.min(...numbers);
  }), "fn");

  env.set("max", native("max", { minArgs: 1, maxArgs: null, doc: "max(a, b, ...) or max(array) — the largest number." }, (args, ctx, loc) => {
    const numbers = collectNumbers("max", args, loc);
    if (numbers.length === 0) {
      throw new RuntimeFault(Code.BAD_NATIVE_ARGUMENT, "max() needs at least one number", loc);
    }
    return Math.max(...numbers);
  }), "fn");

  env.set("random", native("random", { minArgs: 0, maxArgs: 0, doc: "random() — a pseudo-random number in [0, 1)." }, () => Math.random()), "fn");
}

function collectNumbers(name, args, loc) {
  // `min(array)` / `max(array)` accept a single array argument.
  if (args.length === 1 && args[0] instanceof TArray) {
    const array = expectArray(name, "array", args[0], loc);
    return array.items.map((v, i) => expectNumber(name, `element ${i}`, v, loc));
  }
  return args.map((v, i) => expectNumber(name, `argument ${i + 1}`, v, loc));
}
