/**
 * Stage D — Abstract Syntax Tree.
 *
 * AST nodes are plain objects carrying a `type` discriminant and a `loc`
 * (source location). Definitions here are intentionally independent of both
 * the parser and the interpreter so either can evolve without the other.
 *
 * Node kinds
 * ----------
 *  Program
 *  -------- statements
 *  VarDecl(kind,name,init)  FnDecl(name,params,body)  ExprStmt(expression)
 *  Block(body)  IfStmt(test,consequent,alternate)  WhileStmt(test,body)
 *  ForInStmt(variable,iterable,body)  ForStmt(init,test,update,body)
 *  BreakStmt  ContinueStmt  ReturnStmt(argument)  ImportStmt(path,alias)
 *  TryStmt(block,param,handler)
 *  -------- expressions
 *  NumberLit(value)  StringLit(value)  BoolLit(value)  NullLit
 *  Identifier(name)  ArrayLit(elements)  MapLit(entries)
 *  UnaryExpr(operator,operand)  BinaryExpr(operator,left,right)
 *  LogicalExpr(operator,left,right)  AssignExpr(operator,target,value)
 *  GroupingExpr(expression)  CallExpr(callee,args)  IndexExpr(object,index)
 */

export const NodeType = Object.freeze({
  Program: "Program",
  VarDecl: "VarDecl",
  FnDecl: "FnDecl",
  FnExpr: "FnExpr",
  ExprStmt: "ExprStmt",
  Block: "Block",
  IfStmt: "IfStmt",
  WhileStmt: "WhileStmt",
  ForInStmt: "ForInStmt",
  ForStmt: "ForStmt",
  BreakStmt: "BreakStmt",
  ContinueStmt: "ContinueStmt",
  ReturnStmt: "ReturnStmt",
  ImportStmt: "ImportStmt",
  TryStmt: "TryStmt",
  NumberLit: "NumberLit",
  StringLit: "StringLit",
  BoolLit: "BoolLit",
  NullLit: "NullLit",
  Identifier: "Identifier",
  ArrayLit: "ArrayLit",
  MapLit: "MapLit",
  UnaryExpr: "UnaryExpr",
  BinaryExpr: "BinaryExpr",
  LogicalExpr: "LogicalExpr",
  AssignExpr: "AssignExpr",
  GroupingExpr: "GroupingExpr",
  CallExpr: "CallExpr",
  IndexExpr: "IndexExpr",
});

const node = (type, loc, fields) => ({ type, loc, ...fields });

export const nodes = {
  program: (body, loc) => node(NodeType.Program, loc, { body }),
  varDecl: (kind, name, init, loc) => node(NodeType.VarDecl, loc, { kind, name, init }),
  fnDecl: (name, params, body, loc) => node(NodeType.FnDecl, loc, { name, params, body }),
  fnExpr: (name, params, body, loc) => node(NodeType.FnExpr, loc, { name, params, body }),
  exprStmt: (expression, loc) => node(NodeType.ExprStmt, loc, { expression }),
  block: (body, loc) => node(NodeType.Block, loc, { body }),
  ifStmt: (test, consequent, alternate, loc) =>
    node(NodeType.IfStmt, loc, { test, consequent, alternate }),
  whileStmt: (test, body, loc) => node(NodeType.WhileStmt, loc, { test, body }),
  forInStmt: (variable, iterable, body, loc) =>
    node(NodeType.ForInStmt, loc, { variable, iterable, body }),
  forStmt: (init, test, update, body, loc) =>
    node(NodeType.ForStmt, loc, { init, test, update, body }),
  breakStmt: (loc) => node(NodeType.BreakStmt, loc, {}),
  continueStmt: (loc) => node(NodeType.ContinueStmt, loc, {}),
  returnStmt: (argument, loc) => node(NodeType.ReturnStmt, loc, { argument }),
  importStmt: (path, alias, loc) => node(NodeType.ImportStmt, loc, { path, alias }),
  tryStmt: (block, param, handler, loc) =>
    node(NodeType.TryStmt, loc, { block, param, handler }),
  numberLit: (value, loc) => node(NodeType.NumberLit, loc, { value }),
  stringLit: (value, loc) => node(NodeType.StringLit, loc, { value }),
  boolLit: (value, loc) => node(NodeType.BoolLit, loc, { value }),
  nullLit: (loc) => node(NodeType.NullLit, loc, {}),
  identifier: (name, loc) => node(NodeType.Identifier, loc, { name }),
  arrayLit: (elements, loc) => node(NodeType.ArrayLit, loc, { elements }),
  mapLit: (entries, loc) => node(NodeType.MapLit, loc, { entries }),
  unaryExpr: (operator, operand, loc) => node(NodeType.UnaryExpr, loc, { operator, operand }),
  binaryExpr: (operator, left, right, loc) =>
    node(NodeType.BinaryExpr, loc, { operator, left, right }),
  logicalExpr: (operator, left, right, loc) =>
    node(NodeType.LogicalExpr, loc, { operator, left, right }),
  assignExpr: (operator, target, value, loc) =>
    node(NodeType.AssignExpr, loc, { operator, target, value }),
  groupingExpr: (expression, loc) => node(NodeType.GroupingExpr, loc, { expression }),
  callExpr: (callee, args, loc) => node(NodeType.CallExpr, loc, { callee, args }),
  indexExpr: (object, index, loc) => node(NodeType.IndexExpr, loc, { object, index }),
};

/** True when `n` is an expression node. */
export function isExpression(n) {
  if (!n || typeof n.type !== "string") return false;
  return !EXPRESSION_EXCLUDED.has(n.type);
}

const EXPRESSION_EXCLUDED = new Set([
  NodeType.Program,
  NodeType.VarDecl,
  NodeType.FnDecl,
  NodeType.ExprStmt,
  NodeType.Block,
  NodeType.IfStmt,
  NodeType.WhileStmt,
  NodeType.ForInStmt,
  NodeType.ForStmt,
  NodeType.BreakStmt,
  NodeType.ContinueStmt,
  NodeType.ReturnStmt,
  NodeType.ImportStmt,
  NodeType.TryStmt,
]);
