# Typhoun Diagnostics — v0.1

A diagnostic is structured data produced by a pipeline stage. It always has:

| Field | Meaning |
| --- | --- |
| `code` | stable identifier, e.g. `TYP3001` |
| `phase` | `lexical`, `syntax`, `semantic`, `runtime`, `import`, `resource`, `lint` |
| `severity` | `error` or `warning` |
| `message` | one-line human explanation |
| `location` | `{ file, offset, line, column, length }` (1-based line/column) |
| `help` | optional suggested correction |
| `stack` | Typhoun call frames (runtime errors only) |

Diagnostics are rendered as:

```text
error[TYP2004]: Expected an expression but found 'if'
  --> /path/to/main.typ:2:1
    |
  2 | if x { print("hi") }
    | ^^
    |
  = help: A value, variable, call or literal was expected here.
```

Everything in the excerpt above is produced from the actual failing source
text: the file name, the line and column, the source line and the caret span.

Warnings are rendered with the `warning[CODE]` prefix and do **not** change the
process exit code by themselves — `typhoun lint` has `--strict` and
`--max-warnings <n>` for when a project wants them to. Every warning today
comes from the linter (`TYP7xxx`); see [tooling.md](tooling.md) for the rules
behind them.

---

## Error codes

### Lexical — `TYP1xxx`

| Code | Name | Raised when |
| --- | --- | --- |
| `TYP1001` | `UNEXPECTED_CHARACTER` | a character cannot begin any token (e.g. a lone `!`) |
| `TYP1002` | `UNTERMINATED_STRING` | a string literal is not closed, or contains a raw newline |
| `TYP1003` | `INVALID_ESCAPE` | an unknown escape such as `\q` |
| `TYP1004` | `UNTERMINATED_BLOCK_COMMENT` | a `/*` comment is never closed |
| `TYP1005` | `MALFORMED_NUMBER` | `12abc`, `1.2.3` and similar |
| `TYP1006` | `INVALID_UNICODE_ESCAPE` | `\u12` or `\u{110000}` |

### Syntax — `TYP2xxx`

| Code | Name | Raised when |
| --- | --- | --- |
| `TYP2001` | `UNEXPECTED_TOKEN` | the parser sees a token it cannot use here |
| `TYP2002` | `EXPECTED_TOKEN` | a required token is missing (e.g. `}`) |
| `TYP2003` | `INVALID_ASSIGNMENT_TARGET` | `1 + 2 = 3` |
| `TYP2004` | `EXPECTED_EXPRESSION` | an expression was required but not found |

### Semantic — `TYP3xxx`

| Code | Name | Raised when |
| --- | --- | --- |
| `TYP3001` | `UNDEFINED_VARIABLE` | a name is read that is declared nowhere |
| `TYP3002` | `DUPLICATE_DECLARATION` | two `let`/`const`/`fn` with one name in a scope |
| `TYP3003` | `RETURN_OUTSIDE_FUNCTION` | `return` at top level |
| `TYP3004` | `CONTROL_OUTSIDE_LOOP` | `break`/`continue` outside a loop |
| `TYP3006` | `CONST_REASSIGNMENT` | assigning to a `const`, `fn`, or read-only global |
| `TYP3007` | `IMPORT_MISUSE` | a malformed import statement |
| `TYP3008` | `USED_BEFORE_DECLARATION` | reading a binding in its temporal dead zone |
| `TYP3009` | `DUPLICATE_PARAMETER` | `fn f(a, a) { }` |

> `TYP3005 SELF_REFERENTIAL_INITIALIZER` is **reserved**: `let x = x` is
> currently reported as `TYP3008`, and the code is kept for a future, more
> specific message.

### Runtime — `TYP4xxx`

| Code | Name | Raised when |
| --- | --- | --- |
| `TYP4001` | `TYPE_ERROR` | an operator or index is applied to the wrong type |
| `TYP4002` | `DIVISION_BY_ZERO` | `/` or `%` with a zero divisor |
| `TYP4003` | `UNDEFINED_VARIABLE_RUNTIME` | a binding vanished at run time |
| `TYP4004` | `ARITY_MISMATCH` | wrong number of call arguments |
| `TYP4005` | `INDEX_OUT_OF_BOUNDS` | array/string index outside `0..len-1` |
| `TYP4007` | `NOT_CALLABLE` | calling a non-function value |
| `TYP4008` | `INVALID_INDEX_TYPE` | non-integer index, or a non-scalar map key |
| `TYP4009` | `IMMUTABLE_BINDING` | runtime write to a `const`/`fn` binding |
| `TYP4010` | `UNCAUGHT_ERROR` | `assert` failure and internal invariants |
| `TYP4012` | `BAD_NATIVE_ARGUMENT` | a built-in received a wrong-typed argument |

> `TYP4006 KEY_NOT_FOUND` and `TYP4011 MISSING_RETURN` are **reserved**:
> Typhoun returns `null` for a missing map key and for a function that falls
> off its end, so neither is currently emitted.

These codes, and only these, are what a program can recover from: a `catch`
handler is given the fields above as a value (see
[language-spec.md](language-spec.md) §9.1). Everything outside `TYP4xxx` passes
straight through a `try` and still stops the program, which is why `catch`
cannot be used to spend past a limit or to hide a module that would not load.

### Import — `TYP5xxx`

| Code | Name | Raised when |
| --- | --- | --- |
| `TYP5001` | `MODULE_NOT_FOUND` | path missing, or without the `.typ` extension |
| `TYP5002` | `MODULE_OUT_OF_BOUNDS` | the import escapes the project root |
| `TYP5003` | `IMPORT_CYCLE` | modules import each other in a cycle |
| `TYP5004` | `IMPORT_NAME_CONFLICT` | a merged import name collides locally |

> `TYP5005 MODULE_PARSE_FAILED` is **reserved**: a broken module currently
> surfaces its own lexical/syntax/semantic diagnostics instead.

### Resource limits — `TYP6xxx`

| Code | Name | Raised when |
| --- | --- | --- |
| `TYP6001` | `STEP_LIMIT` | more than `maxSteps` AST steps executed |
| `TYP6002` | `DEPTH_LIMIT` | more than `maxCallDepth` nested calls |
| `TYP6003` | `TIME_LIMIT` | wall clock exceeded `maxDurationMs` |
| `TYP6004` | `OUTPUT_LIMIT` | more than `maxOutputChars` printed |
| `TYP6005` | `COLLECTION_LIMIT` | too many collection elements or modules |
| `TYP6006` | `SOURCE_LIMIT` | a source file exceeds `maxSourceBytes` |

---

### Lint — `TYP7xxx`

Warnings from `typhoun lint`. They are findings of the linter, not errors: the
program is valid, but the code is dead, redundant or misleading. `help` on each
one says what to do about it. See [tooling.md](tooling.md) for the full rule
table, examples and the reasoning behind the narrower rules.

| Code | Name | Reported when |
| --- | --- | --- |
| `TYP7001` | `LINT_UNUSED_VARIABLE` | a binding is declared and never read |
| `TYP7002` | `LINT_UNUSED_PARAMETER` | a parameter is never read |
| `TYP7003` | `LINT_UNUSED_FUNCTION` | a top-level function is never referenced in a program file |
| `TYP7004` | `LINT_UNUSED_LOOP_VARIABLE` | a `for … in` variable is never read |
| `TYP7005` | `LINT_SHADOWED_VARIABLE` | an inner binding hides an outer one |
| `TYP7006` | `LINT_PREFER_CONST` | a `let` binding is never reassigned |
| `TYP7007` | `LINT_UNREACHABLE_CODE` | statements follow a `return`, `break` or `continue` |
| `TYP7008` | `LINT_CONSTANT_CONDITION` | an `if`/`while` condition is a literal |
| `TYP7009` | `LINT_SELF_ASSIGNMENT` | a binding is assigned its own value |
| `TYP7010` | `LINT_REDUNDANT_PARENTHESES` | parentheses wrap a leaf expression |
| `TYP7011` | `LINT_DIVISION_BY_ZERO` | `/ 0` or `% 0` with a literal zero |
| `TYP7012` | `LINT_EMPTY_BLOCK` | a control-flow body is empty and unexplained |
| `TYP7013` | `LINT_DEAD_STORE` | a value is overwritten, or goes out of scope, unread |

`typhoun check` never emits `TYP7xxx`: it reports errors only. `typhoun lint`
reports both, errors first.

---

## Exit codes

The CLI uses:

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | one or more error diagnostics, a runtime failure, or a tooling check that failed (`fmt --check`, `lint --strict`, `lint --max-warnings`) |
| `2` | usage error (bad arguments, missing file, wrong extension) |

Program output goes to **stdout**; diagnostics go to **stderr**, except for
`typhoun ast` and `typhoun tokens`, which print their requested artifact to
stdout and report their own lexical/syntax problems on stderr with exit code 1.
