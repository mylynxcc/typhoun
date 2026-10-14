/**
 * Differential fuzzing of the two engines.
 *
 * `tests/engine/parity.test.js` proves that the tree-walker and the bytecode VM
 * agree on the programs somebody thought to write down. This suite covers the
 * other half of that contract: it generates programs nobody wrote by hand, runs
 * each one on both engines, and requires the two observable results to be
 * identical — the same output text, or the same diagnostic code, message and
 * stack depth.
 *
 * That is not hypothetical. The temporal-dead-zone divergence between the
 * engines was found by exactly this method: a program in which the tree-walker
 * wrote to an outer binding while the bytecode compiler wrote to a slot the
 * resolver had already reserved, so `x = 5` above `let x = 2` meant two
 * different things. The generator below keeps that shape in the corpus — a
 * store or a read before the block's own `let`, with an outer binding present to
 * be captured instead — so the case that once diverged cannot regress silently.
 *
 * Three properties make it usable as a test rather than a script:
 *
 *   - **deterministic.** Every program comes from a seeded LCG, so a failure
 *     names its seed and round and replays identically on any machine and any
 *     Node version. No `Math.random`, no clock, no environment.
 *   - **bounded.** A fixed number of rounds per seed, and every program runs
 *     under explicit step and depth limits, so no generated program can hang
 *     the suite. Every corpus costs a fraction of a second.
 *   - **not vacuous.** A generator that emitted only `print(0)` would "agree"
 *     trivially, so each corpus is checked for what it actually covered:
 *     programs that ran to completion (the output text has to match, which is
 *     the strictest half of the contract), programs that failed, a spread of
 *     diagnostic codes, and — in the statement corpus — the staged `TYP3008`
 *     the engines once disagreed about.
 *
 * One deliberate exclusion, because it is not part of the contract: when a
 * program trips a *resource limit*, the two engines stop at different points by
 * design — the tree-walker counts an AST node per step, the VM a bytecode
 * instruction — so how much output survived differs, and `parity: resource
 * limits` says explicitly that it is not compared. Rather than look away from
 * those cases, the generators keep every loop counter monotone and every
 * recursion bounded, so a limit trip cannot happen; if one ever does, the
 * comparison below fails loudly and blames the template instead of laundering
 * it into a phantom "divergence".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Code } from "../../src/diagnostics/codes.js";
import { runOnBothEngines } from "../helpers.js";

/**
 * A backstop, not a working part of the corpus: the generated programs need a
 * few thousand steps at most. Deliberately equal to the budget the parity tests
 * give their runaway programs, so a trip here is unambiguous.
 */
const LIMITS = { maxSteps: 200_000, maxCallDepth: 64 };

/** A tiny deterministic generator, so a failure is reproducible from its seed. */
function generator(seed) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  const int = (n) => Math.floor(random() * n) % n;
  return { random, pick, int };
}

const NUM_ATOMS = ["0", "1", "2", "3", "7", "-1", "-0", "0.5", "1.5", "2.0", "1000", "1e3", "1e-3"];
const NONZERO_ATOMS = NUM_ATOMS.filter((atom) => atom !== "0" && atom !== "-0");
const STRING_ATOMS = ['"a"', '"1"', '""', '"typhoun"'];
const OTHER_ATOMS = ["true", "false", "null", "[]", "[1, 2, 3]", '["a"]', '{"a": 1}'];
const ARITHMETIC = ["+", "-", "*", "/", "%"];
const COMPARISON = ["<", "<=", ">", ">=", "==", "!="];
const LOGICAL = ["and", "or"];

/**
 * Expression corpus: `print(<expr>)`.
 *
 * Three kinds of expression, mixed deliberately. `numeric` and `text` are built
 * to succeed — a corpus that fails everywhere compares error paths only, and
 * the output text is the strictest thing the two engines have to agree on —
 * while `mixed` pairs operands without regard to type, which is where the
 * runtime diagnostics come from. The divisor of `/` and `%` is drawn from the
 * non-zero atoms most of the time so that a division by zero is a deliberate
 * visit rather than the default outcome of a deep tree.
 */
function expressionSuite(seed) {
  const { random, pick } = generator(seed);
  const atoms = [...NUM_ATOMS, ...STRING_ATOMS, ...OTHER_ATOMS];

  function numeric(depth) {
    if (depth <= 0) return pick(NUM_ATOMS);
    const roll = random();
    if (roll < 0.5) {
      const op = pick(ARITHMETIC);
      // A zero divisor by construction, rarely, so that every corpus contains
      // the division-by-zero diagnosis without most programs failing.
      const right =
        op === "/" || op === "%"
          ? random() < 0.12
            ? "0"
            : pick(NONZERO_ATOMS)
          : numeric(depth - 1);
      return `(${numeric(depth - 1)} ${op} ${right})`;
    }
    if (roll < 0.6) return `(-${numeric(depth - 1)})`;
    if (roll < 0.68) return `abs(${numeric(depth - 1)})`;
    if (roll < 0.75) return `floor(${numeric(depth - 1)})`;
    if (roll < 0.81) return `ceil(${numeric(depth - 1)})`;
    if (roll < 0.86) return `sqrt(${numeric(depth - 1)})`;
    if (roll < 0.91) return `min(${numeric(depth - 1)}, ${numeric(depth - 1)})`;
    if (roll < 0.95) return `len([${numeric(depth - 1)}, ${numeric(depth - 1)}])`;
    return `((${numeric(depth - 1)} ${pick(COMPARISON)} ${numeric(depth - 1)}) ${pick(LOGICAL)} true)`;
  }

  function text(depth) {
    if (depth <= 0) return pick(STRING_ATOMS);
    const roll = random();
    if (roll < 0.45) return `(${text(depth - 1)} + ${text(depth - 1)})`;
    if (roll < 0.65) return `str(${numeric(depth - 1)})`;
    if (roll < 0.78) return `upper(${text(depth - 1)})`;
    if (roll < 0.88) return `trim(${text(depth - 1)})`;
    return `join([${text(depth - 1)}, ${text(depth - 1)}], "-")`;
  }

  /** Deliberately untyped: this is where type errors and bad arguments live. */
  function mixed(depth) {
    if (depth <= 0) return pick(atoms);
    const roll = random();
    const either = () => `${mixed(depth - 1)} ${pick([...ARITHMETIC, ...COMPARISON, ...LOGICAL])} ${mixed(depth - 1)}`;
    if (roll < 0.4) return `(${either()})`;
    if (roll < 0.5) return `(-${mixed(depth - 1)})`;
    if (roll < 0.56) return `(not ${mixed(depth - 1)})`;
    if (roll < 0.64) return `[${mixed(depth - 1)}, ${mixed(depth - 1)}]`;
    if (roll < 0.7) return `{"k": ${mixed(depth - 1)}}`;
    if (roll < 0.76) return `len(${mixed(depth - 1)})`;
    if (roll < 0.82) return `str(${mixed(depth - 1)})`;
    if (roll < 0.86) return `type(${mixed(depth - 1)})`;
    if (roll < 0.9) return `abs(${mixed(depth - 1)})`;
    if (roll < 0.93) return `min(${mixed(depth - 1)}, ${mixed(depth - 1)})`;
    if (roll < 0.96) return `[${mixed(depth - 1)}, ${mixed(depth - 1)}][0]`;
    return `pow(${mixed(depth - 1)}, ${mixed(depth - 1)})`;
  }

  return () => {
    const roll = random();
    if (roll < 0.55) return `print(${numeric(3)})\n`;
    if (roll < 0.8) return `print(${text(3)})\n`;
    return `print(${mixed(3)})\n`;
  };
}

/**
 * Statement corpus: declarations and shadowing, loops including the C-style
 * form, closures over per-iteration cells, functions that recurse, handlers that
 * report what they caught, and the staged diagnoses the resolver decides before
 * either engine runs.
 *
 * Two rules keep every loop bounded, which is what lets a limit trip be treated
 * as a fault rather than noise: no template stores a constant into a loop
 * counter, so counters only move toward their bound, and every recursion has a
 * depth bound in its own condition.
 */
function statementSuite(seed) {
  const { random, pick, int } = generator(seed);
  const pad = (indent) => " ".repeat(indent * 2);

  /** Leaf statements, one line unless the template needs a declaration first. */
  function simple(n) {
    return [
      "log2(x, total)",
      `let s${n} = x * 2\nlog(s${n})`,
      "total += x\nlog(total)",
      'if x > 1 { log("big") } else { log("small") }',
      "log(x > 1 and x < 10)\nlog(x > 100 or x < 100)\nlog(not (x == 2))",
      "log2(x / 2, x % 3)\nlog(-x)",
      "log2(sqrt(x + 1), floor(x + 0.5))\nlog2(abs(0 - x - 1), pow(2, x))",
      'log2(type(x), bool(0))\nlog(str(x) + "!")',
      'log2(len("abc"), num("42") + x)',
      "log2(min(x, 3), max([x, 2, 1]))",
      `let m${n} = {"k": x}\nm${n}["j"] = x + 1\nlog2(m${n}["k"], m${n}["j"])`,
      `let a${n} = [x]\npush(a${n}, x + 1)\nlog2(len(a${n}), pop(a${n}))`,
      'log2(keys({"n": x}), values({"n": x}))',
      "log2(ceil(x + 0.1), round(x + 0.5))",
      'log2(contains("hello", "ell"), contains([1, 2], 2))',
      'log2(join(["a", "b"], "-"), split("a-b", "-"))\nlog2(upper("ab"), trim("  z  "))',
    ];
  }

  /**
   * The shape that once diverged — a store or a read above the block's own
   * `let` — plus the legal shadows around it and the other staged diagnoses,
   * which must also be decided identically before either engine runs.
   */
  function blocks(n) {
    return pick([
      "{\n  x = 5\n  let x = 2\n  log(x)\n}",
      "{\n  log(x)\n  let x = 2\n  log(x)\n}",
      "{\n  x += 1\n  let x = 2\n  log(x)\n}",
      "{\n  let x = 2\n  x += 1\n  log(x)\n}",
      "{\n  let x = 2\n  {\n    let x = 3\n    log(x)\n  }\n  log(x)\n}",
      `let dup${n} = 1\nlet dup${n} = 2`,
      `log(missing${n})`,
      `const k${n} = 1\nk${n} = 2`,
    ]);
  }

  function statement(depth, indent) {
    const lead = pad(indent);
    const n = int(10_000);
    const body = () => statement(depth - 1, indent + 1);
    const lines = (text) =>
      text
        .split("\n")
        .map((line) => lead + line)
        .join("\n");

    if (depth <= 0 || random() < 0.45) return lines(pick(simple(int(10_000))));

    switch (int(12)) {
      case 0:
        return `${lead}if x > 2 {\n${body()}\n${lead}} else {\n${body()}\n${lead}}`;
      case 1:
        return `${lead}for k in range(0, 3) {\n${lead}  x += 1\n${body()}\n${lead}}`;
      case 2:
        return `${lead}for (let j = 0; j < 3; j += 1) {\n${lead}  total += j\n${body()}\n${lead}}`;
      case 3:
        return `${lead}while x < 4 {\n${lead}  x += 1\n${body()}\n${lead}}`;
      case 4:
        // A nested body can leave x at 3, so this assertion is sometimes the
        // very failure the handler observes.
        return `${lead}try {\n${body()}\n${lead}  assert(x != 3, "boom")\n${lead}} catch err {\n${lead}  log2(err.code, err.phase)\n${lead}}`;
      case 5:
        // A failure inside a handler, and the call stack the error value
        // carries: the frames are part of the compared result.
        return lines(
          [
            "fn risky() { return 1 / 0 }",
            "try {",
            "  try { log(risky()) } catch inner { log2(inner.code, len(inner.stack)) }",
            '} catch outer { log("outer") }',
          ].join("\n"),
        );
      case 6:
        return lines(`fn w${n}(p) {\n  if p > 3 { return p }\n  return w${n}(p + 1)\n}\nlog(w${n}(0))`);
      case 7:
        return lines(
          `let fns${n} = []\nfor k in range(0, 3) {\n  let cell = k * 10\n  push(fns${n}, fn () { return cell })\n}\nlet out${n} = []\nfor f in fns${n} { push(out${n}, f()) }\nlog2(out${n}[0], out${n}[2])`,
        );
      case 8:
        return lines(blocks(n));
      case 9:
        // An uncaught runtime failure: whatever output came first has to match
        // too, not just the diagnostic.
        return lines(`let a${n} = [1]\nlog(a${n}[3])`);
      case 10:
        // The fields of the error value a handler receives, including the
        // position, are part of the compared result.
        return lines(
          `fn r${n}() { return 1 / 0 }\ntry { log(r${n}()) } catch err { log2(err.code, len(err.stack))\nlog2(err.phase, err.location.line) }`,
        );
      default:
        return lines(
          `fn counter${n}() {\n  let c = 0\n  return fn () { c += 1\n  return c }\n}\nlet cc${n} = counter${n}()\nlog2(cc${n}(), cc${n}())`,
        );
    }
  }

  return function program() {
    const parts = [
      "let x = 1",
      "let total = 0",
      "fn log(v) { print(v) }",
      "fn log2(a, b) { print(a, b) }",
    ];
    const count = 2 + int(3);
    for (let i = 0; i < count; i += 1) parts.push(statement(2, 0));
    parts.push("log(x)");
    return parts.join("\n") + "\n";
  };
}

/**
 * Generate `rounds` programs, run each on both engines, and require the two
 * results to be identical. Returns what the corpus actually covered, so every
 * caller can refuse a pass that proves nothing.
 */
function compare(makeProgram, rounds, seed) {
  const codes = new Map();
  let ran = 0;

  for (let round = 0; round < rounds; round += 1) {
    const source = makeProgram();
    const results = runOnBothEngines(source, { fileName: "<fuzz>", limits: LIMITS });

    for (const engine of ["tree", "vm"]) {
      const code = results[engine].error && results[engine].error.code;
      if (!code) continue;
      // A limit trip is a fault in the generator, not a divergence: the two
      // engines stop a runaway program at different points on purpose, so their
      // output prefixes are not comparable. The templates are meant to make
      // this unreachable.
      assert.ok(
        !code.startsWith("TYP6"),
        `a generated program hit ${code} on the ${engine} engine, so the corpus is not bounded:\n${source}`,
      );
      // Both engines report a malformed program without ever running it, so a
      // corpus full of those would agree about nothing at all.
      assert.ok(
        !code.startsWith("TYP1") && !code.startsWith("TYP2"),
        `a generated program was rejected by the ${code.startsWith("TYP1") ? "lexer" : "parser"} (${code}):\n${source}`,
      );
    }

    assert.deepEqual(
      results.vm,
      results.tree,
      [
        `the two engines diverged (seed ${seed}, round ${round}):`,
        source,
        ` tree: ${JSON.stringify(results.tree)}`,
        `   vm: ${JSON.stringify(results.vm)}`,
      ].join("\n"),
    );

    if (results.tree.ok) ran += 1;
    const code = results.tree.error && results.tree.error.code;
    if (code) codes.set(code, (codes.get(code) ?? 0) + 1);
  }

  return { cases: rounds, ran, codes };
}

/**
 * A corpus must both have run and have been varied, or it proves nothing. The
 * complaints are collected rather than asserted one by one, so a single failure
 * reports everything that stopped being covered instead of only the first.
 */
function assertNotVacuous(stats, seed, rounds, expected) {
  const complaints = [];
  if (stats.cases !== rounds) complaints.push(`generated ${stats.cases} programs, expected ${rounds}`);
  if (stats.ran < expected.ran) {
    complaints.push(
      `only ${stats.ran} of ${stats.cases} programs ran to completion, so the output text was barely compared`,
    );
  }
  if (stats.codes.size < expected.codes) {
    complaints.push(
      `produced ${stats.codes.size} distinct diagnostic code(s) — ${[...stats.codes.keys()].join(", ") || "none"} — where at least ${expected.codes} are expected`,
    );
  }
  for (const code of expected.includes) {
    if (!stats.codes.has(code)) complaints.push(`never produced ${code}, one of the codes it exists to cover`);
  }
  assert.deepEqual(
    complaints,
    [],
    `seed ${seed}: the generated corpus no longer exercises what it is here for:\n  - ${complaints.join("\n  - ")}`,
  );
}

describe("differential fuzz: generated expressions", () => {
  for (const seed of [1234567, 88, 20261014]) {
    it(`agrees on both engines for every generated expression (seed ${seed})`, () => {
      const stats = compare(expressionSuite(seed), 150, seed);
      assertNotVacuous(stats, seed, 150, {
        // Measured at 91–107 of 150 running to completion, across 3 distinct
        // diagnostic codes; the floor is a vacuity guard, not a target.
        ran: 70,
        codes: 3,
        includes: [Code.TYPE_ERROR, Code.DIVISION_BY_ZERO],
      });
    });
  }
});

describe("differential fuzz: generated programs", () => {
  for (const seed of [987654321, 42, 5150]) {
    it(`agrees on both engines for every generated program (seed ${seed})`, () => {
      const stats = compare(statementSuite(seed), 150, seed);
      assertNotVacuous(stats, seed, 150, {
        // Measured at 108–118 of 150 running to completion, across 5 distinct
        // diagnostic codes; the floor is a vacuity guard, not a target.
        ran: 80,
        codes: 4,
        // The staged diagnosis the two engines once disagreed about.
        includes: [Code.USED_BEFORE_DECLARATION, Code.DUPLICATE_DECLARATION],
      });
    });
  }
});
