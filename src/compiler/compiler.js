/**
 * Stage F₂ — Bytecode compiler.
 *
 * Lowers a resolved AST into a tree of `Chunk`s. The scheme is the classic
 * single-pass one:
 *
 *  - **Slots.** Every local in a function owns a fixed position in its call
 *    frame. The declaration order inside a block is decided by a pre-pass, so
 *    a hoisted function can reference a local that is textually declared later
 *    — the same trick the tree-walking interpreter gets from hoisting into a
 *    shared environment.
 *  - **Upvalues.** A local referenced by a nested function is captured as an
 *    upvalue: a reference to the frame slot that is *closed* (copied out) when
 *    the declaring scope ends, so each loop iteration gets a fresh cell.
 *  - **Globals.** Bindings declared at the outermost scope of a script or
 *    module live in the lexical `Environment`, which is what lets two modules
 *    keep separate top-level namespaces and lets the module loader export
 *    them.
 *  - **Control flow.** Loops are compiled to labelled jumps; `break` and
 *    `continue` unwind the frame slots they leave behind and close any
 *    upvalues that escape with them.
 *
 * The compiler performs no type checking and no name resolution of its own; it
 * assumes the parser and the semantic resolver have already accepted the
 * program. Every construct it cannot lower is reported as a structured
 * diagnostic rather than a crash.
 */
import { NodeType } from "../ast/nodes.js";
import { Chunk } from "./../bytecode/chunk.js";
import { OP, KIND_INDEX } from "./../bytecode/opcodes.js";
import { Diagnostic, Phase, TyphounError } from "../diagnostics/diagnostic.js";
import { Code } from "../diagnostics/codes.js";

/** Name used for the hidden slot that holds a `for ... in` iterator. */
export const ITERATOR_SLOT = "\u0000iter";

const BINARY_OPS = Object.freeze({
  "+": OP.ADD,
  "-": OP.SUB,
  "*": OP.MUL,
  "/": OP.DIV,
  "%": OP.MOD,
  "<": OP.LT,
  "<=": OP.LE,
  ">": OP.GT,
  ">=": OP.GE,
});

const COMPARE_OPS = Object.freeze({ "==": OP.EQ, "!=": OP.NEQ });

function compileFault(message, loc) {
  return new TyphounError(
    new Diagnostic({
      code: Code.UNCAUGHT_ERROR,
      phase: Phase.SEMANTIC,
      message,
      location: loc ?? null,
      help: "This is a compiler bug: the AST node should not reach this stage.",
    }),
  );
}

class Compiler {
  /**
   * @param {Compiler|null} parent Enclosing function compiler.
   * @param {"script"|"function"} type
   * @param {string} name
   * @param {object|null} loc
   */
  constructor(parent, type, name, loc) {
    this.parent = parent;
    this.type = type;
    this.proto = new Chunk({ name, type, loc });
    /** @type {Array<{name: string, depth: number, slot: number, isConst: boolean, isCaptured: boolean}>} */
    this.locals = [];
    this.scopeDepth = 0;
    this.slotCount = 0;
    /** @type {number[]} Slot count when each open scope began. */
    this.scopeEntries = [];
    /** @type {Array<object>} Active loop contexts. */
    this.loops = [];
    this.functionDepth = type === "function" ? 1 : 0;
    /**
     * Number of `try` regions currently open in *this* function. A jump that
     * leaves a region (`break`, `continue`, `return`) emits one `TRY_END` per
     * region it leaves, so the runtime handler chain stays balanced without the
     * VM having to inspect a table.
     */
    this.tryDepth = 0;
  }

  // ------------------------------------------------------------------ output

  emit(op, loc = null, ...operands) {
    return this.proto.emit(op, loc, ...operands);
  }

  constantIndex(value) {
    return this.proto.addConstant(value);
  }

  /** Implicit "return null" at the end of a chunk. */
  finish(loc) {
    this.emit(OP.NULL, loc);
    this.emit(OP.RETURN, loc);
  }

  // ------------------------------------------------------------------ scopes

  beginScope() {
    this.scopeEntries.push(this.slotCount);
    this.scopeDepth += 1;
  }

  endScope(loc) {
    this.scopeDepth -= 1;
    const entry = this.scopeEntries.pop() ?? 0;
    const drop = this.slotCount - entry;
    if (drop > 0) {
      this.emit(OP.CLOSE_DOWN, loc, entry);
      this.emit(OP.DROP, loc, drop);
    }
    while (this.locals.length > 0 && this.locals[this.locals.length - 1].depth > this.scopeDepth) {
      this.locals.pop();
    }
    this.slotCount = entry;
  }

  isGlobalScope() {
    return this.type === "script" && this.scopeDepth === 0;
  }

  /**
   * Reserve a slot for `name` in the current scope.
   * @returns {number|null} the slot, or null when the binding is a global.
   */
  declareName(name, isConst = false) {
    if (this.isGlobalScope()) return null;
    const slot = this.slotCount;
    this.slotCount += 1;
    this.proto.slotCount = Math.max(this.proto.slotCount, this.slotCount);
    this.locals.push({
      name,
      depth: this.scopeDepth,
      slot,
      isConst: Boolean(isConst),
      isCaptured: false,
    });
    return slot;
  }

  /** Reserve a frame slot that no name refers to yet (the catch binding). */
  reserveSlot() {
    const slot = this.slotCount;
    this.slotCount += 1;
    this.proto.slotCount = Math.max(this.proto.slotCount, this.slotCount);
    return slot;
  }

  /**
   * Give `name` to an already reserved slot.
   *
   * The catch binding needs a slot *before* the guarded block runs (so the VM
   * has somewhere to put the error) but must not be visible by name until the
   * handler is compiled — otherwise a reference inside the `try` block that
   * should resolve to an outer binding would silently resolve to it instead.
   */
  bindSlot(name, slot) {
    this.locals.push({
      name,
      depth: this.scopeDepth,
      slot,
      isConst: false,
      isCaptured: false,
    });
  }

  resolveLocal(name) {
    for (let i = this.locals.length - 1; i >= 0; i -= 1) {
      if (this.locals[i].name === name) return this.locals[i];
    }
    return null;
  }

  /** Capture `name` from an enclosing function, if it lives there. */
  resolveUpvalue(name) {
    if (!this.parent) return null;
    const local = this.parent.resolveLocal(name);
    if (local) {
      local.isCaptured = true;
      return this.addUpvalue(name, true, local.slot);
    }
    const inherited = this.parent.resolveUpvalue(name);
    if (inherited !== null) return this.addUpvalue(name, false, inherited);
    return null;
  }

  addUpvalue(name, fromLocal, index) {
    for (let i = 0; i < this.proto.upvalueCount; i += 1) {
      if (
        this.proto.upvalueNames[i] === name &&
        this.proto.upvalueFromLocal[i] === fromLocal &&
        this.proto.upvalueIndex[i] === index
      ) {
        return i;
      }
    }
    return this.proto.declareUpvalue(name, fromLocal, index);
  }

  resolveName(name) {
    const local = this.resolveLocal(name);
    if (local) return { kind: "local", slot: local.slot };
    const upvalue = this.resolveUpvalue(name);
    if (upvalue !== null) return { kind: "upvalue", index: upvalue };
    return { kind: "global" };
  }

  emitGet(name, loc) {
    const resolved = this.resolveName(name);
    if (resolved.kind === "local") this.emit(OP.GET_LOCAL, loc, resolved.slot);
    else if (resolved.kind === "upvalue") this.emit(OP.GET_UPVALUE, loc, resolved.index);
    else this.emit(OP.GET_GLOBAL, loc, this.constantIndex(name));
  }

  emitSet(name, loc) {
    const resolved = this.resolveName(name);
    if (resolved.kind === "local") this.emit(OP.SET_LOCAL, loc, resolved.slot);
    else if (resolved.kind === "upvalue") this.emit(OP.SET_UPVALUE, loc, resolved.index);
    else this.emit(OP.SET_GLOBAL, loc, this.constantIndex(name));
  }

  // -------------------------------------------------------------- statements

  /**
   * Compile a statement list that forms a single lexical scope.
   *
   * Pass 1 reserves a slot for everything declared in the scope, pass 2 emits
   * the hoisted function closures and pass 3 compiles the statements in order.
   */
  compileStatements(body, loc) {
    const entry = this.slotCount;

    for (const stmt of body) {
      if (stmt.type === NodeType.FnDecl) this.declareName(stmt.name);
    }
    for (const stmt of body) {
      if (stmt.type === NodeType.VarDecl) this.declareName(stmt.name, stmt.kind === "const");
    }

    const reserve = this.slotCount - entry;
    if (reserve > 0) this.emit(OP.RESERVE, loc, reserve);

    for (const stmt of body) {
      if (stmt.type === NodeType.FnDecl) this.compileFnDecl(stmt);
    }
    for (const stmt of body) {
      if (stmt.type !== NodeType.FnDecl) this.compileStatement(stmt);
    }
  }

  compileFnDecl(stmt) {
    const protoIndex = this.compileFunctionProto(stmt.name, stmt.params, stmt.body, stmt.loc, null);
    if (this.isGlobalScope()) {
      this.emit(OP.CLOSURE, stmt.loc, protoIndex);
      this.emit(OP.HOIST_FN, stmt.loc, this.constantIndex(stmt.name));
      return;
    }
    const local = this.resolveLocal(stmt.name);
    if (!local) throw compileFault(`Cannot allocate a slot for function '${stmt.name}'`, stmt.loc);
    this.emit(OP.CLOSURE, stmt.loc, protoIndex);
    this.emit(OP.DEF_LOCAL, stmt.loc, local.slot);
  }

  compileStatement(node) {
    switch (node.type) {
      case NodeType.Program:
        this.compileStatements(node.body, node.loc);
        return;
      case NodeType.VarDecl:
        return this.compileVarDecl(node);
      case NodeType.FnDecl:
        // Hoisted by compileStatements; nothing to emit at the statement site.
        return;
      case NodeType.ExprStmt:
        this.compileExpression(node.expression);
        this.emit(OP.POP, node.loc);
        return;
      case NodeType.Block:
        this.beginScope();
        this.compileStatements(node.body, node.loc);
        this.endScope(node.loc);
        return;
      case NodeType.IfStmt:
        return this.compileIf(node);
      case NodeType.WhileStmt:
        return this.compileWhile(node);
      case NodeType.ForStmt:
        return this.compileFor(node);
      case NodeType.ForInStmt:
        return this.compileForIn(node);
      case NodeType.BreakStmt:
        return this.compileBreak(node);
      case NodeType.ContinueStmt:
        return this.compileContinue(node);
      case NodeType.TryStmt:
        return this.compileTry(node);
      case NodeType.ReturnStmt:
        // The value is evaluated *inside* the region, so a fault while
        // computing it is still caught by an enclosing `try`.
        if (node.argument) this.compileExpression(node.argument);
        else this.emit(OP.NULL, node.loc);
        this.emitTryEnds(this.tryDepth, node.loc);
        this.emit(OP.RETURN, node.loc);
        return;
      case NodeType.ImportStmt:
        this.emit(
          OP.IMPORT,
          node.loc,
          this.constantIndex(node.path),
          node.alias ? this.constantIndex(node.alias) : -1,
        );
        return;
      default:
        throw compileFault(`Cannot compile statement '${node.type}'`, node.loc);
    }
  }

  compileVarDecl(node) {
    this.compileExpression(node.init);
    if (this.isGlobalScope()) {
      this.emit(
        OP.DEF_GLOBAL,
        node.loc,
        this.constantIndex(node.name),
        KIND_INDEX[node.kind] ?? KIND_INDEX.let,
      );
      return;
    }
    const local = this.resolveLocal(node.name);
    if (!local) throw compileFault(`Cannot allocate a slot for '${node.name}'`, node.loc);
    this.emit(OP.DEF_LOCAL, node.loc, local.slot);
  }

  compileIf(node) {
    this.compileExpression(node.test);
    const elseJump = this.proto.emitJump(OP.JUMP_IF_FALSE_POP, node.loc);
    this.compileStatement(node.consequent);
    if (!node.alternate) {
      this.proto.patchJump(elseJump, this.proto.code.length);
      return;
    }
    const endJump = this.proto.emitJump(OP.JUMP, node.loc);
    this.proto.patchJump(elseJump, this.proto.code.length);
    this.compileStatement(node.alternate);
    this.proto.patchJump(endJump, this.proto.code.length);
  }

  pushLoop(context) {
    this.loops.push(context);
  }

  /**
   * Point every pending `break` at the current end of the chunk.
   *
   * Callers must do this *after* emitting the scope teardown for the loop, or
   * `break` would land on it and unwind the same slots a second time: a break
   * already closes and drops everything down to `breakSlot` on its own.
   */
  patchBreaks(loop) {
    for (const jump of loop.breakJumps) this.proto.patchJump(jump, this.proto.code.length);
  }

  popLoop(loc) {
    const loop = this.loops.pop();
    if (!loop) throw compileFault("Loop context underflow", loc);
    return loop;
  }

  /** Discard frame slots down to `target`, closing any captured cells. */
  emitUnwind(target, loc) {
    const drop = this.slotCount - target;
    if (drop <= 0) return;
    this.emit(OP.CLOSE_DOWN, loc, target);
    this.emit(OP.DROP, loc, drop);
  }

  compileWhile(node) {
    const entry = this.slotCount;
    const loop = {
      breakJumps: [],
      continueJumps: [],
      breakSlot: entry,
      continueSlot: entry,
      tryDepth: this.tryDepth,
    };
    this.pushLoop(loop);
    const top = this.proto.code.length;
    this.compileExpression(node.test);
    const exitJump = this.proto.emitJump(OP.JUMP_IF_FALSE_POP, node.loc);
    this.compileStatement(node.body);
    this.proto.patchJump(this.proto.emitJump(OP.JUMP, node.loc), top);
    this.proto.patchJump(exitJump, this.proto.code.length);
    for (const jump of loop.continueJumps) this.proto.patchJump(jump, top);
    // A `while` owns no scope, so a break lands directly after the loop.
    this.patchBreaks(loop);
    this.popLoop(node.loc);
  }

  compileFor(node) {
    this.beginScope();
    const entry = this.slotCount;
    if (node.init && node.init.type === NodeType.VarDecl) {
      this.declareName(node.init.name, node.init.kind === "const");
    }
    const reserve = this.slotCount - entry;
    if (reserve > 0) this.emit(OP.RESERVE, node.loc, reserve);

    if (node.init) this.compileStatement(node.init);

    const loop = {
      breakJumps: [],
      continueJumps: [],
      breakSlot: entry,
      continueSlot: this.slotCount,
      tryDepth: this.tryDepth,
    };
    this.pushLoop(loop);
    const top = this.proto.code.length;
    let exitJump = -1;
    if (node.test) {
      this.compileExpression(node.test);
      exitJump = this.proto.emitJump(OP.JUMP_IF_FALSE_POP, node.loc);
    }
    this.compileStatement(node.body);

    for (const jump of loop.continueJumps) this.proto.patchJump(jump, this.proto.code.length);
    if (node.update) {
      this.compileExpression(node.update);
      this.emit(OP.POP, node.loc);
    }
    this.proto.patchJump(this.proto.emitJump(OP.JUMP, node.loc), top);
    // Falling out of the test still runs the for-header scope teardown.
    if (exitJump >= 0) this.proto.patchJump(exitJump, this.proto.code.length);
    this.endScope(node.loc);
    // A break unwound that scope itself, so it must land past the teardown.
    this.patchBreaks(loop);
    this.popLoop(node.loc);
  }

  compileForIn(node) {
    this.beginScope();
    const entry = this.slotCount;
    const iterSlot = this.declareName(ITERATOR_SLOT);
    const varSlot = this.declareName(node.variable);
    const reserve = this.slotCount - entry;
    if (reserve > 0) this.emit(OP.RESERVE, node.loc, reserve);

    this.compileExpression(node.iterable);
    this.emit(OP.ITER_PREP, node.loc);
    this.emit(OP.DEF_LOCAL, node.loc, iterSlot);

    const loop = {
      breakJumps: [],
      continueJumps: [],
      breakSlot: entry,
      continueSlot: this.slotCount,
      tryDepth: this.tryDepth,
    };
    this.pushLoop(loop);
    const top = this.proto.code.length;
    // ITER_NEXT has two operands, so the jump offset is patched past both.
    const exitJump = this.proto.emit(OP.ITER_NEXT, node.loc, 0, iterSlot);
    this.emit(OP.DEF_LOCAL, node.loc, varSlot);
    this.compileStatement(node.body);
    this.proto.patchJump(this.emit(OP.JUMP, node.loc), top);
    // An exhausted iterator lands on the scope teardown, which drops the
    // iterator and loop-variable slots.
    this.proto.patchJump(exitJump, this.proto.code.length, exitJump + 3);
    for (const jump of loop.continueJumps) this.proto.patchJump(jump, top);
    this.endScope(node.loc);
    // A break already dropped the iterator and loop variable itself.
    this.patchBreaks(loop);
    this.popLoop(node.loc);
  }

  compileBreak(node) {
    const loop = this.loops[this.loops.length - 1];
    if (!loop) throw compileFault("'break' reached the compiler outside a loop", node.loc);
    this.emitTryEnds(this.tryDepth - loop.tryDepth, node.loc);
    this.emitUnwind(loop.breakSlot, node.loc);
    loop.breakJumps.push(this.proto.emitJump(OP.JUMP, node.loc));
  }

  compileContinue(node) {
    const loop = this.loops[this.loops.length - 1];
    if (!loop) throw compileFault("'continue' reached the compiler outside a loop", node.loc);
    this.emitTryEnds(this.tryDepth - loop.tryDepth, node.loc);
    this.emitUnwind(loop.continueSlot, node.loc);
    loop.continueJumps.push(this.proto.emitJump(OP.JUMP, node.loc));
  }

  /** Leave `count` `try` regions, so a jump out of them stays balanced. */
  emitTryEnds(count, loc) {
    for (let i = 0; i < count; i += 1) this.emit(OP.TRY_END, loc);
  }

  /**
   * Compile `try { ... } catch err { ... }`.
   *
   * The error binding owns a frame slot reserved before the guarded block, so
   * the VM has a place to put the caught error. The slot is only *named* while
   * the handler is compiled.
   *
   * `TRY_BEGIN` records where the handler sits and how deep the value stack was
   * when the region opened; the VM restores that depth before running the
   * handler, which is what discards anything the failing expression had left
   * half-built.
   */
  compileTry(node) {
    this.beginScope();
    const slot = this.reserveSlot();
    this.emit(OP.RESERVE, node.loc, 1);
    const begin = this.emit(OP.TRY_BEGIN, node.loc, 0, slot);

    this.tryDepth += 1;
    this.compileStatement(node.block);
    this.emit(OP.TRY_END, node.loc);
    this.tryDepth -= 1;

    const done = this.proto.emitJump(OP.JUMP, node.loc);
    // Falling into the handler from above must not happen: TRY_BEGIN and the
    // handler are separated by this jump.
    this.proto.patchJump(begin, this.proto.code.length, begin + 3);

    this.beginScope();
    this.bindSlot(node.param, slot);
    this.compileStatements(node.handler.body, node.handler.loc);
    this.endScope(node.handler.loc);

    this.proto.patchJump(done, this.proto.code.length);
    this.endScope(node.loc);
  }

  // ------------------------------------------------------------- expressions

  compileExpression(node) {
    switch (node.type) {
      case NodeType.NumberLit:
      case NodeType.StringLit:
        this.emit(OP.CONST, node.loc, this.constantIndex(node.value));
        return;
      case NodeType.BoolLit:
        // Booleans and null have dedicated opcodes, which keeps them out of the
        // constant pool and saves an operand byte at every use site.
        this.emit(node.value ? OP.TRUE : OP.FALSE, node.loc);
        return;
      case NodeType.NullLit:
        this.emit(OP.NULL, node.loc);
        return;
      case NodeType.Identifier:
        this.emitGet(node.name, node.loc);
        return;
      case NodeType.GroupingExpr:
        this.compileExpression(node.expression);
        return;
      case NodeType.ArrayLit: {
        for (const element of node.elements) this.compileExpression(element);
        this.emit(OP.ARRAY, node.loc, node.elements.length);
        return;
      }
      case NodeType.MapLit: {
        for (const entry of node.entries) {
          this.compileExpression(entry.key);
          this.compileExpression(entry.value);
        }
        this.emit(OP.MAP, node.loc, node.entries.length);
        return;
      }
      case NodeType.UnaryExpr:
        this.compileExpression(node.operand);
        this.emit(node.operator === "not" ? OP.NOT : OP.NEG, node.loc);
        return;
      case NodeType.BinaryExpr:
        return this.compileBinary(node);
      case NodeType.LogicalExpr:
        return this.compileLogical(node);
      case NodeType.AssignExpr:
        return this.compileAssignment(node);
      case NodeType.CallExpr: {
        this.compileExpression(node.callee);
        for (const arg of node.args) this.compileExpression(arg);
        this.emit(OP.CALL, node.loc, node.args.length);
        return;
      }
      case NodeType.IndexExpr:
        this.compileExpression(node.object);
        this.compileExpression(node.index);
        this.emit(OP.INDEX, node.loc);
        return;
      case NodeType.FnExpr: {
        const protoIndex = this.compileFunctionProto(
          node.name ?? "",
          node.params,
          node.body,
          node.loc,
          node.name ?? null,
        );
        this.emit(OP.CLOSURE, node.loc, protoIndex);
        return;
      }
      default:
        throw compileFault(`Cannot compile expression '${node.type}'`, node.loc);
    }
  }

  compileBinary(node) {
    const compare = COMPARE_OPS[node.operator];
    if (compare !== undefined) {
      this.compileExpression(node.left);
      this.compileExpression(node.right);
      this.emit(compare, node.loc);
      return;
    }
    const op = BINARY_OPS[node.operator];
    if (op === undefined) {
      throw compileFault(`Unknown binary operator '${node.operator}'`, node.loc);
    }
    this.compileExpression(node.left);
    this.compileExpression(node.right);
    this.emit(op, node.loc);
  }

  compileLogical(node) {
    this.compileExpression(node.left);
    const jump = this.proto.emitJump(
      node.operator === "and" ? OP.JUMP_IF_FALSE : OP.JUMP_IF_TRUE,
      node.loc,
    );
    this.emit(OP.POP, node.loc);
    this.compileExpression(node.right);
    this.proto.patchJump(jump, this.proto.code.length);
  }

  compileAssignment(node) {
    const target = node.target;
    if (target.type === NodeType.Identifier) {
      if (node.operator === "=") {
        this.compileExpression(node.value);
        this.emitSet(target.name, node.loc);
        return;
      }
      this.emitGet(target.name, node.loc);
      this.compileExpression(node.value);
      this.emit(BINARY_OPS[node.operator.slice(0, -1)] ?? OP.ADD, node.loc);
      this.emitSet(target.name, node.loc);
      return;
    }

    if (target.type !== NodeType.IndexExpr) {
      throw compileFault(`Cannot assign to '${target.type}'`, node.loc);
    }

    if (node.operator === "=") {
      this.compileExpression(target.object);
      this.compileExpression(target.index);
      this.compileExpression(node.value);
      this.emit(OP.SET_INDEX, node.loc);
      return;
    }

    this.compileExpression(target.object);
    this.compileExpression(target.index);
    this.emit(OP.DUP2, node.loc);
    this.emit(OP.INDEX, node.loc);
    this.compileExpression(node.value);
    this.emit(BINARY_OPS[node.operator.slice(0, -1)] ?? OP.ADD, node.loc);
    this.emit(OP.SET_INDEX, node.loc);
  }

  // ---------------------------------------------------------------- functions

  /**
   * Compile a function body into a standalone prototype.
   * @returns {number} the index of the prototype in the enclosing chunk.
   */
  compileFunctionProto(name, params, bodyNode, loc, selfName) {
    const fn = new Compiler(this, "function", name || "<anonymous>", loc);
    fn.proto.arity = params.length;
    fn.proto.paramNames = params.slice();
    fn.functionDepth = 1;

    // Parameters already occupy the first slots: the caller pushed them there.
    for (let i = 0; i < params.length; i += 1) {
      fn.locals.push({
        name: params[i],
        depth: 1,
        slot: i,
        isConst: false,
        isCaptured: false,
      });
    }
    fn.slotCount = params.length;
    fn.scopeEntries.push(params.length);
    fn.scopeDepth = 1;

    if (selfName) {
      const slot = fn.declareName(selfName);
      fn.emit(OP.RESERVE, bodyNode.loc ?? loc, 1);
      fn.emit(OP.SELF, bodyNode.loc ?? loc, slot);
    }

    fn.compileStatements(bodyNode.body, bodyNode.loc ?? loc);
    fn.finish(bodyNode.loc ?? loc);

    // Parameters occupy slots without going through `declareName`, so make sure
    // the reported frame size covers them.
    fn.proto.slotCount = Math.max(params.length, fn.proto.slotCount);

    return this.proto.addFunction(fn.proto);
  }
}

/**
 * Compile a whole program (script or module body).
 * @param {object} program Program AST node
 * @param {object} [options]
 * @param {string} [options.name] Chunk name used in traces and disassembly
 * @returns {Chunk}
 */
export function compileProgram(program, options = {}) {
  const compiler = new Compiler(null, "script", options.name ?? "<script>", program.loc ?? null);
  compiler.compileStatements(program.body, program.loc ?? null);
  compiler.finish(program.loc ?? null);
  return compiler.proto;
}
