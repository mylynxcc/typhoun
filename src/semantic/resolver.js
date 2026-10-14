/**
 * Stage E — Semantic analysis and resolver.
 *
 * The resolver walks the AST before execution and:
 *   - builds a lexical scope chain,
 *   - detects duplicate declarations in the same scope,
 *   - rejects reads before a declaration (temporal dead zone),
 *   - rejects reassignment of `const` bindings,
 *   - validates `return`/`break`/`continue` placement,
 *   - reports references to names that are not defined anywhere.
 *
 * Typhoun is dynamically typed, so this stage performs *no* type checking.
 * It also annotates each resolved `Identifier` with an informational binding
 * descriptor (`node.binding`, `node.scopeDepth`) for tooling; the runtime
 * performs its own linked-environment lookup.
 */
import { NodeType } from "../ast/nodes.js";
import { DiagnosticBag, Diagnostic, Phase, TyphounError } from "../diagnostics/diagnostic.js";
import { Code } from "../diagnostics/codes.js";

const BINDING_KIND = Object.freeze({
  LET: "let",
  CONST: "const",
  FN: "fn",
  PARAM: "param",
  IMPORT: "import",
  BUILDIN: "builtin",
  GLOBAL: "global",
});

class Scope {
  constructor() {
    /** @type {Map<string, {kind: string, node: object, initialized: boolean}>} */
    this.bindings = new Map();
  }
}

export class Resolver {
  /**
   * @param {object} [options]
   * @param {Set<string>} [options.globals] Names available without declaration
   *        (built-ins plus merged import exports).
   */
  constructor(options = {}) {
    this.diagnostics = new DiagnosticBag();
    /** @type {Scope[]} */
    this.scopes = [];
    this.globals = options.globals ?? new Set();
    this.functionDepth = 0;
    this.loopDepth = 0;
  }

  /** Resolve a whole program. @returns {DiagnosticBag} */
  resolve(program) {
    this.scopes = [];
    this.beginScope();
    this.resolveBlockBody(program.body, false);
    this.endScope();
    return this.diagnostics;
  }

  resolveChecked(program) {
    const bag = this.resolve(program);
    if (bag.hasErrors) throw new TyphounError(bag.errors);
    return bag;
  }

  // ------------------------------------------------------------------ scopes

  beginScope() {
    this.scopes.push(new Scope());
  }

  endScope() {
    this.scopes.pop();
  }

  get currentScope() {
    return this.scopes[this.scopes.length - 1];
  }

  declare(name, kind, node) {
    const existing = this.currentScope.bindings.get(name);
    if (existing) {
      this.report(
        Code.DUPLICATE_DECLARATION,
        `Duplicate declaration of '${name}' in the same scope`,
        node,
        "Use a different name or remove the earlier declaration.",
      );
      return;
    }
    this.currentScope.bindings.set(name, { kind, node, initialized: false });
  }

  markInitialized(name) {
    const binding = this.currentScope.bindings.get(name);
    if (binding) binding.initialized = true;
  }

  /** Look a name up across the scope chain (innermost first). */
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const binding = this.scopes[i].bindings.get(name);
      if (binding) return { binding, depth: this.scopes.length - 1 - i };
    }
    return null;
  }

  report(code, message, node, help = null) {
    this.diagnostics.add(
      new Diagnostic({
        code,
        phase: Phase.SEMANTIC,
        message,
        location: node.loc ?? node.location ?? null,
        help,
      }),
    );
  }

  // -------------------------------------------------------------- statements

  /**
   * Resolve a list of statements as one lexical block.
   * @param {object[]} body
   * @param {boolean} ownScope Whether to open a nested scope (blocks do).
   */
  resolveBlockBody(body, ownScope) {
    if (ownScope) this.beginScope();

    // Pass 1 — declare everything in the block up front. Function
    // declarations are hoisted *initialized* so mutual recursion works;
    // `let`/`const` bindings are declared uninitialized so later reads can be
    // diagnosed as uses before declaration.
    for (const stmt of body) {
      if (stmt.type === NodeType.FnDecl) this.declare(stmt.name, BINDING_KIND.FN, stmt);
    }
    for (const stmt of body) {
      if (stmt.type === NodeType.VarDecl) this.declare(stmt.name, stmt.kind, stmt);
    }
    for (const stmt of body) {
      if (stmt.type === NodeType.FnDecl) this.markInitialized(stmt.name);
    }

    // Pass 2 — resolve initializers, bodies and references.
    for (const stmt of body) this.resolveStatement(stmt);

    if (ownScope) this.endScope();
  }

  resolveStatement(stmt) {
    switch (stmt.type) {
      case NodeType.VarDecl:
        this.resolveExpression(stmt.init);
        // Already declared by the block pre-pass; loop headers declare here.
        if (!this.currentScope.bindings.has(stmt.name)) {
          this.declare(stmt.name, stmt.kind, stmt);
        }
        this.markInitialized(stmt.name);
        break;

      case NodeType.FnDecl:
        this.resolveFunction(stmt);
        break;

      case NodeType.ExprStmt:
        this.resolveExpression(stmt.expression);
        break;

      case NodeType.Block:
        this.resolveBlockBody(stmt.body, true);
        break;

      case NodeType.IfStmt:
        this.resolveExpression(stmt.test);
        this.resolveNested(stmt.consequent);
        if (stmt.alternate) this.resolveNested(stmt.alternate);
        break;

      case NodeType.WhileStmt:
        this.resolveExpression(stmt.test);
        this.loopDepth += 1;
        this.resolveNested(stmt.body);
        this.loopDepth -= 1;
        break;

      case NodeType.ForInStmt:
        this.resolveExpression(stmt.iterable);
        this.beginScope();
        this.declare(stmt.variable, BINDING_KIND.LET, stmt);
        this.markInitialized(stmt.variable);
        this.loopDepth += 1;
        this.resolveNested(stmt.body);
        this.loopDepth -= 1;
        this.endScope();
        break;

      case NodeType.ForStmt: {
        this.beginScope();
        if (stmt.init) this.resolveStatement(stmt.init);
        if (stmt.test) this.resolveExpression(stmt.test);
        if (stmt.update) this.resolveExpression(stmt.update);
        this.loopDepth += 1;
        this.resolveNested(stmt.body);
        this.loopDepth -= 1;
        this.endScope();
        break;
      }

      case NodeType.TryStmt: {
        // The guarded block is its own scope, so nothing it declares leaks
        // into the handler. `break`, `continue` and `return` are *not*
        // confined by a `try`: the handler finishes the statement, not the
        // loop or the function, so the surrounding context is unchanged.
        this.resolveNested(stmt.block);
        this.beginScope();
        this.declare(stmt.param, BINDING_KIND.LET, stmt);
        this.markInitialized(stmt.param);
        this.resolveNested(stmt.handler);
        this.endScope();
        break;
      }

      case NodeType.BreakStmt:
        if (this.loopDepth === 0) {
          this.report(
            Code.CONTROL_OUTSIDE_LOOP,
            "'break' used outside of a loop",
            stmt,
            "Place it inside a 'while' or 'for' loop.",
          );
        }
        break;

      case NodeType.ContinueStmt:
        if (this.loopDepth === 0) {
          this.report(
            Code.CONTROL_OUTSIDE_LOOP,
            "'continue' used outside of a loop",
            stmt,
            "Place it inside a 'while' or 'for' loop.",
          );
        }
        break;

      case NodeType.ReturnStmt:
        if (this.functionDepth === 0) {
          this.report(
            Code.RETURN_OUTSIDE_FUNCTION,
            "'return' used outside of a function",
            stmt,
            "Move the statement into an 'fn' body.",
          );
        }
        if (stmt.argument) this.resolveExpression(stmt.argument);
        break;

      case NodeType.ImportStmt:
        // Names merged by an import are supplied to the resolver up front via
        // `globals`; here we only validate the reference shape.
        if (!stmt.path || typeof stmt.path !== "string") {
          this.report(Code.IMPORT_MISUSE, "Invalid import path", stmt);
        }
        break;

      default:
        this.report(
          Code.UNEXPECTED_TOKEN,
          `Resolver encountered an unsupported statement '${stmt.type}'`,
          stmt,
        );
    }
  }

  resolveNested(node) {
    if (!node) return;
    if (node.type === NodeType.Block) this.resolveBlockBody(node.body, true);
    else this.resolveStatement(node);
  }

  resolveFunction(fn) {
    this.beginScope();
    // A named function *expression* may refer to itself recursively.
    if (fn.type === NodeType.FnExpr && fn.name) {
      this.currentScope.bindings.set(fn.name, {
        kind: BINDING_KIND.FN,
        node: fn,
        initialized: true,
      });
    }
    for (const param of fn.params) {
      const existing = this.currentScope.bindings.get(param);
      if (existing) {
        this.report(
          Code.DUPLICATE_PARAMETER,
          `Duplicate parameter '${param}'`,
          fn,
          "Rename one of the parameters.",
        );
      } else {
        this.currentScope.bindings.set(param, {
          kind: BINDING_KIND.PARAM,
          node: fn,
          initialized: true,
        });
      }
    }
    this.functionDepth += 1;
    this.resolveBlockBody(fn.body.body, false);
    this.functionDepth -= 1;
    this.endScope();
  }

  // ------------------------------------------------------------- expressions

  resolveExpression(expr) {
    switch (expr.type) {
      case NodeType.NumberLit:
      case NodeType.StringLit:
      case NodeType.BoolLit:
      case NodeType.NullLit:
        return;

      case NodeType.Identifier:
        this.resolveIdentifier(expr);
        return;

      case NodeType.ArrayLit:
        for (const el of expr.elements) this.resolveExpression(el);
        return;

      case NodeType.MapLit:
        for (const entry of expr.entries) {
          this.resolveExpression(entry.key);
          this.resolveExpression(entry.value);
        }
        return;

      case NodeType.UnaryExpr:
        this.resolveExpression(expr.operand);
        return;

      case NodeType.BinaryExpr:
      case NodeType.LogicalExpr:
        this.resolveExpression(expr.left);
        this.resolveExpression(expr.right);
        return;

      case NodeType.GroupingExpr:
        this.resolveExpression(expr.expression);
        return;

      case NodeType.AssignExpr:
        this.resolveAssignmentTarget(expr);
        this.resolveExpression(expr.value);
        return;

      case NodeType.FnExpr:
        this.resolveFunction(expr);
        return;

      case NodeType.CallExpr:
        this.resolveExpression(expr.callee);
        for (const arg of expr.args) this.resolveExpression(arg);
        return;

      case NodeType.IndexExpr:
        this.resolveExpression(expr.object);
        this.resolveExpression(expr.index);
        return;

      default:
        this.report(
          Code.UNEXPECTED_TOKEN,
          `Resolver encountered an unsupported expression '${expr.type}'`,
          expr,
        );
    }
  }

  resolveIdentifier(expr) {
    const found = this.lookup(expr.name);
    if (!found) {
      if (this.globals.has(expr.name)) {
        expr.binding = { kind: BINDING_KIND.GLOBAL, name: expr.name };
        expr.scopeDepth = null;
        return;
      }
      this.report(
        Code.UNDEFINED_VARIABLE,
        `Undefined variable '${expr.name}'`,
        expr,
        `Declare '${expr.name}' before using it, or check for a typo.`,
      );
      return;
    }
    const { binding, depth } = found;
    // Only flag reads in code that runs immediately. Inside a function body a
    // reference may legally be resolved later, when the closure is called.
    if (!binding.initialized && this.functionDepth === 0) {
      this.report(
        Code.USED_BEFORE_DECLARATION,
        `'${expr.name}' is used before its declaration`,
        expr,
        `Move the declaration of '${expr.name}' above this line.`,
      );
    }
    expr.binding = { kind: binding.kind, name: expr.name };
    expr.scopeDepth = depth;
  }

  resolveAssignmentTarget(expr) {
    const target = expr.target;
    if (target.type === NodeType.Identifier) {
      const found = this.lookup(target.name);
      if (!found) {
        if (this.globals.has(target.name)) {
          this.report(
            Code.CONST_REASSIGNMENT,
            `Cannot assign to the read-only global '${target.name}'`,
            target,
            "Assign to a variable you declared with 'let'.",
          );
          return;
        }
        this.report(
          Code.UNDEFINED_VARIABLE,
          `Undefined variable '${target.name}'`,
          target,
          `Declare '${target.name}' with 'let' before assigning to it.`,
        );
        return;
      }
      const { binding } = found;
      // A target that resolves to a binding still in its temporal dead zone is
      // rejected here, in the resolver, so both execution engines agree. The
      // two runtimes otherwise differ: the tree-walker looks the name up
      // dynamically and cannot see a `let` that has not run yet, while the
      // compiler allocates its slot up front. `+=` and friends read the target
      // as well as writing it, so this is the same "used before declaration"
      // error as a plain read. As with reads, references inside a function
      // body may legally be resolved later, when the closure is called.
      if (!binding.initialized && this.functionDepth === 0) {
        this.report(
          Code.USED_BEFORE_DECLARATION,
          `'${target.name}' is used before its declaration`,
          target,
          `Move the declaration of '${target.name}' above this line.`,
        );
        return;
      }
      if (binding.kind === BINDING_KIND.CONST) {
        this.report(
          Code.CONST_REASSIGNMENT,
          `Cannot assign to constant '${target.name}'`,
          target,
          "Declare it with 'let' if it needs to change.",
        );
      } else if (binding.kind === BINDING_KIND.FN) {
        this.report(
          Code.CONST_REASSIGNMENT,
          `Cannot assign to function '${target.name}'`,
          target,
          "Functions are bindings; declare a new 'let' variable instead.",
        );
      }
      target.binding = { kind: binding.kind, name: target.name };
    } else if (target.type === NodeType.IndexExpr) {
      this.resolveExpression(target.object);
      this.resolveExpression(target.index);
    }
  }
}

/** Built-in names always available to Typhoun programs. */
export function builtinNames() {
  return new Set(GLOBALS);
}

const GLOBALS = [
  "print",
  "input",
  "len",
  "type",
  "str",
  "num",
  "bool",
  "range",
  "push",
  "pop",
  "keys",
  "values",
  "has",
  "remove",
  "join",
  "split",
  "upper",
  "lower",
  "trim",
  "contains",
  "abs",
  "floor",
  "ceil",
  "round",
  "sqrt",
  "min",
  "max",
  "pow",
  "random",
  "assert",
];
