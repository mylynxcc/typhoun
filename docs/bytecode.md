# Typhoun Bytecode Backend — compiler, VM and measured performance

Typhoun has **two execution backends** for the same language:

| engine | implementation | selected with | default |
| --- | --- | --- | --- |
| `tree` | tree-walking interpreter (`src/interpreter/`) | `--engine tree` | no |
| `vm` | bytecode compiler + stack VM (`src/compiler/`, `src/bytecode/`, `src/vm/`) | `--engine vm` | **yes** |

They share everything *except* control flow: the source manager, lexer, parser,
AST, resolver, value representation, equality and truthiness rules, operators,
standard library, module loader, diagnostics, resource limits and the CLI. The
VM exists so the engine can be cross-checked against an independent second
implementation of the language's semantics — and, eventually, to be the faster
backend. It is not the faster one today; this document records that honestly,
with the numbers and the reason.

---

## 1. Pipeline

```
.typ source
   │  A–E identical for both engines (source, lexer, parser, ast, resolver)
   ▼
 resolved AST
   │  F₂  compiler          src/compiler/compiler.js
   ▼
 Chunk tree (prototypes, constants, upvalue descriptors, line info)
   │  F₂  VM                src/vm/vm.js
   ▼
 output · diagnostics · exit code      (same shapes as the tree-walker)
```

`runFile`, `runSource`, `checkFile` and `createEngine` in `src/main/index.js`
take an `engine` option, so the CLI, the tests and any embedding host switch
backends with one parameter:

```bash
typhoun run examples/hello.typ                # the VM, compiled first — the default
typhoun run --engine tree examples/hello.typ  # the tree-walker, no compile step
typhoun dis benchmarks/sort.typ        # compile to bytecode, print the disassembly
typhoun bench                          # both engines, same programs, measured
```

```js
import { runFile } from "./src/main/index.js";

runFile("examples/hello.typ");                        // the default: vm, compiled first
runFile("examples/hello.typ", { engine: "tree" });    // the tree-walker instead
```

---

## 2. Instruction set

`src/bytecode/opcodes.js` defines 49 opcodes. Bytecode is a flat `number[]`,
one opcode followed by its inline operands; a parallel `locs` array carries the
source location of every slot. Opcodes start at `1` so that `0` (a plausible
uninitialised slot or truncated stream) is always invalid and shows up in the
disassembler rather than silently decoding as something else.

| family | opcodes |
| --- | --- |
| stack | `CONST` `NULL` `TRUE` `FALSE` `POP` `DUP2` `RESERVE` `DROP` |
| variables | `DEF_LOCAL` `SET_LOCAL` `GET_LOCAL` `DEF_GLOBAL` `HOIST_FN` `SET_GLOBAL` `GET_GLOBAL` `GET_UPVALUE` `SET_UPVALUE` `CLOSE_DOWN` `SELF` |
| functions | `CLOSURE` `CALL` `RETURN` |
| arithmetic | `ADD` `SUB` `MUL` `DIV` `MOD` `NEG` `NOT` `EQ` `NEQ` `LT` `LE` `GT` `GE` |
| control | `JUMP` `JUMP_IF_FALSE` `JUMP_IF_TRUE` `JUMP_IF_FALSE_POP` `JUMP_IF_TRUE_POP` |
| collections | `ARRAY` `MAP` `INDEX` `SET_INDEX` `ITER_PREP` `ITER_NEXT` |
| modules | `IMPORT` |
| errors | `TRY_BEGIN` `TRY_END` |

Operand kinds: a constant-pool index, a frame slot index, an upvalue index, a
count, or a *relative jump offset measured from the instruction that follows the
operand* (so an offset of `0` falls through, and the compiler patches targets
after the fact with `Chunk#patchJump`). `ITER_NEXT` carries two operands — the
exit offset and the loop variable's slot — because the `for…in` state machine
lives in a frame slot rather than on the value stack, where nothing can observe
it. `TRY_BEGIN` carries the offset of its handler (a jump target like any other)
and the frame slot the caught error value is written to; `TRY_END` carries
nothing, because leaving a region is a pop.

A `Chunk` (`src/bytecode/chunk.js`) is both a compilation unit and a callable
prototype: code, source locations, interned constants, child prototypes, arity,
slot high-water mark and upvalue descriptors. `Chunk#decode()` and
`src/bytecode/disassembler.js` turn a chunk tree into the listing printed by
`typhoun dis` / `disassemble()` / `disassembleSummary()`, which the tests also
use to assert on emitted code.

---

## 3. Compiler

`compileProgram(ast)` is a single pass over the already-resolved AST — the
resolver has run, so every name already carries its scope information and the
compiler never has to search for a binding.

* **Scopes and slots.** Locals live in frame slots; the compiler tracks the slot
  high-water mark per scope and reuses slots as blocks end. Globals still go
  through the lexical `Environment`, which is what keeps module namespaces
  separate and lets the loader export bindings.
* **Functions.** Declarations are hoisted into their scope by emitting
  `CLOSURE` + `HOIST_FN` before the rest of the body runs, reproducing the
  "callable before its declaration" behaviour of the tree-walker.
* **Closures and upvalues.** A nested function that touches an outer local
  captures it as an upvalue (`GET_UPVALUE`/`SET_UPVALUE`); the VM keeps *open*
  upvalues pointing at frame slots and closes them (`CLOSE_DOWN`) when the
  declaring scope exits, so a variable re-declared on each loop iteration gets a
  fresh cell — the same semantics the tree-walker gets from allocating an
  environment per block.
* **Control flow.** `while`, C-style and `for…in` loops collect their `break`
  and `continue` jump sites and patch them once the loop body is emitted;
  `and`/`or` compile to short-circuit jumps that return the operand value, not a
  coerced boolean.
* **Assignment.** Compound assignment on a slot or an element compiles to a
  read/modify/write that evaluates the target once (`DUP2` exists for exactly
  this), matching the interpreter's single-evaluation rule.
* **Regions.** `try` reserves a frame slot for the error value, opens a region
  with `TRY_BEGIN`, emits the guarded block, closes it with `TRY_END`, and jumps
  over the handler, which is exactly where `TRY_BEGIN` points. Leaving a region
  early — `break`, `continue`, `return` — emits one `TRY_END` per region it
  leaves, so the runtime handler chain is balanced however the statement exits.
  A returned value is computed *inside* the region, so a fault while evaluating
  it is still caught by an enclosing `try`.

---

## 4. Virtual machine

* **One value stack, one frame per call.** `frame.base + slot` addresses a
  local; temporaries grow above the locals and are always balanced at statement
  boundaries. The stack pointer is kept in a local variable inside the dispatch
  loop and written back only where something else can observe it (a call, a
  module load, an unwind).
* **Frames carry their prototype.** `CALL` switches to the callee's code array,
  constants and line table; `RETURN` pops the frame, restores the caller's
  continuation and pushes the result into the callee's slot.
* **Diagnostics are shared, not reimplemented.** Faults are raised as the same
  `RuntimeFault`s with the same `Code`s as the tree-walker, and
  `vmStackFrames()` formats a Typhoun call stack in the same shape, so
  `renderDiagnostics` output is identical for both engines.
* **Limits are identical.** `maxSteps`, `maxCallDepth`, `maxDurationMs`,
  `maxOutputChars` and `maxCollectionSize` come from the same
  `ExecutionContext`; step accounting is batched (published every 1024
  instructions, wall-clock checked on the same cadence) so the common
  instruction costs one dispatch plus a push or a pop.
* **A fault is recovered where it can be, and reported where it cannot.** Each
  frame holds a linked stack of open handlers (`TRY_BEGIN` pushes, `TRY_END`
  pops). On a catchable fault the VM walks the active frames outwards for the
  innermost handler, unrolls the calls in between exactly as `RETURN` would
  (closing their upvalues and keeping the call depth honest), restores the value
  stack to the depth the region opened at — discarding anything the failing
  expression left half-built — writes the error value into the handler's slot
  and resumes there. Faults the language does not catch (see
  [security-model.md](security-model.md)) return `false` from `recover()` and
  propagate unchanged, so both engines report the same diagnostic and no handler
  can run for them.

---

## 5. Verification

The two backends are only worth having if they agree, so agreement is a test
property rather than a claim:

| suite | what it pins down |
| --- | --- |
| `tests/engine/compiler.test.js` | emitted instructions, jump patching, slot layout, constant interning, closures |
| `tests/engine/vm.test.js` | runtime behaviour of the bytecode engine alone |
| `tests/engine/parity.test.js` | **byte-identical output and diagnostics** between `tree` and `vm` for every example, fixture and benchmark program, plus an error-handling corpus (error values, call stacks, nesting, uncatchable limits) |
| `tests/engine/differential-fuzz.test.js` | **generated** programs nobody wrote by hand: identical output text, or an identical diagnostic, on both engines — from a seeded corpus that is bounded and checked for coverage |
| `tests/engine/bytecode-invariants.test.js` | structural invariants over every compiled chunk (valid opcodes, jumps in range, slot and constant indices in range, every `TRY_BEGIN` landing on a real handler) |
| `tests/integration/benchmark.test.js` | the harness itself: both engines really run, mismatches are detected and reported, reports render |

`npm test` runs 662 tests (on every push and pull request, across Node 20, 22
and 24 — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). Parity
is checked on **output text**, not just exit
codes, so a divergence surfaces as a test failure instead of a silently
different program — including the error-handling corpus, where the text of a
caught error value and the frames in its `stack` have to match to the byte.

One real bug was found this way and fixed in the tree-walker: a named function
expression resolved its own name but failed at runtime, and a `break` inside a
nested `for…in` popped its scope slots twice, corrupting the value stack.

Agreement is not only asserted but *fuzzed*. `tests/engine/differential-fuzz.test.js`
generates programs nobody wrote by hand and requires the two engines to produce
the same output, or the same diagnostic, for every one of them. The corpus is
seeded, so a failure names its seed and round and replays exactly, and bounded,
so it costs a fraction of a second beside the rest of the suite on every push.
It is also the method that found the temporal-dead-zone divergence — a store or
a read above the block's own `let` — so that shape stays in the generated
corpus, where it can no longer come back unnoticed.

---

## 6. Measured benchmark

Both engines run the *same* `.typ` files with the same limits. Parse, resolve
and module discovery are identical for both, so the reported time is the
runtime. The VM's compile phase is measured separately and shown next to the
result. Each figure is the fastest of 7 timed runs after 2 untimed warm-ups.
The harness reports a **mismatch** rather than averaging over one, and exits
nonzero if any program fails or the engines disagree.

```
node tools/development/benchmark.js --iterations 7 --warmups 2
```

```
node v22.23.1 · darwin arm64 (Apple silicon) · 7 iteration(s) + 2 warm-up, fastest kept

program                    tree (ms)   vm (ms)   speedup   tree steps   vm steps   compile (ms)
-------------------------  ---------  --------  --------  -----------  ---------  ------------
benchmarks/calls.typ          70.244    90.135     0.78x      1100013    1300021        0.374
benchmarks/closures.typ       70.782   117.944     0.60x      1200013    1500021        0.288
benchmarks/collections.typ    22.454    77.676     0.29x       600026     880023        0.348
benchmarks/fib.typ            14.810    15.603     0.95x       251750     240807        0.119
benchmarks/loop.typ           62.729   198.127     0.32x      2400013    3400015        0.237
benchmarks/sort.typ           68.450   254.062     0.27x      2746595    3245213        0.358
benchmarks/strings.typ         2.593     7.026     0.37x        64036      88048        0.120

7/7 program(s) compared · 0 output mismatch(es) · 0 error(s)
median speedup 0.37x · best 0.95x · worst 0.27x
total wall clock: tree 312.1 ms vs vm 760.6 ms
```

**Verdict: the bytecode VM is correct but still slower — 0.37x the tree-walker's
speed at the median (2.7x slower end-to-end), and 0.27x on the tightest loop.**
It comes closest on call- and closure-heavy code (`fib` 0.95x, `calls` 0.78x).

Those figures are 1.22x faster than the run this document used to carry (median
0.29x, best 0.71x, vm 925.5 ms) — same command, same programs, same machine —
after the dispatch rework in §7.

---

## 7. Why the VM is slower

Two separate effects, both measured:

**1. It retires more units of work.** On `loop.typ` the VM executes 3.4M
instructions where the tree-walker counts 2.4M evaluations — 1.42x more. A
stack machine moves every operand explicitly: `total += i % 7` is
`GET_GLOBAL, GET_GLOBAL, CONST, MOD, ADD, SET_GLOBAL, POP` (7 instructions)
against roughly 4 AST evaluations. Step counts are not the same unit (an AST
evaluation is "more work" than a bytecode step), so read the ratio as
indicative, not exact.

**2. Each unit costs about twice as much.** `loop.typ`: 62.73 ms / 2.4M steps
= **26 ns per tree-walking evaluation**, versus 198.1 ms / 3.4M instructions =
**58 ns per VM instruction**. 1.42x more units at 2.2x the unit cost is the
3.2x measured on that program.

The cost of a unit is a host-runtime question, and it is worth 4.5x: the same
program, timed in-process (`%GetOptimizationStatus` for the tier, timing with
`process.hrtime.bigint`), fastest of eight fresh runs:

| tier | ns per instruction |
| --- | --- |
| Ignition only (`--no-sparkplug --no-turbofan`) | 267 |
| Maglev (`--maglev --no-turbofan`) | 158 |
| TurboFan, before the dispatch rework | 84 |
| TurboFan, after the dispatch rework | 59 |

The optimising tier is the difference between a useful VM and a slow one, so
keeping the dispatch loop there is worth work.

### The deopt trap: cold code inside a hot function

The loop does reach TurboFan — `--trace-osr` shows `OSR - entry` and
`%GetOptimizationStatus(VirtualMachine.prototype.dispatchLoop)` reports
`kOptimized | kTurboFanned` in steady state. What it did not do was *stay*
there. TurboFan compiles a site with no type feedback into an **eager
deoptimisation**: it accepts the function, then throws the code away — back to
Maglev — the first time control reaches that site. In one giant `switch`, most
sites are cold at the moment the optimiser looks at them:

* The four conditional jumps read their operand — `code[ip]` — *inside* the arm
  the branch does not take. A `while` loop leaves through that arm exactly once,
  at the end, so the load stayed cold for the whole loop and then deoptimised
  the dispatch loop on its way out (`--trace-deopt`: `Insufficient type feedback
  for generic keyed access`, at `case OP.JUMP_IF_FALSE_POP`). The operand and both
  targets are now computed before the branch is taken, so every site in those
  cases runs every time the case does.
* Any opcode a program reaches for the first time *after* the OSR point did the
  same thing, because its case body had never executed: cold arithmetic, cold
  keyed loads, cold calls.

A program enters `dispatchLoop` essentially once, so one such bail-out drops the
rest of the run to Maglev — a 2.8x cliff.

### The fix: a hot half and a cold half

`dispatchLoop` now carries only the opcodes that dominate real programs;
`slowOp` carries the rest, one call away. The split is data-driven — an opcode
histogram over the benchmark suite, share of all instructions executed:

| opcode | share | opcode | share |
| --- | --- | --- | --- |
| `GET_LOCAL` | 15.6% | `JUMP_IF_FALSE_POP` | 3.4% |
| `CONST` | 12.3% | `MOD` | 3.2% |
| `GET_GLOBAL` | 12.2% | `CALL` | 2.9% |
| `POP` | 9.4% | `DEF_LOCAL` | 2.9% |
| `ADD` | 7.0% | `RETURN` | 2.3% |
| `SET_GLOBAL` | 5.5% | `LT` | 2.1% |
| `JUMP` | 5.4% | `SET_LOCAL` | 1.2% |

Those stay inline (plus `NULL`, `TRUE`, `FALSE`, `CLOSURE` and the remaining
jump forms). Everything else — `SUB`, `MUL`, `DIV`, `NEG`, `NOT`, `EQ`, `NEQ`,
`LE`, `GT`, `GE`, `DUP2`, `RESERVE`, `DROP`, `GET_UPVALUE`, `SET_UPVALUE`,
`CLOSE_DOWN`, `SELF`, `ARRAY`, `MAP`, `INDEX`, `SET_INDEX`, `ITER_PREP`,
`ITER_NEXT`, `TRY_BEGIN`, `TRY_END`, `IMPORT` — runs in `slowOp`, and between
them those are under 8% of the instructions in any program measured here.

Two effects, both measured: the loop above is small enough to keep its state in
registers, and a cold case's cold inline caches can now only deoptimise
`slowOp`, never the loop that called it. `--trace-deopt` shows that happening —
the cold-case bail-outs name `slowOp` (plus `Environment.get` and `invoke`) —
but it also shows the loop itself still bailing out once or twice per program,
always for the same reason: a `x ± 1` site (V8's `Inc`/`Dec`/`AddSmi`/`SubSmi`)
that this particular program had not reached before the loop was optimised,
because the case it belongs to runs for the first time late — `RETURN`'s
`stack[sp - 1]` in a program whose only return is its last instruction, for
example. Those are the last of the cold sites inside the hot half, and the win
above is measured with them still present.

### What it measured

| experiment | result |
| --- | --- |
| same program, same VM: shipping switch vs. a narrow switch (real frames, real helpers, `loop.typ`) | **1.33x** (84.9 → 64.0 ns per instruction) |
| `loop.typ`, in-process, steady state | 271 → 198 ms (**1.37x**) |
| suite total VM wall clock, `--iterations 7 --warmups 2` | 925.5 → 760.6 ms (**1.22x**) |
| per program | 1.09x (`closures`) … 1.37x (`loop`) |
| output parity and tests | 7/7 programs identical, `npm test` 568/568 at the time of the measurement |

Things that were tried earlier and did **not** help, kept here so they are not
rediscovered: keeping `ip` in a local instead of on the frame, moving step
accounting out of the context object (kept anyway — it removes a property store
from the hot loop), delegating the step-counter arithmetic to a helper, giving
the loop a resumable "quantum" driven from an outer loop, and preallocating the
value stack so its element kind never changes.

### Where the next win is

The VM is still 2.7x slower end-to-end than the tree-walker, and the remaining
~59 ns per instruction is not a runtime artefact: about twenty opcodes are on
the hot path here, and most of them touch the value stack and the code stream
through keyed array accesses, which a JavaScript host charges for on every one.
The histogram points at three moves:

1. **Superinstructions** for the shapes the compiler emits constantly
   (`GET_LOCAL, CONST, ADD, SET_LOCAL`), plus absolute jump targets instead of
   `ip += offset`. This attacks effect (1) — fewer units of work — and is
   independent of the host runtime.
2. **Resolved global slots** so `GET_GLOBAL`/`SET_GLOBAL` (17.7% of instructions
   measured here) stop walking an environment chain with a `Map#get` per access.
3. **Threaded dispatch** — one small function per opcode, invoked through a
   table — to remove the switch ladder itself and with it the last large
   function that a cold site can deoptimise.

The `vm` is now the default engine, which turns that remaining gap into a
user-facing one rather than a curiosity: over the benchmark suite it runs at a
median 0.37x of the tree-walker's speed, so `--engine tree` is the quick backend
today and the three moves above are how the default becomes the fast one too.
Until then the VM earns its place twice over — as the default, and as the
independent implementation the tree-walker is tested against.

---

## 8. Reproducing the measurements

```bash
# the benchmark table above
node tools/development/benchmark.js --iterations 7 --warmups 2

# the same report as JSON (machine-readable, includes per-run samples)
node tools/development/benchmark.js --json --iterations 5

# write benchmark.md + benchmark.json somewhere
node tools/development/benchmark.js --out build/bench

# the V8 tiering evidence (Node only, uses natives syntax)
node --allow-natives-syntax --trace-opt --trace-osr --trace-deopt your-driver.cjs
```

Absolute times move with the host; the *ratio* between the two engines is the
stable result. Re-run the tool rather than trusting the table above.
