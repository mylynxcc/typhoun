# Typhoun Security Model — v0.1

Typhoun treats every `.typ` program as **untrusted input**. This document
states exactly which boundaries the implementation enforces, how, and what it
does *not* claim.

---

## 1. Threat model

A hostile Typhoun program is assumed to attempt:

* reading or writing files outside the project,
* executing shell commands,
* reaching the network,
* reading environment variables or application secrets,
* consuming unbounded CPU, memory, output or recursion,
* inspecting or mutating host objects (reflection, prototype access).

---

## 2. Enforced boundaries

### 2.1 No host evaluation, no shell

The interpreter is a tree-walking evaluator over Typhoun AST nodes. It never
calls `eval`, `Function`, `vm`, `child_process`, or any shell. There is no
"foreign function" escape hatch in v0.1.

### 2.2 No ambient standard library

Only the functions listed in [standard-library.md](standard-library.md) are
reachable. They are installed explicitly into the global environment, and
`tests/integration/security.test.js` asserts that names such as `eval`,
`require`, `process`, `fetch`, `readFile` and `constructor` are **not**
defined as Typhoun globals.

Indexing a number or string does not expose host prototypes: it raises
`TYP4001` instead of returning a host property.

### 2.3 Filesystem: project-rooted, read-only

* The only file access is **module loading**.
* Import paths resolve relative to the importing file.
* A resolved path must:

  * end in `.typ`,
  * exist,
  * and lie **inside the project root** (by default the directory of the entry
    file, overridable with `--root`).

  Escaping the root raises `TYP5002 MODULE_OUT_OF_BOUNDS`.
* Programs can never *write* files; no built-in opens a path for writing.
* A program cannot import a module that the entry program could not already
  reach; module discovery and semantic validation happen before execution.

### 2.4 No network, no environment, no clock-based abuse

There is no network or environment built-in. The only nondeterministic
built-in is `random()`, which uses the host PRNG and is explicitly documented
as non-cryptographic.

### 2.5 Input is opt-in

`input()` fails with `TYP4012` unless the host supplies an input channel *and*
`limits.allowInput` is true. The CLI exposes `--no-input` to turn it off.

### 2.6 Resource limits

Enforced by `src/runtime/context.js` and checked on every evaluated node:

| Limit | Default | Error |
| --- | --- | --- |
| `maxSourceBytes` | 1,000,000 | `TYP6006` |
| `maxSteps` | 5,000,000 | `TYP6001` |
| `maxCallDepth` | 512 | `TYP6002` |
| `maxDurationMs` | 10,000 | `TYP6003` |
| `maxOutputChars` | 4,000,000 | `TYP6004` |
| `maxCollectionSize` | 1,000,000 | `TYP6005` |
| `maxModules` | 64 | `TYP6005` |

The wall clock is sampled every 1024 steps, so a program cannot spin in a tight
loop without being observed. Limits are configurable per run through the CLI
(`--max-steps`, `--max-depth`, `--max-ms`, `--output-limit`) or the API.

### 2.7 `catch` cannot weaken a boundary

`try { ... } catch err { ... }` recovers from a *runtime* error (`TYP4xxx`)
only, and that restriction is a security property rather than a language
detail:

* **Limits stay hard stops.** A resource limit (`TYP6xxx`) is never handed to a
  handler, so a program cannot catch `TYP6001`–`TYP6006` and carry on: every
  limit in the table above still ends the run, and it is enforced in the shared
  `ExecutionContext` both engines use.
* **Load failures stay load failures.** A module failure (`TYP5xxx`) is decided
  before execution and is never handed to a handler, so a `try` cannot probe
  for files, swallow an out-of-bounds import, or continue with a half-loaded
  program.
* **The caught value is data, not an object.** A handler receives the same
  fields as the rendered diagnostic — `code`, `message`, `phase`, `location`,
  `help` and Typhoun call frames — as plain maps, strings, numbers and arrays.
  It carries no host object, no host stack trace and no environment data.
* **`catch` grants no new capability.** It is not a way to run a block twice,
  to raise a value of the program's choosing, or to read anything the program
  could not already see; the guarded block is a scope of its own and adds no
  names.

`tests/integration/security.test.js` asserts each of these, including that a
guarded runaway loop and a guarded runaway recursion still stop with `TYP6001`
and `TYP6002`, and that the handler prints nothing when they do.

### 2.8 Errors never leak host internals

Runtime failures are converted to structured diagnostics. Unexpected host
errors are reported as an internal error and do not expose program-visible
host state. Diagnostics contain file paths (which the operator already knows)
but never environment variables or secret values.

---

## 3. What this model does **not** claim

* **No operating-system isolation.** The interpreter runs *in-process* inside
  the host Node.js runtime. A defect in the engine, or a future native
  add-on, could in principle be exploited. For genuinely hostile input,
  combine Typhoun with OS-level sandboxing (a container, a restricted user,
  `seccomp`/`landlock`, a VM) and a hard wall-clock kill from the supervisor.
* **No memory accounting.** `maxCollectionSize` bounds element counts, not
  bytes; a program can still allocate large strings within `maxOutputChars`.
  There is no custom garbage collector — the host reclaims memory.
* **No per-capability permissions yet.** Every program gets exactly the same
  capabilities. An opt-in capability model (filesystem, network, timers) is
  roadmap work for a later release.
* **`random()` is not cryptographic.**
* **Module root is a policy, not a jail.** Symlinked directories inside the
  root are followed by the host; do not place secrets inside the module root.

---

## 4. Operating recommendations

1. Run untrusted programs under a dedicated, unprivileged OS user.
2. Set `--root` to a directory containing **only** the program's sources.
3. Keep the source-size, step, depth, output and time limits tight for
   multi-tenant execution.
4. Prefer `--no-input` for automated pipelines.
5. Treat diagnostics as data, not as HTML, when surfacing them in a UI.
