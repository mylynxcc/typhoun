/**
 * Shared test helpers.
 *
 * Everything runs through the same public API the CLI uses, so tests exercise
 * the real pipeline rather than a parallel implementation.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  ExecutionContext,
  checkSource,
  parseSource,
  runFile,
  runSource,
  tokenizeSource,
} from "../src/main/index.js";
import { Lexer } from "../src/lexer/lexer.js";
import { SourceManager } from "../src/source/source-manager.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(here, "fixtures");
export function fixture(...parts) {
  return resolve(FIXTURES, ...parts);
}

/** Tokenize without throwing; returns { tokens, diagnostics }. */
export function lex(source, fileName = "<test>") {
  const manager = new SourceManager();
  const file = manager.add(fileName, source);
  const lexer = new Lexer(file);
  const tokens = lexer.tokenize();
  return { tokens, diagnostics: lexer.diagnostics, sourceManager: manager, file };
}

/** Tokenize and require zero lexical errors. */
export function lexOk(source, fileName = "<test>") {
  const result = lex(source, fileName);
  if (result.diagnostics.hasErrors) {
    throw new Error(
      "Unexpected lexical errors: " + result.diagnostics.items.map((d) => d.toCompactString()).join("; "),
    );
  }
  return result.tokens;
}

/** Parse and return { ast, diagnostics }. */
export function parse(source, fileName = "<test>") {
  return parseSource(source, fileName);
}

/** Run a source string and capture output. Throws on any failure. */
export function execute(source, options = {}) {
  const chunks = [];
  const result = runSource(source, options.fileName ?? "<test>", {
    engine: options.engine,
    limits: options.limits,
    moduleRoot: options.moduleRoot,
    context: options.context,
    now: options.now,
    onOutput: (text) => chunks.push(text),
    onInput: options.onInput ?? (() => ""),
  });
  return { output: chunks.join(""), ...result };
}

/** Run and return the output text only. */
export function outputOf(source, options) {
  return execute(source, options).output;
}

/**
 * Run the same source on both execution engines and return a comparable
 * summary of each: output, or the diagnostic code/message/stack depth.
 * Used by the engine-parity tests to prove the two backends agree.
 */
export function runOnBothEngines(source, options = {}) {
  const results = {};
  for (const engine of ["tree", "vm"]) {
    const chunks = [];
    try {
      runSource(source, options.fileName ?? "<parity>", {
        engine,
        limits: options.limits,
        moduleRoot: options.moduleRoot,
        now: options.now,
        onOutput: (text) => chunks.push(text),
        onInput: options.onInput ?? (() => ""),
      });
      results[engine] = { ok: true, output: chunks.join(""), error: null };
    } catch (err) {
      const diagnostic = firstDiagnostic(err);
      results[engine] = {
        ok: false,
        output: chunks.join(""),
        error: diagnostic
          ? { code: diagnostic.code, message: diagnostic.message, frames: diagnostic.stack.length }
          : { code: "non-diagnostic", message: String(err && err.message), frames: 0 },
      };
    }
  }
  return results;
}

/** Run expecting failure; returns the thrown error (or null). */
export function expectFailure(source, options = {}) {
  try {
    execute(source, options);
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Run a fixture file with a private output buffer.
 * @param {string} path
 * @param {object} [options]
 */
export function runFixture(path, options = {}) {
  const chunks = [];
  const result = runFile(path, {
    engine: options.engine,
    limits: options.limits,
    context: new ExecutionContext({
      limits: options.limits,
      onOutput: (text) => chunks.push(text),
      onInput: options.onInput ?? (() => ""),
    }),
  });
  return { output: chunks.join(""), ...result };
}

/** Check a source string; returns the DiagnosticBag. */
export function check(source, options = {}) {
  return checkSource(source, options.fileName ?? "<test>", options).diagnostics;
}

/** Collect the diagnostic codes produced by a check. */
export function codes(source, options = {}) {
  return check(source, options).items.map((d) => d.code);
}

export function firstDiagnostic(err) {
  if (!err) return null;
  if (Array.isArray(err.diagnostics) && err.diagnostics.length > 0) return err.diagnostics[0];
  if (typeof err.toDiagnostic === "function") return err.toDiagnostic();
  return null;
}

export { runSource, runFile, tokenizeSource, checkSource, parseSource, ExecutionContext };
