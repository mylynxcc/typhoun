/**
 * Stage F₂ — Stack-based virtual machine.
 *
 * Executes the bytecode produced by `src/compiler/compiler.js`. It is a
 * second, independent backend for the same language: it shares the value
 * representation, the standard library, the module loader, the diagnostic
 * system and the resource limits with the tree-walking interpreter, but not a
 * single line of its control flow.
 *
 * Design notes
 * ------------
 *  - One shared value stack and a per-frame `base` pointer. Locals live at
 *    `base + slot`; temporaries grow above them and are always balanced at
 *    statement boundaries.
 *  - Closures capture *upvalues*: references to frame slots that are closed
 *    (copied into the upvalue) as soon as the declaring scope ends, so a
 *    variable re-declared on each loop iteration gets a fresh cell — the same
 *    semantics the tree-walker gets from allocating an environment per block.
 *  - Globals resolve through the lexical `Environment`, which is what keeps
 *    module namespaces separate and lets the module loader export bindings.
 *  - Resource limits, output limits and the call-stack trace come from the
 *    shared `ExecutionContext`, so both engines report identical diagnostics.
 *
 * Performance
 * -----------
 *  The interpreter loop keeps the stack pointer in a local variable and only
 *  writes it back before anything that can observe it (a call, a module load,
 *  or a return). The step counter is incremented inline and the wall-clock
 *  check only runs every few thousand instructions, so the common instructions
 *  cost one switch dispatch plus a push or a pop. `docs/bytecode.md` records
 *  the measured effect of both decisions.
 */
import { NodeType } from "../ast/nodes.js";
import { OP, BINDING_KINDS } from "../bytecode/opcodes.js";
import { compileProgram } from "../compiler/compiler.js";
import { SourceManager } from "../source/source-manager.js";
import { Environment } from "../runtime/environment.js";
import { ExecutionContext } from "../runtime/context.js";
import { RuntimeFault, isCatchableFault, errorValueOf } from "../runtime/errors.js";
import { Code } from "../diagnostics/codes.js";
import {
  NULL,
  TArray,
  TMap,
  TClosure,
  TFunction,
  TNativeFunction,
  typeOf,
  isTruthy,
  equals,
} from "../runtime/values.js";
import { applyBinaryOperator, applyUnaryOperator } from "../runtime/operators.js";
import { getIndexValue, setIndexValue, iterableItems } from "../runtime/indexing.js";
import { installBuiltins } from "../builtins/index.js";

/** Instructions between wall-clock checks: same cadence as the interpreter. */
const STEP_CHECK_MASK = 0x3ff;

const COMPARISON_TEXT = Object.freeze({
  [OP.LT]: "<",
  [OP.LE]: "<=",
  [OP.GT]: ">",
  [OP.GE]: ">=",
});

const LITERAL_OPS = new Map([
  [OP.ADD, "+"],
  [OP.SUB, "-"],
  [OP.MUL, "*"],
  [OP.DIV, "/"],
  [OP.MOD, "%"],
  [OP.LT, "<"],
  [OP.LE, "<="],
  [OP.GT, ">"],
  [OP.GE, ">="],
]);

/** A captured variable cell. Open cells read the frame slot; closed cells own the value. */
class Upvalue {
  constructor(stack, index) {
    this.stack = stack;
    this.index = index;
    this.value = NULL;
    this.closed = false;
  }

  get() {
    return this.closed ? this.value : this.stack[this.index];
  }

  set(value) {
    if (this.closed) this.value = value;
    else this.stack[this.index] = value;
  }

  close() {
    if (this.closed) return;
    this.value = this.stack[this.index];
    this.closed = true;
  }
}

/**
 * Iteration state for `for ... in`. The elements are snapshotted up front,
 * which is what lets a program mutate an array while iterating it and still see
 * the same sequence — the tree-walking interpreter behaves identically.
 * Instances only ever live in a frame slot; no Typhoun operation can observe one.
 */
class IterState {
  constructor(items) {
    this.items = items;
    this.index = 0;
  }
}

export class VirtualMachine {
  /**
   * @param {object} [options]
   * @param {SourceManager} [options.sourceManager]
   * @param {ExecutionContext} [options.context]
   * @param {object|null} [options.moduleSystem]
   */
  constructor(options = {}) {
    this.sourceManager = options.sourceManager ?? new SourceManager();
    this.context = options.context ?? new ExecutionContext();
    this.moduleSystem = options.moduleSystem ?? null;
    /** @type {string|null} */
    this.currentFile = null;
    /** @type {unknown[]} */
    this.stack = [];
    this.sp = 0;
    /** @type {object[]} */
    this.frames = [];
    /** Number of nested user function calls, for the depth limit. */
    this.callDepth = 0;
    /** @type {Map<number, Upvalue>} */
    this.openUpvalues = new Map();
    /** @type {WeakMap<object, object>} */
    this.chunkCache = new WeakMap();
    /** Prototype of the most recently executed chunk (tooling/tests). */
    this.lastProto = null;
    /** Value returned by the most recent top-level chunk (used by the REPL). */
    this.lastResult = NULL;
  }

  // ------------------------------------------------------------ host surface

  /** Build a fresh global environment with the standard library installed. */
  createGlobalEnvironment() {
    const env = new Environment(null);
    installBuiltins(env, this);
    return env;
  }

  /**
   * Compile (once) and run a program.
   * @param {object} program Program AST node
   * @param {object} [options]
   * @param {string} [options.file]
   * @param {Environment} [options.env]
   * @returns {{value: unknown, context: ExecutionContext, env: Environment}}
   */
  run(program, options = {}) {
    const env = options.env ?? this.createGlobalEnvironment();
    const previousFile = this.currentFile;
    if (options.file) this.currentFile = options.file;
    try {
      const proto = this.protoFor(program, options.file ?? "<script>");
      this.lastResult = NULL;
      this.executeChunk(proto, env);
    } finally {
      this.currentFile = previousFile;
    }
    return { value: this.lastResult, context: this.context, env };
  }

  /**
   * Evaluate a single expression against an existing global scope and return
   * its value. Used by the REPL so both engines can echo results.
   */
  evaluate(expression, env) {
    const program = {
      type: NodeType.Program,
      loc: expression.loc ?? null,
      body: [{ type: NodeType.ReturnStmt, loc: expression.loc ?? null, argument: expression }],
    };
    const proto = compileProgram(program, { name: "<repl-expression>" });
    this.lastResult = NULL;
    this.executeChunk(proto, env);
    return this.lastResult;
  }

  /**
   * ModuleLoader-compatible entry point: run a module body with `env` as its
   * global scope.
   */
  executeStatements(body, env) {
    const program = { type: NodeType.Program, loc: null, body };
    const proto = this.protoFor(program, this.currentFile ?? "<module>");
    this.executeChunk(proto, env);
  }

  /**
   * Function declarations are hoisted by the compiler into the top of their
   * scope, so the loader has nothing to do here. Kept for interface parity.
   */
  hoistFunctions() {}

  /** Compile a program, memoising the result on the AST node. */
  protoFor(program, name) {
    let proto = this.chunkCache.get(program);
    if (!proto) {
      proto = compileProgram(program, { name });
      this.chunkCache.set(program, proto);
    }
    this.lastProto = proto;
    return proto;
  }

  // ------------------------------------------------------------ frame control

  top() {
    return this.frames[this.frames.length - 1];
  }

  /** Friendly call trace, formatted exactly like `ExecutionContext.stackFrames`. */
  vmStackFrames() {
    const out = [];
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i];
      if (!frame.tracked) continue;
      const where = frame.callLoc
        ? `${frame.callLoc.file}:${frame.callLoc.line}:${frame.callLoc.column}`
        : "<unknown>";
      out.push(`${frame.closure.proto.name || "<anonymous>"} (${where})`);
    }
    return out;
  }

  /** Run a chunk as a fresh top-level frame. Supports re-entrant module loads. */
  executeChunk(proto, globals) {
    const startDepth = this.frames.length;
    const startSp = this.sp;
    const base = this.sp;
    this.frames.push({
        closure: new TClosure(proto, [], globals),
        ip: 0,
        base,
        returnSlot: base,
        tracked: false,
        callLoc: null,
        handler: null,
      });
    try {
      this.dispatch(startDepth + 1);
    } catch (err) {
      if (err instanceof RuntimeFault) {
        const frame = this.top();
        if (!err.loc && frame) err.loc = frame.closure.proto.locs[frame.ip - 1] ?? null;
        if (err.typhounStack.length === 0) err.typhounStack = this.vmStackFrames();
      }
      this.unwindTo(startDepth, startSp);
      throw err;
    }
    this.sp = startSp;
  }

  /**
   * Try to hand a fault to a `catch` handler.
   *
   * Walks the active frames from the innermost outwards. A frame that is
   * inside a `try` region has a handler on its stack (pushed by `TRY_BEGIN`,
   * popped by `TRY_END` or by leaving the region), which records where the
   * handler lives, which slot the error value belongs in and how deep the
   * value stack was when the region opened. Frames without a handler are
   * unwound exactly as a `RETURN` would, so upvalues close and the call depth
   * stays honest.
   *
   * @param {RuntimeFault} fault
   * @param {number} floor Frame depth that must not be unwound past.
   * @returns {boolean} true when the fault was caught and execution resumes.
   */
  recover(fault, floor) {
    if (!isCatchableFault(fault)) return false;

    // The frame this call to `dispatch` owns sits at `floor - 1`; it is part of
    // this dispatch context, so it can catch, but if nothing catches the fault
    // the stack is left untouched for `executeChunk` to unwind and report.
    const lowest = floor - 1;
    let target = -1;
    for (let index = this.frames.length - 1; index >= lowest; index -= 1) {
      if (this.frames[index].handler) {
        target = index;
        break;
      }
    }
    if (target < 0) return false;

    // The call stack for the error value. A fault that escaped an inner
    // dispatch (a module body, say) already recorded the frames it unwound
    // through; otherwise the frames are still standing and this is the stack at
    // the point of the error. The tree-walker applies the same rule, so both
    // engines report the same list.
    const stack =
      fault.typhounStack.length > 0 ? fault.typhounStack : this.vmStackFrames();

    // Calls between the fault and its handler are abandoned the way a RETURN
    // would abandon them, so upvalues close and the call depth stays honest.
    while (this.frames.length - 1 > target) {
      const abandoned = this.frames[this.frames.length - 1];
      this.closeUpvalues(abandoned.base);
      if (abandoned.tracked) this.callDepth -= 1;
      this.frames.pop();
    }

    const frame = this.frames[target];
    const handler = frame.handler;
    frame.handler = handler.prev;
    this.closeUpvalues(handler.sp);
    this.sp = handler.sp;
    frame.ip = handler.target;
    this.stack[frame.base + handler.slot] = errorValueOf(fault, stack);
    return true;
  }

  unwindTo(depth, sp) {
    while (this.frames.length > depth) {
      const frame = this.frames.pop();
      this.closeUpvalues(frame.base);
      if (frame.tracked) this.callDepth -= 1;
    }
    this.sp = sp;
  }

  captureUpvalue(index) {
    let upvalue = this.openUpvalues.get(index);
    if (!upvalue) {
      upvalue = new Upvalue(this.stack, index);
      this.openUpvalues.set(index, upvalue);
    }
    return upvalue;
  }

  /** Close every open upvalue referring to a slot at or above `from`. */
  closeUpvalues(from) {
    if (this.openUpvalues.size === 0) return;
    for (const [index, upvalue] of this.openUpvalues) {
      if (index >= from) {
        upvalue.close();
        this.openUpvalues.delete(index);
      }
    }
  }

  // --------------------------------------------------------------- main loop

  /**
   * Run bytecode until the frame that started at depth `floor` returns.
   *
   * A runtime fault does not always mean the end of the program: when the
   * failing frame (or one of its callers) has an active `try` region, the VM
   * restores that frame's value stack, parks the error value in the catch
   * binding's slot and resumes inside the same dispatch context.
   *
   * @param {number} floor Frame depth below which this call stops.
   */
  dispatch(floor) {
    for (;;) {
      try {
        this.dispatchLoop(floor);
        return;
      } catch (err) {
        if (!(err instanceof RuntimeFault) || !this.recover(err, floor)) throw err;
        // Recovery starts a fresh invocation of the loop, so the wall clock
        // has to be checked here as well as inside it: a program that catches
        // its way through a long run must not be able to outlast the budget.
        this.context.checkTime(err.loc ?? null);
      }
    }
  }

  /**
   * The instruction loop itself: one flat switch over the current frame's
   * code, spanning every frame it calls into.
   *
   * @param {number} floor Frame depth below which this call stops.
   */
  dispatchLoop(floor) {
    let frame = this.frames[this.frames.length - 1];
    let closure = frame.closure;
    let proto = closure.proto;
    let code = proto.code;
    let locs = proto.locs;
    // `proto.constants`, `frame.base` and `closure.globals` are read by most
    // instructions in a loop like `while i < n { total += i }`. The dispatch
    // loop cannot afford a property read per operand — measured on
    // `benchmarks/loop.typ`, those reads were the largest single cost in the
    // optimised code (docs/bytecode.md) — so they live in locals and are
    // refreshed below wherever the frame, prototype or closure changes.
    let constants = proto.constants;
    let base = frame.base;
    let globals = closure.globals;
    let sp = this.sp;
    let ip = frame.ip;

    const stack = this.stack;
    const context = this.context;
    const stepLimit = context.limits.maxSteps;

    // Step accounting is kept in locals too. Writing through an object property
    // on every instruction parks a mutable property store in the hottest loop
    // in the engine, which costs both time and V8 type feedback; the counter is
    // published to the context a few thousand instructions apart instead.
    let steps = 0;
    let synced = 0;
    let budget = stepLimit - context.steps;
    let nextClock = STEP_CHECK_MASK + 1;

    try {
      for (;;) {
        const at = ip;
        const op = code[ip++];

        steps += 1;
        if (steps > budget) {
          // The `finally` publishes the same amount on the way out.
          context.steps += steps - synced;
          synced = steps;
          throw new RuntimeFault(
            Code.STEP_LIMIT,
            `Execution limit reached: more than ${stepLimit} steps`,
            locs[at] ?? null,
            "The program ran too long. Check for an infinite loop.",
            this.vmStackFrames(),
          );
        }
        if (steps >= nextClock) {
          context.steps += steps - synced;
          synced = steps;
          context.checkTime(locs[at] ?? null);
          budget = stepLimit - context.steps + steps;
          nextClock += STEP_CHECK_MASK + 1;
        }

        switch (op) {
          // ------------------------------------------------------------- stack
          case OP.CONST:
            stack[sp++] = constants[code[ip++]];
            break;
          case OP.NULL:
            stack[sp++] = NULL;
            break;
          case OP.TRUE:
            stack[sp++] = true;
            break;
          case OP.FALSE:
            stack[sp++] = false;
            break;
          case OP.POP:
            sp -= 1;
            break;

          // --------------------------------------------------------- variables
          case OP.DEF_LOCAL:
            stack[base + code[ip++]] = stack[--sp];
            break;
          case OP.SET_LOCAL:
            stack[base + code[ip++]] = stack[sp - 1];
            break;
          case OP.GET_LOCAL:
            stack[sp++] = stack[base + code[ip++]];
            break;
          case OP.DEF_GLOBAL: {
            const name = constants[code[ip++]];
            const kind = BINDING_KINDS[code[ip++]] ?? "let";
            globals.define(name, stack[--sp], kind, locs[at] ?? null);
            break;
          }
          case OP.HOIST_FN: {
            const name = constants[code[ip++]];
            globals.set(name, stack[--sp], "fn");
            break;
          }
          case OP.SET_GLOBAL: {
            const name = constants[code[ip++]];
            globals.assign(name, stack[sp - 1], locs[at] ?? null);
            break;
          }
          case OP.GET_GLOBAL: {
            const name = constants[code[ip++]];
            stack[sp++] = globals.get(name, locs[at] ?? null);
            break;
          }

          // --------------------------------------------------------- functions
          case OP.CLOSURE: {
            const child = proto.functions[code[ip++]];
            const count = child.upvalueCount;
            const upvalues = new Array(count);
            for (let i = 0; i < count; i += 1) {
              upvalues[i] = child.upvalueFromLocal[i]
                ? this.captureUpvalue(base + child.upvalueIndex[i])
                : closure.upvalues[child.upvalueIndex[i]];
            }
            stack[sp++] = new TClosure(child, upvalues, globals);
            break;
          }
          case OP.CALL: {
            const argc = code[ip++];
            const loc = locs[at] ?? null;
            const depth = this.frames.length;
            this.sp = sp;
            frame.ip = ip;
            this.invoke(argc, loc);
            sp = this.sp;
            if (this.frames.length !== depth) {
              frame = this.frames[this.frames.length - 1];
              closure = frame.closure;
              proto = closure.proto;
              code = proto.code;
              locs = proto.locs;
              constants = proto.constants;
              base = frame.base;
              globals = closure.globals;
              ip = frame.ip;
            }
            break;
          }
          case OP.RETURN: {
            const result = stack[sp - 1];
            const finished = frame;
            this.closeUpvalues(finished.base);
            if (finished.tracked) this.callDepth -= 1;
            this.frames.pop();
            sp = finished.returnSlot;
            if (this.frames.length < floor) {
              // The step tail is published by the `finally`.
              this.sp = sp;
              frame.ip = ip;
              this.lastResult = result;
              return;
            }
            stack[sp++] = result;
            frame = this.frames[this.frames.length - 1];
            closure = frame.closure;
            proto = closure.proto;
            code = proto.code;
            locs = proto.locs;
            constants = proto.constants;
            base = frame.base;
            globals = closure.globals;
            ip = frame.ip;
            break;
          }

          // -------------------------------------------------------- arithmetic
          case OP.ADD: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            stack[sp - 1] =
              typeof a === "number" && typeof b === "number"
                ? a + b
                : applyBinaryOperator("+", a, b, locs[at] ?? null);
            break;
          }
          case OP.MOD: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            stack[sp - 1] =
              typeof a === "number" && typeof b === "number" && b !== 0
                ? a % b
                : applyBinaryOperator("%", a, b, locs[at] ?? null);
            break;
          }
          case OP.LT: {
            const b = stack[--sp];
            const a = stack[sp - 1];
            stack[sp - 1] =
              typeof a === "number" && typeof b === "number"
                ? a < b
                : applyBinaryOperator("<", a, b, locs[at] ?? null);
            break;
          }

          // ------------------------------------------------------ control flow
          //
          // Conditional jumps read their operand *and compute both targets*
          // before the branch, so every site in this case runs every time the
          // case does.
          //
          // That matters more than it looks. A site that has never executed has
          // no type feedback, and V8's optimiser compiles such a site into an
          // eager deoptimisation: it accepts the code, then throws it away the
          // first time control reaches the site. A `while` loop's exit branch
          // is taken exactly once, at the very end, so anything left in the
          // not-taken arm — the operand load, the target arithmetic — stayed
          // cold for the whole loop and then deoptimised the entire dispatch
          // loop on its way out, long after the loop had been running in
          // optimised code. Because a program enters `dispatchLoop` essentially
          // once, the run finished in the interpreter instead. Computing the
          // fallthrough, the offset and the target unconditionally keeps every
          // site in these four cases warm from the first iteration onward; the
          // branch itself is a select.
          case OP.JUMP:
            ip += code[ip] + 1;
            break;
          case OP.JUMP_IF_FALSE: {
            const fallthrough = ip + 1;
            const target = fallthrough + code[ip];
            ip = isTruthy(stack[sp - 1]) ? fallthrough : target;
            break;
          }
          case OP.JUMP_IF_TRUE: {
            const fallthrough = ip + 1;
            const target = fallthrough + code[ip];
            ip = isTruthy(stack[sp - 1]) ? target : fallthrough;
            break;
          }
          case OP.JUMP_IF_FALSE_POP: {
            const fallthrough = ip + 1;
            const target = fallthrough + code[ip];
            ip = isTruthy(stack[--sp]) ? fallthrough : target;
            break;
          }
          case OP.JUMP_IF_TRUE_POP: {
            const fallthrough = ip + 1;
            const target = fallthrough + code[ip];
            ip = isTruthy(stack[--sp]) ? target : fallthrough;
            break;
          }

          // Everything else is a cold opcode, and lives in its own function.
          // The two halves have to agree on where execution is, so publish the
          // value stack and the instruction pointer before the call and take
          // them back after it — including when the cold opcode faults and a
          // surrounding `try` region recovers it.
          default:
            this.sp = sp;
            frame.ip = ip;
            this.slowOp(op, at);
            sp = this.sp;
            ip = frame.ip;
            break;
        }
      }
    } finally {
      // Publish the instructions executed since the last sync point on *every*
      // exit, including a fault unwinding the loop. Without this a program
      // could loop forever on caught errors: each recovery would hand the loop
      // a fresh step budget and the step and time limits would never fire.
      context.steps += steps - synced;
      synced = steps;
    }
  }

  /**
   * The cold half of the instruction set.
   *
   * `dispatchLoop` is one function and V8 compiles it as one: every case body
   * shares a single register allocation, one stack frame and one set of inline
   * caches. The opcodes a tight loop executes millions of times a second were
   * therefore paying for the ones a program reaches once — and a case whose
   * code has not run yet has no type feedback when the optimiser looks at it,
   * which turns its first execution into an eager deoptimisation of the whole
   * dispatch loop (see docs/bytecode.md).
   *
   * Splitting the rare half out addresses both: the loop above carries only the
   * opcodes measured to dominate real programs, and a cold opcode runs here,
   * one call away, where its cold inline caches can only deoptimise this
   * function instead of the loop that called it.
   *
   * The caller publishes the value stack and the instruction pointer onto the
   * frame first and reloads them afterwards, so the two halves agree on where
   * execution is even when a cold opcode faults into a surrounding `try`.
   *
   * @param {number} op Opcode being executed.
   * @param {number} at Bytecode index of `op`, for source locations.
   */
  slowOp(op, at) {
    const frame = this.frames[this.frames.length - 1];
    const closure = frame.closure;
    const proto = closure.proto;
    const code = proto.code;
    const constants = proto.constants;
    const locs = proto.locs;
    const stack = this.stack;
    const globals = closure.globals;
    const base = frame.base;
    const context = this.context;
    let sp = this.sp;
    let ip = frame.ip;

    switch (op) {
      // ------------------------------------------------------------- stack
      case OP.DUP2: {
        const b = stack[sp - 1];
        const a = stack[sp - 2];
        stack[sp] = a;
        stack[sp + 1] = b;
        sp += 2;
        break;
      }
      case OP.RESERVE: {
        const count = code[ip++];
        for (let i = 0; i < count; i += 1) stack[sp++] = NULL;
        break;
      }
      case OP.DROP:
        sp -= code[ip++];
        break;

      // --------------------------------------------------------- variables
      case OP.GET_UPVALUE:
        stack[sp++] = closure.upvalues[code[ip++]].get();
        break;
      case OP.SET_UPVALUE:
        closure.upvalues[code[ip++]].set(stack[sp - 1]);
        break;
      case OP.CLOSE_DOWN:
        this.closeUpvalues(base + code[ip++]);
        break;
      case OP.SELF:
        stack[base + code[ip++]] = closure;
        break;

      // -------------------------------------------------------- arithmetic
      case OP.SUB: {
        const b = stack[--sp];
        const a = stack[sp - 1];
        stack[sp - 1] =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : applyBinaryOperator("-", a, b, locs[at] ?? null);
        break;
      }
      case OP.MUL: {
        const b = stack[--sp];
        const a = stack[sp - 1];
        stack[sp - 1] =
          typeof a === "number" && typeof b === "number"
            ? a * b
            : applyBinaryOperator("*", a, b, locs[at] ?? null);
        break;
      }
      case OP.DIV: {
        const b = stack[--sp];
        const a = stack[sp - 1];
        stack[sp - 1] =
          typeof a === "number" && typeof b === "number" && b !== 0
            ? a / b
            : applyBinaryOperator("/", a, b, locs[at] ?? null);
        break;
      }
      case OP.NEG:
        stack[sp - 1] = applyUnaryOperator("-", stack[sp - 1], locs[at] ?? null);
        break;
      case OP.NOT:
        stack[sp - 1] = !isTruthy(stack[sp - 1]);
        break;
      case OP.EQ: {
        const b = stack[--sp];
        const a = stack[sp - 1];
        stack[sp - 1] = typeof a === "number" && typeof b === "number" ? a === b : equals(a, b);
        break;
      }
      case OP.NEQ: {
        const b = stack[--sp];
        const a = stack[sp - 1];
        stack[sp - 1] = typeof a === "number" && typeof b === "number" ? a !== b : !equals(a, b);
        break;
      }
      case OP.LE:
      case OP.GT:
      case OP.GE: {
        const b = stack[--sp];
        const a = stack[sp - 1];
        stack[sp - 1] =
          typeof a === "number" && typeof b === "number"
            ? compareNumbers(op, a, b)
            : applyBinaryOperator(COMPARISON_TEXT[op], a, b, locs[at] ?? null);
        break;
      }

      // ------------------------------------------------------- collections
      case OP.ARRAY: {
        const count = code[ip++];
        const items = new Array(count);
        for (let i = count - 1; i >= 0; i -= 1) items[i] = stack[--sp];
        context.accountCollection(count, locs[at] ?? null);
        stack[sp++] = new TArray(items);
        break;
      }
      case OP.MAP: {
        const pairs = code[ip++];
        const flat = new Array(pairs * 2);
        for (let i = pairs * 2 - 1; i >= 0; i -= 1) flat[i] = stack[--sp];
        const map = new TMap();
        for (let i = 0; i < pairs; i += 1) map.set(flat[i * 2], flat[i * 2 + 1]);
        context.accountCollection(map.size, locs[at] ?? null);
        stack[sp++] = map;
        break;
      }
      case OP.INDEX: {
        const index = stack[--sp];
        const object = stack[sp - 1];
        if (object instanceof TArray && typeof index === "number" && Number.isInteger(index)) {
          const items = object.items;
          if (index >= 0 && index < items.length) {
            stack[sp - 1] = items[index];
            break;
          }
        }
        stack[sp - 1] = getIndexValue(object, index, locs[at] ?? null);
        break;
      }
      case OP.SET_INDEX: {
        const value = stack[sp - 1];
        const index = stack[sp - 2];
        const object = stack[sp - 3];
        if (
          object instanceof TArray &&
          typeof index === "number" &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < object.items.length
        ) {
          object.items[index] = value;
        } else {
          setIndexValue(object, index, value, locs[at] ?? null);
        }
        sp -= 2;
        break;
      }
      case OP.ITER_PREP: {
        const iterable = stack[--sp];
        stack[sp++] = new IterState(iterableItems(iterable, locs[at] ?? null));
        break;
      }
      case OP.ITER_NEXT: {
        const offset = code[ip];
        const slot = code[ip + 1];
        ip += 2;
        const state = stack[base + slot];
        if (state.index >= state.items.length) {
          ip += offset;
          break;
        }
        stack[sp++] = state.items[state.index++];
        break;
      }

      // ------------------------------------------------------------ errors
      case OP.TRY_BEGIN: {
        // `target` is relative to the end of this instruction; `slot` is the
        // frame slot the caught error value is written to.
        const offset = code[ip];
        const slot = code[ip + 1];
        ip += 2;
        frame.handler = { target: ip + offset, slot, sp, prev: frame.handler };
        break;
      }
      case OP.TRY_END:
        // Handlers nest, so leaving a region is a pop.
        frame.handler = frame.handler.prev;
        break;

      // ----------------------------------------------------------- modules
      case OP.IMPORT: {
        const path = constants[code[ip++]];
        const aliasIndex = code[ip++];
        this.sp = sp;
        frame.ip = ip;
        this.executeImport(
          path,
          aliasIndex >= 0 ? constants[aliasIndex] : null,
          locs[at] ?? null,
          globals,
        );
        sp = this.sp;
        break;
      }

      default:
        throw new RuntimeFault(
          Code.UNCAUGHT_ERROR,
          `Invalid bytecode instruction ${op} at offset ${at} in '${proto.name}'`,
          locs[at] ?? null,
        );
    }

    this.sp = sp;
    frame.ip = ip;
  }

  // ------------------------------------------------------------------ calling

  /** Call the callee sitting at `sp - argc - 1`. Reads and writes `this.sp`. */
  invoke(argc, loc) {
    const stack = this.stack;
    const calleeIndex = this.sp - argc - 1;
    const callee = stack[calleeIndex];

    if (callee instanceof TNativeFunction) {
      this.checkNativeArity(callee, argc, loc);
      const args = stack.slice(calleeIndex + 1, this.sp);
      const result = callee.fn(args, this.context, loc, null);
      this.sp = calleeIndex;
      stack[this.sp] = result;
      this.sp += 1;
      return;
    }

    if (callee instanceof TClosure) {
      const proto = callee.proto;
      if (argc !== proto.arity) {
        throw new RuntimeFault(
          Code.ARITY_MISMATCH,
          `${proto.name || "function"}() expected ${proto.arity} argument(s) but received ${argc}`,
          loc,
          "Check the number of arguments at the call site.",
        );
      }
      if (this.callDepth >= this.context.limits.maxCallDepth) {
        throw new RuntimeFault(
          Code.DEPTH_LIMIT,
          `Maximum call depth of ${this.context.limits.maxCallDepth} exceeded`,
          loc,
          "Reduce recursion depth or check for runaway recursion.",
          this.vmStackFrames(),
        );
      }
      this.callDepth += 1;
      this.frames.push({
        closure: callee,
        ip: 0,
        base: calleeIndex + 1,
        returnSlot: calleeIndex,
        tracked: true,
        callLoc: loc,
        handler: null,
      });
      return;
    }

    if (callee instanceof TFunction) {
      throw new RuntimeFault(
        Code.NOT_CALLABLE,
        "Value is a tree-walker closure, which this engine cannot execute",
        loc,
        "One program must not mix the 'tree' and 'vm' engines.",
      );
    }
    if (callee === NULL) {
      throw new RuntimeFault(Code.NOT_CALLABLE, "Cannot call null", loc, "Check the function reference.");
    }
    throw new RuntimeFault(
      Code.NOT_CALLABLE,
      `Value of type '${typeOf(callee)}' is not callable`,
      loc,
      "Only functions can be called.",
    );
  }

  checkNativeArity(fn, argc, loc) {
    const { minArgs, maxArgs } = fn;
    if (argc < minArgs || (maxArgs !== null && argc > maxArgs)) {
      const expected =
        maxArgs !== null && minArgs === maxArgs
          ? `${minArgs}`
          : maxArgs === null
            ? `at least ${minArgs}`
            : `${minArgs}-${maxArgs}`;
      throw new RuntimeFault(
        Code.ARITY_MISMATCH,
        `${fn.name}() expected ${expected} argument(s) but received ${argc}`,
        loc,
        "Check the call site.",
      );
    }
  }

  executeImport(path, alias, loc, env) {
    if (!this.moduleSystem) {
      throw new RuntimeFault(
        Code.MODULE_OUT_OF_BOUNDS,
        "Modules are not available in this execution environment",
        loc,
        "Run through the CLI, which provides a module loader.",
      );
    }
    const result = this.moduleSystem.requireModule(path, this.currentFile, loc);
    if (alias) {
      env.set(alias, result.namespace, "import");
      return;
    }
    for (const [name, value] of result.bindings) {
      if (env.hasLocal(name)) {
        throw new RuntimeFault(
          Code.IMPORT_NAME_CONFLICT,
          `Import name '${name}' conflicts with an existing declaration`,
          loc,
          "Rename it locally or import the module with 'as'.",
        );
      }
      env.set(name, value, "import");
    }
  }

  /** Compile source text to a prototype without executing it (tooling/tests). */
  compile(program, options = {}) {
    return compileProgram(program, { name: options.name ?? "<script>" });
  }

  /** Live frame summary, used by the debug tooling. */
  frameSummary() {
    return this.frames.map((frame) => ({
      name: frame.closure.proto.name,
      ip: frame.ip,
      base: frame.base,
      slots: frame.closure.proto.slotCount,
    }));
  }
}

function compareNumbers(op, a, b) {
  switch (op) {
    case OP.LT:
      return a < b;
    case OP.LE:
      return a <= b;
    case OP.GT:
      return a > b;
    default:
      return a >= b;
  }
}

export { Upvalue, IterState, LITERAL_OPS };
