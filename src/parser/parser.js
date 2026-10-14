/**
 * Stage C — Parser.
 *
 * Strategy: recursive descent for statements and declarations, combined with
 * precedence climbing (a.k.a. Pratt-style binding-power parsing) for
 * expressions. This yields straightforward code, correct associativity and
 * easy extension.
 *
 * Error handling: the parser is panic-mode resilient. When a statement fails
 * to parse it records a diagnostic and synchronizes to the next plausible
 * statement boundary, so one source file can report many issues per pass.
 */
import { TokenType } from "../lexer/token.js";
import { nodes, NodeType } from "../ast/nodes.js";
import { DiagnosticBag, Diagnostic, Phase, TyphounError } from "../diagnostics/diagnostic.js";
import { Code } from "../diagnostics/codes.js";

/** Internal control-flow signal used for local parser recovery. */
class ParseError extends Error {}

/**
 * Raised when the source nests deeper than the parser allows. Unlike a
 * `ParseError` this is unrecoverable — there is no sensible place to resume —
 * so `parse` stops instead of trying to synchronize.
 */
class NestingLimitError extends Error {}

/**
 * The deepest the parser will descend into a statement or an expression.
 *
 * Recursive descent spends host stack frames proportional to this, and the
 * later stages (resolver, interpreter) walk the resulting tree the same way,
 * so it bounds every stage at once. It is set far below the depth at which the
 * JavaScript stack overflows (about a thousand levels of `((((…))))` on the
 * default stack) and far above any nesting a person writes by hand. Reaching
 * it is a diagnostic, never a host crash.
 */
export const MAX_NESTING_DEPTH = 256;

// Binding powers, lowest to highest. Assignment is handled separately so it
// can be right-associative and validated against assignable targets.
const BINARY_PRECEDENCE = new Map([
  [TokenType.OR, 1],
  [TokenType.AND, 2],
  [TokenType.EQEQ, 3],
  [TokenType.BANGEQ, 3],
  [TokenType.LT, 4],
  [TokenType.LTEQ, 4],
  [TokenType.GT, 4],
  [TokenType.GTEQ, 4],
  [TokenType.PLUS, 5],
  [TokenType.MINUS, 5],
  [TokenType.STAR, 6],
  [TokenType.SLASH, 6],
  [TokenType.PERCENT, 6],
]);

const ASSIGN_OPS = new Set([
  TokenType.EQUAL,
  TokenType.PLUSEQ,
  TokenType.MINUSEQ,
  TokenType.STAREQ,
  TokenType.SLASHEQ,
]);

const OPERATOR_SPELLING = Object.freeze({
  [TokenType.PLUS]: "+",
  [TokenType.MINUS]: "-",
  [TokenType.STAR]: "*",
  [TokenType.SLASH]: "/",
  [TokenType.PERCENT]: "%",
  [TokenType.EQEQ]: "==",
  [TokenType.BANGEQ]: "!=",
  [TokenType.LT]: "<",
  [TokenType.LTEQ]: "<=",
  [TokenType.GT]: ">",
  [TokenType.GTEQ]: ">=",
  [TokenType.AND]: "and",
  [TokenType.OR]: "or",
  [TokenType.EQUAL]: "=",
  [TokenType.PLUSEQ]: "+=",
  [TokenType.MINUSEQ]: "-=",
  [TokenType.STAREQ]: "*=",
  [TokenType.SLASHEQ]: "/=",
  [TokenType.NOT]: "not",
});

export class Parser {
  /**
   * @param {import("../lexer/token.js").Token[]} tokens
   */
  constructor(tokens) {
    this.tokens = tokens;
    this.current = 0;
    this.diagnostics = new DiagnosticBag();
    /** Current depth of recursive-descent nesting; checked in `statement`,
     *  `expression`, `assignment` and `unary` — the four methods that can
     *  recurse into themselves without passing through another. */
    this.depth = 0;
  }

  /** Record the "too deep" diagnostic and abandon the parse. */
  reportTooDeep(token) {
    this.error(
      Code.NESTING_TOO_DEEP,
      `Source nests more than ${MAX_NESTING_DEPTH} levels deep`,
      token,
      "Flatten the expression or split it into named steps.",
    );
    throw new NestingLimitError("nesting too deep");
  }

  /** @returns {object} a Program AST node (throws only on unrecoverable input) */
  parse() {
    const start = this.peek().location;
    const body = [];
    while (!this.check(TokenType.EOF)) {
      const before = this.current;
      try {
        const stmt = this.declaration();
        if (stmt) body.push(stmt);
      } catch (err) {
        if (err instanceof NestingLimitError) break;
        if (err instanceof ParseError) {
          this.synchronize();
          // Recovery must always make progress. A token that is itself a
          // synchronization point (a stray '}' is the usual one) leaves
          // `synchronize` standing still, and parsing would then retry the
          // same token forever. Skipping it is the only way forward.
          if (this.current === before) this.advance();
        } else {
          throw err;
        }
      }
    }
    const program = nodes.program(body, start);
    this.checkTreeDepth(body);
    return program;
  }

  /**
   * Reject a tree that nests deeper than the parser allows.
   *
   * The descent guard in `statement`/`expression`/… only sees recursion. A
   * long left-to-right chain such as `1 + 1 + … + 1` is built by a *loop*, so
   * it costs the parser no depth while still producing a tree as deep as the
   * chain is long — which the resolver, compiler and interpreter would then
   * walk recursively. This pass measures the tree with an explicit stack, so
   * it can find that without overflowing itself.
   */
  checkTreeDepth(body) {
    const stack = body.map((node) => ({ node, depth: 1 }));
    while (stack.length > 0) {
      const { node, depth } = stack.pop();
      if (!node || typeof node !== "object" || typeof node.type !== "string") continue;
      if (depth > MAX_NESTING_DEPTH) {
        this.error(
          Code.NESTING_TOO_DEEP,
          `Source nests more than ${MAX_NESTING_DEPTH} levels deep`,
          node.loc ?? this.peek(),
          "Flatten the expression or split it into named steps.",
        );
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "loc" || key === "binding" || key === "scopeDepth") continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === "object" && typeof item.type === "string") {
              stack.push({ node: item, depth: depth + 1 });
            }
          }
        } else if (value && typeof value === "object" && typeof value.type === "string") {
          stack.push({ node: value, depth: depth + 1 });
        }
      }
    }
  }

  /** Parse and throw a `TyphounError` when syntax diagnostics exist. */
  parseChecked() {
    const ast = this.parse();
    if (this.diagnostics.hasErrors) throw new TyphounError(this.diagnostics.errors);
    return ast;
  }

  // ------------------------------------------------------------- token utils

  peek(ahead = 0) {
    const i = Math.min(this.current + ahead, this.tokens.length - 1);
    return this.tokens[i];
  }

  previous() {
    return this.tokens[Math.max(0, this.current - 1)];
  }

  check(type) {
    return this.peek().type === type;
  }

  match(...types) {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  advance() {
    const token = this.peek();
    if (!this.check(TokenType.EOF)) this.current += 1;
    return token;
  }

  error(code, message, token, help = null, length) {
    const loc = token.location ?? token;
    this.diagnostics.add(
      new Diagnostic({
        code,
        phase: Phase.SYNTAX,
        message,
        location: length ? { ...loc, length } : loc,
        help,
      }),
    );
  }

  consume(type, code, message, help = null) {
    if (this.check(type)) return this.advance();
    const token = this.peek();
    this.error(code, message, token, help, Math.max(1, token.lexeme.length));
    throw new ParseError(message);
  }

  synchronize() {
    while (!this.check(TokenType.EOF)) {
      const type = this.peek().type;
      if (
        type === TokenType.LET ||
        type === TokenType.CONST ||
        type === TokenType.FN ||
        type === TokenType.IF ||
        type === TokenType.WHILE ||
        type === TokenType.FOR ||
        type === TokenType.RETURN ||
        type === TokenType.IMPORT ||
        type === TokenType.BREAK ||
        type === TokenType.CONTINUE ||
        type === TokenType.RBRACE
      ) {
        return;
      }
      this.advance();
    }
  }

  // -------------------------------------------------------------- statements

  declaration() {
    if (this.match(TokenType.LET)) return this.varDecl("let", this.previous());
    if (this.match(TokenType.CONST)) return this.varDecl("const", this.previous());
    if (this.match(TokenType.FN)) return this.fnDecl(this.previous());
    return this.statement();
  }

  varDecl(kind, keyword) {
    const nameTok = this.consume(
      TokenType.IDENTIFIER,
      Code.EXPECTED_TOKEN,
      `Expected a variable name after '${kind}'`,
      `Example: ${kind} name = 1`,
    );
    this.consume(
      TokenType.EQUAL,
      Code.EXPECTED_TOKEN,
      `Expected '=' after variable name '${nameTok.lexeme}'`,
      `Every '${kind}' binding must be initialized.`,
    );
    const init = this.expression();
    this.optionalSemicolon();
    return nodes.varDecl(kind, nameTok.lexeme, init, {
      ...keyword.location,
      length: nameTok.offset + nameTok.lexeme.length - keyword.offset,
    });
  }

  fnDecl(keyword) {
    const nameTok = this.consume(
      TokenType.IDENTIFIER,
      Code.EXPECTED_TOKEN,
      "Expected a function name after 'fn'",
      "Example: fn add(a, b) { return a + b }",
    );
    this.consume(
      TokenType.LPAREN,
      Code.EXPECTED_TOKEN,
      `Expected '(' after the function name '${nameTok.lexeme}'`,
    );
    const params = this.parseParameterList();
    const body = this.blockStatement();
    return nodes.fnDecl(nameTok.lexeme, params, body, keyword.location);
  }

  /** Parse `( a, b, c )` parameter lists for function declarations/expressions. */
  parseParameterList() {
    const params = [];
    if (!this.check(TokenType.RPAREN)) {
      do {
        const param = this.consume(
          TokenType.IDENTIFIER,
          Code.EXPECTED_TOKEN,
          "Expected a parameter name",
        );
        if (params.includes(param.lexeme)) {
          this.error(
            Code.DUPLICATE_PARAMETER,
            `Duplicate parameter '${param.lexeme}'`,
            param,
            "Rename one of the parameters.",
          );
        }
        params.push(param.lexeme);
      } while (this.match(TokenType.COMMA));
    }
    this.consume(TokenType.RPAREN, Code.EXPECTED_TOKEN, "Expected ')' after parameters");
    return params;
  }

  /** Anonymous (or named) function expression: fn (a) { ... } */
  fnExpression(keyword) {
    let name = null;
    if (this.check(TokenType.IDENTIFIER)) name = this.advance().lexeme;
    this.consume(TokenType.LPAREN, Code.EXPECTED_TOKEN, "Expected '(' after 'fn'");
    const params = this.parseParameterList();
    const body = this.blockStatement();
    return nodes.fnExpr(name, params, body, keyword.location);
  }

  statement() {
    this.depth += 1;
    try {
      if (this.depth > MAX_NESTING_DEPTH) this.reportTooDeep(this.peek());
      return this.statementBody();
    } finally {
      this.depth -= 1;
    }
  }

  statementBody() {
    if (this.check(TokenType.LBRACE)) return this.blockStatement();
    if (this.match(TokenType.IF)) return this.ifStatement(this.previous());
    if (this.match(TokenType.WHILE)) return this.whileStatement(this.previous());
    if (this.match(TokenType.FOR)) return this.forStatement(this.previous());
    if (this.match(TokenType.BREAK)) return this.breakStatement(this.previous());
    if (this.match(TokenType.CONTINUE)) return this.continueStatement(this.previous());
    if (this.match(TokenType.RETURN)) return this.returnStatement(this.previous());
    if (this.match(TokenType.IMPORT)) return this.importStatement(this.previous());
    if (this.match(TokenType.TRY)) return this.tryStatement(this.previous());
    return this.expressionStatement();
  }

  blockStatement() {
    const open = this.consume(TokenType.LBRACE, Code.EXPECTED_TOKEN, "Expected '{'");
    const body = [];
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      try {
        const stmt = this.declaration();
        if (stmt) body.push(stmt);
      } catch (err) {
        if (err instanceof ParseError) this.synchronize();
        else throw err;
      }
    }
    const close = this.consume(
      TokenType.RBRACE,
      Code.EXPECTED_TOKEN,
      "Expected '}' to close this block",
      "Check that every '{' has a matching '}'.",
    );
    // The location spans both braces, so tooling can tell what is *inside* an
    // empty block (a comment explaining it, for instance) from what follows it.
    return nodes.block(body, {
      ...open.location,
      length: Math.max(0, close.offset + close.lexeme.length - open.offset),
    });
  }

  ifStatement(keyword) {
    const test = this.expression();
    const consequent = this.blockStatement();
    let alternate = null;
    if (this.match(TokenType.ELSE)) {
      if (this.match(TokenType.IF)) alternate = this.ifStatement(this.previous());
      else alternate = this.blockStatement();
    }
    return nodes.ifStmt(test, consequent, alternate, keyword.location);
  }

  whileStatement(keyword) {
    const test = this.expression();
    const body = this.blockStatement();
    return nodes.whileStmt(test, body, keyword.location);
  }

  forStatement(keyword) {
    if (this.match(TokenType.LPAREN)) {
      // C-style: for (init; test; update) { ... }
      let init = null;
      if (!this.check(TokenType.SEMICOLON)) {
        if (this.match(TokenType.LET)) init = this.varDecl("let", this.previous());
        else if (this.match(TokenType.CONST)) init = this.varDecl("const", this.previous());
        else init = this.expressionStatement();
      } else {
        this.advance();
      }
      let test = null;
      if (!this.check(TokenType.SEMICOLON)) test = this.expression();
      this.consume(TokenType.SEMICOLON, Code.EXPECTED_TOKEN, "Expected ';' in the for header");
      let update = null;
      if (!this.check(TokenType.RPAREN)) update = this.expression();
      this.consume(TokenType.RPAREN, Code.EXPECTED_TOKEN, "Expected ')' to close the for header");
      const body = this.blockStatement();
      return nodes.forStmt(init, test, update, body, keyword.location);
    }

    // for-in: for name in iterable { ... }
    const nameTok = this.consume(
      TokenType.IDENTIFIER,
      Code.EXPECTED_TOKEN,
      "Expected a loop variable or '(' after 'for'",
      "Examples: for x in items { ... }  |  for (let i = 0; i < n; i += 1) { ... }",
    );
    this.consume(
      TokenType.IN,
      Code.EXPECTED_TOKEN,
      "Expected 'in' after the loop variable",
      "Example: for item in items { ... }",
    );
    const iterable = this.expression();
    const body = this.blockStatement();
    return nodes.forInStmt(nameTok.lexeme, iterable, body, keyword.location);
  }

  breakStatement(keyword) {
    // Placement (loop/function context) is validated by the semantic phase.
    this.optionalSemicolon();
    return nodes.breakStmt(keyword.location);
  }

  continueStatement(keyword) {
    this.optionalSemicolon();
    return nodes.continueStmt(keyword.location);
  }

  returnStatement(keyword) {
    let argument = null;
    if (
      !this.check(TokenType.SEMICOLON) &&
      !this.check(TokenType.RBRACE) &&
      !this.check(TokenType.EOF)
    ) {
      argument = this.expression();
    }
    this.optionalSemicolon();
    return nodes.returnStmt(argument, keyword.location);
  }

  /**
   * `try { ... } catch name { ... }`
   *
   * The handler name is required: a `catch` that cannot refer to the error it
   * caught is almost always a mistake, and `_` is available when the error is
   * deliberately ignored.
   */
  tryStatement(keyword) {
    const block = this.blockStatement();
    this.consume(
      TokenType.CATCH,
      Code.EXPECTED_TOKEN,
      "Expected 'catch' after the 'try' block",
      "Every 'try' needs a handler: try { ... } catch err { ... }",
    );
    const paramTok = this.consume(
      TokenType.IDENTIFIER,
      Code.EXPECTED_TOKEN,
      "Expected a name for the caught error after 'catch'",
      "Example: catch err { print(err.message) }",
    );
    const handler = this.blockStatement();
    return nodes.tryStmt(block, paramTok.lexeme, handler, keyword.location);
  }

  importStatement(keyword) {
    const pathTok = this.consume(
      TokenType.STRING,
      Code.EXPECTED_TOKEN,
      "Expected a module path string after 'import'",
      'Example: import "math.typ"',
    );
    let alias = null;
    if (this.match(TokenType.AS)) {
      const aliasTok = this.consume(
        TokenType.IDENTIFIER,
        Code.EXPECTED_TOKEN,
        "Expected a name after 'as'",
      );
      alias = aliasTok.lexeme;
    }
    this.optionalSemicolon();
    return nodes.importStmt(pathTok.value, alias, keyword.location);
  }

  expressionStatement() {
    const expr = this.expression();
    this.optionalSemicolon();
    return nodes.exprStmt(expr, expr.loc);
  }

  optionalSemicolon() {
    this.match(TokenType.SEMICOLON);
  }

  // ------------------------------------------------------------- expressions

  expression() {
    this.depth += 1;
    try {
      if (this.depth > MAX_NESTING_DEPTH) this.reportTooDeep(this.peek());
      return this.assignment();
    } finally {
      this.depth -= 1;
    }
  }

  assignment() {
    this.depth += 1;
    try {
      if (this.depth > MAX_NESTING_DEPTH) this.reportTooDeep(this.peek());
      return this.assignmentBody();
    } finally {
      this.depth -= 1;
    }
  }

  assignmentBody() {
    const target = this.or();
    const token = this.peek();
    if (ASSIGN_OPS.has(token.type)) {
      this.advance();
      if (
        target.type !== NodeType.Identifier &&
        target.type !== NodeType.IndexExpr
      ) {
        this.error(
          Code.INVALID_ASSIGNMENT_TARGET,
          "Invalid assignment target",
          token,
          "Assign to a variable name or an indexed element, e.g. x = 1 or items[0] = 1.",
        );
        throw new ParseError("invalid assignment target");
      }
      const value = this.assignment(); // right-associative
      return nodes.assignExpr(OPERATOR_SPELLING[token.type], target, value, target.loc);
    }
    return target;
  }

  or() {
    return this.binaryLevel(TokenType.OR);
  }

  binaryLevel(...types) {
    const precedence = Math.min(...types.map((t) => BINARY_PRECEDENCE.get(t)));
    let left = this.nextLevel(precedence);
    for (;;) {
      const type = this.peek().type;
      if (!types.includes(type)) return left;
      this.advance();
      const right = this.nextLevel(precedence);
      const operator = OPERATOR_SPELLING[type];
      left =
        type === TokenType.AND || type === TokenType.OR
          ? nodes.logicalExpr(operator, left, right, left.loc)
          : nodes.binaryExpr(operator, left, right, left.loc);
    }
  }

  /** Parse the level strictly above `precedence`. */
  nextLevel(precedence) {
    let left = this.unary();
    for (;;) {
      const type = this.peek().type;
      const p = BINARY_PRECEDENCE.get(type);
      if (p === undefined || p <= precedence) return left;
      this.advance();
      const right = this.nextLevel(p);
      const operator = OPERATOR_SPELLING[type];
      left =
        type === TokenType.AND || type === TokenType.OR
          ? nodes.logicalExpr(operator, left, right, left.loc)
          : nodes.binaryExpr(operator, left, right, left.loc);
    }
  }

  unary() {
    this.depth += 1;
    try {
      if (this.depth > MAX_NESTING_DEPTH) this.reportTooDeep(this.peek());
      if (this.match(TokenType.NOT, TokenType.MINUS)) {
        const operator = this.previous();
        const operand = this.unary();
        return nodes.unaryExpr(OPERATOR_SPELLING[operator.type], operand, operator.location);
      }
      return this.call();
    } finally {
      this.depth -= 1;
    }
  }

  call() {
    let expr = this.primary();
    for (;;) {
      if (this.match(TokenType.LPAREN)) {
        const args = [];
        if (!this.check(TokenType.RPAREN)) {
          do {
            args.push(this.expression());
          } while (this.match(TokenType.COMMA));
        }
        this.consume(
          TokenType.RPAREN,
          Code.EXPECTED_TOKEN,
          "Expected ')' after the argument list",
        );
        expr = nodes.callExpr(expr, args, expr.loc);
      } else if (this.match(TokenType.LBRACKET)) {
        const index = this.expression();
        this.consume(
          TokenType.RBRACKET,
          Code.EXPECTED_TOKEN,
          "Expected ']' after the index expression",
        );
        expr = nodes.indexExpr(expr, index, expr.loc);
      } else if (this.match(TokenType.DOT)) {
        // `obj.key` is sugar for `obj["key"]`.
        const keyTok = this.consume(
          TokenType.IDENTIFIER,
          Code.EXPECTED_TOKEN,
          "Expected a name after '.'",
          "Member access is written obj.key.",
        );
        expr = nodes.indexExpr(expr, nodes.stringLit(keyTok.lexeme, keyTok.location), expr.loc);
      } else {
        return expr;
      }
    }
  }

  primary() {
    const token = this.peek();

    if (this.match(TokenType.NUMBER)) {
      return nodes.numberLit(token.value, token.location);
    }
    if (this.match(TokenType.STRING)) {
      return nodes.stringLit(token.value, token.location);
    }
    if (this.match(TokenType.TRUE)) {
      return nodes.boolLit(true, token.location);
    }
    if (this.match(TokenType.FALSE)) {
      return nodes.boolLit(false, token.location);
    }
    if (this.match(TokenType.NULL)) {
      return nodes.nullLit(token.location);
    }
    if (this.match(TokenType.IDENTIFIER)) {
      return nodes.identifier(token.lexeme, token.location);
    }
    if (this.match(TokenType.LPAREN)) {
      const open = token;
      const expr = this.expression();
      this.consume(
        TokenType.RPAREN,
        Code.EXPECTED_TOKEN,
        "Expected ')' to close this expression",
      );
      return nodes.groupingExpr(expr, open.location);
    }
    if (this.match(TokenType.LBRACKET)) {
      return this.arrayLiteral(token);
    }
    if (this.match(TokenType.LBRACE)) {
      return this.mapLiteral(token);
    }
    if (this.match(TokenType.FN)) {
      return this.fnExpression(token);
    }

    this.error(
      Code.EXPECTED_EXPRESSION,
      `Expected an expression but found ${describeToken(token)}`,
      token,
      "A value, variable, call or literal was expected here.",
    );
    throw new ParseError("expected expression");
  }

  arrayLiteral(open) {
    const elements = [];
    if (!this.check(TokenType.RBRACKET)) {
      do {
        elements.push(this.expression());
      } while (this.match(TokenType.COMMA));
    }
    this.consume(TokenType.RBRACKET, Code.EXPECTED_TOKEN, "Expected ']' to close the array");
    return nodes.arrayLit(elements, open.location);
  }

  mapLiteral(open) {
    const entries = [];
    if (!this.check(TokenType.RBRACE)) {
      do {
        const keyTok = this.peek();
        if (!this.match(TokenType.STRING, TokenType.NUMBER)) {
          this.error(
            Code.EXPECTED_TOKEN,
            "Expected a string or number key in the map",
            keyTok,
            'Map keys are written like { "name": "Typhoun" }.',
          );
          throw new ParseError("expected map key");
        }
        const key = this.previous();
        const keyNode =
          key.type === TokenType.STRING
            ? nodes.stringLit(key.value, key.location)
            : nodes.numberLit(key.value, key.location);
        this.consume(
          TokenType.COLON,
          Code.EXPECTED_TOKEN,
          "Expected ':' after the map key",
          'Example: { "key": value }',
        );
        const value = this.expression();
        entries.push({ key: keyNode, value });
      } while (this.match(TokenType.COMMA));
    }
    this.consume(TokenType.RBRACE, Code.EXPECTED_TOKEN, "Expected '}' to close the map");
    return nodes.mapLit(entries, open.location);
  }
}

function describeToken(token) {
  switch (token.type) {
    case TokenType.EOF:
      return "the end of the file";
    case TokenType.STRING:
      return `string ${JSON.stringify(token.value)}`;
    case TokenType.NUMBER:
      return `number ${token.value}`;
    case TokenType.IDENTIFIER:
      return `'${token.lexeme}'`;
    default:
      return `'${token.lexeme}'`;
  }
}
