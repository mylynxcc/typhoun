/**
 * Stage B — Lexer tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenType } from "../../src/lexer/token.js";
import { Code } from "../../src/diagnostics/codes.js";
import { lex, lexOk } from "../helpers.js";

const types = (source) => lexOk(source).map((t) => t.type);
const values = (source) => lexOk(source).map((t) => t.value);

describe("lexer: basics", () => {
  it("produces an EOF token for empty input", () => {
    const tokens = lexOk("");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, TokenType.EOF);
  });

  it("recognizes all keyword spellings", () => {
    const tokens = lexOk(
      "let const fn return if else while for in break continue import as try catch and or not true false null",
    );
    assert.deepEqual(
      tokens.map((t) => t.type),
      [
        TokenType.LET,
        TokenType.CONST,
        TokenType.FN,
        TokenType.RETURN,
        TokenType.IF,
        TokenType.ELSE,
        TokenType.WHILE,
        TokenType.FOR,
        TokenType.IN,
        TokenType.BREAK,
        TokenType.CONTINUE,
        TokenType.IMPORT,
        TokenType.AS,
        TokenType.TRY,
        TokenType.CATCH,
        TokenType.AND,
        TokenType.OR,
        TokenType.NOT,
        TokenType.TRUE,
        TokenType.FALSE,
        TokenType.NULL,
        TokenType.EOF,
      ],
    );
  });

  it("gives booleans their literal values", () => {
    assert.deepEqual(values("true false null"), [true, false, null, null]);
  });

  it("keeps keywords distinct from identifiers", () => {
    assert.deepEqual(types("letting iffy forLoop own"), [
      TokenType.IDENTIFIER,
      TokenType.IDENTIFIER,
      TokenType.IDENTIFIER,
      TokenType.IDENTIFIER,
      TokenType.EOF,
    ]);
  });
});

describe("lexer: numbers", () => {
  it("scans integers, decimals and exponents", () => {
    assert.deepEqual(values("0 42 3.5 1e3 2.5e-2 7E2"), [0, 42, 3.5, 1000, 0.025, 700, null]);
  });

  it("rejects malformed numbers", () => {
    const { diagnostics } = lex("let x = 12abc");
    assert.ok(diagnostics.items.some((d) => d.code === Code.MALFORMED_NUMBER));
  });

  it("rejects a second decimal point", () => {
    const { diagnostics } = lex("1.2.3");
    assert.ok(diagnostics.items.some((d) => d.code === Code.MALFORMED_NUMBER));
  });
});

describe("lexer: strings", () => {
  it("decodes escapes", () => {
    const [token] = lexOk('"a\\nb\\t\\"c\\u2603"');
    assert.equal(token.value, 'a\nb\t"c\u2603');
  });

  it("decodes braced unicode escapes", () => {
    const [token] = lexOk('"\\u{1F600}"');
    assert.equal(token.value, "\u{1F600}");
  });

  it("reports unterminated strings at end of file", () => {
    const { diagnostics } = lex('let s = "abc');
    assert.ok(diagnostics.items.some((d) => d.code === Code.UNTERMINATED_STRING));
  });

  it("reports a raw newline inside a string", () => {
    const { diagnostics } = lex('let s = "ab\ncd"');
    assert.ok(diagnostics.items.some((d) => d.code === Code.UNTERMINATED_STRING));
  });

  it("reports invalid escape sequences", () => {
    const { diagnostics } = lex('"\\q"');
    assert.ok(diagnostics.items.some((d) => d.code === Code.INVALID_ESCAPE));
  });

  it("reports invalid unicode escapes", () => {
    const { diagnostics } = lex('"\\u12"');
    assert.ok(diagnostics.items.some((d) => d.code === Code.INVALID_UNICODE_ESCAPE));
  });
});

describe("lexer: operators and punctuation", () => {
  it("scans each operator", () => {
    assert.deepEqual(types("+ - * / % = == != < <= > >= += -= *= /="), [
      TokenType.PLUS,
      TokenType.MINUS,
      TokenType.STAR,
      TokenType.SLASH,
      TokenType.PERCENT,
      TokenType.EQUAL,
      TokenType.EQEQ,
      TokenType.BANGEQ,
      TokenType.LT,
      TokenType.LTEQ,
      TokenType.GT,
      TokenType.GTEQ,
      TokenType.PLUSEQ,
      TokenType.MINUSEQ,
      TokenType.STAREQ,
      TokenType.SLASHEQ,
      TokenType.EOF,
    ]);
  });

  it("scans brackets, braces, parens and separators", () => {
    assert.deepEqual(types("( ) { } [ ] , . ; :"), [
      TokenType.LPAREN,
      TokenType.RPAREN,
      TokenType.LBRACE,
      TokenType.RBRACE,
      TokenType.LBRACKET,
      TokenType.RBRACKET,
      TokenType.COMMA,
      TokenType.DOT,
      TokenType.SEMICOLON,
      TokenType.COLON,
      TokenType.EOF,
    ]);
  });

  it("rejects a lone exclamation mark", () => {
    const { diagnostics } = lex("a ! b");
    assert.ok(diagnostics.items.some((d) => d.code === Code.UNEXPECTED_CHARACTER));
  });
});

describe("lexer: comments and whitespace", () => {
  it("skips line comments", () => {
    assert.deepEqual(types("1 // comment\n2"), [TokenType.NUMBER, TokenType.NUMBER, TokenType.EOF]);
  });

  it("skips block comments, including nested ones", () => {
    assert.deepEqual(values("1 /* a /* b */ c */ 2"), [1, 2, null]);
  });

  it("reports an unterminated block comment", () => {
    const { diagnostics } = lex("1 /* never ends");
    assert.ok(diagnostics.items.some((d) => d.code === Code.UNTERMINATED_BLOCK_COMMENT));
  });
});

describe("lexer: identifiers and source positions", () => {
  it("accepts Unicode identifiers", () => {
    assert.deepEqual(values("café naïve Δ"), ["café", "naïve", "Δ", null]);
  });

  it("records accurate line and column for each token", () => {
    const tokens = lexOk("let x = 1\n   print(x)");
    const print = tokens.find((t) => t.lexeme === "print");
    assert.equal(print.line, 2);
    assert.equal(print.column, 4);
    assert.equal(print.offset, 13);
  });

  it("stores the originating file name on each token", () => {
    const tokens = lexOk("let x = 1", "demo.typ");
    assert.equal(tokens[0].file, "demo.typ");
  });
});
