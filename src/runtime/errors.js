/**
 * Stage F — Runtime faults and control-flow signals.
 *
 * A `RuntimeFault` is the engine's error object. `try`/`catch` turns one into a
 * Typhoun *value* — a plain map — so a program can inspect the code, the
 * message and the source location of what went wrong without the interpreter
 * leaking host objects into the language.
 */
import { Diagnostic, Phase, Severity } from "../diagnostics/diagnostic.js";
import { NULL, TArray, TMap } from "./values.js";

/**
 * A fatal Typhoun runtime error. Carries a structured `Diagnostic` plus an
 * optional Typhoun call stack. It is thrown by the interpreter and caught at
 * the top level, where it becomes a rendered diagnostic.
 */
export class RuntimeFault extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object|null} loc
   * @param {string|null} [help]
   * @param {string[]} [stack]
   */
  constructor(code, message, loc, help = null, stack = []) {
    super(message);
    this.name = "RuntimeFault";
    this.code = code;
    this.help = help;
    this.loc = loc;
    this.typhounStack = stack;
  }

  toDiagnostic() {
    return new Diagnostic({
      code: this.code,
      phase: faultPhase(this.code),
      severity: Severity.ERROR,
      message: this.message,
      location: this.loc,
      help: this.help,
      stack: this.typhounStack,
    });
  }
}

/**
 * The phase a fault belongs to, derived from its code family.
 *
 * Runtime faults are not all raised for runtime reasons: an import that
 * conflicts with a local name is a load error, and a resource limit is the
 * sandbox rather than the program.
 */
export function faultPhase(code) {
  const family = typeof code === "string" ? code.slice(0, 4) : "";
  if (family === "TYP5") return Phase.IMPORT;
  if (family === "TYP6") return Phase.RESOURCE;
  return Phase.RUNTIME;
}

/**
 * Whether a `catch` handler may receive this fault.
 *
 * Only the runtime family (`TYP4xxx`) is catchable. Load-time errors
 * (`TYP5xxx`) are decided before or independently of execution — a missing
 * module, a path outside the project, an import cycle — and the sandbox limits
 * (`TYP6xxx`) are the floor under an untrusted program, not something it may
 * observe and swallow. Both pass straight through a `try`.
 */
export function isCatchableFault(fault) {
  return (
    fault instanceof RuntimeFault &&
    typeof fault.code === "string" &&
    fault.code.startsWith("TYP4")
  );
}

/**
 * The value bound by `catch err { ... }`.
 *
 * A plain map, so the language needed no new value type for it:
 *
 *   {
 *     "code": "TYP4002",
 *     "message": "Division by zero",
 *     "phase": "runtime",
 *     "location": { "file": "main.typ", "line": 3, "column": 11 },
 *     "help": "…" | null,
 *     "stack": ["f (main.typ:1:1)", …]
 *   }
 *
 * `location` is `null` when the fault has no source position.
 *
 * @param {RuntimeFault} fault
 * @param {string[]} [stack] Call frames, innermost first.
 */
export function errorValueOf(fault, stack = []) {
  const loc = fault.loc ?? null;
  return TMap.fromPairs([
    ["code", fault.code],
    ["message", fault.message],
    ["phase", faultPhase(fault.code)],
    [
      "location",
      loc
        ? TMap.fromPairs([
            ["file", loc.file ?? "<unknown>"],
            ["line", loc.line ?? 0],
            ["column", loc.column ?? 0],
          ])
        : NULL,
    ],
    ["help", fault.help ?? NULL],
    ["stack", new TArray(stack)],
  ]);
}

/** Control-flow signals implemented as non-error exceptions. */
export class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}

export class BreakSignal {}
export class ContinueSignal {}
