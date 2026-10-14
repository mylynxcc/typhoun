/**
 * Stage F/8 — Module system.
 *
 * Security model:
 *  - paths are resolved relative to the importing file;
 *  - only files ending in `.typ` inside the configured project root may be
 *    imported (no `..` escapes, no absolute paths);
 *  - each module is executed at most once and cached;
 *  - import cycles are reported instead of looping.
 *
 * Discovery and validation happen before execution: every reachable module is
 * lexed, parsed and semantically resolved first, so `check` is meaningful and
 * the interpreter never starts from a broken graph.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { NodeType } from "../ast/nodes.js";
import { Resolver, builtinNames } from "../semantic/resolver.js";
import { DiagnosticBag, Diagnostic, Phase, TyphounError } from "../diagnostics/diagnostic.js";
import { Code } from "../diagnostics/codes.js";
import { Environment } from "../runtime/environment.js";
import { TMap } from "../runtime/values.js";
import { LANG_EXTENSION, DEFAULT_LIMITS } from "../config.js";

/**
 * Every `import` statement in a module, in source order.
 *
 * Imports are collected from the whole tree rather than only from the top
 * level, so an import written inside a block is still resolved, parsed and
 * validated before the program runs. Nothing about *when* it executes changes.
 *
 * @param {object} node
 * @param {object[]} [out]
 * @returns {object[]}
 */
function collectImports(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectImports(item, out);
    return out;
  }
  if (!node || typeof node !== "object" || typeof node.type !== "string") return out;
  if (node.type === NodeType.ImportStmt) {
    out.push(node);
    return out;
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "type") continue;
    collectImports(node[key], out);
  }
  return out;
}

export class ModuleLoader {
  /**
   * @param {object} options
   * @param {import("../source/source-manager.js").SourceManager} options.sourceManager
   * @param {string} options.rootDir Boundary for all imports.
   * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
   */
  constructor(options) {
    this.sourceManager = options.sourceManager;
    this.explicitRoot = options.rootDir != null;
    this.rootDir = resolve(options.rootDir ?? process.cwd());
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.diagnostics = new DiagnosticBag();
    /** @type {Map<string, object>} */
    this.graph = new Map();
    /** @type {string[]} */
    this.order = [];
    /** @type {Map<string, {bindings: Map<string, unknown>, namespace: TMap, env: Environment}>} */
    this.cache = new Map();
    this.executing = new Set();
    this.interpreter = null;
    this.baseEnv = null;
  }

  /** Called once the interpreter exists so module bodies can run. */
  attach(interpreter) {
    this.interpreter = interpreter;
    this.baseEnv = interpreter.createGlobalEnvironment();
  }

  // ----------------------------------------------------------- path handling

  /** Resolve and validate an import specifier. Throws on policy violations. */
  resolveSpec(specPath, fromFile, loc) {
    if (!specPath.endsWith(LANG_EXTENSION)) {
      throw this.fault(
        Code.MODULE_NOT_FOUND,
        `Module path '${specPath}' must end with '${LANG_EXTENSION}'`,
        loc,
        `Example: import "util${LANG_EXTENSION}"`,
      );
    }
    const baseDir = fromFile ? dirname(fromFile) : this.rootDir;
    const abs = resolve(baseDir, specPath);
    const rel = relative(this.rootDir, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === "..") {
      throw this.fault(
        Code.MODULE_OUT_OF_BOUNDS,
        `Import '${specPath}' escapes the project root`,
        loc,
        `Only modules inside '${this.rootDir}' may be imported.`,
      );
    }
    if (!existsSync(abs)) {
      throw this.fault(
        Code.MODULE_NOT_FOUND,
        `Cannot find module '${specPath}'`,
        loc,
        `Looked for '${abs}'.`,
      );
    }
    // The check above is purely lexical, so a symlink placed inside the root
    // would pass it while its target lives outside. Resolve both the module
    // and the root to their real paths and re-check containment, which closes
    // that escape. `realpathSync` also normalises `/tmp` -> `/private/tmp` on
    // macOS, so the two sides are always compared on the same footing.
    let realAbs;
    let realRoot;
    try {
      realAbs = realpathSync(abs);
      realRoot = realpathSync(this.rootDir);
    } catch (err) {
      // A symlink loop, or the file vanishing between the check and here,
      // is a load failure like any other — not a host exception.
      throw this.fault(
        Code.MODULE_NOT_FOUND,
        `Cannot resolve module '${specPath}' (${err.code ?? err.message})`,
        loc,
        `Looked for '${abs}'.`,
      );
    }
    const realRel = relative(realRoot, realAbs);
    if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
      throw this.fault(
        Code.MODULE_OUT_OF_BOUNDS,
        `Import '${specPath}' escapes the project root`,
        loc,
        `Only modules inside '${this.rootDir}' may be imported.`,
      );
    }
    return abs;
  }

  fault(code, message, loc, help) {
    const diagnostic = new Diagnostic({ code, phase: Phase.IMPORT, message, location: loc, help });
    return new TyphounError(diagnostic);
  }

  // -------------------------------------------------------------- discovery

  /**
   * Parse and semantically validate every module reachable from `entryPath`.
   * @param {string} entryPath Absolute path of the entry module.
   * @returns {Map<string, object>} the module graph
   */
  discover(entryPath) {
    this.graph = new Map();
    this.order = [];
    const entryAbs = resolve(entryPath);
    if (!this.explicitRoot) this.rootDir = dirname(entryAbs);
    this.visit(entryAbs, null);
    if (this.diagnostics.hasErrors) {
      throw new TyphounError(this.diagnostics.errors);
    }
    this.resolveSemantics();
    if (this.diagnostics.hasErrors) {
      throw new TyphounError(this.diagnostics.errors);
    }
    return this.graph;
  }

  visit(absPath, loc) {
    const existing = this.graph.get(absPath);
    if (existing) {
      if (existing.state === "visiting") {
        throw this.fault(
          Code.IMPORT_CYCLE,
          `Import cycle detected involving '${relative(this.rootDir, absPath)}'`,
          loc,
          "Break the cycle by moving shared code into its own module.",
        );
      }
      return;
    }

    const record = { path: absPath, state: "visiting", ast: null, file: null, imports: [], exports: new Set() };
    this.graph.set(absPath, record);
    this.order.push(absPath);

    const file = this.loadSource(absPath);
    record.file = file;

    const lexer = new Lexer(file);
    const tokens = lexer.tokenize();
    this.diagnostics.merge(lexer.diagnostics);

    const parser = new Parser(tokens);
    const ast = parser.parse();
    this.diagnostics.merge(parser.diagnostics);
    record.ast = ast;

    for (const stmt of ast.body) {
      if (stmt.type === NodeType.VarDecl) record.exports.add(stmt.name);
      else if (stmt.type === NodeType.FnDecl) record.exports.add(stmt.name);
    }
    // Every import is discovered statically, including one written inside a
    // block (`try { import "x.typ" } catch err { }`). Whether it runs depends
    // on the path taken, but whether it *exists* is decided here, which is what
    // makes a missing module a load error rather than a runtime one.
    for (const stmt of collectImports(ast)) {
      record.imports.push({ path: stmt.path, alias: stmt.alias, loc: stmt.loc });
    }

    for (const imp of record.imports) {
      let resolved = null;
      try {
        resolved = this.resolveSpec(imp.path, absPath, imp.loc);
      } catch (err) {
        if (err instanceof TyphounError) {
          for (const d of err.diagnostics) this.diagnostics.add(d);
        } else {
          throw err;
        }
      }
      imp.resolved = resolved;
      if (resolved) this.visit(resolved, imp.loc);
    }

    record.state = "visited";
  }

  loadSource(absPath) {
    const text = readFileSync(absPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > this.limits.maxSourceBytes) {
      throw this.fault(
        Code.SOURCE_LIMIT,
        `Source file exceeds the ${this.limits.maxSourceBytes} byte limit`,
        { file: absPath, line: 1, column: 1, offset: 0, length: 1 },
        "Split the file into smaller modules.",
      );
    }
    return this.sourceManager.add(absPath, text);
  }

  resolveSemantics() {
    const builtins = builtinNames();
    for (const record of this.graph.values()) {
      if (!record.ast) continue;
      const globals = new Set(builtins);
      for (const imp of record.imports) {
        if (!imp.resolved) continue;
        if (imp.alias) {
          globals.add(imp.alias);
        } else {
          const target = this.graph.get(imp.resolved);
          if (target) for (const name of target.exports) globals.add(name);
        }
      }
      const resolver = new Resolver({ globals });
      const bag = resolver.resolve(record.ast);
      this.diagnostics.merge(bag);
    }
  }

  // -------------------------------------------------------------- execution

  /**
   * Execute a module (once) and return its exported bindings.
   * @param {string} specPath As written in the import statement.
   * @param {string|null} fromFile Importing file (for relative resolution).
   * @param {object|null} loc Source location of the import statement.
   */
  requireModule(specPath, fromFile, loc) {
    if (!this.interpreter) throw new Error("ModuleLoader.attach(interpreter) was not called");
    const abs = this.resolveSpec(specPath, fromFile, loc);
    const record = this.graph.get(abs);
    if (!record || !record.ast) {
      throw this.fault(Code.MODULE_NOT_FOUND, `Module '${specPath}' was not loaded`, loc);
    }
    if (this.cache.has(abs)) return this.cache.get(abs);
    if (this.executing.has(abs)) {
      throw this.fault(
        Code.IMPORT_CYCLE,
        `Import cycle detected while executing '${relative(this.rootDir, abs)}'`,
        loc,
      );
    }

    this.executing.add(abs);
    this.interpreter.context.accountModule(loc);
    const env = new Environment(this.baseEnv);
    const previousFile = this.interpreter.currentFile;
    this.interpreter.currentFile = abs;
    try {
      this.interpreter.hoistFunctions(record.ast.body, env);
      this.interpreter.executeStatements(record.ast.body, env, false);
    } finally {
      this.interpreter.currentFile = previousFile;
      this.executing.delete(abs);
    }

    const bindings = new Map();
    for (const [name, binding] of env.bindings) bindings.set(name, binding.value);
    const namespace = TMap.fromPairs([...bindings.entries()]);
    const result = { bindings, namespace, env, path: abs };
    this.cache.set(abs, result);
    return result;
  }

  /** Exported names of a module by absolute path (used by tooling/tests). */
  exportsOf(absPath) {
    const record = this.graph.get(resolve(absPath));
    return record ? [...record.exports] : [];
  }
}
