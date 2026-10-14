/**
 * `dead-store` is the only lint rule that reasons about the *order* of events,
 * so it is the only one that can be wrong in a way the other tests cannot see:
 * a structural walk can miss a finding, but an ordered analysis can invent one.
 * The guarantee is that every report is true — the value really is never read —
 * and the check below enforces it empirically instead of by argument.
 *
 * For each generated program the rule is asked to lint, every report is
 * *falsified*: the stored value is replaced with a canary and the program is run
 * again. A store whose value is never read cannot change what the program
 * prints, so any difference is a false positive.
 *
 * That conclusion needs one precondition: replacing the value must be the only
 * thing the patch does. So both generators keep the right-hand sides numeric and
 * free of calls — `false + 1` would throw, and a canary that no longer throws
 * would skip the `catch` that observed it, which is a difference in the patch's
 * doing rather than the rule's — and never put two statements on one line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintSource, runFile, LINT_RULE_CODES } from "../../src/main/index.js";

const DEAD_STORE = LINT_RULE_CODES["dead-store"];

/** A tiny deterministic generator, so a failure is reproducible from its seed. */
function generator(seed) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (list) => list[Math.floor(random() * list.length)];
  return { random, pick };
}

/** Programs made of top-level statements: joins, loops, handlers. */
function topLevel(seed) {
  const { random, pick } = generator(seed);
  const WRITES = ["a = 1", "a = 2", "b = 3", "b = a", "a = b", "c = c + 1"];
  const READS = ["print(a)", "print(b)", 'print("t", a, b)'];

  function statement() {
    switch (Math.floor(random() * 12)) {
      case 0:
        return pick(WRITES);
      case 1:
        return pick(READS);
      case 2:
        return `if c { ${pick(WRITES)} }`;
      case 3:
        return `if c { ${pick(READS)} } else { ${pick(WRITES)} }`;
      case 4:
        return `{ ${pick(WRITES)} }`;
      case 5:
        return `${pick(READS)}\n${pick(WRITES)}`;
      case 6:
        return `${pick(WRITES)}\n${pick(READS)}`;
      case 7:
        return `try { ${pick(WRITES)} } catch err { ${pick(READS)} }`;
      case 8:
        return `try { ${pick(READS)} } catch err { ${pick(WRITES)} }`;
      case 9:
        return `while c > 0 {\n    ${pick(WRITES)}\n    break\n}`;
      case 10:
        return `for n in [1, 2] {\n    ${pick(WRITES)}\n}`;
      default:
        return pick([`if c { a = 1 }\n${pick(READS)}`, `if c { ${pick(READS)} }\n${pick(WRITES)}`]);
    }
  }

  return function program() {
    const body = [];
    const count = 2 + Math.floor(random() * 4);
    for (let i = 0; i < count; i += 1) body.push(statement());
    return ["let a = 0", "let b = 1", "let c = 2", ...body, "print(a)"].join("\n") + "\n";
  };
}

/**
 * Programs made of a function body with early returns, nested blocks, closures
 * and handlers — the shapes where an ordered analysis has the most room to be
 * wrong, since a return ends a path in the middle of a statement list.
 */
function inFunction(seed) {
  const { random, pick } = generator(seed);
  const WRITES = ["x = 1", "x = 2", "y = x", "x = y + 1", "x = 3"];
  const READS = ["print(x)", "print(y)", "print(x, y)"];

  function statement() {
    const pad = "    ";
    switch (Math.floor(random() * 10)) {
      case 0:
        return pad + pick(WRITES);
      case 1:
        return pad + pick(READS);
      case 2:
        return pad + `if c { ${pick(WRITES)} }`;
      case 3:
        return pad + `if c { ${pick(READS)} } else { ${pick(WRITES)} }`;
      case 4:
        return pad + `if c { ${pick(WRITES)}; return x }`;
      case 5:
        return `${pad}if c { return x }\n${pad}${pick(WRITES)}`;
      case 6:
        return pad + "{\n" + pad + "    " + pick(WRITES) + "\n" + pad + "}";
      case 7:
        return pad + `try { ${pick(WRITES)} } catch err { ${pick(READS)} }`;
      case 8:
        return pad + `fn inner${Math.floor(random() * 3)}() { return x }`;
      default:
        return pad + `while c > 0 {\n${pad}    ${pick(WRITES)}\n${pad}    break\n${pad}}`;
    }
  }

  return function program() {
    const body = [];
    const count = 2 + Math.floor(random() * 5);
    for (let i = 0; i < count; i += 1) body.push(statement());
    return [
      "let c = 2",
      "fn g(c) {",
      "    let x = 0",
      "    let y = 1",
      ...body,
      "    return x",
      "}",
      "print(g(c))",
      "print(c)",
    ].join("\n") + "\n";
  };
}

/** Run a source string in a throwaway file; returns its output, or null on failure. */
function outputOf(source) {
  const path = join(mkdtempSync(join(tmpdir(), "typhoun-fuzz-")), "program.typ");
  writeFileSync(path, source, "utf8");
  const chunks = [];
  try {
    runFile(path, { onOutput: (text) => chunks.push(text) });
  } catch {
    return null;
  }
  return chunks.join("");
}

/**
 * The store a report points at, anywhere on its line: `a = 1`,
 * `if c { a = 1 }`, `b = a`, `if c { y = x; return x }`. Reads, comparisons and
 * whatever follows a `;` on the same line are left alone.
 */
const STORE = /^([^=]*[^=<>!])=(?!=)(\s*)([^()={};]+)/;

/**
 * Lint `rounds` generated programs and falsify every report. Returns how many
 * reports were checked, so a suite can insist there were any at all.
 */
function falsifyEveryReport(makeProgram, name, rounds) {
  let reports = 0;
  for (let round = 0; round < rounds; round += 1) {
    const source = makeProgram();
    const before = outputOf(source);
    if (before === null) continue; // a generated program that does not run proves nothing

    const result = lintSource(source, `${name}-${round}.typ`);
    assert.equal(result.errors.length, 0, `generated program does not validate:\n${source}`);

    const lines = source.split("\n");
    for (const warning of result.warnings.filter((w) => w.code === DEAD_STORE)) {
      reports += 1;
      const line = lines[warning.location.line - 1];
      assert.ok(
        STORE.test(line),
        `dead-store reported line ${warning.location.line}, which is not a patchable store:\n${source}`,
      );

      const canary = STORE.exec(line)[3].trim().startsWith('"') ? '"CANARY"' : "-424242";
      const patched = lines.slice();
      patched[warning.location.line - 1] = line.replace(STORE, `$1=$2${canary}`);
      const after = outputOf(patched.join("\n"));
      assert.notEqual(after, null, `the canary broke the program, so it proves nothing:\n${source}`);

      assert.equal(
        after,
        before,
        [
          `dead-store was wrong about line ${warning.location.line} of:`,
          source,
          `the value it called unread reached the output: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
        ].join("\n"),
      );
    }
  }
  return reports;
}

describe("lint: dead stores are always true", () => {
  for (const seed of [7, 101, 9001]) {
    it(`never reports a value the program reads (statements, seed ${seed})`, () => {
      const reports = falsifyEveryReport(topLevel(seed), `t${seed}`, 150);
      assert.ok(reports >= 40, `expected the corpus to exercise the rule (got ${reports})`);
    });
  }

  for (const seed of [3, 21, 77]) {
    it(`never reports a value the program reads (function bodies, seed ${seed})`, () => {
      const reports = falsifyEveryReport(inFunction(seed), `f${seed}`, 150);
      assert.ok(reports >= 40, `expected the corpus to exercise the rule (got ${reports})`);
    });
  }
});
