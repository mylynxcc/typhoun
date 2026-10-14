/**
 * Stage G — String and collection built-ins.
 */
import { TNativeFunction, TArray, toDisplay, equals, typeOf } from "../runtime/values.js";
import { RuntimeFault } from "../runtime/errors.js";
import { Code } from "../diagnostics/codes.js";
import { expectArray, expectString } from "./helpers.js";

function native(name, meta, fn) {
  return new TNativeFunction(name, meta.minArgs, fn, meta);
}

export function installStringBuiltins(env) {
  env.set("join", native("join", { minArgs: 2, maxArgs: 2, doc: "join(array, separator) — concatenate the display forms of the elements." }, (args, ctx, loc) => {
    const array = expectArray("join", "array", args[0], loc);
    const sep = expectString("join", "separator", args[1], loc);
    return array.items.map((v) => toDisplay(v)).join(sep);
  }), "fn");

  env.set("split", native("split", { minArgs: 2, maxArgs: 2, doc: "split(string, separator) — split into an array of substrings." }, (args, ctx, loc) => {
    const text = expectString("split", "string", args[0], loc);
    const sep = expectString("split", "separator", args[1], loc);
    const parts = sep === "" ? [...text] : text.split(sep);
    ctx.accountCollection(parts.length, loc);
    return new TArray(parts);
  }), "fn");

  env.set("upper", native("upper", { minArgs: 1, maxArgs: 1, doc: "upper(string) — an uppercased copy." }, (args, ctx, loc) => expectString("upper", "string", args[0], loc).toUpperCase()), "fn");

  env.set("lower", native("lower", { minArgs: 1, maxArgs: 1, doc: "lower(string) — a lowercased copy." }, (args, ctx, loc) => expectString("lower", "string", args[0], loc).toLowerCase()), "fn");

  env.set("trim", native("trim", { minArgs: 1, maxArgs: 1, doc: "trim(string) — a copy with surrounding whitespace removed." }, (args, ctx, loc) => expectString("trim", "string", args[0], loc).trim()), "fn");

  env.set("contains", native("contains", { minArgs: 2, maxArgs: 2, doc: "contains(string, substring) or contains(array, value) — membership test returning a boolean." }, (args, ctx, loc) => {
    const container = args[0];
    if (typeof container === "string") {
      const needle = expectString("contains", "substring", args[1], loc);
      return container.includes(needle);
    }
    if (container instanceof TArray) {
      return container.items.some((item) => equals(item, args[1]));
    }
    throw new RuntimeFault(
      Code.BAD_NATIVE_ARGUMENT,
      `contains() expected a string or array, got '${typeOf(container)}'`,
      loc,
    );
  }), "fn");
}
