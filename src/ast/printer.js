/**
 * Stage D — AST printer.
 *
 * Deterministic, indentation-based rendering used by `typhoun ast` and by
 * golden tests. Field order is fixed so output is stable across runs.
 */
import { NodeType } from "./nodes.js";

const INDENT = "  ";

/**
 * @param {object} astNode
 * @returns {string}
 */
export function printAst(astNode) {
  const lines = [];
  emit(astNode, 0, lines);
  return lines.join("\n");
}

function emit(node, depth, lines) {
  const pad = INDENT.repeat(depth);
  switch (node.type) {
    case NodeType.Program:
      lines.push(`${pad}Program`);
      node.body.forEach((s) => emit(s, depth + 1, lines));
      break;
    case NodeType.VarDecl:
      lines.push(`${pad}VarDecl ${node.kind} ${node.name}`);
      emitOrNull(node.init, depth + 1, lines, "init");
      break;
    case NodeType.FnDecl:
      lines.push(`${pad}FnDecl ${node.name}(${node.params.join(", ")})`);
      emit(node.body, depth + 1, lines);
      break;
    case NodeType.FnExpr:
      lines.push(`${pad}FnExpr ${node.name ?? "<anonymous>"}(${node.params.join(", ")})`);
      emit(node.body, depth + 1, lines);
      break;
    case NodeType.ExprStmt:
      lines.push(`${pad}ExprStmt`);
      emit(node.expression, depth + 1, lines);
      break;
    case NodeType.Block:
      lines.push(`${pad}Block`);
      node.body.forEach((s) => emit(s, depth + 1, lines));
      break;
    case NodeType.IfStmt:
      lines.push(`${pad}If`);
      emit(node.test, depth + 1, lines);
      emit(node.consequent, depth + 1, lines);
      if (node.alternate) emit(node.alternate, depth + 1, lines);
      break;
    case NodeType.WhileStmt:
      lines.push(`${pad}While`);
      emit(node.test, depth + 1, lines);
      emit(node.body, depth + 1, lines);
      break;
    case NodeType.ForInStmt:
      lines.push(`${pad}ForIn ${node.variable}`);
      emit(node.iterable, depth + 1, lines);
      emit(node.body, depth + 1, lines);
      break;
    case NodeType.ForStmt:
      lines.push(`${pad}For`);
      lines.push(`${pad}${INDENT}init`);
      if (node.init) emit(node.init, depth + 2, lines);
      lines.push(`${pad}${INDENT}test`);
      if (node.test) emit(node.test, depth + 2, lines);
      lines.push(`${pad}${INDENT}update`);
      if (node.update) emit(node.update, depth + 2, lines);
      emit(node.body, depth + 1, lines);
      break;
    case NodeType.BreakStmt:
      lines.push(`${pad}Break`);
      break;
    case NodeType.ContinueStmt:
      lines.push(`${pad}Continue`);
      break;
    case NodeType.ReturnStmt:
      lines.push(`${pad}Return`);
      emitOrNull(node.argument, depth + 1, lines, "value");
      break;
    case NodeType.ImportStmt:
      lines.push(`${pad}Import ${JSON.stringify(node.path)}${node.alias ? ` as ${node.alias}` : ""}`);
      break;
    case NodeType.TryStmt:
      lines.push(`${pad}Try`);
      emit(node.block, depth + 1, lines);
      lines.push(`${pad}${INDENT}Catch ${node.param}`);
      emit(node.handler, depth + 1, lines);
      break;
    case NodeType.NumberLit:
      lines.push(`${pad}NumberLit ${formatNumber(node.value)}`);
      break;
    case NodeType.StringLit:
      lines.push(`${pad}StringLit ${JSON.stringify(node.value)}`);
      break;
    case NodeType.BoolLit:
      lines.push(`${pad}BoolLit ${node.value}`);
      break;
    case NodeType.NullLit:
      lines.push(`${pad}NullLit`);
      break;
    case NodeType.Identifier:
      lines.push(`${pad}Identifier ${node.name}`);
      break;
    case NodeType.ArrayLit:
      lines.push(`${pad}ArrayLit`);
      node.elements.forEach((e) => emit(e, depth + 1, lines));
      break;
    case NodeType.MapLit:
      lines.push(`${pad}MapLit`);
      node.entries.forEach((entry) => {
        lines.push(`${pad}${INDENT}Entry`);
        emit(entry.key, depth + 2, lines);
        emit(entry.value, depth + 2, lines);
      });
      break;
    case NodeType.UnaryExpr:
      lines.push(`${pad}Unary ${node.operator}`);
      emit(node.operand, depth + 1, lines);
      break;
    case NodeType.BinaryExpr:
      lines.push(`${pad}Binary ${node.operator}`);
      emit(node.left, depth + 1, lines);
      emit(node.right, depth + 1, lines);
      break;
    case NodeType.LogicalExpr:
      lines.push(`${pad}Logical ${node.operator}`);
      emit(node.left, depth + 1, lines);
      emit(node.right, depth + 1, lines);
      break;
    case NodeType.AssignExpr:
      lines.push(`${pad}Assign ${node.operator}`);
      emit(node.target, depth + 1, lines);
      emit(node.value, depth + 1, lines);
      break;
    case NodeType.GroupingExpr:
      lines.push(`${pad}Group`);
      emit(node.expression, depth + 1, lines);
      break;
    case NodeType.CallExpr:
      lines.push(`${pad}Call`);
      emit(node.callee, depth + 1, lines);
      node.args.forEach((a) => emit(a, depth + 1, lines));
      break;
    case NodeType.IndexExpr:
      lines.push(`${pad}Index`);
      emit(node.object, depth + 1, lines);
      emit(node.index, depth + 1, lines);
      break;
    default:
      lines.push(`${pad}<unknown ${node.type}>`);
  }
}

function emitOrNull(node, depth, lines, label) {
  if (node) emit(node, depth, lines);
  else lines.push(`${INDENT.repeat(depth)}<none ${label}>`);
}

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return String(value);
}
