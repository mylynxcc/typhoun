/**
 * Lint — rule registry.
 *
 * The registry is the single source of truth for which rules exist, what codes
 * they report and what each one is for. `typhoun lint` uses it to validate
 * `--rule` / `--disable`, `docs/tooling.md` documents it, and the tests assert
 * that every registered rule is reachable.
 *
 * A rule is a *warning*: it never changes what a program does, and the linter
 * never rewrites source. Each rule is named after the problem, not the fix, so
 * the name stays true as the suggestion evolves.
 */
import { Code } from "../diagnostics/codes.js";
import { AnalyzerRules } from "./analyzer.js";

/**
 * @typedef {{ name: string, code: string, summary: string, example: string }} LintRule
 */

/** @type {LintRule[]} */
export const RULES = Object.freeze([
  {
    name: AnalyzerRules.UNUSED_VARIABLE,
    code: Code.LINT_UNUSED_VARIABLE,
    summary: "a binding is declared and never read",
    example: "let unused = 1",
  },
  {
    name: AnalyzerRules.UNUSED_PARAMETER,
    code: Code.LINT_UNUSED_PARAMETER,
    summary: "a function parameter is never read",
    example: "fn f(used, unused) { return used }",
  },
  {
    name: AnalyzerRules.UNUSED_FUNCTION,
    code: Code.LINT_UNUSED_FUNCTION,
    summary: "a top-level function is never referenced in this file",
    example: "fn neverCalled() { return 1 }",
  },
  {
    name: AnalyzerRules.UNUSED_LOOP_VARIABLE,
    code: Code.LINT_UNUSED_LOOP_VARIABLE,
    summary: "a `for ... in` variable is never read",
    example: "for key in items { print(items) }",
  },
  {
    name: AnalyzerRules.SHADOWED_VARIABLE,
    code: Code.LINT_SHADOWED_VARIABLE,
    summary: "an inner binding hides an outer one with the same name",
    example: "let n = 1\nfn f() { let n = 2\n  return n }",
  },
  {
    name: AnalyzerRules.PREFER_CONST,
    code: Code.LINT_PREFER_CONST,
    summary: "a `let` binding is never reassigned",
    example: "let name = \"Typhoun\"",
  },
  {
    name: AnalyzerRules.UNREACHABLE_CODE,
    code: Code.LINT_UNREACHABLE_CODE,
    summary: "statements follow a `return`, `break` or `continue` in one block",
    example: "fn f() { return 1\n  print(2) }",
  },
  {
    name: AnalyzerRules.CONSTANT_CONDITION,
    code: Code.LINT_CONSTANT_CONDITION,
    summary: "an `if`/`while` condition is a literal",
    example: "if true { print(1) }",
  },
  {
    name: AnalyzerRules.SELF_ASSIGNMENT,
    code: Code.LINT_SELF_ASSIGNMENT,
    summary: "a binding is assigned its own value",
    example: "x = x",
  },
  {
    name: AnalyzerRules.REDUNDANT_PARENTHESES,
    code: Code.LINT_REDUNDANT_PARENTHESES,
    summary: "parentheses wrap a leaf expression and change nothing",
    example: "let n = (1)",
  },
  {
    name: AnalyzerRules.DIVISION_BY_ZERO,
    code: Code.LINT_DIVISION_BY_ZERO,
    summary: "`/ 0` or `% 0` with a literal zero divisor",
    example: "print(10 / 0)",
  },
  {
    name: AnalyzerRules.EMPTY_BLOCK,
    code: Code.LINT_EMPTY_BLOCK,
    summary: "a control-flow body is empty and has no comment explaining it",
    example: "if ready { }",
  },
  {
    name: AnalyzerRules.DEAD_STORE,
    code: Code.LINT_DEAD_STORE,
    summary: "a value is written and then overwritten, or goes out of scope, unread",
    example: "let total = 0\ntotal = 1\nprint(total)",
  },
]);

/** Every rule name, in registry order. */
export const RULE_NAMES = Object.freeze(RULES.map((rule) => rule.name));

/** Rule name → code, for tooling and tests. */
export const RULE_CODES = Object.freeze(
  Object.fromEntries(RULES.map((rule) => [rule.name, rule.code])),
);

/**
 * Decide which rules are enabled.
 *
 * @param {{ rules?: string[]|null, disable?: string[] }} [options]
 *        `rules` is an allow-list (null/empty means "all of them"); `disable`
 *        removes names from the result either way.
 * @returns {Set<string>}
 */
export function selectRules({ rules = null, disable = [] } = {}) {
  const enabled = new Set(rules && rules.length > 0 ? rules : RULE_NAMES);
  for (const name of disable) enabled.delete(name);
  return enabled;
}

/** Names in `names` that are not registered rules. */
export function unknownRules(names) {
  const known = new Set(RULE_NAMES);
  return names.filter((name) => !known.has(name));
}
