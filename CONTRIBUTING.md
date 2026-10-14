# Contributing to Typhoun

Thanks for helping build Typhoun. This guide describes how the project is
organised and the standards changes are held to.

---

## Ground rules

1. **Correctness before feature count.** A small language that works beats a
   large one that nearly works.
2. **Never weaken a test to make it pass.** Fix the cause.
3. **Never mark an unimplemented feature as complete.** Update the status
   tables in `docs/roadmap.md` and `README.md` instead.
4. **Keep the engine UI-free.** Anything interactive belongs in `src/cli/`.
5. **No new runtime dependencies** without a strong, documented reason.

---

## Development setup

```bash
node --version          # 20 or newer
npm test                # run the whole suite (node --test)
npm run test:verbose    # spec reporter
node bin/typhoun.js repl
```

There is no build step. The engine is plain ES modules under `src/`.

---

## Repository map

| Path | Contents |
| --- | --- |
| `src/source/` | Stage A — source files, offsets, excerpts |
| `src/lexer/` | Stage B — tokens and scanner |
| `src/parser/` | Stage C — recursive-descent parser |
| `src/ast/` | Stage D — node factories and printer |
| `src/semantic/` | Stage E — resolver |
| `src/runtime/` | Stage F — values, environments, context, faults |
| `src/interpreter/` | Stage F — the evaluator |
| `src/builtins/` | Stage G — standard library |
| `src/diagnostics/` | Stage H — codes, model, renderer |
| `src/modules/` | module loader |
| `src/cli/`, `bin/` | command-line interface |
| `src/main/` | public API facade |
| `docs/` | specification and references |
| `examples/` | runnable programs |
| `tests/` | unit, integration, fixtures |
| `tools/` | development and release helpers |

---

## Changing the language

Adding or altering syntax touches several stages. Work through them in order:

1. **Lexer** — add token types in `src/lexer/token.js` and scanning rules in
   `src/lexer/lexer.js`. Add lexer tests.
2. **AST** — add a node factory in `src/ast/nodes.js` and a printer case in
   `src/ast/printer.js`.
3. **Parser** — parse it in `src/parser/parser.js`, respecting precedence.
   Add parser tests.
4. **Resolver** — validate names and control flow in
   `src/semantic/resolver.js`. Add semantic tests.
5. **Interpreter** — evaluate/execute it in
   `src/interpreter/interpreter.js`. Add runtime tests.
6. **Docs** — update `docs/grammar.ebnf`, `docs/language-spec.md` and, if it
   changes user-visible behaviour, `CHANGELOG.md`.

## Adding a built-in

See the checklist at the end of
[docs/standard-library.md](docs/standard-library.md). In short: implement it
under `src/builtins/`, validate every argument with the `expect*` helpers,
register the name in both `BUILTIN_NAMES` and the resolver's `GLOBALS`, add
tests, and document it.

## Adding a diagnostic

1. Add the code to `src/diagnostics/codes.js` in the correct range.
2. Emit it with `phase` matching the code range.
3. Provide a `help` line that tells the user how to fix the problem.
4. Document it in `docs/diagnostics.md`.
5. Test that it fires *and* that the location points at the right token.

---

## Style

* Plain ES modules (`import`/`export`), no transpilation.
* 2-space indentation, double-quoted strings, semicolons, 100-column soft
  limit.
* Prefer small pure functions and explicit data over clever abstractions.
* Use the project's own diagnostic codes for failures; do not throw bare
  `Error`s from engine code that a Typhoun program can trigger.
* Every exported function gets a one-line comment describing its contract.

---

## Tests

* Tests live next to their stage under `tests/`.
* Use `node:test` and `node:assert/strict`.
* Go through `tests/helpers.js` so tests exercise the same public API as the
  CLI.
* Golden output changes must be regenerated deliberately with
  `node tools/development/update-goldens.js` and reviewed in the diff.
* New behaviour needs a test that fails without the change.
* CI runs the whole suite on every push and pull request — see
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — so a change is not
  ready until `npm test` is green on Node 20, 22 and 24.

---

## Commits and pull requests

* Keep commits focused; one logical change per commit.
* Describe *why* in the message, not just *what*.
* Ensure `npm test` passes before proposing a change.
* Note any behaviour change in `CHANGELOG.md` under an "Unreleased" heading.

---

## Releases

Cutting a release is a CHANGELOG edit, not a command. `.github/workflows/release.yml`
derives everything from the file, so the tag and the notes cannot disagree with
what the project says it shipped:

1. Replace the `## [Unreleased]` heading with `## [<version>] — <date>`, where
   `<version>` is a plain `x.y.z` (nothing else, no `v`).
2. Move the entries that shipped under it. Its body becomes the release notes
   verbatim, so write it for someone reading the repository front page.
3. Merge to `main`.

Once `CI` finishes green the release workflow tags the merge commit and
publishes the release from that section. It is idempotent: if the tag already
exists it reports `releasable=false` and stops, so re-running it — or merging
while it is still going — cannot publish twice. `node tools/release/plan-release.js`
reports the same decision locally without touching GitHub, and
`node tools/release/plan-release.js --tagged v0.1.0` lets you check what a
CHANGELOG edit *would* release before you merge it.

---

## Reporting bugs

Include the Typhoun version (`typhoun version`), the Node.js version, the
smallest `.typ` program that reproduces the problem, the exact command, the
observed output and the expected output.
