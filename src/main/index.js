/**
 * Typhoun public API.
 *
 * A thin facade over the pipeline stages so the CLI, the tests and any future
 * embedding host all use exactly the same code path:
 *
 *   tokenize → parse → resolve → interpret
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SourceManager } from "../source/source-manager.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { Resolver, builtinNames } from "../semantic/resolver.js";
import { Interpreter } from "../interpreter/interpreter.js";
import { VirtualMachine } from "../vm/vm.js";
import { compileProgram } from "../compiler/compiler.js";
import { formatSource } from "../format/formatter.js";
import { disassemble } from "../bytecode/disassembler.js";
import { chunkStats } from "../bytecode/chunk.js";
import { ExecutionContext } from "../runtime/context.js";
import { Environment } from "../runtime/environment.js";
import { ModuleLoader } from "../modules/module-loader.js";
import { DiagnosticBag, TyphounError } from "../diagnostics/diagnostic.js";
import { DEFAULT_LIMITS, LANG_EXTENSION } from "../config.js";

export { SourceManager } from "../source/source-manager.js";
export { SourceFile } from "../source/source-file.js";
export { Lexer } from "../lexer/lexer.js";
export { Parser } from "../parser/parser.js";
export { Resolver, builtinNames } from "../semantic/resolver.js";
export { Interpreter } from "../interpreter/interpreter.js";
export { VirtualMachine } from "../vm/vm.js";
export { Upvalue, IterState } from "../vm/vm.js";
export { Chunk, chunkStats, walkChunks } from "../bytecode/chunk.js";
export { OP, OP_NAME, OP_OPERANDS } from "../bytecode/opcodes.js";
export { compileProgram } from "../compiler/compiler.js";
export { formatSource, Formatter, DEFAULT_WIDTH, DEFAULT_INDENT } from "../format/formatter.js";
export { lintSource, lintFile } from "../lint/linter.js";
export {
  RULES as LINT_RULES,
  RULE_NAMES as LINT_RULE_NAMES,
  RULE_CODES as LINT_RULE_CODES,
  selectRules,
  unknownRules,
} from "../lint/rules.js";
export { disassemble, disassembleSummary } from "../bytecode/disassembler.js";
export { ExecutionContext } from "../runtime/context.js";
export { applyBinaryOperator, applyUnaryOperator } from "../runtime/operators.js";
export { getIndexValue, setIndexValue, iterableItems } from "../runtime/indexing.js";
export { Environment } from "../runtime/environment.js";
export {
  NULL,
  TArray,
  TMap,
  TClosure,
  TFunction,
  TNativeFunction,
  typeOf,
  toDisplay,
  toRepr,
} from "../runtime/values.js";
export { ModuleLoader } from "../modules/module-loader.js";
export {
  Diagnostic,
  DiagnosticBag,
  TyphounError,
  Phase,
  Severity,
} from "../diagnostics/diagnostic.js";
export { renderDiagnostic, renderDiagnostics } from "../diagnostics/renderer.js";
export { printAst } from "../ast/printer.js";
export { NodeType, nodes } from "../ast/nodes.js";
export { TokenType, Token } from "../lexer/token.js";

/** Stage B only. */
export function tokenizeSource(text, fileName = "<source>", sourceManager = new SourceManager()) {
  const file = sourceManager.add(fileName, text);
  const lexer = new Lexer(file);
  const tokens = lexer.tokenize();
  return { tokens, diagnostics: lexer.diagnostics, file, sourceManager };
}

/** Stage B + C. */
export function parseSource(text, fileName = "<source>", sourceManager = new SourceManager()) {
  const { tokens, diagnostics, file } = tokenizeSource(text, fileName, sourceManager);
  const parser = new Parser(tokens);
  const ast = parser.parse();
  const bag = new DiagnosticBag().merge(diagnostics).merge(parser.diagnostics);
  return { tokens, ast, diagnostics: bag, file, sourceManager };
}

/** Stage B + C + E, without executing anything. */
export function checkSource(text, fileName = "<source>", options = {}) {
  const sourceManager = options.sourceManager ?? new SourceManager();
  const { tokens, ast, diagnostics, file } = parseSource(text, fileName, sourceManager);
  if (!diagnostics.hasErrors) {
    const resolver = new Resolver({ globals: options.globals ?? builtinNames() });
    diagnostics.merge(resolver.resolve(ast));
  }
  return { tokens, ast, diagnostics, file, sourceManager };
}

function makeContext(options) {
  return (
    options.context ??
    new ExecutionContext({
      limits: options.limits,
      onOutput: options.onOutput,
      onInput: options.onInput,
      now: options.now,
    })
  );
}

/**
 * Execution backends. `tree` walks the AST; `vm` runs compiled bytecode.
 *
 * `vm` is the default: compiling first is the path the project intends to grow
 * along (see `docs/bytecode.md`), and both engines are required to agree, so
 * the choice is about which one the project exercises by default rather than
 * about which language a program sees. It is not yet the quick one — over the
 * benchmark suite the VM runs at a median 0.37x of the tree-walker's speed — so
 * `--engine tree` remains available as the faster backend.
 */
export const ENGINES = Object.freeze(["tree", "vm"]);
export const DEFAULT_ENGINE = "vm";

/**
 * Build an execution engine by name. Both engines expose the same runtime
 * surface (`context`, `currentFile`, `run`, `createGlobalEnvironment`,
 * `executeStatements`), so the module loader and the CLI do not care which
 * one they are driving.
 */
export function createEngine(engineName, deps = {}) {
  const engine = engineName ?? DEFAULT_ENGINE;
  if (engine === "vm") return new VirtualMachine(deps);
  if (engine === "tree") return new Interpreter(deps);
  throw new ConfigurationError(
    `Unknown engine '${engine}'. Expected one of: ${ENGINES.join(", ")}`,
  );
}

/** Execute a single source string (module imports resolve against the root). */
export function runSource(text, fileName = "<source>", options = {}) {
  const sourceManager = options.sourceManager ?? new SourceManager();
  const { tokens, ast, diagnostics, file } = parseSource(text, fileName, sourceManager);
  if (diagnostics.hasErrors) throw new TyphounError(diagnostics.errors);

  const loader = new ModuleLoader({
    sourceManager,
    rootDir: options.moduleRoot ?? process.cwd(),
    limits: options.limits,
  });
  const context = makeContext(options);
  const engine = createEngine(options.engine, { sourceManager, context, moduleSystem: loader });
  loader.attach(engine);

  const semantic = new Resolver({ globals: builtinNames() }).resolve(ast);
  if (semantic.hasErrors) throw new TyphounError(semantic.errors);

  const env = new Environment(loader.baseEnv);
  engine.run(ast, { file: file.name, env });
  return { context, engine, interpreter: engine, loader, sourceManager, tokens, ast };
}

/** Execute a `.typ` file from disk, loading and validating its imports. */
export function runFile(path, options = {}) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ConfigurationError(`File not found: ${absolute}`);
  if (!absolute.endsWith(LANG_EXTENSION) && options.allowAnyExtension !== true) {
    throw new ConfigurationError(`Expected a '${LANG_EXTENSION}' source file, got '${absolute}'`);
  }

  const sourceManager = options.sourceManager ?? new SourceManager();
  const loader = new ModuleLoader({
    sourceManager,
    rootDir: options.moduleRoot,
    limits: options.limits,
  });
  loader.discover(absolute); // throws TyphounError on lexical/syntax/semantic/import errors

  const context = makeContext(options);
  const engine = createEngine(options.engine, { sourceManager, context, moduleSystem: loader });
  loader.attach(engine);

  const entry = loader.graph.get(absolute);
  const env = new Environment(loader.baseEnv);
  engine.run(entry.ast, { file: absolute, env });

  return { context, engine, interpreter: engine, loader, sourceManager, entry };
}

/** Statically validate a file and all of its imports without executing. */
export function checkFile(path, options = {}) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ConfigurationError(`File not found: ${absolute}`);
  const sourceManager = options.sourceManager ?? new SourceManager();
  const loader = new ModuleLoader({
    sourceManager,
    rootDir: options.moduleRoot,
    limits: options.limits,
  });
  try {
    loader.discover(absolute);
    return { diagnostics: loader.diagnostics, loader, sourceManager, ok: true };
  } catch (err) {
    if (err instanceof TyphounError) {
      const bag = new DiagnosticBag();
      for (const d of err.diagnostics) bag.add(d);
      return { diagnostics: bag, loader, sourceManager, ok: false };
    }
    throw err;
  }
}

/**
 * Compile a source string to bytecode without executing it.
 * @returns {{proto: object, ast: object, tokens: object[], diagnostics: DiagnosticBag, sourceManager: SourceManager}}
 */
export function compileSource(text, fileName = "<source>", options = {}) {
  const sourceManager = options.sourceManager ?? new SourceManager();
  const { tokens, ast, diagnostics, file } = parseSource(text, fileName, sourceManager);
  const semantic = new Resolver({ globals: options.globals ?? builtinNames() }).resolve(ast);
  const bag = new DiagnosticBag().merge(diagnostics).merge(semantic);
  if (bag.hasErrors) throw new TyphounError(bag.errors);
  const proto = compileProgram(ast, { name: file.name });
  return {
    proto,
    ast,
    tokens,
    sourceManager,
    diagnostics: bag,
    stats: chunkStats(proto),
    disassembly: disassemble(proto),
  };
}

/**
 * Compile a `.typ` file and every module it imports, without executing.
 * @returns {{absolute: string, protos: Map<string, object>, loader: ModuleLoader, sourceManager: SourceManager}}
 */
export function compileFile(path, options = {}) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ConfigurationError(`File not found: ${absolute}`);
  const sourceManager = options.sourceManager ?? new SourceManager();
  const loader = new ModuleLoader({
    sourceManager,
    rootDir: options.rootDir,
    limits: options.limits,
  });
  loader.discover(absolute);
  /** @type {Map<string, object>} */
  const protos = new Map();
  for (const [absPath, record] of loader.graph) {
    if (record.ast) protos.set(absPath, compileProgram(record.ast, { name: absPath }));
  }
  return {
    absolute,
    entry: protos.get(absolute) ?? null,
    protos,
    loader,
    sourceManager,
    diagnostics: loader.diagnostics,
  };
}

/**
 * Format a `.typ` file and return the canonical source.
 *
 * @param {string} path
 * @param {{ width?: number, indent?: string }} [options]
 * @returns {{ path: string, code: string, formatted: boolean, diagnostics: DiagnosticBag, file: object, comments: object[], ast: object|null }}
 */
export function formatFile(path, options = {}) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ConfigurationError(`File not found: ${absolute}`);
  const text = readFileSync(absolute, "utf8");
  const result = formatSource(text, absolute, options);
  return { ...result, path: absolute };
}

/** Raised for CLI-level problems (missing file, wrong extension). */
export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export { DEFAULT_LIMITS };
