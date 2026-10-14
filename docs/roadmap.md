# Typhoun Roadmap

This roadmap is a plan, not a promise. Items are listed here so that the
architecture can be prepared for them; **nothing below is implemented in
v0.1 unless it is also in the v0.1 column of the status table.**

---

## Status of v0.1 (this release)

| Area | Status |
| --- | --- |
| Source manager, positions, excerpts | ✅ implemented |
| Lexer (tokens, escapes, unicode policy) | ✅ implemented |
| Parser (recursive descent + precedence climbing, error recovery) | ✅ implemented |
| AST + printer | ✅ implemented |
| Semantic resolver (scopes, TDZ, const rules, control-flow placement) | ✅ implemented |
| Tree-walking interpreter, closures, recursion | ✅ implemented |
| Bytecode compiler + stack VM (`--engine vm`) | ✅ implemented |
| Engine parity tests (tree vs vm, byte-identical output) | ✅ implemented |
| Benchmark harness with measured numbers | ✅ implemented |
| Standard library (30 built-ins) | ✅ implemented |
| Diagnostics with codes, carets and help | ✅ implemented |
| CLI: `run` `check` `tokens` `ast` `dis` `version` `help` `repl` | ✅ implemented |
| Canonical formatter (`typhoun fmt`) | ✅ implemented |
| Linter (`typhoun lint`, 13 rules, `TYP7xxx`) | ✅ implemented |
| Flow-sensitive dead-store analysis (`TYP7013`) | ✅ implemented |
| Project settings (`typhoun.json`) for `fmt` and `lint` | ✅ implemented |
| Module loader (rooted, cached, cycle-safe) | ✅ implemented |
| Resource limits | ✅ implemented |
| Error handling (`try`/`catch`, error values, catchability rule) | ✅ implemented |
| Automated test suite (662 tests) | ✅ implemented |
| Continuous integration — `npm test` on Node 20/22/24, every push and PR | ✅ implemented |
| Static typing | ❌ not implemented |

| Package manager, LSP, editor integration | ❌ not implemented |
| Native compilation | ❌ not implemented |

---

## v0.2 — Ergonomics and modules

* ~~`try { } catch err { }` plus a `Result`-style convention.~~ (shipped early,
  in v0.1 — see [language-spec.md](language-spec.md) §9) Follow-ups: a
  `Result`-style convention built on these error values, and a way for a program
  to raise an error of its own instead of only catching one.
* Richer diagnostics: "did you mean?" suggestions based on edit distance.
* Better module system: explicit `export`, named imports, module metadata.
* ~~`typhoun fmt` formatter and `typhoun lint`.~~ (v0.1 — see
  [tooling.md](tooling.md)) Follow-ups: ~~a configuration file~~ (shipped early,
  in v0.1 — `typhoun.json`, see
  [tooling.md](tooling.md#project-settings--typhounjson)), ~~flow-sensitive
  analysis~~ (shipped early — `dead-store`, see
  [tooling.md](tooling.md#dead-stores)), per-line suppression, and more lint
  rules as the language grows.
* Package manifest (`typhoun.json`) and a dependency resolver. The name is
  already taken by the tool settings file, which is the growth path: the same
  document gains a package section rather than a second file beside it.
* `for ... in` yielding `[key, value]` pairs for maps.

## v0.3 — Compilation and performance

The first three items shipped early, in v0.1 — see
[bytecode.md](bytecode.md). What remains opens with making the VM *faster* than
the tree-walker rather than merely equal to it — and the VM is the default
engine now, so that difference is one users meet rather than a footnote:

* ~~Bytecode instruction set definition and a compiler from the AST.~~
  (v0.1)
* ~~Stack-based virtual machine executing that bytecode.~~ (v0.1)
* ~~Benchmarks comparing the tree-walker with the VM on representative
  programs.~~ (v0.1)
* ~~Honest performance documentation with measured numbers.~~ (v0.1)
* ~~A hot/cold split so the dispatch loop keeps the host's optimising tier.~~
  (v0.1 follow-up — see [bytecode.md](bytecode.md) §7: 1.22x on the benchmark
  suite, per program 1.09–1.37x; the VM is still 2.7x slower than the
  tree-walker) What remains of this item: superinstructions for the commonest
  compiler patterns and absolute jump targets, resolved global slots, and
  threaded (one function per opcode) dispatch.
* Debugger foundations: breakpoints, single-stepping, variable inspection.

## v0.4 — Tooling

* Language Server Protocol server: diagnostics, hover, completion, go-to-definition.
* Editor integration (VS Code first) driven by the LSP server.
* Documentation generator from doc comments.
* Structured `--json` output for every CLI command.

## v0.5 — Types and concurrency research

* Optional static typing / type inference research; must remain opt-in so
  existing dynamically typed code keeps working.
* Concurrency model design (structured concurrency over OS threads or
  cooperative tasks).
* Expanded standard library: dates, regular expressions, binary data.
* Foreign-function interface research with an explicit capability model.

## 1.0 — Stability

* Frozen language specification with a compatibility policy.
* Versioned package ecosystem.
* Reproducible builds and a documented release process.
* Independent security review and comprehensive regression testing.

---

## Explicitly out of scope

Native compilation, operating-system development and systems programming are
**separate engineering efforts**. Typhoun having an interpreter does not make
those promises. They are not on this roadmap and should not be inferred.
