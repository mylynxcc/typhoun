/**
 * Stage F — Lexical environments.
 *
 * A linked chain of binding maps. The interpreter consults the innermost
 * environment and walks outward, which naturally supports closures: a
 * function value captures its defining environment as its parent chain.
 */
import { RuntimeFault } from "./errors.js";
import { Code } from "../diagnostics/codes.js";

export class Environment {
  /** @param {Environment|null} [parent] */
  constructor(parent = null) {
    this.parent = parent;
    /** @type {Map<string, {value: unknown, kind: string}>} */
    this.bindings = new Map();
  }

  /** Create a nested child scope. */
  child() {
    return new Environment(this);
  }

  /**
   * Create a binding in this scope.
   * @param {string} name
   * @param {unknown} value
   * @param {string} kind 'let' | 'const' | 'fn' | 'param' | 'import'
   * @param {object|null} loc
   */
  define(name, value, kind = "let", loc = null) {
    if (this.bindings.has(name)) {
      throw new RuntimeFault(
        Code.DUPLICATE_DECLARATION,
        `Duplicate declaration of '${name}'`,
        loc,
      );
    }
    this.bindings.set(name, { value, kind });
  }

  /** Define or overwrite (used for hoisted functions and imports). */
  set(name, value, kind = "let") {
    this.bindings.set(name, { value, kind });
  }

  hasLocal(name) {
    return this.bindings.has(name);
  }

  /** Resolve a binding, walking the chain. @returns {{value, kind, env}|null} */
  lookup(name) {
    let env = this;
    while (env) {
      const binding = env.bindings.get(name);
      if (binding) return { value: binding.value, kind: binding.kind, env };
      env = env.parent;
    }
    return null;
  }

  /**
   * Read a binding, throwing a runtime fault when it does not exist.
   * @param {string} name
   * @param {object|null} loc
   */
  get(name, loc = null) {
    const found = this.lookup(name);
    if (!found) {
      throw new RuntimeFault(
        Code.UNDEFINED_VARIABLE_RUNTIME,
        `Undefined variable '${name}'`,
        loc,
        `Declare '${name}' before using it.`,
      );
    }
    return found.value;
  }

  /**
   * Assign to an existing binding (never creates one).
   * @param {string} name
   * @param {unknown} value
   * @param {object|null} loc
   */
  assign(name, value, loc = null) {
    let env = this;
    while (env) {
      const binding = env.bindings.get(name);
      if (binding) {
        if (binding.kind === "const" || binding.kind === "fn") {
          throw new RuntimeFault(
            Code.IMMUTABLE_BINDING,
            `Cannot assign to ${binding.kind === "const" ? "constant" : "function"} '${name}'`,
            loc,
            "Declare it with 'let' if it needs to change.",
          );
        }
        binding.value = value;
        return value;
      }
      env = env.parent;
    }
    throw new RuntimeFault(
      Code.UNDEFINED_VARIABLE_RUNTIME,
      `Undefined variable '${name}'`,
      loc,
      `Declare '${name}' with 'let' before assigning to it.`,
    );
  }
}
