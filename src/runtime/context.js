/**
 * Stage F — Execution context.
 *
 * Owns everything that is *around* evaluation rather than part of it:
 * resource accounting, the output buffer, the input channel and the wall
 * clock. The interpreter asks the context for permission before doing
 * anything unbounded.
 */
import { DEFAULT_LIMITS } from "../config.js";
import { Code } from "../diagnostics/codes.js";
import { RuntimeFault } from "./errors.js";

const STEP_CHECK_MASK = 0x3ff; // check the clock every 1024 steps

export class ExecutionContext {
  /**
   * @param {object} [options]
   * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
   * @param {(text: string) => void} [options.onOutput]
   * @param {(prompt: string) => string|null} [options.onInput]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.onOutput = options.onOutput ?? null;
    this.onInput = options.onInput ?? null;
    this.now = options.now ?? (() => Date.now());

    this.steps = 0;
    this.outputChars = 0;
    /** @type {string[]} */
    this.output = [];
    /** @type {{name: string, loc: object|null}[]} */
    this.callStack = [];
    this.collectionElements = 0;
    this.moduleCount = 0;
    this.startedAt = this.now();
    this.truncated = false;
  }

  /** Count one evaluated step and enforce step/time limits. */
  tick(loc = null) {
    this.steps += 1;
    if (this.steps > this.limits.maxSteps) {
      throw new RuntimeFault(
        Code.STEP_LIMIT,
        `Execution limit reached: more than ${this.limits.maxSteps} steps`,
        loc,
        "The program ran too long. Check for an infinite loop.",
        this.stackFrames(),
      );
    }
    if ((this.steps & STEP_CHECK_MASK) === 0) this.checkTime(loc);
  }

  checkTime(loc = null) {
    const elapsed = this.now() - this.startedAt;
    if (elapsed > this.limits.maxDurationMs) {
      throw new RuntimeFault(
        Code.TIME_LIMIT,
        `Execution limit reached: ran longer than ${this.limits.maxDurationMs} ms`,
        loc,
        "The program exceeded the wall-clock budget.",
        this.stackFrames(),
      );
    }
  }

  stackFrames() {
    return this.callStack
      .slice()
      .reverse()
      .map((f) => {
        const where = f.loc ? `${f.loc.file}:${f.loc.line}:${f.loc.column}` : "<unknown>";
        return `${f.name} (${where})`;
      });
  }

  /** Append program output, enforcing the output limit. */
  write(text) {
    if (this.outputChars + text.length > this.limits.maxOutputChars) {
      const remaining = this.limits.maxOutputChars - this.outputChars;
      if (remaining > 0) {
        this.output.push(text.slice(0, remaining));
        this.outputChars += remaining;
      }
      this.truncated = true;
      throw new RuntimeFault(
        Code.OUTPUT_LIMIT,
        `Output limit reached: more than ${this.limits.maxOutputChars} characters`,
        null,
        "Reduce how much the program prints.",
        this.stackFrames(),
      );
    }
    this.outputChars += text.length;
    this.output.push(text);
    if (this.onOutput) this.onOutput(text);
  }

  get outputText() {
    return this.output.join("");
  }

  /** Read a line of input, or throw when input is unavailable. */
  read(prompt, loc) {
    if (!this.limits.allowInput || !this.onInput) {
      throw new RuntimeFault(
        Code.BAD_NATIVE_ARGUMENT,
        "input() is not available in this execution environment",
        loc,
        "Input is disabled for untrusted programs.",
        this.stackFrames(),
      );
    }
    const value = this.onInput(prompt);
    return value === null || value === undefined ? "" : String(value);
  }

  /** Account for newly created collection elements and enforce the size cap. */
  accountCollection(count, loc) {
    this.collectionElements += count;
    if (this.collectionElements > this.limits.maxCollectionSize) {
      throw new RuntimeFault(
        Code.COLLECTION_LIMIT,
        `Collection limit reached: more than ${this.limits.maxCollectionSize} elements`,
        loc,
        "Reduce the size of the data the program builds.",
        this.stackFrames(),
      );
    }
  }

  accountModule(loc) {
    this.moduleCount += 1;
    if (this.moduleCount > this.limits.maxModules) {
      throw new RuntimeFault(
        Code.COLLECTION_LIMIT,
        `Module limit reached: more than ${this.limits.maxModules} modules`,
        loc,
        "Reduce the number of imported modules.",
        this.stackFrames(),
      );
    }
  }

  elapsedMs() {
    return this.now() - this.startedAt;
  }
}
