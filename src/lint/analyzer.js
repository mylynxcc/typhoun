/**
 * Lint — scope and usage analysis.
 *
 * One walk over the resolved AST produces everything the rules need: a list of
 * bindings with their read/write counts and shadowing relationships, plus
 * structural findings (unreachable code, constant conditions, redundant
 * parentheses, and so on). Rules are then pure functions over those facts, so
 * adding a rule never means walking the tree again.
 *
 * The usage counts are deliberately *flow-insensitive*: a binding is "used" when
 * it is read anywhere in its scope, including inside a nested function that is
 * never called. That keeps the warnings honest — it can miss dead code, but it
 * does not report a live binding as unused.
 *
 * `dead-store` is the one rule that needs order, so the same walk also carries a
 * small forward dataflow state: for each binding, the writes whose value could
 * still be read. A write replaces the previous ones in the same straight-line
 * sequence (its own function, outside any loop) and a read marks whatever is
 * live as read; a write left unread when its scope ends is dead. Where the order
 * of events is not knowable the binding is dropped from the analysis rather
 * than guessed at — see `deadStoreEligible` for the two exclusions and why they
 * are required for soundness.
 */
import { NodeType } from "../ast/nodes.js";

const LITERALS = new Set([
  NodeType.NumberLit,
  NodeType.StringLit,
  NodeType.BoolLit,
  NodeType.NullLit,
]);

/** Only `false` and `null` are falsy in Typhoun. */
function literalIsTruthy(node) {
  if (node.type === NodeType.BoolLit) return node.value;
  if (node.type === NodeType.NullLit) return false;
  return true;
}

function isTerminator(node) {
  return (
    node.type === NodeType.ReturnStmt ||
    node.type === NodeType.BreakStmt ||
    node.type === NodeType.ContinueStmt
  );
}

/** Rule names, kept here so the analyzer and the registry cannot drift. */
export const AnalyzerRules = Object.freeze({
  UNUSED_VARIABLE: "unused-variable",
  UNUSED_PARAMETER: "unused-parameter",
  UNUSED_FUNCTION: "unused-function",
  UNUSED_LOOP_VARIABLE: "unused-loop-variable",
  SHADOWED_VARIABLE: "shadowed-variable",
  PREFER_CONST: "prefer-const",
  UNREACHABLE_CODE: "unreachable-code",
  CONSTANT_CONDITION: "constant-condition",
  SELF_ASSIGNMENT: "self-assignment",
  REDUNDANT_PARENTHESES: "redundant-parentheses",
  DIVISION_BY_ZERO: "division-by-zero",
  EMPTY_BLOCK: "empty-block",
  DEAD_STORE: "dead-store",
});

/**
 * Whether a write to `binding` can be judged by execution order at all.
 *
 * Two exclusions keep the rule from ever reporting a value that is in fact
 * read:
 *
 * * **Captured** — the binding is read or written inside a nested function.
 *   `fn f() { print(x) }` says nothing about *when* it runs, so a later `x = 2`
 *   cannot be called an overwrite: `f` may already have read the old value.
 * * **Loop-exposed** — the binding is read or written inside a loop body. A
 *   value written at the end of one iteration is read at the top of the next,
 *   so source order does not describe the order the reads happen in.
 *
 * A binding nothing reads is left to `unused-variable`, which says it better
 * than "this value is never read" would.
 */
function deadStoreEligible(binding) {
  if (binding.error) return false;
  if (binding.kind === "fn") return false;
  if (binding.name.startsWith("_")) return false;
  if (binding.captured || binding.loopExposed) return false;
  if (binding.reads === 0) return false;
  return true;
}

/**
 * @param {object} ast
 * @param {{ comments?: Array<{offset: number, endOffset: number}> }} [options]
 * @returns {{ bindings: object[], findings: object[] }}
 */
export function analyze(ast, options = {}) {
  return new Analyzer(options).run(ast);
}

class Analyzer {
  constructor(options = {}) {
    /** @type {object[]} */
    this.bindings = [];
    /** @type {object[]} */
    this.findings = [];
    this.comments = options.comments ?? [];
    this.scope = null;
    this.inFunction = 0;
    /** @type {object[]} every write this walk could not prove live, pending the final filter */
    this.deadStores = [];
    /** @type {Map<object, object[]>} binding → writes whose value may still be read */
    this.live = new Map();
    /** Loop bodies currently being walked; a binding touched in one is excluded. */
    this.loopDepth = 0;
    /** Nested function bodies currently being walked, relative to the binding. */
    this.fnDepth = 0;
    /** Non-zero while walking statements proven unreachable, which never run. */
    this.unreachable = 0;
  }

  run(ast) {
    this.scope = { parent: null, vars: new Map() };
    this.visitBody(ast.body, this.scope, true);
    this.flushDeadStores();
    return { bindings: this.bindings, findings: this.findings };
  }

  // ------------------------------------------------------------------- flow

  /**
   * A read can see whatever value is live, so every live write becomes read.
   * The flags are shared between branch states on purpose: a read on *any* path
   * settles the question for the write, which is what keeps a value that one
   * branch reads from being reported as dead because another branch overwrote
   * it.
   */
  noteRead(binding) {
    if (!binding) return;
    if (this.loopDepth > 0) binding.loopExposed = true;
    if (binding.depth < this.fnDepth) binding.captured = true;
    if (this.unreachable > 0) return;
    const live = this.live.get(binding);
    if (!live) return;
    for (const write of live) write.read = true;
  }

  /**
   * Record a write, replacing the values still live before it when it runs
   * unconditionally in the binding's own function — inside a loop or a nested
   * function it is only one of several possible outcomes, so those values stay
   * live and the write is merely added to them.
   */
  noteWrite(binding, node) {
    if (!binding) return;
    if (this.loopDepth > 0) binding.loopExposed = true;
    if (binding.depth < this.fnDepth) binding.captured = true;
    if (this.unreachable > 0) return;
    if (this.loopDepth === 0 && this.fnDepth === binding.depth) this.retire(binding, "overwritten");
    const write = { binding, loc: this.storeLoc(node), read: false };
    const live = this.live.get(binding);
    if (live) live.push(write);
    else this.live.set(binding, [write]);
  }

  /**
   * The span a dead store is underlined with: the whole store, from the `let` or
   * the target through the value it assigns. A node's own location stops at its
   * name (`let a`, not `let a = 1`), which would point at the wrong thing for a
   * finding about the value.
   */
  storeLoc(node) {
    const written = node.type === NodeType.VarDecl ? node.init : node.value;
    const start = node.loc ?? fallbackLoc(node);
    if (!written) return start;
    const end = this.nodeEnd(written);
    return { ...start, length: Math.max(1, end - (start.offset ?? 0)) };
  }

  /** Move every live write of `binding` into the candidate list with `reason`. */
  retire(binding, reason) {
    const live = this.live.get(binding);
    if (!live) return;
    for (const write of live) {
      write.reason = reason;
      this.deadStores.push(write);
    }
    this.live.delete(binding);
  }

  /**
   * Report the writes of the bindings a closing scope owns: their values can no
   * longer be read by anything, because the names are gone.
   */
  closeScope(scope) {
    for (const binding of scope.vars.values()) this.retire(binding, "unread");
  }

  /** A copy of the live map, for the branch that is about to be walked. */
  snapshotLive() {
    const copy = new Map();
    for (const [binding, writes] of this.live) copy.set(binding, writes.slice());
    return copy;
  }

  /** The union of states a join point can arrive from, keyed by write identity. */
  mergeLive(states) {
    const merged = new Map();
    for (const state of states) {
      for (const [binding, writes] of state) {
        const target = merged.get(binding);
        if (!target) {
          merged.set(binding, writes.slice());
          continue;
        }
        for (const write of writes) if (!target.includes(write)) target.push(write);
      }
    }
    this.live = merged;
  }

  /** Emit the dead stores the walk found; the read flags are final by now. */
  flushDeadStores() {
    const emitted = new Set();
    for (const write of this.deadStores) {
      // A joined state can carry the same write into more than one arm, so a
      // write can be retired more than once; it is still one dead store.
      if (emitted.has(write)) continue;
      emitted.add(write);
      if (write.read || !deadStoreEligible(write.binding)) continue;
      this.report(
        AnalyzerRules.DEAD_STORE,
        write.loc,
        write.reason === "overwritten"
          ? "The value assigned here is overwritten before it is ever read"
          : "The value assigned here is never read",
        write.reason === "overwritten"
          ? "Delete this assignment, or read the value before it is replaced."
          : "Delete the assignment, or read the value it produces.",
      );
    }
  }

  // --------------------------------------------------------------- reporting

  report(rule, loc, message, help = null) {
    this.findings.push({ rule, loc, message, help });
  }

  /** True when a comment sits inside the source range of a node. */
  hasComment(node, end) {
    const from = node.loc?.offset ?? 0;
    const to = end ?? from + (node.loc?.length ?? 0);
    return this.comments.some((c) => c.offset >= from && c.offset < to);
  }

  /** End offset of a block, from its last statement or its own location. */
  blockEnd(block) {
    const last = block.body[block.body.length - 1];
    if (!last) return (block.loc?.offset ?? 0) + (block.loc?.length ?? 0);
    return this.nodeEnd(last);
  }

  nodeEnd(node) {
    let end = (node.loc?.offset ?? 0) + (node.loc?.length ?? 0);
    for (const child of this.childNodes(node)) end = Math.max(end, this.nodeEnd(child));
    return end;
  }

  *childNodes(node) {
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (!entry || typeof entry !== "object") continue;
          if (entry.key) {
            yield entry.key;
            if (entry.value) yield entry.value;
          } else {
            yield entry;
          }
        }
      } else if (value && typeof value === "object") {
        yield value;
      }
    }
  }

  // ------------------------------------------------------------------ scopes

  pushScope() {
    this.scope = { parent: this.scope, vars: new Map() };
    return this.scope;
  }

  popScope() {
    this.scope = this.scope.parent;
  }

  resolve(name) {
    let scope = this.scope;
    while (scope) {
      const binding = scope.vars.get(name);
      if (binding) return binding;
      scope = scope.parent;
    }
    return null;
  }

  outerScopeWith(name) {
    let scope = this.scope.parent;
    while (scope) {
      if (scope.vars.has(name)) return scope.vars.get(name);
      scope = scope.parent;
    }
    return null;
  }

  declare(name, kind, node, options = {}) {
    const binding = {
      name,
      kind,
      node,
      loc: node.loc,
      reads: 0,
      writes: 0,
      // The function nesting this name was declared in, and the two reasons a
      // write to it cannot be ordered against its reads (see
      // `deadStoreEligible`).
      depth: this.fnDepth,
      captured: false,
      loopExposed: false,
      topLevel: options.topLevel === true,
      loop: options.loop === true,
      // A `catch` binding: not reading it is how a program says "ignore this
      // error", so it is never reported as unused.
      error: options.error === true,
    };
    if (!name.startsWith("_")) {
      const outer = this.outerScopeWith(name);
      if (outer) {
        this.report(
          AnalyzerRules.SHADOWED_VARIABLE,
          node.loc,
          `'${name}' shadows an outer binding of the same name`,
          "Rename one of the two bindings so it is clear which one is meant.",
        );
      }
    }
    this.scope.vars.set(name, binding);
    this.bindings.push(binding);
    return binding;
  }

  reference(node, { write = false } = {}) {
    const binding = this.resolve(node.name);
    if (!binding) return null;
    if (write) binding.writes += 1;
    else {
      binding.reads += 1;
      this.noteRead(binding);
    }
    return binding;
  }

  /**
   * Record a write against the binding an assignment target is rooted at.
   *
   * `items[0] = x` and `user.level += 1` mutate the value held by `items` /
   * `user`; without this, the ``prefer-const`` rule would tell the reader to
   * freeze a binding that is plainly being written to.
   */
  referenceTarget(node) {
    let target = node;
    while (target && target.type === NodeType.IndexExpr) target = target.object;
    if (!target || target.type !== NodeType.Identifier) return;
    const binding = this.reference(target, { write: true });
    // Mutating what a binding holds counts as *using* the value it holds —
    // `items[0] = 2` reads the array it then writes into — so the write this
    // looks like to `prefer-const` is a read as far as dead stores are
    // concerned. A mutation is never itself a dead store.
    this.noteRead(binding);
  }

  // ------------------------------------------------------------- statements

  /** Visit a statement list in a new scope, hoisting function declarations. */
  visitBody(body, scope, topLevel = false) {
    const previous = this.scope;
    this.scope = scope;
    for (const statement of body) {
      if (statement.type === NodeType.FnDecl) {
        this.declare(statement.name, "fn", statement, { topLevel });
      }
    }

    let terminated = null;
    let reported = false;
    const inheritedUnreachable = this.unreachable;
    for (const statement of body) {
      if (terminated) {
        if (!reported) {
          reported = true;
          this.report(
            AnalyzerRules.UNREACHABLE_CODE,
            statement.loc,
            `This code is unreachable: the ${terminatorWord(terminated)} above always leaves this block first`,
            "Delete it, or move it before the terminating statement.",
          );
        }
        // Nothing after a terminator runs, so none of it reads or writes
        // anything as far as the flow analysis is concerned.
        this.unreachable = inheritedUnreachable + 1;
      }
      this.visitStatement(statement);
      if (isTerminator(statement)) terminated = statement;
    }
    this.unreachable = inheritedUnreachable;
    this.scope = previous;
    this.closeScope(scope);
  }

  visitStatement(node) {
    switch (node.type) {
      case NodeType.VarDecl: {
        const binding = this.declare(node.name, node.kind, node, {
          topLevel: this.scope.parent === null,
        });
        if (node.init) {
          this.visitExpression(node.init);
          // The value the declaration gives the name is a store like any other,
          // and `let x = 1` followed by `x = 2` is the commonest dead store of
          // all.
          this.noteWrite(binding, node);
        }
        return;
      }
      case NodeType.FnDecl:
        // The name was already bound by the enclosing body (hoisting), so the
        // function scope must not declare a second one — that would make every
        // recursive function look unreferenced.
        this.visitFunction(node.name, node.params, node.body, node, false);
        return;
      case NodeType.ExprStmt:
        this.visitExpression(node.expression);
        return;
      case NodeType.Block:
        this.visitBody(node.body, this.childScope(), false);
        this.checkEmptyBlock(node, "block");
        return;
      case NodeType.IfStmt: {
        this.checkCondition(node.test, "if");
        this.visitExpression(node.test);
        // Each arm is walked from the state the test left behind, and what
        // survives the join is what survived in *either* arm. A write killed
        // inside one arm stays a candidate unless some other arm reads the
        // value it replaced.
        const before = this.snapshotLive();
        this.visitBranch(node.consequent, "if branch");
        const consequent = this.snapshotLive();
        if (node.alternate) {
          this.live = before;
          if (node.alternate.type === NodeType.IfStmt) this.visitStatement(node.alternate);
          else this.visitBranch(node.alternate, "else branch");
          this.mergeLive([consequent, this.live]);
        } else {
          this.mergeLive([before, consequent]);
        }
        return;
      }
      case NodeType.WhileStmt:
        this.checkCondition(node.test, "while");
        this.loopDepth += 1;
        this.visitExpression(node.test);
        this.visitBranch(node.body, "loop body");
        this.loopDepth -= 1;
        return;
      case NodeType.ForInStmt: {
        this.visitExpression(node.iterable);
        const scope = this.childScope();
        const previous = this.scope;
        this.scope = scope;
        this.declare(node.variable, "let", node, { loop: true });
        this.loopDepth += 1;
        this.visitBody(node.body.body, this.childScope(), false);
        this.loopDepth -= 1;
        this.checkEmptyBlock(node.body, "loop body");
        this.closeScope(scope);
        this.scope = previous;
        return;
      }
      case NodeType.TryStmt: {
        // The guarded block is a scope of its own. An empty *try* block is a
        // finding; an empty *handler* is not — ignoring an error is exactly
        // what `catch err {}` means, so it needs no comment to justify itself.
        //
        // The handler can run at any point inside the guarded block, so it is
        // walked from whatever was live before the block *and* whatever the
        // block left behind: a read there settles the writes from either.
        const before = this.snapshotLive();
        this.visitBranch(node.block, "try block");
        const guarded = this.snapshotLive();
        this.mergeLive([before, guarded]);
        const scope = this.childScope();
        const previous = this.scope;
        this.scope = scope;
        this.declare(node.param, "let", node, { error: true });
        this.visitBody(node.handler.body, this.childScope(), false);
        this.closeScope(scope);
        this.scope = previous;
        this.mergeLive([guarded, this.live]);
        return;
      }
      case NodeType.ForStmt: {
        const scope = this.childScope();
        const previous = this.scope;
        this.scope = scope;
        if (node.init) {
          if (node.init.type === NodeType.VarDecl) {
            const binding = this.declare(node.init.name, node.init.kind, node.init);
            if (node.init.init) {
              this.visitExpression(node.init.init);
              this.noteWrite(binding, node.init);
            }
          } else {
            this.visitStatement(node.init);
          }
        }
        this.loopDepth += 1;
        if (node.test) {
          this.checkCondition(node.test, "while");
          this.visitExpression(node.test);
        }
        if (node.update) this.visitExpression(node.update);
        this.visitBody(node.body.body, this.childScope(), false);
        this.loopDepth -= 1;
        this.checkEmptyBlock(node.body, "loop body");
        this.closeScope(scope);
        this.scope = previous;
        return;
      }
      case NodeType.ReturnStmt:
        if (node.argument) this.visitExpression(node.argument);
        return;
      case NodeType.BreakStmt:
      case NodeType.ContinueStmt:
      case NodeType.ImportStmt:
        return;
      default:
        return;
    }
  }

  childScope() {
    return { parent: this.scope, vars: new Map() };
  }

  visitBranch(block, label) {
    if (block.type !== NodeType.Block) {
      this.visitStatement(block);
      return;
    }
    this.visitBody(block.body, this.childScope(), false);
    this.checkEmptyBlock(block, label);
  }

  visitFunction(name, params, body, node, declareName = true) {
    const scope = this.childScope();
    const previous = this.scope;
    this.scope = scope;
    // Parameters and the body belong to the function's own nesting level, so the
    // depth is raised before either is declared: a write to a parameter by the
    // body is an ordinary store, not a write from somewhere else.
    this.fnDepth += 1;
    if (name && declareName) this.declare(name, "fn", node);
    for (const param of params) {
      // Parameters have no node of their own; the declaration site is the
      // function itself.
      const binding = {
        name: param,
        kind: "param",
        node,
        loc: node.loc,
        reads: 0,
        writes: 0,
        depth: this.fnDepth,
        captured: false,
        loopExposed: false,
        parameter: true,
      };
      if (!param.startsWith("_")) {
        const outer = this.outerScopeWith(param);
        if (outer) {
          this.report(
            AnalyzerRules.SHADOWED_VARIABLE,
            node.loc,
            `Parameter '${param}' shadows an outer binding of the same name`,
            "Rename one of the two bindings so it is clear which one is meant.",
          );
        }
      }
      scope.vars.set(param, binding);
      this.bindings.push(binding);
    }
    this.inFunction += 1;
    this.visitBody(body.body, this.childScope(), false);
    this.inFunction -= 1;
    // The parameter scope closes with the body, so unread parameters count as
    // gone exactly when the function returns.
    this.closeScope(scope);
    this.fnDepth -= 1;
    // An empty function body is a deliberate stub (`fn noop() {}`), unlike an
    // empty branch or loop body, which is almost always a mistake. It is not
    // reported.
    this.scope = previous;
  }

  // ------------------------------------------------------------ expressions

  visitExpression(node) {
    switch (node.type) {
      case NodeType.Identifier:
        this.reference(node);
        return;
      case NodeType.NumberLit:
      case NodeType.StringLit:
      case NodeType.BoolLit:
      case NodeType.NullLit:
      case NodeType.ImportStmt:
        return;
      case NodeType.GroupingExpr:
        this.checkParentheses(node);
        this.visitExpression(node.expression);
        return;
      case NodeType.UnaryExpr:
        this.visitExpression(node.operand);
        return;
      case NodeType.BinaryExpr:
        this.checkLiteralDivision(node);
        this.visitExpression(node.left);
        this.visitExpression(node.right);
        return;
      case NodeType.LogicalExpr:
        this.visitExpression(node.left);
        this.visitExpression(node.right);
        return;
      case NodeType.AssignExpr:
        this.visitAssignment(node);
        return;
      case NodeType.ArrayLit:
        for (const element of node.elements) this.visitExpression(element);
        return;
      case NodeType.MapLit:
        for (const entry of node.entries) {
          this.visitExpression(entry.key);
          this.visitExpression(entry.value);
        }
        return;
      case NodeType.CallExpr:
        this.visitExpression(node.callee);
        for (const argument of node.args) this.visitExpression(argument);
        return;
      case NodeType.IndexExpr:
        this.visitExpression(node.object);
        this.visitExpression(node.index);
        return;
      case NodeType.FnExpr:
        // A named function expression can refer to itself, so its own scope
        // owns the binding.
        this.visitFunction(node.name, node.params, node.body, node, true);
        return;
      default:
        return;
    }
  }

  visitAssignment(node) {
    const compound = node.operator !== "=";
    const selfAssignment =
      node.value.type === NodeType.Identifier && node.value.name === node.target.name;
    let binding = null;
    if (node.target.type === NodeType.Identifier) {
      // `x += 1` reads the value it is about to replace, so it is a read of the
      // live writes before it is a write of its own.
      if (compound) this.reference(node.target, { write: false });
      binding = this.reference(node.target, { write: true });
      if (!compound && selfAssignment) {
        this.report(
          AnalyzerRules.SELF_ASSIGNMENT,
          node.loc,
          `'${node.target.name}' is assigned to itself`,
          "Delete the statement, or assign the value that was actually meant.",
        );
      }
    } else {
      this.referenceTarget(node.target);
      this.visitExpression(node.target);
    }
    // The right-hand side runs before the store does, so a read in it reads the
    // value the store is about to replace: `out = out * 2` uses `out`.
    this.visitExpression(node.value);
    // `x = x` is `self-assignment`'s finding under its own name; recording it as
    // a store as well would report the same line twice.
    if (binding && !selfAssignment) this.noteWrite(binding, node);
  }

  // ------------------------------------------------------- structural checks

  checkParentheses(node) {
    const REDUNDANT = new Set([
      NodeType.NumberLit,
      NodeType.StringLit,
      NodeType.BoolLit,
      NodeType.NullLit,
      NodeType.Identifier,
      NodeType.ArrayLit,
      NodeType.MapLit,
      NodeType.CallExpr,
      NodeType.IndexExpr,
      NodeType.FnExpr,
      NodeType.GroupingExpr,
    ]);
    if (!REDUNDANT.has(node.expression.type)) return;
    this.report(
      AnalyzerRules.REDUNDANT_PARENTHESES,
      node.loc,
      "These parentheses do not change how the expression is read",
      "Remove them; operator precedence already gives this grouping.",
    );
  }

  checkLiteralDivision(node) {
    if (node.operator !== "/" && node.operator !== "%") return;
    if (node.right.type !== NodeType.NumberLit || node.right.value !== 0) return;
    const word = node.operator === "/" ? "Division" : "Modulo";
    this.report(
      AnalyzerRules.DIVISION_BY_ZERO,
      node.loc,
      `${word} by a literal zero always fails at runtime`,
      `Replace the zero divisor, or guard the operation with a check.`,
    );
  }

  checkCondition(test, kind) {
    if (!LITERALS.has(test.type)) return;
    const truthy = literalIsTruthy(test);
    // `while true { ... break }` is the idiomatic way to write an infinite
    // loop, so it is not reported.
    if (kind === "while" && test.type === NodeType.BoolLit && test.value === true) return;
    const which = kind === "while" ? "This loop" : "This condition";
    const reason = truthy
      ? "is always true, because only 'false' and 'null' are falsy"
      : "is always false, because only 'false' and 'null' are falsy";
    this.report(
      AnalyzerRules.CONSTANT_CONDITION,
      test.loc,
      `${which} ${reason}`,
      kind === "while"
        ? "Use a real condition, or write 'while true' if the loop is meant to run forever."
        : "Remove the branch, or use the condition that was meant.",
    );
  }

  checkEmptyBlock(block, label) {
    if (block.body.length !== 0) return;
    if (this.hasComment(block, this.blockEnd(block))) return;
    this.report(
      AnalyzerRules.EMPTY_BLOCK,
      block.loc,
      `This ${label} is empty, so it does nothing`,
      "Remove it, or fill in the body it was meant to have.",
    );
  }
}

/** A fallback location when a node carries none of its own. */
function fallbackLoc(node) {
  return node.loc ?? node.target?.loc ?? node.init?.loc ?? { offset: 0, line: 1, column: 1, length: 1 };
}

function terminatorWord(node) {
  return node.type === NodeType.ReturnStmt ? "'return'" : `'${node.type === NodeType.BreakStmt ? "break" : "continue"}'`;
}
