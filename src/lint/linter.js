/**
 * Lint — orchestration.
 *
 * Pipeline: lex → parse → resolve → analyze → warnings. Errors from the lexer,
 * parser and resolver are reported alongside the warnings, so `typhoun lint`
 * doubles as `typhoun check` plus advise.
 *
 * Every warning carries a code (`TYP7001`…), a source location and a `help`
 * line that says what to do about it. Nothing is auto-fixed: a lint warning is
 * a suggestion, and a tool that silently rewrites code is a different tool.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { Resolver, builtinNames } from "../semantic/resolver.js";
import {
  Phase,
  Severity,
  Diagnostic,
  DiagnosticBag,
  TyphounError,
} from "../diagnostics/diagnostic.js";
import { Code } from "../diagnostics/codes.js";
import { SourceManager } from "../source/source-manager.js";
import { ModuleLoader } from "../modules/module-loader.js";
import { analyze, AnalyzerRules } from "./analyzer.js";
import { selectRules } from "./rules.js";
import { NodeType } from "../ast/nodes.js";

/** Add every enabled warning for an AST to `bag`. */
function addLintWarnings(bag, file, ast, comments, options) {
  const enabled = selectRules(options);
  const { bindings, findings } = analyze(ast, { comments });
  const library = isLibraryModule(ast);
  for (const finding of findings) {
    if (!enabled.has(finding.rule)) continue;
    addWarning(bag, file, finding.rule, finding.loc, finding.message, finding.help);
  }
  for (const binding of bindings) {
    const report = bindingRule(binding, { library });
    if (!report || !enabled.has(report.rule)) continue;
    addWarning(bag, file, report.rule, binding.loc, report.message, report.help);
  }
}

/**
 * A library module is a file whose top level is nothing but declarations, at
 * least one of them a function — a module written to be imported, like
 * `examples/modules/math.typ`.
 *
 * Typhoun exports every top-level declaration, so "never used in this file"
 * carries no information about a library's public names. A file that also does
 * something at the top level is a program, and there a leftover binding or
 * function really is dead weight.
 */
function isLibraryModule(ast) {
  let hasFunction = false;
  for (const statement of ast.body) {
    if (statement.type === NodeType.FnDecl) {
      hasFunction = true;
    } else if (
      statement.type !== NodeType.VarDecl &&
      statement.type !== NodeType.ImportStmt
    ) {
      return false;
    }
  }
  return hasFunction;
}

/**
 * Lint a source string.
 *
 * @param {string} text
 * @param {string} [fileName]
 * @param {{ rules?: string[]|null, disable?: string[], globals?: Set<string>|Map<string, unknown>, sourceManager?: SourceManager }} [options]
 * @returns {{
 *   diagnostics: DiagnosticBag,
 *   warnings: Diagnostic[],
 *   errors: Diagnostic[],
 *   sourceManager: SourceManager,
 *   file: object,
 *   ast: object|null,
 * }}
 */
export function lintSource(text, fileName = "<source>", options = {}) {
  const sourceManager = options.sourceManager ?? new SourceManager();
  const file = sourceManager.add(fileName, text);
  const lexer = new Lexer(file, { collectComments: true });
  const tokens = lexer.tokenize();
  const diagnostics = lexer.diagnostics;
  const parser = new Parser(tokens);
  const ast = parser.parse();
  diagnostics.merge(parser.diagnostics);

  if (diagnostics.hasErrors) {
    return {
      diagnostics,
      warnings: diagnostics.warnings,
      errors: diagnostics.errors,
      sourceManager,
      file,
      ast: null,
    };
  }

  const resolver = new Resolver({ globals: options.globals ?? builtinNames() });
  diagnostics.merge(resolver.resolve(ast));

  addLintWarnings(diagnostics, file, ast, lexer.comments, options);
  diagnostics.items.sort(byLocation);
  return {
    diagnostics,
    warnings: diagnostics.warnings,
    errors: diagnostics.errors,
    sourceManager,
    file,
    ast,
  };
}

/**
 * Lint a `.typ` file from disk.
 * @param {string} path
 * @param {object} [options] see `lintSource`
 */
export function lintFile(path, options = {}) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }

  const sourceManager = options.sourceManager ?? new SourceManager();
  const loader = new ModuleLoader({
    sourceManager,
    rootDir: options.rootDir,
    limits: options.limits,
  });
  const diagnostics = new DiagnosticBag();

  try {
    loader.discover(absolute);
    diagnostics.merge(loader.diagnostics);
  } catch (err) {
    if (err instanceof TyphounError) {
      for (const diagnostic of err.diagnostics) diagnostics.add(diagnostic);
    } else {
      throw err;
    }
  }

  const record = loader.graph.get(absolute);
  const file = record?.file ?? sourceManager.get(absolute) ?? null;
  const ast = record?.ast ?? null;

  if (!ast) {
    return { path: absolute, diagnostics, warnings: [], errors: diagnostics.errors, sourceManager, file, ast: null };
  }

  if (!file) {
    return { path: absolute, diagnostics, warnings: [], errors: diagnostics.errors, sourceManager, file: null, ast: null };
  }

  // The loader lexes without comment trivia; re-lex the entry file so rules
  // can tell "empty on purpose, with a comment" from "empty by accident".
  const comments = new Lexer(file, { collectComments: true }).comments;
  addLintWarnings(diagnostics, file, ast, comments, options);
  diagnostics.items.sort(byLocation);

  return {
    path: absolute,
    diagnostics,
    warnings: diagnostics.warnings,
    errors: diagnostics.errors,
    sourceManager,
    file,
    ast,
    loader,
  };
}

/** Rules that are decided by a binding's usage counts. */
function bindingRule(binding, { library = false } = {}) {
  // A `catch` binding nobody reads is how a program says "ignore this error":
  // only deliberate shadowing is worth reporting.
  if (binding.error) return null;
  const intentional = binding.name.startsWith("_");
  // Unused *top-level* names in a library module are its public surface.
  if (library && binding.topLevel && binding.reads === 0) return null;
  if (binding.parameter) {
    if (intentional || binding.reads > 0) return null;
    return {
      rule: AnalyzerRules.UNUSED_PARAMETER,
      message: `Parameter '${binding.name}' is never used`,
      help: "Remove it and update the call sites, or name it with a leading '_' to keep it for the arity.",
    };
  }
  if (binding.loop) {
    if (intentional || binding.reads > 0) return null;
    return {
      rule: AnalyzerRules.UNUSED_LOOP_VARIABLE,
      message: `Loop variable '${binding.name}' is never used`,
      help: "Iterate the values you need, or name it '_' to say the key is intentionally ignored.",
    };
  }
  if (binding.kind === "fn" && binding.topLevel && binding.reads === 0) {
    return {
      rule: AnalyzerRules.UNUSED_FUNCTION,
      message: `Function '${binding.name}' is never called or referenced in this file`,
      help: "Delete it, or call it — a file that only declares things is treated as a library and not reported.",
    };
  }
  if (!intentional && binding.reads === 0) {
    return {
      rule: AnalyzerRules.UNUSED_VARIABLE,
      message: `'${binding.name}' is declared but never read`,
      help: "Remove it, use it, or rename it with a leading '_' to mark it as intentional.",
    };
  }
  // Loop variables are re-bound by the loop itself, so `const` is not an
  // option there even though the body never assigns to them.
  if (
    binding.kind === "let" &&
    !binding.parameter &&
    !binding.loop &&
    binding.writes === 0 &&
    binding.reads > 0
  ) {
    return {
      rule: AnalyzerRules.PREFER_CONST,
      message: `'${binding.name}' is never reassigned; declare it with 'const'`,
      help: "Then the compiler and the reader both know the value cannot change.",
    };
  }
  return null;
}

function addWarning(bag, file, rule, loc, message, help) {
  const location = loc
    ? {
        file: file ? file.name : "<source>",
        offset: loc.offset,
        line: loc.line,
        column: loc.column,
        length: Math.max(1, loc.length ?? 1),
      }
    : null;
  bag.add(
    new Diagnostic({
      code: ruleCode(rule),
      phase: Phase.LINT,
      severity: Severity.WARNING,
      message,
      location,
      help,
    }),
  );
}

const CODES = Object.freeze({
  [AnalyzerRules.UNUSED_VARIABLE]: Code.LINT_UNUSED_VARIABLE,
  [AnalyzerRules.UNUSED_PARAMETER]: Code.LINT_UNUSED_PARAMETER,
  [AnalyzerRules.UNUSED_FUNCTION]: Code.LINT_UNUSED_FUNCTION,
  [AnalyzerRules.UNUSED_LOOP_VARIABLE]: Code.LINT_UNUSED_LOOP_VARIABLE,
  [AnalyzerRules.SHADOWED_VARIABLE]: Code.LINT_SHADOWED_VARIABLE,
  [AnalyzerRules.PREFER_CONST]: Code.LINT_PREFER_CONST,
  [AnalyzerRules.UNREACHABLE_CODE]: Code.LINT_UNREACHABLE_CODE,
  [AnalyzerRules.CONSTANT_CONDITION]: Code.LINT_CONSTANT_CONDITION,
  [AnalyzerRules.SELF_ASSIGNMENT]: Code.LINT_SELF_ASSIGNMENT,
  [AnalyzerRules.REDUNDANT_PARENTHESES]: Code.LINT_REDUNDANT_PARENTHESES,
  [AnalyzerRules.DIVISION_BY_ZERO]: Code.LINT_DIVISION_BY_ZERO,
  [AnalyzerRules.EMPTY_BLOCK]: Code.LINT_EMPTY_BLOCK,
  [AnalyzerRules.DEAD_STORE]: Code.LINT_DEAD_STORE,
});

function ruleCode(rule) {
  const code = CODES[rule];
  if (!code) throw new Error(`lint: no code registered for rule '${rule}'`);
  return code;
}

function byLocation(a, b) {
  const left = a.location?.offset ?? Number.MAX_SAFE_INTEGER;
  const right = b.location?.offset ?? Number.MAX_SAFE_INTEGER;
  return left - right;
}
