/**
 * Stage H — The structured diagnostic model.
 *
 * A `Diagnostic` is pure data: an error code, a phase, a message and (when
 * known) a source location plus an optional hint. Rendering is a separate
 * concern handled by `renderer.js`.
 *
 * Severity separates the two kinds the tools emit: `error` (the program cannot
 * be checked or run) and `warning` (from `typhoun lint`; the program is fine).
 */

export const Phase = Object.freeze({
  LEXICAL: "lexical",
  SYNTAX: "syntax",
  SEMANTIC: "semantic",
  RUNTIME: "runtime",
  IMPORT: "import",
  RESOURCE: "resource",
  /** Warnings from `typhoun lint` (codes TYP7xxx). */
  LINT: "lint",
});

export const Severity = Object.freeze({
  ERROR: "error",
  WARNING: "warning",
});

/**
 * A source location. `offset` is a 0-based UTF-16 code-unit offset, `line`
 * and `column` are 1-based, and `length` is the number of code units the
 * caret should span (defaults to 1).
 * @typedef {{ file: string, offset: number, line: number, column: number, length?: number }} Location
 */

export class Diagnostic {
  /**
   * @param {object} init
   * @param {string} init.code
   * @param {string} init.phase
   * @param {string} init.message
   * @param {Location} [init.location]
   * @param {string} [init.help]
   * @param {string} [init.severity]
   * @param {string[]} [init.stack]  Typhoun call stack (runtime errors only).
   * @param {string[]} [init.notes]
   */
  constructor({
    code,
    phase,
    message,
    location = null,
    help = null,
    severity = Severity.ERROR,
    stack = [],
    notes = [],
  }) {
    this.code = code;
    this.phase = phase;
    this.message = message;
    this.location = location;
    this.help = help;
    this.severity = severity;
    this.stack = stack;
    this.notes = notes;
  }

  get isError() {
    return this.severity === Severity.ERROR;
  }

  /** A compact single-line form, useful for logs and tests. */
  toCompactString() {
    const where = this.location
      ? `${this.location.file}:${this.location.line}:${this.location.column}`
      : "<unknown>";
    return `${this.severity}[${this.code}]: ${this.message} (${where})`;
  }

  toJSON() {
    return {
      code: this.code,
      phase: this.phase,
      severity: this.severity,
      message: this.message,
      location: this.location,
      help: this.help,
      notes: this.notes,
      stack: this.stack,
    };
  }
}

/** Collects diagnostics across a pipeline stage. */
export class DiagnosticBag {
  constructor() {
    /** @type {Diagnostic[]} */
    this.items = [];
  }

  add(diagnostic) {
    this.items.push(diagnostic);
    return diagnostic;
  }

  error(code, phase, message, init = {}) {
    return this.add(new Diagnostic({ code, phase, message, ...init }));
  }

  warning(code, phase, message, init = {}) {
    return this.add(
      new Diagnostic({ code, phase, message, severity: Severity.WARNING, ...init }),
    );
  }

  get errors() {
    return this.items.filter((d) => d.isError);
  }

  get warnings() {
    return this.items.filter((d) => !d.isError);
  }

  get hasErrors() {
    return this.items.some((d) => d.isError);
  }

  get length() {
    return this.items.length;
  }

  /** Merge another bag's entries into this one. */
  merge(other) {
    for (const d of other.items) this.items.push(d);
    return this;
  }

  toJSON() {
    return this.items.map((d) => d.toJSON());
  }
}

/**
 * Thrown when a pipeline stage cannot continue because of fatal diagnostics.
 * Carries the full list so callers can render every reported problem.
 */
export class TyphounError extends Error {
  /**
   * @param {Diagnostic|Diagnostic[]} diagnostic
   */
  constructor(diagnostic) {
    const list = Array.isArray(diagnostic) ? diagnostic : [diagnostic];
    const first = list[0];
    super(first ? first.message : "Typhoun error");
    this.name = "TyphounError";
    this.diagnostics = list;
  }

  get primary() {
    return this.diagnostics[0];
  }
}
