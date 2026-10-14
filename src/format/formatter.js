/**
 * Canonical source formatter (`typhoun fmt`).
 *
 * The formatter walks the parsed AST and prints it back with a single,
 * canonical layout. It is a printer, not a pretty-printer with knobs to burn:
 * the only inputs that influence the output are the tree, the comments, the
 * indentation unit and the line width. That is what makes the transform
 * idempotent — running it twice cannot produce a third, different result.
 *
 * Rules
 * -----
 *  - one statement per line, four-space indentation, no semicolons, no
 *    parentheses added or removed;
 *  - blocks always span lines (`if x {` … `}`); an empty block collapses to
 *    `{}`;
 *  - lists (call arguments, array elements, map entries, parameters) stay on
 *    one line when they fit the width, otherwise one item per line with the
 *    closing delimiter back at the list's own indent. Typhoun has no trailing
 *    commas, so none are ever emitted;
 *  - numeric literals print verbatim from the source, so precision and
 *    notation cannot drift; strings are re-quoted canonically;
 *  - `obj["name"]` prints as `obj.name` when the key is a plain identifier;
 *  - comments are preserved. A comment that shares a line with code stays a
 *    trailing comment (two spaces before it); every other comment keeps its
 *    own line. Comments inside a list force that list to break;
 *  - runs of blank lines collapse to one, and blank lines survive only between
 *    statements.
 *
 * If the source has lexical or syntax errors the formatter refuses to rewrite
 * it and reports the diagnostics instead — it never touches a file it does not
 * fully understand.
 */
import { Lexer } from "../lexer/lexer.js";
import { TokenType } from "../lexer/token.js";
import { Parser } from "../parser/parser.js";
import { NodeType } from "../ast/nodes.js";
import { SourceManager } from "../source/source-manager.js";

/** Default maximum line width before lists break. */
export const DEFAULT_WIDTH = 100;

/** Default indentation unit. */
export const DEFAULT_INDENT = "    ";

const IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{N}_]*$/u;

/** Keywords cannot follow a `.`, so they never become member sugar. */
const KEYWORDS = new Set([
  "let",
  "const",
  "fn",
  "return",
  "if",
  "else",
  "while",
  "for",
  "in",
  "break",
  "continue",
  "import",
  "as",
  "try",
  "catch",
  "and",
  "or",
  "not",
  "true",
  "false",
  "null",
]);

/**
 * Format Typhoun source text.
 *
 * @param {string} text
 * @param {string} [fileName]
 * @param {{ width?: number, indent?: string, sourceManager?: SourceManager }} [options]
 * @returns {{
 *   code: string,
 *   formatted: boolean,
 *   diagnostics: import("../diagnostics/diagnostic.js").DiagnosticBag,
 *   sourceManager: SourceManager,
 *   file: object,
 *   comments: object[],
 *   ast: object|null,
 * }}
 */
export function formatSource(text, fileName = "<source>", options = {}) {
  const sourceManager = options.sourceManager ?? new SourceManager();
  const file = sourceManager.add(fileName, text);
  const lexer = new Lexer(file, { collectComments: true });
  const tokens = lexer.tokenize();
  const diagnostics = lexer.diagnostics;
  const parser = new Parser(tokens);
  const ast = parser.parse();
  diagnostics.merge(parser.diagnostics);

  if (diagnostics.hasErrors) {
    return {
      code: text,
      formatted: false,
      diagnostics,
      sourceManager,
      file,
      comments: lexer.comments,
      ast: null,
    };
  }

  const formatter = new Formatter({
    source: text,
    tokens,
    comments: lexer.comments,
    width: options.width ?? DEFAULT_WIDTH,
    indent: options.indent ?? DEFAULT_INDENT,
  });
  const code = formatter.format(ast);
  return {
    code,
    formatted: code !== text,
    diagnostics,
    sourceManager,
    file,
    comments: lexer.comments,
    ast,
  };
}

/** Map every opening delimiter to the token that closes it. */
function buildPairs(tokens) {
  const pairs = new Map();
  const stack = [];
  for (const token of tokens) {
    switch (token.type) {
      case TokenType.LPAREN:
      case TokenType.LBRACKET:
      case TokenType.LBRACE:
        stack.push(token);
        break;
      case TokenType.RPAREN:
      case TokenType.RBRACKET:
      case TokenType.RBRACE: {
        const open = stack.pop();
        if (open) pairs.set(open.offset, token);
        break;
      }
      default:
        break;
    }
  }
  return pairs;
}

/**
 * Re-indent a comment by `delta` columns `""`.
 *
 * The whole comment is shifted rather than reformatted: continuation lines keep
 * their indentation *relative to the first line*, so prose, tables and ASCII
 * art inside a block comment survive untouched. A delta of zero returns the
 * comment verbatim, which is what makes the formatter idempotent — on the
 * second pass every comment already sits at its target column.
 */
export function normalizeComment(text, delta = 0) {
  const trimmed = text.replace(/[ \t]+$/gm, "");
  if (delta === 0 || !trimmed.includes("\n")) return trimmed;
  const [first, ...rest] = trimmed.split("\n");
  const shifted = rest.map((line) => {
    if (line.trim() === "") return "";
    if (delta > 0) return " ".repeat(delta) + line;
    return line.replace(/^[ \t]{0,}/, (spaces) => spaces.slice(0, Math.max(0, spaces.length + delta)));
  });
  return [first, ...shifted].join("\n");
}

export class Formatter {
  /**
   * @param {{ source: string, tokens: object[], comments: object[], width: number, indent: string }} init
   */
  constructor({ source, tokens, comments, width, indent }) {
    this.source = source ?? "";
    this.tokens = tokens ?? [];
    this.comments = comments ?? [];
    this.width = width;
    this.indentUnit = indent;
    /** @type {string[]} */
    this.lines = [];
    this.depth = 0;
    this.nextComment = 0;
    /** Source line of the last thing emitted, for blank-line preservation. */
    this.lastSourceLine = 0;
    /** End offset of the last leaf rendered, used to locate a call's `(`. */
    this.lastLeafEnd = 0;
    this.pairs = buildPairs(this.tokens);
    /** Line of the closing token at each closing offset. */
    this.closeLines = new Map();
    for (const token of this.pairs.values()) this.closeLines.set(token.offset, token.line);
    this.parens = this.tokens.filter((t) => t.type === TokenType.LPAREN).map((t) => t.offset);
  }

  // ------------------------------------------------------------------ output

  get pad() {
    return this.indentUnit.repeat(this.depth);
  }

  line(text) {
    this.lines.push(this.pad + text);
  }

  blank() {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.lines.push("");
    }
  }

  /** Append to the line just emitted (used to build `} else if x {`). */
  appendLine(text) {
    if (this.lines.length === 0) {
      this.lines.push(this.pad + text);
      return;
    }
    const last = this.lines.length - 1;
    this.lines[last] = `${this.lines[last].replace(/\s+$/, "")}${text}`;
  }

  finish() {
    while (this.lines.length > 0 && this.lines[this.lines.length - 1] === "") this.lines.pop();
    return this.lines.length === 0 ? "" : `${this.lines.join("\n")}\n`;
  }

  fits(text) {
    return this.pad.length + text.length <= this.width;
  }

  touch(line) {
    if (typeof line === "number" && line > this.lastSourceLine) this.lastSourceLine = line;
  }

  /** Source line of a closing delimiter, or null. */
  closeLine(offset) {
    return offset === null || offset === undefined ? null : this.closeLines.get(offset) ?? null;
  }

  closerOf(openOffset) {
    if (openOffset === null || openOffset === undefined) return null;
    return this.pairs.get(openOffset) ?? null;
  }

  /**
   * The first offset in `sorted` at or after `offset`.
   *
   * `>=` rather than `>` matters: a callee's last token ends exactly where its
   * `(` begins, so an exclusive search would skip the very delimiter we are
   * looking for.
   */
  firstOffsetAtOrAfter(sorted, offset) {
    let lo = 0;
    let hi = sorted.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] >= offset) {
        found = sorted[mid];
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return found;
  }

  /** End offset of a node, derived from its leaves and its closing delimiters. */
  endOffset(node) {
    if (node.type === NodeType.CallExpr) {
      const close = this.closerOf(this.callParenOffset(node));
      if (close) return close.offset + 1;
    }
    const own = this.closerOf(node.loc?.offset);
    if (own && (this.isListOwner(node) || Array.isArray(node.body))) return own.offset + 1;
    let end = (node.loc?.offset ?? 0) + (node.loc?.length ?? 0);
    for (const child of this.children(node)) {
      if (child && typeof child === "object" && child.loc) {
        end = Math.max(end, this.endOffset(child));
      }
    }
    return end;
  }

  isListOwner(node) {
    return node.type === NodeType.ArrayLit || node.type === NodeType.MapLit;
  }

  *children(node) {
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const entry of value) {
          yield entry && entry.key ? entry.key : entry;
          if (entry && entry.key) yield entry.value;
        }
      } else if (value && typeof value === "object") {
        yield value;
      }
    }
  }

  // ---------------------------------------------------------------- comments

  /** True when a comment shares its line with code that precedes it. */
  isTrailing(comment) {
    const start = this.source.lastIndexOf("\n", comment.offset - 1) + 1;
    return this.source.slice(start, comment.offset).trim().length > 0;
  }

  /** True when an unemitted comment lies inside `[from, to)`. */
  hasCommentsIn(from, to) {
    if (from === null || from === undefined || to === null || to === undefined || to <= from) {
      return false;
    }
    for (let i = this.nextComment; i < this.comments.length; i += 1) {
      const comment = this.comments[i];
      if (comment.offset >= to) return false;
      if (comment.offset >= from) return true;
    }
    return false;
  }

  /** Emit every comment that starts before `limit`. */
  flushComments(limit) {
    while (
      this.nextComment < this.comments.length &&
      this.comments[this.nextComment].offset < limit
    ) {
      this.emitComment(this.comments[this.nextComment]);
      this.nextComment += 1;
    }
  }

  emitComment(comment) {
    // A trailing comment keeps its own spacing; an own-line comment is shifted
    // to whatever column this depth puts it at.
    const delta = this.isTrailing(comment) ? 0 : this.pad.length + 1 - (comment.column ?? 1);
    const body = normalizeComment(comment.text, delta);
    if (this.isTrailing(comment)) {
      const [first, ...rest] = body.split("\n");
      this.appendLine(`  ${first}`);
      for (const extra of rest) this.line(extra);
      this.touch(comment.endLine);
      return;
    }
    if (this.lines.length > 0 && comment.line - this.lastSourceLine >= 2) this.blank();
    for (const text of body.split("\n")) this.lines.push(text === "" ? "" : this.pad + text);
    this.touch(comment.endLine);
  }

  // ----------------------------------------------------------------- program

  format(ast) {
    this.emitStatements(ast.body, Infinity);
    this.flushComments(Infinity);
    return this.finish();
  }

  emitStatements(body, closeOffset) {
    for (const statement of body) {
      this.flushComments(statement.loc.offset);
      if (this.lines.length > 0 && statement.loc.line - this.lastSourceLine >= 2) this.blank();
      this.emitStatement(statement);
    }
    this.flushComments(closeOffset);
  }

  emitStatement(node) {
    this.touch(node.loc.line);
    switch (node.type) {
      case NodeType.VarDecl:
        this.emitValue(`${node.kind} ${node.name} = `, node.init);
        return;
      case NodeType.FnDecl:
        this.emitFunction("", `fn ${node.name}`, node.params, node.body, this.fnParenOffset(node));
        return;
      case NodeType.ExprStmt:
        this.emitValue("", node.expression);
        return;
      case NodeType.Block:
        // A bare block statement brings its own braces.
        this.line("{");
        this.emitBlockLines(node);
        return;
      case NodeType.IfStmt:
        this.emitIf(node);
        return;
      case NodeType.TryStmt:
        this.emitTry(node);
        return;
      case NodeType.WhileStmt:
        this.emitBlockWithHeader(`while ${this.expr(node.test)}`, node.body);
        return;
      case NodeType.ForInStmt:
        this.emitBlockWithHeader(
          `for ${node.variable} in ${this.expr(node.iterable)}`,
          node.body,
        );
        return;
      case NodeType.ForStmt:
        this.emitBlockWithHeader(`for (${this.forHeader(node)})`, node.body);
        return;
      case NodeType.ReturnStmt: {
        if (!node.argument) {
          this.line("return");
          return;
        }
        this.emitValue("return ", node.argument);
        return;
      }
      case NodeType.BreakStmt:
        this.line("break");
        return;
      case NodeType.ContinueStmt:
        this.line("continue");
        return;
      case NodeType.ImportStmt:
        this.line(
          node.alias
            ? `import ${JSON.stringify(node.path)} as ${node.alias}`
            : `import ${JSON.stringify(node.path)}`,
        );
        return;
      default:
        throw new Error(`formatter: unsupported statement '${node.type}'`);
    }
  }

  /** C-style `for` header: `for (;;)`, `for (; i < 3;)`, `for (let i = 0; …)`. */
  forHeader(node) {
    const parts = [node.init, node.test, node.update].map((part) => this.forClause(part));
    if (parts.every((part) => part === "")) return ";;";
    return parts.join("; ").replace(/; $/, ";");
  }

  /** One C-style `for` header piece, which may be absent. */
  forClause(node) {
    if (!node) return "";
    if (node.type === NodeType.VarDecl) {
      return `${node.kind} ${node.name} = ${this.expr(node.init)}`;
    }
    if (node.type === NodeType.ExprStmt) return this.expr(node.expression);
    return this.expr(node);
  }

  /** Offset of the `(` opening a function declaration's parameter list. */
  fnParenOffset(node) {
    return this.firstOffsetAtOrAfter(this.parens, node.loc.offset + (node.loc.length ?? 0));
  }

  /**
   * Offset of the `(` that opens a call's argument list: the first `(` at or
   * after the end of the callee. Chained calls (`f()(y)`) resolve correctly
   * because the callee's end offset is derived from its own closer.
   */
  callParenOffset(node) {
    return this.firstOffsetAtOrAfter(this.parens, this.endOffset(node.callee));
  }

  emitIf(node) {
    let current = node;
    let first = true;
    for (;;) {
      const body = current.consequent;
      const empty = this.isEmptyBlock(body);
      if (first) {
        if (empty) {
          this.line(`if ${this.expr(current.test)} {}`);
          this.touchBlockClose(body);
        } else {
          this.line(`if ${this.expr(current.test)} {`);
          this.emitBlockLines(body);
        }
        first = false;
      } else if (empty) {
        this.appendLine(" {}");
        this.touchBlockClose(body);
      } else {
        this.emitBlockLines(body);
      }

      const alternate = current.alternate;
      if (!alternate) return;
      if (alternate.type === NodeType.IfStmt) {
        this.appendLine(` else if ${this.expr(alternate.test)} {`);
        current = alternate;
        continue;
      }
      if (this.isEmptyBlock(alternate)) {
        this.appendLine(" else {}");
        this.touchBlockClose(alternate);
        return;
      }
      this.appendLine(" else {");
      this.emitBlockLines(alternate);
      return;
    }
  }

  /**
   * `try { … } catch err { … }` — the handler hangs off the closing brace, the
   * way `else` does.
   */
  emitTry(node) {
    const body = node.block;
    const handler = node.handler;
    const head = "try {";

    if (this.isEmptyBlock(body)) {
      this.line("try {}");
      this.touchBlockClose(body);
    } else {
      this.line(head);
      this.emitBlockLines(body);
    }

    const label = ` catch ${node.param} {`;
    if (this.isEmptyBlock(handler)) {
      this.appendLine(`${label}}`);
      this.touchBlockClose(handler);
      return;
    }
    this.appendLine(label);
    this.emitBlockLines(handler);
  }

  emitBlockWithHeader(header, block) {
    if (this.isEmptyBlock(block)) {
      this.line(`${header} {}`);
      this.touchBlockClose(block);
      return;
    }
    this.line(`${header} {`);
    this.emitBlockLines(block);
  }

  /** Emit a block's statements, then its closing brace at the current indent. */
  emitBlockLines(block) {
    const [, closeOffset] = this.blockSpan(block);
    this.depth += 1;
    this.emitStatements(block.body, closeOffset);
    this.depth -= 1;
    this.line("}");
    this.touchBlockClose(block);
  }

  isEmptyBlock(block) {
    const [open, close] = this.blockSpan(block);
    return block.body.length === 0 && !this.hasCommentsIn(open, close);
  }

  /** `[openOffset, closeOffset]` of a block, in source offset order. */
  blockSpan(block) {
    const close = this.closerOf(block.loc.offset);
    return [block.loc.offset, close ? close.offset : Number.MAX_SAFE_INTEGER];
  }

  touchBlockClose(block) {
    const close = this.closerOf(block.loc.offset);
    this.touch(close ? close.line : block.loc.line);
    if (close) this.touch(close.line);
  }

  /**
   * Emit a function declaration or expression: header (with `head` before it,
   * used by e.g. `return fn (x) {`), parameter list and body.
   */
  emitFunction(head, label, params, body, openOffset) {
    const close = this.closerOf(openOffset);
    const empty = this.isEmptyBlock(body);
    const forcedParams = this.hasCommentsIn(openOffset, close ? close.offset : null);
    const flatParams = params.join(", ");
    const oneLineHeader = `${label}(${flatParams}) {`;

    if (!forcedParams && this.fits(`${head}${oneLineHeader}`)) {
      this.line(empty ? `${head}${label}(${flatParams}) {}` : `${head}${oneLineHeader}`);
    } else {
      this.line(`${head}${label}(`);
      this.depth += 1;
      for (let i = 0; i < params.length; i += 1) {
        this.line(`${params[i]}${i < params.length - 1 ? "," : ""}`);
      }
      this.depth -= 1;
      this.line(empty ? ") {}" : ") {");
    }
    if (empty) {
      this.touchBlockClose(body);
      return;
    }
    this.emitBlockLines(body);
  }

  // ------------------------------------------------------------- expressions

  /**
   * Emit `head` followed by `node`, on one line when it fits, otherwise with
   * the node's own list broken across lines. `suffix` is appended to the last
   * emitted line (used for item commas).
   */
  emitValue(head, node, suffix = "") {
    if (node.type === NodeType.FnExpr) {
      // Anonymous functions keep a space before the parameter list.
      const label = node.name ? `fn ${node.name}` : "fn ";
      const open = this.firstOffsetAtOrAfter(this.parens, node.loc.offset + (node.loc.length ?? 0));
      this.emitFunction(head, label, node.params, node.body, open);
      return;
    }
    const info = this.listInfo(node);
    if (info) {
      const forced = this.hasCommentsIn(info.openOffset, info.closeOffset);
      if (info.flat !== null && !forced && this.fits(`${head}${info.flat}${suffix}`)) {
        this.line(`${head}${info.flat}${suffix}`);
        this.touch(this.closeLine(info.closeOffset) ?? 0);
        return;
      }
      this.emitList(head, info, suffix);
      return;
    }
    const flat = this.expr(node);
    if (flat !== null) {
      this.line(`${head}${flat}${suffix}`);
      return;
    }
    if (node.type === NodeType.GroupingExpr) {
      this.line(`${head}(`);
      this.depth += 1;
      this.emitValue("", node.expression);
      this.depth -= 1;
      this.line(`)${suffix}`);
      return;
    }
    // Nothing in the language produces this today; keep the exact source
    // rather than dropping code if it ever does.
    this.line(`${head}${this.rawSlice(node)}${suffix}`);
  }

  rawSlice(node) {
    const start = node.loc?.offset ?? 0;
    const end = Math.max(start, this.endOffset(node));
    return this.source.slice(start, end).trim();
  }

  /** Description of a breakable list node, or null when the node is atomic. */
  listInfo(node) {
    switch (node.type) {
      case NodeType.ArrayLit: {
        const close = this.closerOf(node.loc.offset);
        return this.makeInfo({
          head: "[",
          close: "]",
          items: node.elements.map((element) => this.item("", element)),
          openOffset: node.loc.offset,
          closeOffset: close ? close.offset : null,
        });
      }
      case NodeType.MapLit: {
        const close = this.closerOf(node.loc.offset);
        return this.makeInfo({
          head: "{",
          close: "}",
          // Braces carry one space of padding in the single-line form, which
          // is the style the rest of the project uses (`{ "k": 1 }`).
          flatHead: "{ ",
          flatClose: " }",
          items: node.entries.map((entry) =>
            this.item(`${this.expr(entry.key)}: `, entry.value),
          ),
          openOffset: node.loc.offset,
          closeOffset: close ? close.offset : null,
        });
      }
      case NodeType.CallExpr: {
        const callee = this.expr(node.callee);
        if (callee === null) return null;
        const openOffset = this.callParenOffset(node);
        const close = this.closerOf(openOffset);
        if (openOffset === null || !close) return null;
        return this.makeInfo({
          head: `${callee}(`,
          close: ")",
          items: node.args.map((argument) => this.item("", argument)),
          openOffset,
          closeOffset: close.offset,
        });
      }
      default:
        return null;
    }
  }

  /**
   * An item is a head string plus either a node (which may break further) or a
   * literal. `text` is the flat rendering, or null when it cannot be flat.
   */
  item(head, node) {
    const flat = this.expr(node);
    return {
      head,
      node,
      text: flat === null ? null : `${head}${flat}`,
      offset: node.loc.offset,
    };
  }

  makeInfo({ head, close, items, openOffset, closeOffset, flatHead, flatClose }) {
    const flatItems = items.map((i) => i.text);
    let flat = null;
    if (!flatItems.includes(null)) {
      if (flatItems.length === 0) {
        flat = `${head}${close}`;
      } else {
        flat = `${flatHead ?? head}${flatItems.join(", ")}${flatClose ?? close}`;
      }
    }
    return { head, close, items, flat, openOffset, closeOffset };
  }

  emitList(head, info, suffix) {
    this.line(`${head}${info.head}`);
    this.depth += 1;
    const last = info.items.length - 1;
    for (let i = 0; i < info.items.length; i += 1) {
      const item = info.items[i];
      this.flushComments(item.offset);
      this.emitItem(item, i < last ? "," : "");
    }
    this.depth -= 1;
    this.flushComments(info.closeOffset);
    this.line(`${info.close}${suffix}`);
    this.touch(this.closeLine(info.closeOffset) ?? 0);
  }

  emitItem(item, suffix) {
    if (!item.node) {
      this.line(`${item.text ?? ""}${suffix}`);
      return;
    }
    this.emitValue(item.head, item.node, suffix);
  }

  /** Flat (single-line) rendering of an expression, or null when impossible. */
  expr(node) {
    switch (node.type) {
      case NodeType.NumberLit:
      case NodeType.StringLit:
        return this.literal(node);
      case NodeType.BoolLit:
        this.touch(node.loc?.line ?? 0);
        return node.value ? "true" : "false";
      case NodeType.NullLit:
        this.touch(node.loc?.line ?? 0);
        return "null";
      case NodeType.Identifier:
        this.markLeaf(node);
        return node.name;
      case NodeType.ArrayLit:
      case NodeType.MapLit:
      case NodeType.CallExpr: {
        const info = this.listInfo(node);
        return info ? info.flat : null;
      }
      case NodeType.IndexExpr: {
        const object = this.expr(node.object);
        if (object === null) return null;
        if (
          node.index.type === NodeType.StringLit &&
          IDENTIFIER.test(node.index.value) &&
          !KEYWORDS.has(node.index.value)
        ) {
          return `${object}.${node.index.value}`;
        }
        const index = this.expr(node.index);
        return index === null ? null : `${object}[${index}]`;
      }
      case NodeType.UnaryExpr: {
        const operand = this.expr(node.operand);
        if (operand === null) return null;
        const spaced = node.operator === "not" || (node.operator === "-" && operand.startsWith("-"));
        return spaced ? `${node.operator} ${operand}` : `${node.operator}${operand}`;
      }
      case NodeType.BinaryExpr:
      case NodeType.LogicalExpr: {
        const left = this.expr(node.left);
        const right = this.expr(node.right);
        if (left === null || right === null) return null;
        return `${left} ${node.operator} ${right}`;
      }
      case NodeType.AssignExpr: {
        const target = this.expr(node.target);
        const value = this.expr(node.value);
        if (target === null || value === null) return null;
        return `${target} ${node.operator} ${value}`;
      }
      case NodeType.GroupingExpr: {
        const inner = this.expr(node.expression);
        return inner === null ? null : `(${inner})`;
      }
      case NodeType.FnExpr:
        return this.flatFunction(node);
      default:
        return null;
    }
  }

  /** One-line form of a function expression, used inside larger expressions. */
  flatFunction(node) {
    const label = node.name ? `fn ${node.name}` : "fn ";
    const params = node.params.join(", ");
    if (node.body.body.length === 0) return `${label}(${params}) {}`;
    if (node.body.body.length === 1) {
      const only = this.flatStatement(node.body.body[0]);
      if (only !== null) return `${label}(${params}) { ${only} }`;
    }
    return null;
  }

  flatStatement(node) {
    switch (node.type) {
      case NodeType.ReturnStmt:
        return node.argument ? `return ${this.expr(node.argument)}` : "return";
      case NodeType.BreakStmt:
        return "break";
      case NodeType.ContinueStmt:
        return "continue";
      case NodeType.ExprStmt: {
        const expression = this.expr(node.expression);
        return expression === null ? null : expression;
      }
      case NodeType.VarDecl: {
        const init = this.expr(node.init);
        return init === null ? null : `${node.kind} ${node.name} = ${init}`;
      }
      default:
        return null;
    }
  }

  /** Literals print from the source so digits and escapes cannot drift. */
  literal(node) {
    this.markLeaf(node);
    const raw = this.sourceSlice(node);
    if (node.type === NodeType.StringLit) {
      // Member-access sugar produces a string literal whose location covers a
      // bare identifier, so only reuse the slice when it really is a string.
      if (raw && raw.startsWith('"')) return raw;
      return JSON.stringify(node.value);
    }
    if (raw && /^[0-9]/.test(raw)) return raw;
    return String(node.value);
  }

  sourceSlice(node) {
    const { offset, length } = node.loc ?? {};
    if (typeof offset !== "number" || typeof length !== "number" || length <= 0) return null;
    return this.source.slice(offset, offset + length);
  }

  markLeaf(node) {
    const end = (node.loc?.offset ?? 0) + (node.loc?.length ?? 0);
    if (end > this.lastLeafEnd) this.lastLeafEnd = end;
    this.touch(node.loc?.line ?? 0);
  }
}
