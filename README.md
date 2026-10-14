# Typhoun

[![CI](https://github.com/mylynxcc/typhoun/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mylynxcc/typhoun/actions/workflows/ci.yml)

> **Write boldly. Build anything.**

Typhoun is a dynamically typed, expression-oriented programming language with
its own lexer, parser, AST, semantic analyzer, tree-walking interpreter, a
bytecode compiler and stack virtual machine, runtime, standard library, module
loader, diagnostic system and CLI — all implemented from scratch. Source files
use the `.typ` extension and the command-line executable is `typhoun`.

It is **not** a wrapper around another language: `.typ` programs are compiled
to Typhoun tokens and a Typhoun AST, resolved by Typhoun's semantic analyzer
and executed by Typhoun's interpreter. No host `eval`, no shelling out, no
transpilation.

There are **two execution backends** for the same language. `--engine vm`
compiles the resolved AST to bytecode and runs it on a stack VM (the default);
`--engine tree` walks the AST directly. They share everything but control flow,
and their output parity is asserted by the test suite. The tree-walker is still
the quicker of the two on Node — [docs/bytecode.md](docs/bytecode.md) has the
measured numbers and the reason — so `--engine tree` is worth knowing about.

```typ
// hello.typ
let name = "Typhoun"

fn greet(who) {
    return "Hello, " + who + "!"
}

print(greet(name))

for i in range(1, 6) {
    if i % 2 == 0 {
        print(i, "is even")
    }
}
```

```console
$ typhoun run hello.typ
Hello, Typhoun!
2 is even
4 is even
```

---

## Quick start

Requires **Node.js 20+**. No dependencies, no build step.

```bash
node bin/typhoun.js run examples/hello.typ   # run the CLI directly
npm link                                     # or install `typhoun` globally
typhoun run examples/hello.typ
```

New here? Read [docs/getting-started.md](docs/getting-started.md).

---

## CLI

```console
typhoun run <file>        # execute a program
typhoun check <file>      # lexical + syntax + semantic checks, no execution
typhoun tokens <file>     # token stream with line:column positions
typhoun ast <file>        # indented abstract syntax tree
typhoun dis <file>        # compile to bytecode and print the disassembly
typhoun fmt [file..]      # rewrite files in the canonical style (--check to verify)
typhoun lint [file..]     # report dead, redundant or misleading code
typhoun bench [file..]    # benchmark the tree-walker against the bytecode VM
typhoun version           # language and runtime version
typhoun help              # usage
typhoun repl              # interactive session
```

`fmt` and `lint` accept files or directories and are described in full in
[docs/tooling.md](docs/tooling.md):

```console
typhoun fmt --check .          # is every file canonical? (exit 1 if not)
typhoun lint --strict .        # fail the build on any warning
typhoun lint --rule unused-variable src
```

A `typhoun.json` at the repository root supplies those settings so CI needs no
flags, and `--config <path>` names a file explicitly. A command-line flag
always overrides the file:

```json
{
  "fmt": { "width": 80, "indent": 4 },
  "lint": { "rules": ["unused-variable"], "strict": true }
}
```

Useful options: `--engine <tree|vm>`, `--iterations <n>`, `--warmups <n>`,
`--root <dir>`, `--max-steps <n>`, `--max-depth <n>`, `--max-ms <n>`,
`--output-limit <n>`, `--no-input`, `-q`, plus `--check` / `--stdout` /
`--width <n>` for `fmt` and `--strict` / `--max-warnings <n>` / `--rule` /
`--disable` / `--no-strict` / `--config <path>` for `lint`, `--indent <n>`
for `fmt`, and `--json` on every reporting command.

Exit codes: `0` success, `1` error diagnostics / runtime failure, `2` usage.

---

## Language at a glance

```typ
// Bindings (block scoped, no implicit conversion)
let counter = 0
const pi = 3.14159

// Functions, closures, recursion — all first class
fn makeAdder(base) {
    return fn (n) { return base + n }
}
let addTen = makeAdder(10)
print(addTen(5))            // 15

// Arrays and maps (zero-indexed; maps keep insertion order)
let fruits = ["apple", "mango"]
fruits[0] = "pear"
let user = { "name": "Jay", "level": 7 }
user.level += 1

// Control flow
for fruit in fruits { print(fruit) }
for (let i = 0; i < 3; i += 1) { print(i) }
while counter < 5 { counter += 1 }

// Errors are values: a runtime failure can be inspected and recovered from
try {
    print(fruits[99])
} catch err {
    print(err.code, err.message)   // TYP4005 Index 99 is out of bounds for length 2
    print(err.location.line)       // the line the failure happened on
    print(len(err.stack))          // call frames, innermost first
}

// Modules
import "math.typ"           // merges exports
import "math.typ" as math   // or binds a namespace
```

Semantics in one paragraph: **only `false` and `null` are falsy**; `==` is
structural and never coerces; arithmetic needs two numbers (except `+` on two
strings); `/` and `%` by zero are runtime errors; arrays are mutable and
bounds-checked; missing map keys read as `null`; functions capture their
lexical environment; a runtime error can be caught as a map with its code,
message, location and call stack, while import failures and sandbox limits pass
straight through a `try`.

Full details: [docs/language-spec.md](docs/language-spec.md) and
[docs/grammar.ebnf](docs/grammar.ebnf).

---

## Architecture

```
.typ source
   │
   ├─ A  Source Manager      src/source/          offsets ⇄ line/column, excerpts
   ├─ B  Lexer               src/lexer/           hand-written scanner → tokens
   ├─ C  Parser              src/parser/          recursive descent + precedence climbing
   ├─ D  AST                 src/ast/             node definitions + printer
   ├─ E  Resolver            src/semantic/        scopes, TDZ, const rules, placement
   ├─ F  Interpreter         src/interpreter/     tree-walking evaluator (engine "tree")
   │      Runtime            src/runtime/         values, environments, limits, faults
   ├─ F₂ Compiler            src/compiler/        resolved AST → bytecode chunks
   │      Bytecode           src/bytecode/        opcodes, chunks, disassembler
   │      VM                 src/vm/               stack machine (engine "vm", the default)
   ├─ G  Standard library    src/builtins/        30 argument-checked built-ins
   ├─   Modules              src/modules/         rooted, cached, cycle-safe loader
   └─ H  Diagnostics         src/diagnostics/     codes, structure, rendering
        CLI                   src/cli/ + bin/      run/check/tokens/ast/dis/bench/repl
```

Each stage has its own code, interface and tests, and can be exercised
independently through the public API in `src/main/index.js`:

```js
import { tokenizeSource, parseSource, checkSource, runSource } from "./src/main/index.js";

const { tokens } = tokenizeSource('print("hi")');
const { ast } = parseSource('print("hi")');
const { diagnostics } = checkSource("let x = y");
const { context } = runSource('print(1 + 1)');
```

---

## Testing

```bash
npm test            # node --test  (662 tests)
npm run test:verbose
npm run bench       # tree-walker vs bytecode VM, measured
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs exactly that suite —
plain `npm test` — on every push and pull request, across Node **20, 22 and 24**;
the badge at the top of this file reports the latest result on `main`. A second
job walks the release publishing path in dry-run mode — deriving the tag,
slicing the notes, and printing the tag and release it would create — so that
path is exercised on every push rather than only when a version ships. There is
deliberately no install step and no dependency cache: Typhoun has no
dependencies and commits no lock file, so `npm ci` would fail and
`actions/setup-node`'s `cache: npm` errors without one.

Coverage by stage:

| Suite | File | Focus |
| --- | --- | --- |
| Lexer | `tests/lexer/` | keywords, literals, escapes, comments, unicode, positions, malformed input |
| Parser | `tests/parser/` | grammar, precedence, associativity, error recovery |
| Semantic | `tests/semantic/` | undefined names, duplicates, TDZ, const rules, control-flow placement |
| Runtime | `tests/runtime/` | arithmetic, truthiness, equality, closures, recursion, collections, built-ins, error handling, limits |
| Bytecode compiler | `tests/engine/compiler.test.js` | emitted instructions, jump patching, slots, constants |
| Bytecode VM | `tests/engine/vm.test.js` | the `vm` engine on its own |
| Engine parity | `tests/engine/parity.test.js` | byte-identical output and diagnostics on both engines |
| Differential fuzzing | `tests/engine/differential-fuzz.test.js` | generated programs on both engines: identical output or identical diagnostic, from a seeded and bounded corpus |
| Bytecode invariants | `tests/engine/bytecode-invariants.test.js` | valid opcodes, in-range jumps, handler boundaries, slots, constants |
| Formatter | `tests/format/` | canonical layout, idempotency, AST equivalence, comments, width, broken-input refusal |
| Linter | `tests/lint/` | every rule (firing and silent cases), rule selection, imports, repo cleanliness, and randomized falsification of every dead-store report |
| Benchmarks | `tests/integration/benchmark.test.js` | the harness itself, including mismatch detection |
| Tooling CLI | `tests/integration/tooling-cli.test.js` | `fmt` and `lint` end to end: exit codes, flags, JSON |
| Project settings | `tests/integration/project-config.test.js` | `typhoun.json`: discovery, validation, flag precedence |
| End-to-end | `tests/integration/end-to-end.test.js` | the 15 required programs, executed for real |
| CLI | `tests/integration/cli.test.js` | every command, plus a spawned `bin/typhoun.js` |
| Modules | `tests/integration/modules.test.js` | import forms, caching, exports, cycles, boundaries |
| Security | `tests/integration/security.test.js` | capability exposure, every resource limit, and what `catch` cannot swallow |
| Golden | `tests/integration/golden.test.js` | exact tokens/AST/diagnostics output |

Regenerate the golden fixtures with
`node tools/development/update-goldens.js`.

---

## Security

Untrusted programs run with no shell access, no host evaluation, no ambient
library, no network, no environment access and import paths confined to the
project root. Step, depth, time, output, collection and source-size limits are
enforced. `try`/`catch` recovers from runtime errors only: a limit or a module
failure is never handed to a handler, so no program can catch its way past a
budget or keep running with a module that did not load. See
[docs/security-model.md](docs/security-model.md) — including the important note
that an in-process interpreter does **not** provide operating system isolation.

---

## Project layout

```
typhoun/
├── bin/            typhoun executable
├── src/            engine (source, lexer, parser, ast, semantic, runtime,
│                   interpreter, compiler, bytecode, vm, format, lint,
│                   builtins, modules, diagnostics, cli, main)
├── benchmarks/     .typ programs used by `typhoun bench`
├── examples/       runnable .typ programs, including a multi-file module
├── docs/           language spec, grammar, stdlib, diagnostics, security, roadmap
├── tests/          unit, integration and fixture suites
└── tools/          development and release helpers
```

---

## Documentation

* [Getting started](docs/getting-started.md)
* [Language specification](docs/language-spec.md)
* [Grammar (EBNF)](docs/grammar.ebnf)
* [Standard library](docs/standard-library.md)
* [Diagnostics](docs/diagnostics.md)
* [Formatter and linter](docs/tooling.md)
* [Bytecode backend and benchmarks](docs/bytecode.md)
* [Security model](docs/security-model.md)
* [Roadmap](docs/roadmap.md)
* [Contributing](CONTRIBUTING.md)
* [Changelog](CHANGELOG.md)

---

## Limitations (v0.1, stated honestly)

* No static type checking, no classes, no `finally`, no user-raised errors and
  no concurrency. `try`/`catch` handles runtime errors; what it cannot catch is
  listed in [docs/language-spec.md](docs/language-spec.md) §9.2.
* No JIT and no native code generation. The bytecode compiler and stack VM
  (`vm`) is the default engine, and on Node it is currently **slower** than the
  tree-walking interpreter — a median 0.37x of its speed over the benchmark
  suite, so `--engine tree` is the quick backend for now. Both stay correct and
  tested, and the suite asserts they agree; see
  [docs/bytecode.md](docs/bytecode.md) for the measured numbers.
* `maxCollectionSize` bounds element counts, not bytes; there is no custom
  garbage collector.
* Numbers are IEEE-754 doubles; integers are exact only up to 2^53.

---

## License

MIT — see [LICENSE](LICENSE).
