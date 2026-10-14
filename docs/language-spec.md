# Typhoun Language Specification — v0.1

> **Typhoun — Write boldly. Build anything.**

This document is the normative description of Typhoun 0.1: its syntax, values,
semantics and runtime behaviour. Anything the implementation does that is not
described here is a bug, not a feature.

---

## 1. Source files

* A Typhoun source file ends in `.typ` and is UTF-8 encoded text.
* Whitespace (spaces, tabs, CR, LF) separates tokens and is otherwise
  insignificant. Statements are **not** newline sensitive.
* The file is read as a sequence of Unicode code units (UTF-16). Character
  offsets, string lengths and string indexing are therefore measured in UTF-16
  code units, matching the behaviour of most editors and JavaScript hosts.

### Comments

```typ
// a single-line comment

/* a block comment
   /* nested comments are supported */
   and this is still a comment */
```

An unterminated block comment is a lexical error.

---

## 2. Values and types

Typhoun 0.1 is **dynamically typed**. A value always has one of seven types:

| Type | Description | Literal examples |
| --- | --- | --- |
| `number` | IEEE-754 double precision floating point | `42`, `3.14`, `1e6` |
| `string` | UTF-8 text, indexed by UTF-16 code unit | `"hello"`, `"a\nb"` |
| `boolean` | truth value | `true`, `false` |
| `null` | the absent/empty value | `null` |
| `array` | ordered, mutable, zero-indexed sequence | `[1, "two", true]` |
| `map` | insertion-ordered key/value collection | `{ "name": "Typhoun" }` |
| `function` | first-class callable value | `fn (x) { return x }` |

### 2.1 Numbers

Numbers are IEEE-754 doubles. Consequences:

* `0.1 + 0.2` is `0.30000000000000004`.
* Integers are exact only up to 2^53.
* There are no separate integer and floating-point types.
* `NaN`, `Infinity` and `-Infinity` can be produced by arithmetic
  (`1/0` is a *runtime error*, but `0/0`-style results from operations like
  `sqrt`-free expressions may still be `NaN`; `print` renders them as
  `NaN`, `Infinity`, `-Infinity`).

### 2.2 Strings

* Double-quoted only. A raw newline inside a literal is an error; write `\n`.
* Escapes: `\n \t \r \0 \\ \" \' \b \f \v \uXXXX \u{...}`.
* Strings are immutable. `s[0] = "x"` is a runtime error.

### 2.3 Equality

`==` performs **structural** comparison and never coerces:

* `1 == "1"` → `false` (different types)
* `1 == 1.0` → `true`
* `[1, [2]] == [1, [2]]` → `true`
* `{ "a": 1 } == { "a": 1 }` → `true`
* Functions compare by identity.

`!=` is the negation of `==`.

### 2.4 Truthiness

**Only `false` and `null` are falsy.** Everything else — including `0`, `""`,
`[]` and `{}` — is truthy.

```typ
if 0 { print("runs") }   // prints, because 0 is truthy
```

Use the explicit `bool(value)` built-in when a truthiness conversion is
intended.

### 2.5 Conversion

Conversion is **always explicit**. There is no implicit coercion anywhere.

| From | To | How |
| --- | --- | --- |
| number | string | `str(1.5)` → `"1.5"` |
| string | number | `num("42")` → `42` (fails on non-numeric text) |
| boolean | number | `num(true)` → `1` |
| number | boolean | `bool(0)` → `true` |
| any | string | `str(value)` |

---

## 3. Variables

```typ
let name = "Typhoun"     // mutable binding
const author = "Typhoun Project"   // immutable binding
```

* Every binding must be initialized at its declaration.
* Both `let` and `const` are **block scoped**.
* Reading a name before its declaration in the same block is an error
  (temporal dead zone), reported by the semantic analyzer. Assigning to that
  name counts too — including compound assignment, which reads it first — so
  `x = 1` above `let x = 2` is rejected rather than meaning one thing in the
  tree-walker and another in the bytecode engine.
* Assigning to a `const` (or to a function name) is a semantic error.

```typ
{ let x = 1
  print(x) }     // ok
print(x)         // error: Undefined variable 'x'
```

---

## 4. Operators

| Precedence (low → high) | Operators | Associativity |
| --- | --- | --- |
| 1 | `=` `+=` `-=` `*=` `/=` | right |
| 2 | `or` | left |
| 3 | `and` | left |
| 4 | `==` `!=` | left |
| 5 | `<` `<=` `>` `>=` | left |
| 6 | `+` `-` | left |
| 7 | `*` `/` `%` | left |
| 8 | `not` `-` (unary) | right |
| 9 | `f(x)` `a[i]` `a.key` | left |

### 4.1 Arithmetic

* `+`, `-`, `*`, `/`, `%`, unary `-` require **numbers on both sides**.
* The single exception is `+`, which concatenates when **both** operands are
  strings.
* Mixing types is a runtime error: `1 + "1"` fails with `TYP4001`.
* `/` and `%` by zero raise `TYP4002: Division by zero`.

### 4.2 Comparison

`<` `<=` `>` `>=` require numbers on both sides. Strings are compared only
with `==` / `!=`.

### 4.3 Logical operators

`and`, `or` and `not` operate on truthiness and **short-circuit**:

* `a and b` evaluates `b` only when `a` is truthy; the result is `a` or `b`.
* `a or b` evaluates `b` only when `a` is falsy; the result is `a` or `b`.
* `not a` always returns a boolean.

### 4.4 Assignment

`=` assigns; `+=`, `-=`, `*=` and `/=` are compound forms that evaluate the
target's container and key exactly once:

```typ
let a = [1]
a[0] += 4      // a is now [5]

let m = { "n": 1 }
m["n"] *= 10   // m["n"] is now 10
```

Assignment targets are variable names and index expressions. `a.key = v` is
also allowed because `a.key` desugars to `a["key"]`.

---

## 5. Control flow

```typ
if score >= 90 {
    print("Excellent")
} else if score >= 70 {
    print("Good")
} else {
    print("Keep learning")
}
```

* `if` conditions accept any value and use truthiness.
* Braces are mandatory; there is no brace-less form.
* `while`, `for ... in ...` and C-style `for (init; test; update)` loops are
  supported.
* `break` exits the innermost loop; `continue` starts its next iteration.
* Both are errors outside a loop.

```typ
for fruit in ["apple", "mango"] { print(fruit) }
for (let i = 0; i < 3; i += 1) { print(i) }
```

The `for ... in ...` form iterates arrays (elements), maps (keys) and strings
(code points).

### 5.1 Recovering from a runtime error

```typ
try {
    print(risky())
} catch err {
    print(err.code, err.message)
}
```

* `try` runs its block. If a **catchable** error is raised anywhere inside it —
  including inside a function it calls — the handler runs with the error value
  bound to the name after `catch`.
* The error name is an ordinary `let` binding scoped to the handler block: it
  may be assigned to and may shadow an outer binding.
* The guarded block is a scope of its own, so nothing it declares reaches the
  handler, and nothing the handler declares outlives the statement.
* `return`, `break` and `continue` are **not** confined by a `try`. A handler
  finishes the *statement*, not the loop or the function, so the surrounding
  context is unchanged.
* A handler that fails is handled by the enclosing `try`, if there is one.
* Only runtime errors (`TYP4xxx`) are caught; see §9.1 below.

---

## 6. Functions

```typ
fn greet(name) {
    return "Hello, " + name + "!"
}
print(greet("Young Jay"))
```

* Parameters are positional; the argument count must match exactly.
* A function without an executed `return` evaluates to `null`.
* Function declarations are **hoisted** within their block, so mutual
  recursion works.
* Functions are first-class values, may be nested, and capture their
  defining environment (lexical closures).

```typ
fn counter(start) {
    let n = start
    return fn (step) { n += step
        return n }
}
let c = counter(0)
print(c(1), c(2))   // 1 3
```

An expression form `fn (a) { ... }` creates an anonymous function; it may be
named (`fn fact(n) { ... }`) to refer to itself recursively.

---

## 7. Collections

### 7.1 Arrays

* Zero-indexed, ordered, mutable, allowing mixed element types.
* `len(a)`, `a[i]`, `a[i] = v`, `push(a, v)`, `pop(a)`, `has(a, i)`.
* Out-of-range or non-integer indices raise `TYP4005` / `TYP4008`.
* Negative indices are **not** supported.

### 7.2 Maps

* Keys are strings, numbers, booleans or `null`. Keys are compared by value
  and type: `1` and `"1"` are different keys.
* Insertion order is preserved by `keys()` and iteration.
* Reading a missing key returns `null` rather than failing.
* `len(m)`, `m[k]`, `m[k] = v`, `has(m, k)`, `remove(m, k)`, `keys(m)`,
  `values(m)`.

### 7.3 Member access

`expr.name` is sugar for `expr["name"]`:

```typ
let user = { "name": "Jay" }
print(user.name)   // Jay
```

---

## 8. Modules

```typ
import "math.typ"          // merges the module's exports into this scope
import "math.typ" as math  // binds the namespace instead

print(add(10, 20))         // merged form
print(math.multiply(6, 7)) // namespace form
```

* Paths are resolved relative to the **importing file**.
* Imports must end in `.typ` and live inside the project root (by default the
  directory of the entry file). Escaping the root is an error.
* Every top-level `let`, `const` and `fn` of a module is exported.
* A module body executes **once**; later imports reuse the cached result.
* Import cycles are detected and reported (`TYP5003`) instead of looping.

---

## 9. Errors

Errors are structured diagnostics carrying an error code, a phase, a source
location, a rendered source excerpt and, where useful, a suggested fix.

```
error[TYP3001]: Undefined variable 'username'
  --> main.typ:4:7
   |
 4 | print(username)
   |       ^^^^^^^^
   |
   = help: Declare 'username' before using it, or check for a typo.
```

### 9.1 Recovering from an error

A runtime error is also a *value*. `try { ... } catch err { ... }` runs the
handler when the guarded block fails, and binds the error to a map:

```typ
const readings = [4, 8, 15]
try {
    print(readings[4])
} catch err {
    print(err.code)              // TYP4005
    print(err.message)           // Index 4 is out of bounds for length 3
    print(err.phase)             // runtime
    print(err.location.line)     // 3
    print(err.location.column)   // 11
    print(err.help)              // Valid indices are 0 through 2.
    print(len(err.stack))        // 0 — call frames, innermost first
}
```

| Field | Value |
| --- | --- |
| `code` | the diagnostic code, e.g. `TYP4005` |
| `message` | the same one-line message the diagnostic carries |
| `phase` | `runtime` |
| `location` | `{ "file", "line", "column" }`, or `null` when the error has no source position |
| `help` | the suggested fix, or `null` |
| `stack` | call frames, innermost first, as `"name (file:line:column)"` |

Every field is a Typhoun value — the map can be printed, compared, stored in a
collection and passed to a function like any other — and the map deep-compares
equal to another with the same contents, so a program can build one and match
against it.

The `stack` field records the calls that were in flight, innermost first, at the
point of the failure. A failure at the top level has an empty stack, and the
frames of calls that were abandoned on the way to a handler are included.

### 9.2 What a handler can and cannot catch

Only the runtime family is catchable:

| Range | Phase | Catchable with `try`/`catch` |
| --- | --- | --- |
| `TYP1xxx` | lexical | no — the program never runs |
| `TYP2xxx` | syntax | no — the program never runs |
| `TYP3xxx` | semantic | no — the program never runs |
| `TYP4xxx` | runtime | **yes** |
| `TYP5xxx` | import / module | no — a module is loaded before the program runs |
| `TYP6xxx` | resource limit | no — see §10 and [security-model.md](security-model.md) |

A handler may decide what to do about a *failing program*; it may not hide a
*failing load* or the *sandbox*. Both pass straight through a `try`, which is
what makes `catch` safe in a program you did not write: it can never be used to
spend past the step, depth, time, output, collection or source budget.

See [diagnostics.md](diagnostics.md) for the full code table.

---

## 10. Resource limits

Untrusted programs run under configurable limits enforced by the interpreter:
step count, call depth, wall-clock time, output characters, collection size,
source size and module count. Exceeding a limit raises a `TYP6xxx` diagnostic,
which stops the program. A `catch` handler is **never** given a limit error, so
no program can swallow its own budget; see
[security-model.md](security-model.md).

---

## 11. Known limitations (v0.1)

These are **not** implemented and are not claimed to be:

* No static type system or type inference. Types are checked as programs run.
* No `finally`, no bare `catch`, and no way to raise a custom error value from
  a program: an error value can be inspected and re-checked, but only the
  runtime raises one (`assert` is the built-in way to raise your own).
* No classes, interfaces or methods.
* No native code generation; execution is a bytecode virtual machine (the
  default) or a tree-walking interpreter (`--engine tree`), and the two are
  required to agree.
* No concurrency or async primitives.
* No package manager; modules are local files only.
* `for ... in` over a map yields keys, not entries.
* No garbage collector; memory is reclaimed by the host JavaScript engine.
