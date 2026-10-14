/**
 * Stage B — Lexer.
 *
 * A hand-written scanner (not a regular-expression product) that converts
 * Typhoun source characters into a linear token stream. It is resilient:
 * lexical errors are collected rather than thrown immediately, so a single
 * pass can report several problems.
 *
 * Documented policy:
 *  - Identifiers start with a Unicode letter or `_` and continue with
 *    Unicode letters, digits or `_` (Unicode property escapes `\p{L}`,
 *    `\p{Nl}` and `\p{N}`).
 *  - Numbers are decimal: `digits [ . digits ] [ (e|E) [+|-] digits ]`.
 *  - Strings are double-quoted; a raw newline inside a string is an error.
 *  - Comments: `// line` and nestable `block` comments.
 */
import { Token, TokenType, KEYWORDS } from "./token.js";
import { DiagnosticBag, Diagnostic, Phase, TyphounError } from "../diagnostics/diagnostic.js";
import { Code } from "../diagnostics/codes.js";

const IDENT_START = /[\p{L}\p{Nl}_]/u;
const IDENT_CONTINUE = /[\p{L}\p{Nl}\p{N}_]/u;
const DIGIT = /[0-9]/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX_CP = /^[0-9a-fA-F]{1,6}$/;
const SIMPLE_ESCAPES = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  "\\": "\\",
  '"': '"',
  "'": "'",
  b: "\b",
  f: "\f",
  v: "\v",
};
const ESCAPE_HELP = "Valid escapes: \\n \\t \\r \\0 \\\\ \\\" \\uXXXX \\u{...}.";

export class Lexer {
  /**
   * @param {import("../source/source-file.js").SourceFile} sourceFile
   * @param {{ collectComments?: boolean }} [options]
   *        `collectComments` records comment trivia in `this.comments`. It is
   *        off by default so the token stream stays exactly what the parser
   *        expects; `typhoun fmt` turns it on because a formatter that drops
   *        comments is not a formatter.
   */
  constructor(sourceFile, options = {}) {
    this.sourceFile = sourceFile;
    this.text = sourceFile.text;
    this.length = sourceFile.text.length;
    this.pos = 0;
    /** @type {Token[]} */
    this.tokens = [];
    this.diagnostics = new DiagnosticBag();
    /** True when comment trivia should be collected (see `comments`). */
    this.collectComments = options.collectComments === true;
    /**
     * Comment trivia in source order, only populated when `collectComments`
     * is set. Each entry is `{ kind, text, offset, line, column, endOffset,
     * endLine }` where `text` is the raw comment including its markers.
     * @type {Array<{kind: "line"|"block", text: string, offset: number, line: number, column: number, endOffset: number, endLine: number}>}
     */
    this.comments = [];
  }

  /** Record a comment for tooling. No-op unless collection is enabled. */
  recordComment(kind, start, end) {
    if (!this.collectComments || end <= start) return;
    const at = this.sourceFile.locationAt(start);
    const until = this.sourceFile.locationAt(end);
    this.comments.push({
      kind,
      text: this.text.slice(start, end),
      offset: start,
      line: at.line,
      column: at.column,
      endOffset: end,
      endLine: until.line,
    });
  }

  locationAt(offset, length = 1) {
    const loc = this.sourceFile.locationAt(offset);
    return { file: this.sourceFile.name, ...loc, length };
  }

  error(code, message, offset, length = 1, help = null) {
    this.diagnostics.add(
      new Diagnostic({
        code,
        phase: Phase.LEXICAL,
        message,
        location: this.locationAt(offset, length),
        help,
      }),
    );
  }

  /** Tokenize the whole file, appending a final EOF token. @returns {Token[]} */
  tokenize() {
    while (!this.isAtEnd()) this.scanToken();
    const end = this.sourceFile.locationAt(this.length);
    const eof = new Token(TokenType.EOF, "", null, this.length, end.line, end.column);
    eof.file = this.sourceFile.name;
    this.tokens.push(eof);
    return this.tokens;
  }

  /** Tokenize and throw a `TyphounError` if any lexical error occurred. */
  tokenizeChecked() {
    const tokens = this.tokenize();
    if (this.diagnostics.hasErrors) throw new TyphounError(this.diagnostics.errors);
    return tokens;
  }

  /** Static convenience wrapper. */
  static tokenizeOrThrow(sourceFile) {
    return new Lexer(sourceFile).tokenizeChecked();
  }

  // ---------------------------------------------------------------- helpers

  isAtEnd() {
    return this.pos >= this.length;
  }

  peek(ahead = 0) {
    const i = this.pos + ahead;
    return i < this.length ? this.text[i] : undefined;
  }

  advance() {
    return this.text[this.pos++];
  }

  match(expected) {
    if (this.isAtEnd() || this.text[this.pos] !== expected) return false;
    this.pos += 1;
    return true;
  }

  addToken(type, value, start, length) {
    const loc = this.sourceFile.locationAt(start);
    const token = new Token(type, this.text.slice(start, start + length), value, start, loc.line, loc.column);
    token.file = this.sourceFile.name;
    this.tokens.push(token);
    return token;
  }

  // ---------------------------------------------------------------- scanner

  scanToken() {
    const ch = this.peek();

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      this.pos += 1;
      return;
    }
    if (ch === "/" && this.peek(1) === "/") {
      this.skipLineComment();
      return;
    }
    if (ch === "/" && this.peek(1) === "*") {
      this.skipBlockComment();
      return;
    }
    if (IDENT_START.test(ch)) {
      this.scanIdentifier();
      return;
    }
    if (DIGIT.test(ch)) {
      this.scanNumber();
      return;
    }
    if (ch === '"') {
      this.scanString();
      return;
    }
    this.scanOperatorOrPunctuation();
  }

  skipLineComment() {
    const start = this.pos;
    this.pos += 2;
    while (!this.isAtEnd() && this.peek() !== "\n") this.pos += 1;
    this.recordComment("line", start, this.pos);
  }

  skipBlockComment() {
    const start = this.pos;
    let depth = 0;
    while (!this.isAtEnd()) {
      if (this.peek() === "/" && this.peek(1) === "*") {
        depth += 1;
        this.pos += 2;
      } else if (this.peek() === "*" && this.peek(1) === "/") {
        depth -= 1;
        this.pos += 2;
        if (depth === 0) {
          this.recordComment("block", start, this.pos);
          return;
        }
      } else {
        this.pos += 1;
      }
    }
    this.error(
      Code.UNTERMINATED_BLOCK_COMMENT,
      "Unterminated block comment",
      start,
      Math.max(1, this.length - start),
      "Close the comment with '*/'.",
    );
  }

  scanIdentifier() {
    const start = this.pos;
    this.pos += 1;
    while (!this.isAtEnd() && IDENT_CONTINUE.test(this.peek())) this.pos += 1;
    const text = this.text.slice(start, this.pos);
    const keyword = KEYWORDS[text];
    if (keyword === undefined) {
      this.addToken(TokenType.IDENTIFIER, text, start, this.pos - start);
      return;
    }
    let value = null;
    if (keyword === TokenType.TRUE) value = true;
    else if (keyword === TokenType.FALSE) value = false;
    this.addToken(keyword, value, start, this.pos - start);
  }

  scanNumber() {
    const start = this.pos;
    while (!this.isAtEnd() && DIGIT.test(this.peek())) this.pos += 1;

    if (this.peek() === "." && DIGIT.test(this.peek(1))) {
      this.pos += 1;
      while (!this.isAtEnd() && DIGIT.test(this.peek())) this.pos += 1;
    }

    if (this.peek() === "e" || this.peek() === "E") {
      const save = this.pos;
      this.pos += 1;
      if (this.peek() === "+" || this.peek() === "-") this.pos += 1;
      if (DIGIT.test(this.peek())) {
        while (!this.isAtEnd() && DIGIT.test(this.peek())) this.pos += 1;
      } else {
        this.pos = save;
      }
    }

    const lexeme = this.text.slice(start, this.pos);
    const next = this.peek();
    if (next !== undefined && (IDENT_START.test(next) || next === ".")) {
      while (!this.isAtEnd() && (IDENT_CONTINUE.test(this.peek()) || this.peek() === ".")) {
        this.pos += 1;
      }
      this.error(
        Code.MALFORMED_NUMBER,
        `Malformed number literal '${this.text.slice(start, this.pos)}'`,
        start,
        this.pos - start,
        "Numbers are digits with an optional fraction and exponent, e.g. 3, 3.14, 1e6.",
      );
      this.addToken(TokenType.NUMBER, 0, start, this.pos - start);
      return;
    }
    this.addToken(TokenType.NUMBER, Number(lexeme), start, this.pos - start);
  }

  scanString() {
    const start = this.pos;
    this.pos += 1; // opening quote
    let value = "";
    while (!this.isAtEnd() && this.peek() !== '"') {
      const ch = this.peek();
      if (ch === "\n") {
        this.error(
          Code.UNTERMINATED_STRING,
          "Unterminated string literal",
          start,
          this.pos - start + 1,
          "Add a closing '\"' before the line ends, or write \\n for a newline.",
        );
        this.addToken(TokenType.STRING, value, start, this.pos - start);
        return;
      }
      if (ch === "\\") {
        this.pos += 1;
        value += this.scanEscape();
      } else {
        value += ch;
        this.pos += 1;
      }
    }
    if (this.isAtEnd()) {
      this.error(
        Code.UNTERMINATED_STRING,
        "Unterminated string literal",
        start,
        this.length - start,
        "Add a closing '\"'.",
      );
      this.addToken(TokenType.STRING, value, start, this.pos - start);
      return;
    }
    this.pos += 1; // closing quote
    this.addToken(TokenType.STRING, value, start, this.pos - start);
  }

  /** Decode one escape sequence beginning after a consumed backslash. */
  scanEscape() {
    const escOffset = this.pos - 1;
    const esc = this.peek();
    if (esc === undefined) return "";

    if (esc === "u") {
      this.pos += 1;
      if (this.peek() === "{") {
        this.pos += 1;
        let hex = "";
        while (!this.isAtEnd() && this.peek() !== "}") hex += this.advance();
        if (this.peek() === "}") this.advance();
        const cp = parseInt(hex, 16);
        if (!HEX_CP.test(hex) || Number.isNaN(cp) || cp > 0x10ffff) {
          this.error(
            Code.INVALID_UNICODE_ESCAPE,
            `Invalid Unicode escape '\\u{${hex}}'`,
            escOffset,
            this.pos - escOffset,
            "Use 1-6 hex digits with a value up to 10FFFF, e.g. \\u{1F600}.",
          );
          return "";
        }
        return String.fromCodePoint(cp);
      }
      let hex = "";
      for (let i = 0; i < 4 && !this.isAtEnd(); i += 1) hex += this.advance();
      if (!HEX4.test(hex)) {
        this.error(
          Code.INVALID_UNICODE_ESCAPE,
          `Invalid Unicode escape '\\u${hex}'`,
          escOffset,
          this.pos - escOffset,
          "Use exactly four hex digits, e.g. \\u2603.",
        );
        return "";
      }
      return String.fromCharCode(parseInt(hex, 16));
    }

    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, esc)) {
      this.pos += 1;
      return SIMPLE_ESCAPES[esc];
    }

    this.error(
      Code.INVALID_ESCAPE,
      `Invalid escape sequence '\\${esc}'`,
      escOffset,
      2,
      ESCAPE_HELP,
    );
    this.pos += 1;
    return esc;
  }

  scanOperatorOrPunctuation() {
    const start = this.pos;
    const ch = this.advance();
    const simple = (type) => this.addToken(type, null, start, 1);
    const pair = (type) => (this.match("=") ? this.addToken(type, null, start, 2) : null);

    switch (ch) {
      case "(":
        return simple(TokenType.LPAREN);
      case ")":
        return simple(TokenType.RPAREN);
      case "{":
        return simple(TokenType.LBRACE);
      case "}":
        return simple(TokenType.RBRACE);
      case "[":
        return simple(TokenType.LBRACKET);
      case "]":
        return simple(TokenType.RBRACKET);
      case ",":
        return simple(TokenType.COMMA);
      case ".":
        return simple(TokenType.DOT);
      case ";":
        return simple(TokenType.SEMICOLON);
      case ":":
        return simple(TokenType.COLON);
      case "+":
        return pair(TokenType.PLUSEQ) ?? simple(TokenType.PLUS);
      case "-":
        return pair(TokenType.MINUSEQ) ?? simple(TokenType.MINUS);
      case "*":
        return pair(TokenType.STAREQ) ?? simple(TokenType.STAR);
      case "/":
        return pair(TokenType.SLASHEQ) ?? simple(TokenType.SLASH);
      case "%":
        return simple(TokenType.PERCENT);
      case "=":
        return pair(TokenType.EQEQ) ?? simple(TokenType.EQUAL);
      case "!":
        if (this.match("=")) return this.addToken(TokenType.BANGEQ, null, start, 2);
        break;
      case "<":
        return pair(TokenType.LTEQ) ?? simple(TokenType.LT);
      case ">":
        return pair(TokenType.GTEQ) ?? simple(TokenType.GT);
      default:
        break;
    }

    this.error(
      Code.UNEXPECTED_CHARACTER,
      `Unexpected character '${ch}'`,
      start,
      1,
      "Remove or replace this character.",
    );
  }
}
