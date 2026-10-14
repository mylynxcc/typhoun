/**
 * Stage B — Token model.
 */

export const TokenType = Object.freeze({
  // Literals
  NUMBER: "NUMBER",
  STRING: "STRING",
  TRUE: "TRUE",
  FALSE: "FALSE",
  NULL: "NULL",
  IDENTIFIER: "IDENTIFIER",

  // Keywords
  LET: "LET",
  CONST: "CONST",
  FN: "FN",
  RETURN: "RETURN",
  IF: "IF",
  ELSE: "ELSE",
  WHILE: "WHILE",
  FOR: "FOR",
  IN: "IN",
  BREAK: "BREAK",
  CONTINUE: "CONTINUE",
  IMPORT: "IMPORT",
  AS: "AS",
  TRY: "TRY",
  CATCH: "CATCH",
  AND: "AND",
  OR: "OR",
  NOT: "NOT",

  // Punctuation
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  LBRACE: "LBRACE",
  RBRACE: "RBRACE",
  LBRACKET: "LBRACKET",
  RBRACKET: "RBRACKET",
  COMMA: "COMMA",
  DOT: "DOT",
  SEMICOLON: "SEMICOLON",
  COLON: "COLON",

  // Operators
  PLUS: "PLUS",
  MINUS: "MINUS",
  STAR: "STAR",
  SLASH: "SLASH",
  PERCENT: "PERCENT",
  EQUAL: "EQUAL",
  EQEQ: "EQEQ",
  BANGEQ: "BANGEQ",
  LT: "LT",
  LTEQ: "LTEQ",
  GT: "GT",
  GTEQ: "GTEQ",
  PLUSEQ: "PLUSEQ",
  MINUSEQ: "MINUSEQ",
  STAREQ: "STAREQ",
  SLASHEQ: "SLASHEQ",

  EOF: "EOF",
});

/** Keyword spellings mapped to their token type. */
export const KEYWORDS = Object.freeze({
  let: TokenType.LET,
  const: TokenType.CONST,
  fn: TokenType.FN,
  return: TokenType.RETURN,
  if: TokenType.IF,
  else: TokenType.ELSE,
  while: TokenType.WHILE,
  for: TokenType.FOR,
  in: TokenType.IN,
  break: TokenType.BREAK,
  continue: TokenType.CONTINUE,
  import: TokenType.IMPORT,
  as: TokenType.AS,
  try: TokenType.TRY,
  catch: TokenType.CATCH,
  and: TokenType.AND,
  or: TokenType.OR,
  not: TokenType.NOT,
  true: TokenType.TRUE,
  false: TokenType.FALSE,
  null: TokenType.NULL,
});

export class Token {
  /**
   * @param {string} type
   * @param {string} lexeme  Exact source text of the token.
   * @param {*} value        Interpreted value (number/string/boolean/null).
   * @param {number} offset  Start offset in the source.
   * @param {number} line    1-based line.
   * @param {number} column  1-based column.
   */
  constructor(type, lexeme, value, offset, line, column) {
    this.type = type;
    this.lexeme = lexeme;
    this.value = value;
    this.offset = offset;
    this.line = line;
    this.column = column;
    this.length = lexeme.length;
  }

  get location() {
    return {
      file: this.file,
      offset: this.offset,
      line: this.line,
      column: this.column,
      length: this.length,
    };
  }

  is(type) {
    return this.type === type;
  }

  /** Debug/AST-inspector friendly representation. */
  describe() {
    const value =
      this.value === undefined || this.value === null
        ? ""
        : ` ${JSON.stringify(this.value)}`;
    return `${this.type}${value}`;
  }
}
