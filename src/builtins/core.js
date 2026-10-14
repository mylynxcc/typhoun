/**
 * Stage G — Core standard library.
 *
 * Every function documents its argument count, return type, mutation
 * behaviour and failure conditions in `doc`. Contracts are enforced by the
 * helpers in `helpers.js`.
 */
import { TNativeFunction, NULL, TArray, TMap, typeOf, isTruthy, toDisplay } from "../runtime/values.js";
import { RuntimeFault } from "../runtime/errors.js";
import { Code } from "../diagnostics/codes.js";
import { expectArray, expectInteger, expectKeyValue, expectMap } from "./helpers.js";

function native(name, meta, fn) {
  return new TNativeFunction(name, meta.minArgs, fn, meta);
}

export function installCoreBuiltins(env) {
  env.set("print", native("print", { minArgs: 1, maxArgs: null, doc: "print(value...) — write values to standard output, separated by spaces, followed by a newline. Returns null." }, (args, ctx, loc) => {
    ctx.write(args.map((v) => toDisplay(v)).join(" ") + "\n");
    return NULL;
  }), "fn");

  env.set("input", native("input", { minArgs: 0, maxArgs: 1, doc: "input(prompt) — read one line from standard input. Returns a string. Fails when input is disabled." }, (args, ctx, loc) => {
    const prompt = args.length > 0 ? toDisplay(args[0]) : "";
    if (prompt) ctx.write(prompt);
    return ctx.read(prompt, loc);
  }), "fn");

  env.set("len", native("len", { minArgs: 1, maxArgs: 1, doc: "len(value) — length of a string (UTF-16 code units), array or map. Returns a number." }, (args, ctx, loc) => {
    const value = args[0];
    if (typeof value === "string") return value.length;
    if (value instanceof TArray) return value.items.length;
    if (value instanceof TMap) return value.size;
    throw new RuntimeFault(
      Code.BAD_NATIVE_ARGUMENT,
      `len() expected a string, array or map, got '${typeOf(value)}'`,
      loc,
    );
  }), "fn");

  env.set("type", native("type", { minArgs: 1, maxArgs: 1, doc: "type(value) — the Typhoun type name as a string, e.g. 'number', 'array', 'function'." }, (args) => typeOf(args[0]), ), "fn");

  env.set("str", native("str", { minArgs: 1, maxArgs: 1, doc: "str(value) — convert any value to its display string." }, (args) => toDisplay(args[0])), "fn");

  env.set("num", native("num", { minArgs: 1, maxArgs: 1, doc: "num(value) — convert a string, number or boolean to a number. Fails on non-numeric text." }, (args, ctx, loc) => {
    const value = args[0];
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "" || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
        throw new RuntimeFault(
          Code.BAD_NATIVE_ARGUMENT,
          `num() could not parse '${value}' as a number`,
          loc,
          "Pass a numeric string such as \"42\" or \"3.14\".",
        );
      }
      return Number(trimmed);
    }
    throw new RuntimeFault(
      Code.BAD_NATIVE_ARGUMENT,
      `num() expected a string, number or boolean, got '${typeOf(value)}'`,
      loc,
    );
  }), "fn");

  env.set("bool", native("bool", { minArgs: 1, maxArgs: 1, doc: "bool(value) — truthiness as a boolean. Only false and null are falsy." }, (args) => isTruthy(args[0])), "fn");

  env.set("range", native("range", { minArgs: 1, maxArgs: 2, doc: "range(end) or range(start, end) — an array of integers from start (inclusive) to end (exclusive)." }, (args, ctx, loc) => {
    const start = args.length === 2 ? expectInteger("range", "start", args[0], loc) : 0;
    const end = args.length === 2 ? expectInteger("range", "end", args[1], loc) : expectInteger("range", "end", args[0], loc);
    if (end < start) {
      throw new RuntimeFault(
        Code.BAD_NATIVE_ARGUMENT,
        `range() requires end >= start, got ${start}..${end}`,
        loc,
      );
    }
    ctx.accountCollection(end - start, loc);
    const out = [];
    for (let i = start; i < end; i += 1) out.push(i);
    return new TArray(out);
  }), "fn");

  env.set("push", native("push", { minArgs: 2, maxArgs: 2, doc: "push(array, value) — append value to array in place and return the array." }, (args, ctx, loc) => {
    const array = expectArray("push", "array", args[0], loc);
    ctx.accountCollection(1, loc);
    array.items.push(args[1]);
    return array;
  }), "fn");

  env.set("pop", native("pop", { minArgs: 1, maxArgs: 1, doc: "pop(array) — remove and return the last element. Fails on an empty array." }, (args, ctx, loc) => {
    const array = expectArray("pop", "array", args[0], loc);
    if (array.items.length === 0) {
      throw new RuntimeFault(Code.BAD_NATIVE_ARGUMENT, "pop() called on an empty array", loc, "Check len(array) > 0 first.");
    }
    return array.items.pop();
  }), "fn");

  env.set("keys", native("keys", { minArgs: 1, maxArgs: 1, doc: "keys(map) — a new array of the map's keys in insertion order." }, (args, ctx, loc) => {
    const map = expectMap("keys", "map", args[0], loc);
    ctx.accountCollection(map.size, loc);
    return new TArray(map.keys());
  }), "fn");

  env.set("values", native("values", { minArgs: 1, maxArgs: 1, doc: "values(map) — a new array of the map's values in insertion order." }, (args, ctx, loc) => {
    const map = expectMap("values", "map", args[0], loc);
    ctx.accountCollection(map.size, loc);
    return new TArray(map.values());
  }), "fn");

  env.set("has", native("has", { minArgs: 2, maxArgs: 2, doc: "has(map, key) or has(array, index) — membership test returning a boolean." }, (args, loc) => {
    const container = args[0];
    if (container instanceof TMap) {
      expectKeyValue("has", "key", args[1], loc);
      return container.has(args[1]);
    }
    if (container instanceof TArray) {
      const index = expectInteger("has", "index", args[1], loc);
      return index >= 0 && index < container.items.length;
    }
    throw new RuntimeFault(
      Code.BAD_NATIVE_ARGUMENT,
      `has() expected a map or array, got '${typeOf(container)}'`,
      loc,
    );
  }), "fn");

  env.set("remove", native("remove", { minArgs: 2, maxArgs: 2, doc: "remove(map, key) — delete an entry, returning whether it existed." }, (args, loc) => {
    const map = expectMap("remove", "map", args[0], loc);
    expectKeyValue("remove", "key", args[1], loc);
    return map.delete(args[1]);
  }), "fn");

  env.set("assert", native("assert", { minArgs: 1, maxArgs: 2, doc: "assert(condition, message?) — fail the program unless condition is truthy." }, (args, ctx, loc) => {
    if (!isTruthy(args[0])) {
      const message = args.length > 1 ? toDisplay(args[1]) : "assertion failed";
      throw new RuntimeFault(Code.UNCAUGHT_ERROR, message, loc, "An assertion in the program failed.");
    }
    return NULL;
  }), "fn");

}
