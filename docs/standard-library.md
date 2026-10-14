# Typhoun Standard Library — v0.1

Every function below is a **built-in**: it is implemented by the Typhoun
runtime in `src/builtins/`, argument-checked, and documented at its definition
site. Host functions are never exposed automatically.

Failure behaviour is uniform: a wrong argument count raises `TYP4004`
(arity mismatch) and a wrong argument type raises `TYP4012` (bad native
argument), unless a more specific code is listed.

---

## Core

### `print(value, ...)`

* **Arity:** 1 or more.
* **Returns:** `null`.
* **Behaviour:** writes the display form of each argument, separated by a
  single space, followed by a newline. Output counts against the output limit.
* Strings print unquoted; nested strings inside arrays/maps are quoted.

```typ
print("Hello", "Typhoun", 42)   // Hello Typhoun 42
```

### `input(prompt?)`

* **Arity:** 0 or 1.
* **Returns:** `string` — one line without its trailing newline.
* **Failure:** `TYP4012` when input is disabled for the execution environment.
* **Behaviour:** when `prompt` is given it is written to output first (no
  newline).

### `len(value)`

* **Arity:** 1.
* **Returns:** `number` — UTF-16 length for strings, element count for arrays,
  entry count for maps.
* **Failure:** `TYP4012` for any other type.

### `type(value)`

* **Arity:** 1.
* **Returns:** `string` — one of `"number"`, `"string"`, `"boolean"`,
  `"null"`, `"array"`, `"map"`, `"function"`.

### `str(value)`

* **Arity:** 1.
* **Returns:** `string` — the display form of any value.

### `num(value)`

* **Arity:** 1.
* **Returns:** `number`.
* **Behaviour:** numbers pass through; booleans become `1`/`0`; numeric strings
  (optionally signed, with fraction and exponent) are parsed.
* **Failure:** `TYP4012` for other types or non-numeric strings.

### `bool(value)`

* **Arity:** 1.
* **Returns:** `boolean` — `false` only for `false` and `null`.

### `range(end)` / `range(start, end)`

* **Arity:** 1 or 2.
* **Returns:** `array` of integers from `start` (inclusive) to `end`
  (exclusive). `start` defaults to `0`.
* **Failure:** `TYP4012` on non-integers or `end < start`.

### `assert(condition, message?)`

* **Arity:** 1 or 2.
* **Returns:** `null`.
* **Failure:** `TYP4010` when `condition` is falsy, using `message` or a
  default text. The failure is catchable — see
  [language-spec.md](language-spec.md) §9.1.

---

## Arrays

### `push(array, value)`

* **Arity:** 2. **Mutates.** Returns the array (for chaining).

### `pop(array)`

* **Arity:** 1. **Mutates.** Returns the removed last element.
* **Failure:** `TYP4012` on an empty array.

### `has(array, index)` / `has(map, key)`

* **Arity:** 2. Returns `boolean` without failing for out-of-range/absent keys.

---

## Maps

### `keys(map)` / `values(map)`

* **Arity:** 1. Returns a **new** array in insertion order.

### `remove(map, key)`

* **Arity:** 2. **Mutates.** Returns `boolean` — whether an entry was removed.

---

## Strings and collections

### `join(array, separator)`

* **Arity:** 2. Returns `string`: the display forms of the elements joined by
  `separator`.

### `split(string, separator)`

* **Arity:** 2. Returns `array` of substrings. An empty separator splits into
  individual code points.

### `upper(string)`, `lower(string)`, `trim(string)`

* **Arity:** 1 each. Return a new string.

### `contains(string, substring)` / `contains(array, value)`

* **Arity:** 2. Returns `boolean`. Array membership uses structural equality.

---

## Mathematics

| Function | Arity | Returns | Notes |
| --- | --- | --- | --- |
| `abs(n)` | 1 | number | absolute value |
| `floor(n)` | 1 | number | largest integer ≤ `n` |
| `ceil(n)` | 1 | number | smallest integer ≥ `n` |
| `round(n)` | 1 | number | nearest integer |
| `sqrt(n)` | 1 | number | fails (`TYP4012`) for negative input |
| `pow(base, exp)` | 2 | number | base raised to exp |
| `min(a, b, ...)` | 1+ | number | also accepts a single array |
| `max(a, b, ...)` | 1+ | number | also accepts a single array |
| `random()` | 0 | number | pseudo-random in `[0, 1)`; not cryptographically secure |

---

## Not provided (by design)

Typhoun **deliberately does not** expose any of the following:

`eval`, `require`, module access from the filesystem beyond the project root,
process/environment access, shell execution, network access, timers,
reflection, or prototype access. See [security-model.md](security-model.md).

---

## Adding a built-in

1. Implement it in the appropriate file under `src/builtins/`
   (`core.js`, `strings.js`, `math.js`).
2. Use the `expect*` helpers from `src/builtins/helpers.js` for every argument.
3. Add its name to `BUILTIN_NAMES` in `src/builtins/index.js` **and** to
   `GLOBALS` in `src/semantic/resolver.js` so the resolver accepts it.
4. Document it here and cover it in `tests/runtime/interpreter.test.js`.
