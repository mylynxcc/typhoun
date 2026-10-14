# Typhoun Tooling — v0.1

Two commands keep Typhoun source consistent: `typhoun fmt` prints every file in
one canonical style, and `typhoun lint` reports code that is dead, redundant or
misleading. Both are ordinary consumers of the same front end as `run` and
`check` — they lex, parse and resolve with the real pipeline, so a file the
tooling accepts is a file the interpreter accepts.

| Command | Changes files? | Fails the build? |
| --- | --- | --- |
| `typhoun fmt` | yes, unless `--check` or `--stdout` | on parse errors, or with `--check` when a file is not canonical |
| `typhoun lint` | never | on error diagnostics, or on warnings when asked |

---

## Project settings — `typhoun.json`

A repository can keep these settings in a file next to its sources instead of
repeating the same flags on every command:

```json
{
  "fmt": { "width": 80, "indent": 4 },
  "lint": { "rules": ["unused-variable"], "disable": [], "strict": true }
}
```

`fmt` and `lint` look for the nearest `typhoun.json` at or above the working
directory, so the file applies to a whole project from anywhere inside it:

```console
cd src && typhoun fmt --check .   # uses ../typhoun.json
```

Each command reads only its own section, and **a command-line flag always wins
over the file** — the file supplies the defaults you did not type.

| Section | Key | Type | Default | Effect |
| --- | --- | --- | --- | --- |
| `fmt` | `width` | integer 1–1000 | `100` | same as `--width` |
| `fmt` | `indent` | integer 0–8 | `4` | same as `--indent` |
| `lint` | `rules` | array of rule names | all rules | same as `--rule` |
| `lint` | `disable` | array of rule names | none | same as `--disable` |
| `lint` | `strict` | boolean | `false` | same as `--strict` |
| `lint` | `maxWarnings` | integer ≥ 0 | none | same as `--max-warnings` |

The one flag that turns a setting *off* is `--no-strict`, because `--strict`
can only turn strictness on: a file that says `"strict": true` is overridden
by `typhoun lint --no-strict .`.

`--config <path>` reads a specific file instead of searching, which is how a
project keeps settings under a name of its own:

```console
typhoun lint --config tools/lint.json .
```

The file is deliberately strict, because settings that are silently
half-applied are worse than none. Every one of these is a usage error (exit
code `2`) that names the offending key and changes nothing:

* an unknown top-level section, or an unknown key inside `fmt` or `lint`;
* a value of the wrong type or outside the range above;
* a lint rule that does not exist — the message lists the known rules;
* invalid JSON, a non-object top level, or a file that cannot be read.

A command with nothing to configure (`run`, `check`, `tokens`, `ast`, `dis`)
never reads the file, so a broken one cannot break them.

---

## `typhoun fmt`

```console
typhoun fmt examples            # rewrite every .typ file under examples/
typhoun fmt a.typ b.typ         # rewrite two files
typhoun fmt --check examples    # report what would change, change nothing
typhoun fmt --stdout a.typ      # print the canonical source, change nothing
typhoun fmt --width 80 a.typ    # break lists that exceed 80 columns
typhoun fmt --json --check .    # machine-readable report
```

Directories are expanded to the `.typ` files inside them (recursively), so
`typhoun fmt .` formats a whole project. `--stdout` accepts exactly one file.

### The canonical style

The formatter is a printer, not a pretty-printer with knobs: the only inputs
that influence the output are the syntax tree, the comments, the indentation
unit and the line width. Everything a reader might argue about has one answer.

* One statement per line, four-space indentation by default (`--indent` or
  `typhoun.json` change the unit), no semicolons.
* Blocks always span lines:

  ```typ
  fn add(a, b) {
      return a + b
  }
  ```

  An empty block collapses to `{}`.
* Lists — call arguments, array elements, map entries, parameter lists — stay
  on one line while they fit the width, otherwise one item per line with the
  closing delimiter back at the list's own indent:

  ```typ
  print("aaaa", "bbbb", "cccc")

  print(
      "aaaaaaaaaa",
      "bbbbbbbbbb",
      "cccccccccc"
  )
  ```

  Typhoun has no trailing commas, so none are ever emitted.
* The single-line map form carries one space of padding: `{ "k": 1 }`.
* `obj["name"]` prints as `obj.name` when the key is a plain identifier.
* Numeric literals print verbatim from the source, so `0.30000000000000004`
  and `1e-7` cannot drift in precision or notation. Strings are re-quoted
  canonically (`"…"`, with the documented escapes).
* Comments are preserved. A comment that shares a line with code stays a
  trailing comment, separated by two spaces; every other comment keeps its own
  line. A comment inside a list forces that list to break.
* Runs of blank lines collapse to one, and blank lines survive only between
  statements.

### The guarantees

* **Idempotent.** Formatting formatted source returns it byte for byte
  (`fmt(fmt(x)) === fmt(x)`), which is what lets `--check` be a CI gate.
* **Meaning-preserving.** The formatted text parses to the same tree (compared
  with source locations stripped, so only meaning is left). The suite checks
  this on a sample of constructs and on every shipped program: a re-indented
  copy formats back to the canonical file byte for byte, with the same tree.
* **Refuses what it cannot parse.** If a file has lexical or syntax errors the
  formatter reports those diagnostics, leaves the file untouched and exits
  non-zero. It never rewrites a file it does not fully understand, and its
  summary says how many files it skipped.

Checking a repository in CI:

```console
typhoun fmt --check .
```

### Options

| Option | Effect |
| --- | --- |
| `--check` | report files that are not canonical; change nothing; exit 1 if any |
| `--stdout` | print the formatted source for one file instead of writing |
| `--width <n>` | maximum line width before lists break (default `100`) |
| `--indent <n>` | spaces per indent level, 0–8 (default `4`) |
| `--config <path>` | read settings from this file instead of searching for `typhoun.json` |
| `--json` | emit `{ files, changed, total, mode, settings }` |
| `-q`, `--quiet` | suppress the trailing summary line |

---

## `typhoun lint`

```console
typhoun lint examples                  # warn about every file
typhoun lint --strict .                # warnings fail the build
typhoun lint --max-warnings 0 src      # only a clean tree passes
typhoun lint --rule unused-variable .  # run one rule
typhoun lint --disable empty-block .   # skip a rule
typhoun lint --json .                  # machine-readable diagnostics
```

`lint` is a superset of `check`: lexical, syntax, semantic and import
diagnostics are reported first (and fail the build with exit code 1), and the
lint warnings are added on top. Warnings alone do not fail the build unless you
pass `--strict` or `--max-warnings <n>`.

### Rules

Every rule has a stable code in the `TYP7xxx` range, a source location, and a
`help` line that says what to do about it.

| Code | Rule | Reports | Example |
| --- | --- | --- | --- |
| `TYP7001` | `unused-variable` | a binding that is declared and never read | `let unused = 1` |
| `TYP7002` | `unused-parameter` | a parameter that is never read | `fn f(used, unused) { … }` |
| `TYP7003` | `unused-function` | a top-level function never referenced in this file | `fn neverCalled() { … }` |
| `TYP7004` | `unused-loop-variable` | a `for … in` variable that is never read | `for key in items { … }` |
| `TYP7005` | `shadowed-variable` | an inner binding hides an outer one of the same name | `let n = 1` / `fn f(n) { … }` |
| `TYP7006` | `prefer-const` | a `let` binding is never reassigned | `let name = "Typhoun"` |
| `TYP7007` | `unreachable-code` | statements follow a `return`, `break` or `continue` | `return 1` / `print(2)` |
| `TYP7008` | `constant-condition` | an `if`/`while` condition is a literal | `if true { … }` |
| `TYP7009` | `self-assignment` | a binding is assigned its own value | `x = x` |
| `TYP7010` | `redundant-parentheses` | parentheses wrap a leaf and change nothing | `let n = (1)` |
| `TYP7011` | `division-by-zero` | `/ 0` or `% 0` with a literal zero divisor | `print(10 / 0)` |
| `TYP7012` | `empty-block` | a control-flow body is empty with no explaining comment | `if ready { }` |
| `TYP7013` | `dead-store` | a value is overwritten, or goes out of scope, unread | `let total = 0` / `total = 1` |

Names that start with `_` are treated as deliberately unused, which is the
idiomatic way to keep an unused parameter's position:

```typ
fn onEvent(_event, value) {
    return value * 2
}
```

### Dead stores

Every other rule looks at one construct at a time; `dead-store` is the one that
looks at their order, because that is the only way to see a value nobody reads:

```typ
let total = 0
total = 10
print(total)      // 10 · the 0 was never read
```

It reports a store whose value is gone before anything reads it — overwritten in
the same straight line, or left unread when the name goes out of scope:

```typ
fn label(flag) {
    let mode = "strict"   // TYP7013: overwritten before it is ever read
    mode = "lenient"
    return mode + flag
}
```

Three things keep it from ever reporting a value that *is* read:

* **A write replaces a value only where it is certain to run.** A store inside
  an `if` replaces the earlier value on that arm alone, and the join between the
  arms keeps the earlier value live for the path that did not take it — so a
  read on that path, in either arm, or anywhere after the block, clears the
  report. This is what leaves the common `let label = "odd"` … `if even { label
  = "even" }` … `print(label)` pattern alone.
* **Closures and loops are excluded.** A nested function may run at any point,
  so `fn f() { print(x) }` between `x = 1` and `x = 2` says nothing about which
  value `f` sees; and a loop body writes what the next iteration reads, so
  source order does not describe the order the reads happen in. A binding read
  or written in either is left to the judgement of the reader.
* **A binding nothing reads is `unused-variable`'s finding**, not this one's,
  so the two never report the same line twice.

### What the linter is careful about

A linter that reports code which is not actually wrong gets switched off, so
several rules are deliberately narrower than they could be:

* **A file that only declares things is a library.** Typhoun exports every
  top-level declaration, so `unused-function` and `unused-variable` are not
  reported for the top-level names of a module such as
  [examples/modules/math.typ](../examples/modules/math.typ) — those names are
  its public surface. A file that also executes something at the top level is a
  program, and there a leftover binding or function really is dead weight.
* **`while true` is not a constant condition.** It is the idiomatic infinite
  loop, so `constant-condition` lets it through and only reports literal tests
  in `if` and in loops that are meant to terminate.
* **Indexed and field assignments count as writes.** `items[0] = 2` and
  `user.level += 1` mutate the value the binding holds, so `prefer-const` stays
  quiet: the advice would be wrong.
* **Usage counts are flow-insensitive.** A binding read anywhere in its scope
  counts as used — including inside a function that is never called. This can
  miss dead code, but it will not report a live binding as unused. Only
  `dead-store` reasons about order, and it gives up (above) wherever order alone
  does not decide the question.
* **An empty `catch` handler is not a finding.** Ignoring an error is exactly
  what `try { ... } catch err {}` means, so `empty-block` reports an empty
  *guarded* block (which guards nothing) and stays quiet about an empty handler.
  The caught error is also never reported as an unused binding — that is what
  the name after `catch` is for. See
  [language-spec.md](language-spec.md) §9.1.
* **No false positives on the shipped code.** `examples/`, `benchmarks/` and the
  runnable fixtures lint clean, and the test suite fails if that stops being
  true.

### What lint does not do

* **It never rewrites code.** There is no `--fix`, by design: a warning is a
  suggestion for the author, and a tool that silently edits source is a
  different tool. Use `typhoun fmt` for layout.
* **It reports nothing about types or performance.** There is no type checker
  and no cost model yet — see [roadmap.md](roadmap.md).
* **There is no per-line suppression.** Rule selection lives on the command
  line (`--rule`, `--disable`) or in [`typhoun.json`](#project-settings--typhounjson),
  which applies to the whole project rather than to one line.

### Options

| Option | Effect |
| --- | --- |
| `--strict` | exit 1 when any warning is reported |
| `--no-strict` | turn strictness off even when `typhoun.json` asks for it |
| `--max-warnings <n>` | exit 1 when more than `n` warnings are reported |
| `--rule <names>` | run only these rules (comma separated, repeatable) |
| `--disable <names>` | skip these rules (comma separated, repeatable) |
| `--config <path>` | read settings from this file instead of searching for `typhoun.json` |
| `--json` | emit every diagnostic plus `{ files, errors, warnings, settings }` |
| `-q`, `--quiet` | suppress the summary line |

`--rule`/`--disable` names are validated against the registry, and an unknown
name is a usage error (exit code 2) that lists the known rules.

### JSON output

```json
{
  "files": [
    {
      "path": "app.typ",
      "diagnostics": [
        {
          "code": "TYP7001",
          "phase": "lint",
          "severity": "warning",
          "message": "'unused' is declared but never read",
          "location": {
            "file": "app.typ",
            "offset": 0,
            "line": 1,
            "column": 1,
            "length": 10
          },
          "help": "Remove it, use it, or rename it with a leading '_' to mark it as intentional.",
          "notes": [],
          "stack": []
        }
      ]
    }
  ],
  "summary": { "files": 1, "errors": 0, "warnings": 1 },
  "settings": {
    "source": "typhoun.json",
    "rules": ["unused-variable"],
    "disable": [],
    "strict": true,
    "maxWarnings": null
  }
}
```

`settings.source` names the file the settings came from, or `null` when every
value is a built-in default; the other keys report the values actually in
force after the file and the command line have been resolved.

---

## Using both in a project

Keep a [`typhoun.json`](#project-settings--typhounjson) at the repository root
and CI needs no flags at all:

```json
{
  "fmt": { "width": 80 },
  "lint": { "strict": true, "maxWarnings": 0 }
}
```

```console
typhoun fmt --check .     # layout is canonical
ntyphoun lint .           # no dead code, no warnings (strict, from the file)
typhoun check examples    # nothing fails to resolve
typhoun run examples/hello.typ
```

Both commands print `settings from <file>` in their summary when a settings
file was used, so a build log says where the settings came from.

Exit codes are the same across the CLI: `0` success, `1` diagnostics or
failures, `2` usage error. Artifacts go to stdout, diagnostics to stderr.

## How this is tested

* `tests/format/formatter.test.js` — canonical layout, idempotency, AST
  equivalence, comment retention, width behaviour, broken-input refusal, the
  file API, and the assertion that every shipped program is already canonical.
* `tests/lint/linter.test.js` — every rule (a case that fires and a case that
  must stay silent), rule selection, JSON/diagnostic shape, import awareness,
  and the assertion that `examples/` and `benchmarks/` lint clean.
* `tests/lint/dead-store-fuzz.test.js` — the order-aware rule, checked against
  the running program rather than against an expectation. For every generated
  program it lints, each `dead-store` report is *falsified*: the stored value is
  replaced with a canary and the program is run again. A store whose value is
  never read cannot change what the program prints, so a difference is a false
  positive. The corpus is generated from seeds — straight-line statement lists
  and function bodies with early returns, nested blocks, closures and handlers —
  so a failure prints the program that produced it.
* `tests/integration/tooling-cli.test.js` — both commands through the real CLI:
  exit codes, `--check`/`--stdout`/`--width`/`--json`, rule flags and usage
  errors.
* `tests/integration/project-config.test.js` — `typhoun.json` end to end:
  discovery walking up the tree, every validation error, and, for each setting,
  that the file is read and that a command-line flag overrides it.
