/**
 * Stage F — Tree-walking interpreter.
 *
 * Evaluates Typhoun AST nodes directly against explicit runtime values and
 * lexical environments. Control flow that unwinds (`return`, `break`,
 * `continue`) is modelled with dedicated signal objects rather than sentinel
 * values, and all runtime failures are structured `RuntimeFault`s.
 */
import { NodeType } from "../ast/nodes.js";
import { SourceManager } from "../source/source-manager.js";
import { Environment } from "../runtime/environment.js";
import { ExecutionContext } from "../runtime/context.js";
import {
  RuntimeFault,
  ReturnSignal,
  BreakSignal,
  ContinueSignal,
  isCatchableFault,
  errorValueOf,
} from "../runtime/errors.js";
import { Code } from "../diagnostics/codes.js";
import {
  NULL,
  TArray,
  TMap,
  TFunction,
  TNativeFunction,
  typeOf,
  isTruthy,
  equals,
} from "../runtime/values.js";
import { applyBinaryOperator, applyUnaryOperator } from "../runtime/operators.js";
import { iterableItems, getIndexValue, setIndexValue } from "../runtime/indexing.js";
import { installBuiltins } from "../builtins/index.js";

export class Interpreter {
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
  }

  /** Build a fresh global environment with the standard library installed. */
  createGlobalEnvironment() {
    const env = new Environment(null);
    installBuiltins(env, this);
    return env;
  }

  /**
   * Execute a parsed program.
   * @param {object} program Program AST node
   * @param {object} [options]
   * @param {string} [options.file] Source file name, used for imports/diagnostics
   * @param {Environment} [options.env] Reuse a caller-provided global scope
   * @returns {{value: unknown, context: ExecutionContext, env: Environment}}
   */
  run(program, options = {}) {
    const env = options.env ?? this.createGlobalEnvironment();
    const previousFile = this.currentFile;
    if (options.file) this.currentFile = options.file;
    try {
      this.hoistFunctions(program.body, env);
      this.executeStatements(program.body, env, false);
    } finally {
      this.currentFile = previousFile;
    }
    return { value: NULL, context: this.context, env };
  }

  // ------------------------------------------------------------- statements

  hoistFunctions(body, env) {
    for (const stmt of body) {
      if (stmt.type === NodeType.FnDecl) {
        env.set(stmt.name, new TFunction(stmt.name, stmt.params, stmt.body, env, stmt.loc), "fn");
      }
    }
  }

  executeStatements(body, env, ownScope) {
    const scope = ownScope ? env.child() : env;
    if (ownScope) this.hoistFunctions(body, scope);
    for (const stmt of body) this.execute(stmt, scope);
  }

  execute(node, env) {
    this.context.tick(node.loc ?? null);
    switch (node.type) {
      case NodeType.VarDecl: {
        const value = this.evaluate(node.init, env);
        env.define(node.name, value, node.kind, node.loc);
        return;
      }
      case NodeType.FnDecl:
        if (!env.hasLocal(node.name)) {
          env.set(node.name, new TFunction(node.name, node.params, node.body, env, node.loc), "fn");
        }
        return;
      case NodeType.ExprStmt:
        this.evaluate(node.expression, env);
        return;
      case NodeType.Block:
        this.executeStatements(node.body, env, true);
        return;
      case NodeType.IfStmt:
        if (isTruthy(this.evaluate(node.test, env))) this.execute(node.consequent, env);
        else if (node.alternate) this.execute(node.alternate, env);
        return;
      case NodeType.WhileStmt:
        this.executeWhile(node, env);
        return;
      case NodeType.ForInStmt:
        this.executeForIn(node, env);
        return;
      case NodeType.ForStmt:
        this.executeFor(node, env);
        return;
      case NodeType.BreakStmt:
        throw new BreakSignal();
      case NodeType.ContinueStmt:
        throw new ContinueSignal();
      case NodeType.ReturnStmt:
        throw new ReturnSignal(node.argument ? this.evaluate(node.argument, env) : NULL);
      case NodeType.TryStmt:
        this.executeTry(node, env);
        return;
      case NodeType.ImportStmt:
        this.executeImport(node, env);
        return;
      default:
        throw new RuntimeFault(
          Code.UNCAUGHT_ERROR,
          `Interpreter cannot execute node '${node.type}'`,
          node.loc,
        );
    }
  }

  executeWhile(node, env) {
    while (isTruthy(this.evaluate(node.test, env))) {
      try {
        this.execute(node.body, env);
      } catch (err) {
        if (err instanceof BreakSignal) return;
        if (err instanceof ContinueSignal) continue;
        throw err;
      }
    }
  }

  executeForIn(node, env) {
    const iterable = this.evaluate(node.iterable, env);
    const items = this.iterableItems(iterable, node.iterable.loc);
    const loopEnv = env.child();
    for (const item of items) {
      loopEnv.set(node.variable, item, "let");
      try {
        this.execute(node.body, loopEnv);
      } catch (err) {
        if (err instanceof BreakSignal) return;
        if (err instanceof ContinueSignal) continue;
        throw err;
      }
    }
  }

  executeFor(node, env) {
    const loopEnv = env.child();
    if (node.init) this.execute(node.init, loopEnv);
    while (node.test ? isTruthy(this.evaluate(node.test, loopEnv)) : true) {
      try {
        this.execute(node.body, loopEnv);
      } catch (err) {
        if (err instanceof BreakSignal) return;
        if (!(err instanceof ContinueSignal)) throw err;
      }
      if (node.update) this.evaluate(node.update, loopEnv);
    }
  }

  /**
   * Run `try { ... } catch err { ... }`.
   *
   * Only runtime faults are caught. `return`, `break` and `continue` travel as
   * signals and pass straight through, and so do load-time errors, sandbox
   * limits and host bugs (see `isCatchableFault`).
   */
  executeTry(node, env) {
    try {
      this.execute(node.block, env);
      return;
    } catch (err) {
      if (!isCatchableFault(err)) throw err;
      const handlerEnv = env.child();
      handlerEnv.set(node.param, errorValueOf(err, this.errorStack(err)), "let");
      this.hoistFunctions(node.handler.body, handlerEnv);
      this.executeStatements(node.handler.body, handlerEnv, false);
    }
  }

  /**
   * The call frames an error unwound through, innermost first.
   *
   * A fault that crossed a function boundary carries the stack recorded at
   * that boundary; one raised and caught inside a single frame has none yet,
   * so the current stack is the honest answer. Both engines produce the same
   * list for the same program.
   */
  errorStack(fault) {
    return fault.typhounStack.length > 0 ? fault.typhounStack : this.context.stackFrames();
  }

  executeImport(node, env) {
    if (!this.moduleSystem) {
      throw new RuntimeFault(
        Code.MODULE_OUT_OF_BOUNDS,
        "Modules are not available in this execution environment",
        node.loc,
        "Run through the CLI, which provides a module loader.",
      );
    }
    const result = this.moduleSystem.requireModule(node.path, this.currentFile, node.loc);
    if (node.alias) {
      env.set(node.alias, result.namespace, "import");
      return;
    }
    for (const [name, value] of result.bindings) {
      if (env.hasLocal(name)) {
        throw new RuntimeFault(
          Code.IMPORT_NAME_CONFLICT,
          `Import name '${name}' conflicts with an existing declaration`,
          node.loc,
          "Rename it locally or import the module with 'as'.",
        );
      }
      env.set(name, value, "import");
    }
  }

  iterableItems(value, loc) {
    return iterableItems(value, loc);
  }

  // ------------------------------------------------------------ expressions

  evaluate(node, env) {
    this.context.tick(node.loc ?? null);
    switch (node.type) {
      case NodeType.NumberLit:
      case NodeType.StringLit:
      case NodeType.BoolLit:
        return node.value;
      case NodeType.NullLit:
        return NULL;
      case NodeType.Identifier:
        return env.get(node.name, node.loc);
      case NodeType.GroupingExpr:
        return this.evaluate(node.expression, env);
      case NodeType.ArrayLit: {
        const items = node.elements.map((el) => this.evaluate(el, env));
        this.context.accountCollection(items.length, node.loc);
        return new TArray(items);
      }
      case NodeType.MapLit: {
        const map = new TMap();
        for (const entry of node.entries) {
          map.set(this.evaluate(entry.key, env), this.evaluate(entry.value, env));
        }
        this.context.accountCollection(map.size, node.loc);
        return map;
      }
      case NodeType.UnaryExpr:
        return this.evaluateUnary(node, env);
      case NodeType.BinaryExpr:
        return this.evaluateBinary(node, env);
      case NodeType.LogicalExpr:
        return this.evaluateLogical(node, env);
      case NodeType.AssignExpr:
        return this.evaluateAssignment(node, env);
      case NodeType.CallExpr:
        return this.evaluateCall(node, env);
      case NodeType.IndexExpr:
        return this.getIndex(
          this.evaluate(node.object, env),
          this.evaluate(node.index, env),
          node.loc,
        );
      case NodeType.FnExpr:
        return this.makeFunction(node.name ?? "", node.params, node.body, env, node.loc);
      default:
        throw new RuntimeFault(
          Code.UNCAUGHT_ERROR,
          `Interpreter cannot evaluate node '${node.type}'`,
          node.loc,
        );
    }
  }

  evaluateUnary(node, env) {
    const value = this.evaluate(node.operand, env);
    if (node.operator === "not") return !isTruthy(value);
    return applyUnaryOperator(node.operator, value, node.loc);
  }

  evaluateBinary(node, env) {
    const op = node.operator;
    const left = this.evaluate(node.left, env);
    if (op === "==" || op === "!=") {
      const right = this.evaluate(node.right, env);
      return op === "==" ? equals(left, right) : !equals(left, right);
    }
    const right = this.evaluate(node.right, env);
    return this.applyBinaryOperator(op, left, right, node.loc);
  }

  applyBinaryOperator(op, left, right, loc) {
    return applyBinaryOperator(op, left, right, loc);
  }

  evaluateLogical(node, env) {
    const left = this.evaluate(node.left, env);
    if (node.operator === "and") {
      return isTruthy(left) ? this.evaluate(node.right, env) : left;
    }
    return isTruthy(left) ? left : this.evaluate(node.right, env);
  }

  evaluateAssignment(node, env) {
    const target = node.target;
    if (target.type === NodeType.Identifier) {
      if (node.operator === "=") {
        const value = this.evaluate(node.value, env);
        env.assign(target.name, value, node.loc);
        return value;
      }
      const current = env.get(target.name, node.loc);
      const value = this.evaluate(node.value, env);
      const result = this.applyCompound(node.operator, current, value, node.loc);
      env.assign(target.name, result, node.loc);
      return result;
    }

    const container = this.evaluate(target.object, env);
    const key = this.evaluate(target.index, env);
    if (node.operator === "=") {
      const value = this.evaluate(node.value, env);
      this.setIndex(container, key, value, node.loc);
      return value;
    }
    const current = this.getIndex(container, key, node.loc);
    const value = this.evaluate(node.value, env);
    const result = this.applyCompound(node.operator, current, value, node.loc);
    this.setIndex(container, key, result, node.loc);
    return result;
  }

  applyCompound(operator, left, right, loc) {
    const base = operator.slice(0, 1);
    return this.applyBinaryOperator(base, left, right, loc);
  }

  /**
   * Build a user function. A *named* function expression may refer to itself,
   * so it gets its own scope holding its own name — which is exactly the
   * binding the semantic resolver creates for it.
   */
  makeFunction(name, params, body, env, loc) {
    if (!name) return new TFunction("", params, body, env, loc);
    const selfEnv = env.child();
    const fn = new TFunction(name, params, body, selfEnv, loc);
    selfEnv.set(name, fn, "fn");
    return fn;
  }

  evaluateCall(node, env) {
    const callee = this.evaluate(node.callee, env);
    const args = node.args.map((arg) => this.evaluate(arg, env));
    return this.callValue(callee, args, node.loc, node);
  }

  callValue(callee, args, loc, callNode = null) {
    if (callee instanceof TNativeFunction) {
      this.checkNativeArity(callee, args, loc);
      return callee.fn(args, this.context, loc, callNode);
    }
    if (callee instanceof TFunction) return this.callUserFunction(callee, args, loc);
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

  checkNativeArity(fn, args, loc) {
    const { minArgs, maxArgs } = fn;
    if (args.length < minArgs || (maxArgs !== null && args.length > maxArgs)) {
      const expected =
        maxArgs !== null && minArgs === maxArgs
          ? `${minArgs}`
          : maxArgs === null
            ? `at least ${minArgs}`
            : `${minArgs}-${maxArgs}`;
      throw new RuntimeFault(
        Code.ARITY_MISMATCH,
        `${fn.name}() expected ${expected} argument(s) but received ${args.length}`,
        loc,
        "Check the call site.",
      );
    }
  }

  callUserFunction(fn, args, loc) {
    if (args.length !== fn.params.length) {
      throw new RuntimeFault(
        Code.ARITY_MISMATCH,
        `${fn.name || "function"}() expected ${fn.params.length} argument(s) but received ${args.length}`,
        loc,
        "Check the number of arguments at the call site.",
      );
    }
    if (this.context.callStack.length >= this.context.limits.maxCallDepth) {
      throw new RuntimeFault(
        Code.DEPTH_LIMIT,
        `Maximum call depth of ${this.context.limits.maxCallDepth} exceeded`,
        loc,
        "Reduce recursion depth or check for runaway recursion.",
        this.context.stackFrames(),
      );
    }

    const callEnv = fn.closure.child();
    fn.params.forEach((param, i) => callEnv.set(param, args[i], "param"));
    this.context.callStack.push({ name: fn.name || "<anonymous>", loc });
    try {
      this.hoistFunctions(fn.body.body, callEnv);
      try {
        this.executeStatements(fn.body.body, callEnv, false);
      } catch (err) {
        if (err instanceof ReturnSignal) return err.value;
        throw err;
      }
      return NULL;
    } catch (err) {
      if (err instanceof RuntimeFault && err.typhounStack.length === 0) {
        err.typhounStack = this.context.stackFrames();
        if (!err.loc) err.loc = loc;
      }
      throw err;
    } finally {
      this.context.callStack.pop();
    }
  }

  getIndex(object, index, loc) {
    return getIndexValue(object, index, loc);
  }

  setIndex(object, index, value, loc) {
    setIndexValue(object, index, value, loc);
  }
}
