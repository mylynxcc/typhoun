# Changelog

All notable changes to Typhoun are documented here.
This project follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

**Differential fuzzing, as a test rather than a script** (see
[docs/bytecode.md](docs/bytecode.md) §5)

* `tests/engine/differential-fuzz.test.js` generates programs nobody wrote by
  hand — expressions over every operator and atom type, and programs with
  shadowing blocks, loops, per-iteration closures, bounded recursion and
  handlers — runs each on both engines and requires the two observable results
  to be identical: the same output text, or the same diagnostic code, message
  and stack depth. It runs with the rest of the suite, so a divergence now fails
  CI on the push that introduced it instead of being found by hand later.
* The corpus is seeded and bounded, which is what makes that possible: every
  program comes from a deterministic LCG, so a failure names its seed and round
  and replays exactly, and every program runs under explicit step and depth
  limits, so a generated program cannot hang the suite. The generators keep
  every loop counter monotone for the same reason — the two engines stop a
  runaway program at different points by design, and that surviving output
  prefix is explicitly not part of the parity contract.
* It refuses to pass vacuously: each corpus has to show programs that ran to
  completion, programs that failed, and a spread of diagnostic codes, including
  the staged `TYP3008` the two engines once disagreed about. The shape of that
  divergence — a store or a read above the block's own `let` — stays in the
  generated corpus, so it cannot come back unnoticed.

**Release publishing is walked, not assumed** (see
[CONTRIBUTING.md](CONTRIBUTING.md#releases))

* `tools/release/plan-release.js --publish --dry-run` walks the whole publishing
  path — the idempotency checks, the tag, the release built from the notes —
  through a transport that sends nothing, prints the requests a real run would
  make, and needs no token. A manual `Release` run asks for that by default, so
  what a release would do is visible before it does it.
* The publishing code now takes its transport as a parameter, which is what
  makes the branches that matter testable without a repository: a tag that has
  to be created, a tag that already exists and must not be moved, a release that
  must be left alone, and an API refusal that must not be read as "nothing
  there".
* `.github/workflows/ci.yml` gains a job that runs the publishing path in
  dry-run mode on every push, against a copy of the CHANGELOG whose `Unreleased`
  heading is renamed to an untagged version, asserting that the notes it would
  publish are that section verbatim and that nothing was created. That path used
  to run once per version, so a mistake in it was found by the release it broke.

---

## [0.1.0] — 2026-10-14

The first working release. Typhoun is a complete, self-contained language
implementation: source files are tokenized, parsed, semantically analyzed and
executed by its own engine.

### Added

**Language**

* `.typ` source files with UTF-16 offsets tracked throughout the pipeline.
* `let` (mutable) and `const` (immutable) bindings, block scoped, with
  temporal-dead-zone detection.
* Types: `number` (IEEE-754 double), `string` (UTF-8, mutable-free),
  `boolean`, `null`, `array`, `map`, `function`.
* Operators with documented precedence: arithmetic `+ - * / %`, comparison
  `== != < <= > >=`, logical `and or not` (short-circuiting), assignment
  `= += -= *= /=`, unary `-`, parentheses.
* Explicit, coercion-free semantics: only `false` and `null` are falsy;
  `==` is structural; `/` and `%` by zero are runtime errors.
* `if` / `else if` / `else`, `while`, `for ... in ...`, C-style
  `for (init; test; update)`, `break`, `continue`.
* Structured error handling: `try { ... } catch err { ... }`. The handler is
  given the error as a plain map — `code`, `message`, `phase`, `location`
  (`file`/`line`/`column`), `help` and the call `stack`, innermost frame first —
  so a program can inspect a failure, decide what to do and keep running.
  Handlers nest, a handler that fails belongs to the `try` around it, and
  `return`, `break` and `continue` pass straight out of a `try`. Only runtime
  errors (`TYP4xxx`) are catchable: import failures (`TYP5xxx`) and sandbox
  limits (`TYP6xxx`) are never handed to a handler, so `catch` cannot be used to
  spend past the step, depth, time, output, collection or source budget.
* Functions with parameters, return values, nesting, lexical closures,
  recursion, hoisting, arity checking and call-stack tracking; plus anonymous
  and named function expressions.
* Arrays (zero-indexed, mutable, bounds-checked) and maps (scalar keys,
  insertion ordered, missing key ⇒ `null`), with member-access sugar
  `obj.key` ≡ `obj["key"]`.
* Line comments, nestable block comments, and Unicode identifiers.
* Modules: `import "x.typ"` (merge) and `import "x.typ" as ns` (namespace),
  rooted at the entry directory, executed once, cycle-detected.

**Pipeline**

* Stage A Source Manager — safe loading, offsets, line/column conversion,
  diagnostic excerpts.
* Stage B Lexer — hand-written scanner, structured lexical errors, unicode
  escape decoding, malformed-literal detection.
* Stage C Parser — recursive descent with precedence climbing, panic-mode
  error recovery, multi-error reporting.
* Stage D AST — explicit node kinds with locations, plus a deterministic
  indented printer.
* Stage E Resolver — two-pass scope construction, duplicate detection, TDZ,
  const/function reassignment checks, control-flow placement validation
  (including the scope of the error name and the placement rules inside a
  `try`), binding annotations for tooling.
* Stage F Interpreter & Runtime — explicit value representation, linked
  environments, control-flow signals, structured runtime faults that a `try`
  turns into a value, contextual call stacks, step/depth/time/output/collection
  accounting.
* Stage F₂ Bytecode backend — a 49-opcode instruction set, a single-pass
  compiler from the resolved AST to bytecode chunks, a stack virtual machine
  with frames, upvalues, a per-frame handler chain that recovers from a fault
  in a deeper call without leaking a frame, slot or open upvalue, and the same
  diagnostics and limits, a disassembler that shows the `TRY_BEGIN`/`TRY_END`
  regions, and `--engine tree|vm` engine selection. The VM is verified against the
  tree-walker by byte-identical-output parity tests; it is currently *slower*
  than the tree-walker on Node, which is documented with measurements in
  [docs/bytecode.md](docs/bytecode.md).
* Stage G Standard Library — 30 built-ins with documented arity, return type,
  mutation behaviour and failure conditions.
* Stage H Diagnostics — codes across six phases (plus lint warnings),
  caret rendering with source excerpts, help text, JSON output.
* Stage I Tooling — `typhoun fmt`, a canonical, idempotent, meaning-preserving
  formatter that keeps comments and blank lines, and `typhoun lint`, a
  thirteen-rule analyzer (`TYP7xxx`) for dead, redundant and misleading code.
  Both are documented in [docs/tooling.md](docs/tooling.md).

**CLI**

* `run`, `check`, `tokens`, `ast`, `dis` (bytecode disassembly), `fmt`
  (canonical formatting), `lint` (actionable warnings), `bench` (tree-walker
  vs VM, measured), `version`, `help`, and a `repl`.
* `fmt` options `--check`, `--stdout`, `--width <n>`; `lint` options
  `--strict`, `--max-warnings <n>`, `--rule <names>`, `--disable <names>`;
  both report in text or with `--json` and expand directories to the `.typ`
  files inside them.
* Conventional streams (artifact → stdout, diagnostics → stderr) and exit
  codes `0` / `1` / `2`.
* Sandbox flags: `--root`, `--max-steps`, `--max-depth`, `--max-ms`,
  `--output-limit`, `--no-input`, `-q`, `--json`.

**Examples & tooling**

* Eleven runnable example programs, including a multi-file module example and
  one that recovers from failures with `try`/`catch`; the examples, benchmarks
  and runnable fixtures are kept canonical and lint-clean, which the test suite
  enforces.
* Seven benchmark programs in `benchmarks/`, driven by
  `tools/development/benchmark.js` (table, JSON or written artifacts).
* Error fixtures for malformed syntax, undefined variables, division by zero,
  runaway loops, runaway recursion and out-of-bounds imports.
* Golden fixtures for tokens, AST and diagnostics, plus a regeneration tool.

**Tests**

* 636 automated tests across lexer, parser, semantic, runtime, error handling,
  bytecode compiler, VM, engine parity, bytecode invariants, formatter, linter,
  benchmark harness, end-to-end, CLI, modules, security and golden suites.
  All passing.
* The formatter is verified idempotent and meaning-preserving (same AST, same
  program output) and refuses to rewrite a file it cannot parse; the linter
  carries a firing and a silent case per rule, and both tools are exercised
  through the real CLI.

**Flow-sensitive dead stores (lint rule `dead-store`, `TYP7013`)**

* The linter can now see a value that nobody reads. `dead-store` reports a store
  that is overwritten before anything reads it, or that is still unread when the
  name goes out of scope — `let total = 0` / `total = 10` / `print(total)`,
  where the `0` was never used.
* This is the only rule that reasons about the *order* of events, so the walk
  now carries a small forward dataflow state: the writes whose value could still
  be read. A store replaces the previous ones where it certainly runs (its own
  function, outside any loop); a read settles whatever is live; each arm of a
  branch is walked from the state the test left behind and the join keeps what
  either arm kept.
* Soundness is by exclusion, not by hope: a binding read or written inside a
  nested function or a loop body is left out of the analysis, because source
  order does not describe when those reads happen. A binding nothing reads stays
  `unused-variable`'s finding, so no line is reported twice.
* `examples/`, `benchmarks/` and the runnable fixtures stay clean, and
  `tests/lint/dead-store-fuzz.test.js` enforces the guarantee rather than
  asserting it: for every generated program it lints, each report is falsified
  by replacing the stored value with a canary and re-running the program. No
  canary ever changed the output — 19,495 reports over 32,000 seeded programs
  during development, and a bounded replay of the same corpora in the suite
  (613/613 at the time that work landed).

**Project settings — `typhoun.json`** (see [tooling.md](tooling.md#project-settings--typhounjson))

* `typhoun fmt` and `typhoun lint` read their defaults from the nearest
  `typhoun.json` at or above the working directory, so a repository keeps its
  formatting width, indentation unit, lint rule selection, strictness and
  warning budget next to its sources instead of repeating flags in every
  invocation. A command-line flag still wins over the file, and `--config
  <path>` reads a named file instead of searching.
* `fmt` gains `--indent <n>` (spaces per level, 0–8) and `lint` gains
  `--no-strict`, which turns off a `"strict": true` setting from the file.
* The file is validated strictly: an unknown section or key, a value of the
  wrong type or range, a nonexistent lint rule, invalid JSON or an unreadable
  file is a usage error (exit code 2) that names the offender and changes
  nothing. Commands with nothing to configure never read it.
* Both commands print `settings from <file>` when a settings file was used, and
  their `--json` reports carry a `settings` object naming the source and the
  values in force. Covered by
  `tests/integration/project-config.test.js` (28 cases).

### Fixed

**The two engines now agree on assignment in the temporal dead zone**

* A name assigned before its `let`/`const` declaration in the same block used to
  mean different things in the two engines: the tree-walker looked the name up
  dynamically and could not see a binding that had not run yet, while the
  bytecode compiler had already reserved the slot. `x = 1` above `let x = 2`
  therefore wrote to an outer `x` in one engine and to the block's `x` in the
  other, and a compound `x += 1` in the same position failed in one and not the
  other. The resolver now rejects the assignment where it already rejects the
  read — same `TYP3008`, before either engine runs — so a program has one
  meaning. Assignments inside a closure to a binding declared later in its
  block are still allowed. `npm test` passes 636/636.
* Found and confirmed by differential fuzzing the two engines against each
  other over generated programs; the case is now pinned by tests in
  `tests/semantic/resolver.test.js` and `tests/engine/parity.test.js`.

**Deeply nested source is a diagnostic, not a host crash**

* A few thousand nested parentheses, array literals, blocks or unary operators
  overflowed the JavaScript stack and escaped as a raw `RangeError` in every
  stage. The parser now bounds its own recursion and measures the finished tree
  with an explicit stack (so a chain built in a loop cannot slip through),
  reporting the new syntax code `TYP2005 NESTING_TOO_DEEP`. The bound runs
  before execution and applies to both engines.

**Import containment now follows symlinks**

* Module containment was a purely lexical path check, so a symlink inside the
  project root could point at a file outside it and have that file loaded and
  executed. The loader now resolves the real path of both the module and the
  root before comparing them; an escaping link is refused with the existing
  `TYP5002 MODULE_OUT_OF_BOUNDS`.

### Changed

**Bytecode VM — dispatch rework** (see [bytecode.md](bytecode.md) §7)

* The dispatch loop no longer loses the optimising tier to its own cold code.
  V8 compiles a site with no type feedback into an eager deoptimisation, and in
  one giant `switch` most sites are cold when the loop is optimised: the four
  conditional jumps read their operand inside the arm the branch does not take,
  so a `while` loop's exit — taken once, at the end — deoptimised the whole
  dispatch loop on its way out. The operand and both jump targets are now
  computed before the branch is taken.
* The rarely executed half of the instruction set moved out of `dispatchLoop`
  into a new `slowOp` method. The opcodes kept inline are the ones an opcode
  histogram showed dominate real programs (`GET_LOCAL`, `CONST`, `GET_GLOBAL`,
  `POP`, `ADD`, `SET_GLOBAL`, `JUMP`, `JUMP_IF_FALSE_POP`, `MOD`, `CALL`,
  `DEF_LOCAL`, `RETURN`, `LT`, `SET_LOCAL`); cold opcodes are under 8% of the
  instructions in any program measured, and their cold inline caches can now
  only deoptimise `slowOp`, not the loop that called them.
* `proto.constants`, `frame.base` and `closure.globals` are now held in locals
  in the hot loop instead of being read per operand.
* Measured, same command and machine as the table in the docs: total VM wall
  clock over the benchmark suite **925.5 ms → 760.6 ms (1.22x)**, per program
  1.09x (`closures`) to 1.37x (`loop`), median tree-vs-VM speedup 0.29x → 0.37x.
  Output parity unchanged (7/7 programs identical) and `npm test` passes
  (568/568 at the time of the measurement).

The VM remains slower than the tree-walker; `tree` is still the default engine.

---

### Known limitations

* No static typing, classes, exceptions, concurrency or package manager.
* No JIT or native code generation. A bytecode compiler and stack VM do exist
  (`--engine vm`, see [docs/bytecode.md](docs/bytecode.md)) but are slower than
  the tree-walking interpreter on Node, so `tree` remains the default.
* Resource limits bound element counts, not bytes; no custom garbage
  collector.
* Some diagnostic codes are reserved for future use
  (`TYP3005`, `TYP4006`, `TYP4011`, `TYP5005`).
* There is no `--fix`, no per-line suppression and no editor integration yet;
  `fmt` still offers only width and indentation, and `lint` rules are chosen on
  the command line or in `typhoun.json`.
