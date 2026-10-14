# Getting Started with Typhoun

**Typhoun — Write boldly. Build anything.**

This tutorial takes you from installation to a running multi-file program.

---

## 1. Requirements

* **Node.js 20 or newer** (developed and tested on Node.js 22).
* No build step, no external dependencies. The engine is plain ES modules.

Check your version:

```bash
node --version
```

---

## 2. Install

From the project root:

```bash
# run the CLI directly
node bin/typhoun.js version

# or install the `typhoun` command locally
npm link
typhoun version
```

Without `npm link`, every command below works as `node bin/typhoun.js <command>`.

---

## 3. Your first program

Create `hello.typ`:

```typ
let name = "Typhoun"
print("Hello, " + name + "!")
```

Run it:

```bash
typhoun run hello.typ
```

```text
Hello, Typhoun!
[Typhoun] program finished in 1 ms (21 steps)
```

(The summary line goes to stderr; add `-q` to silence it.)

---

## 4. Variables and types

```typ
let mutable = 10        // can be reassigned
const fixed = "text"    // cannot be reassigned

let n = 1.5             // number  (IEEE-754 double)
let s = "text"          // string
let b = true            // boolean
let nothing = null      // null
let list = [1, 2, 3]    // array
let map = { "k": 1 }    // map

print(type(n), type(s), type(b), type(nothing), type(list), type(map), type(print))
```

Typhoun never converts types implicitly:

```typ
print(1 + "1")     // error[TYP4001]: Operator '+' requires two strings or two numbers
print(1 + num("1"))  // 2
```

---

## 5. Control flow

```typ
let score = 85

if score >= 90 {
    print("Excellent")
} else if score >= 70 {
    print("Good")
} else {
    print("Keep learning")
}

for i in range(5) {
    print(i)
}

let n = 0
while n < 3 {
    print("loop", n)
    n += 1
}
```

### Recovering from an error

```typ
const values = [1, 2, 3]
try {
    print(values[9])
} catch err {
    print(err.code)             // TYP4005
    print(err.message)          // Index 9 is out of bounds for length 3
    print(err.location.line)    // 3
    print(err.help)             // Valid indices are 0 through 2.
}
```

`err` is a plain map, so it can be printed, stored and passed around. Only
runtime errors are caught; what a handler cannot catch, and why, is in the
[language specification](language-spec.md) §9.2.

---

## 6. Functions and closures

```typ
fn greet(name) {
    return "Hello, " + name + "!"
}

print(greet("Young Jay"))

fn counter(start) {
    let n = start
    return fn (step) { n += step
        return n }
}

let c = counter(0)
print(c(1), c(2), c(3))   // 1 3 6
```

---

## 7. Collections

```typ
let fruits = ["apple", "mango", "orange"]
push(fruits, "kiwi")
print(len(fruits), fruits[0], fruits)

let user = { "name": "Jay", "level": 7 }
user.level += 1
print(user.name, user["level"], keys(user))
```

---

## 8. Modules

`math.typ`:

```typ
const PI = 3.14159

fn circleArea(r) {
    return PI * r * r
}
```

`main.typ`:

```typ
import "math.typ"

print(circleArea(2))
```

```bash
typhoun run main.typ
```

Imports are relative to the importing file and confined to the project root.

---

## 9. Inspecting the pipeline

```bash
typhoun check  main.typ     # lexical + syntax + semantic checks, no execution
typhoun tokens main.typ     # token stream with line:column positions
typhoun ast    main.typ     # indented abstract syntax tree
typhoun fmt    main.typ     # rewrite it in the canonical style
ntyphoun lint   main.typ     # report dead, redundant or misleading code
typhoun repl                # interactive session (:quit to exit)
```

`fmt` and `lint` are covered in [tooling.md](tooling.md).

---

## 10. Reading errors

Errors show the file, position and a caret under the offending source:

```text
error[TYP3001]: Undefined variable 'username'
  --> main.typ:4:7
    |
  4 | print(username)
    |       ^^^^^^^^
    |
  = help: Declare 'username' before using it, or check for a typo.
```

Run `typhoun check *.typ` in CI: it exits with code `1` when anything is wrong.
Add `typhoun fmt --check .` to prove the layout is canonical, and
`typhoun lint --strict .` to fail on lint warnings too.

---

## 11. Sandbox controls

```bash
typhoun run untrusted.typ \
  --root ./sandbox \
  --max-steps 100000 \
  --max-depth 64 \
  --max-ms 1000 \
  --output-limit 10000 \
  --no-input
```

See [security-model.md](security-model.md) for what is and is not guaranteed.

---

## 12. Next steps

* Read the full [language specification](language-spec.md).
* Browse the [standard library](standard-library.md).
* Look at `examples/` — every file there runs.
* Try the exercises: write a word counter, a prime sieve, or a tiny JSON
  pretty-printer using `split`, `join` and `padStart`-style string building.
