/**
 * Stage G — Standard library installer.
 *
 * Only the functions listed here are exposed to Typhoun programs. Host
 * functions are never passed through automatically: every capability a
 * program can reach is wrapped, argument-checked and documented.
 */
import { installCoreBuiltins } from "./core.js";
import { installStringBuiltins } from "./strings.js";
import { installMathBuiltins } from "./math.js";

/**
 * @param {import("../runtime/environment.js").Environment} env
 * @param {object} [interpreter]
 */
export function installBuiltins(env, interpreter) {
  installCoreBuiltins(env, interpreter);
  installStringBuiltins(env, interpreter);
  installMathBuiltins(env, interpreter);
}

/** Names of every built-in, for documentation and the resolver. */
export const BUILTIN_NAMES = Object.freeze([
  "print",
  "input",
  "len",
  "type",
  "str",
  "num",
  "bool",
  "range",
  "push",
  "pop",
  "keys",
  "values",
  "has",
  "remove",
  "assert",
  "join",
  "split",
  "upper",
  "lower",
  "trim",
  "contains",
  "abs",
  "floor",
  "ceil",
  "round",
  "sqrt",
  "pow",
  "min",
  "max",
  "random",
]);
