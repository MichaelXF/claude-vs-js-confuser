"use strict";
/**
 * Cosmetic passes over the finished AST. None of these change behavior:
 * they undo formatting artifacts of the lifting so the result reads like
 * ordinary source.
 */

const t = require("@babel/types");

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_PROPS = new Set(); // property names may be reserved words in ES5+

function walk(node, visit, parent, key) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    const value = node[k];
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === "string") walk(item, visit, node, k); }
    else if (value && typeof value === "object" && typeof value.type === "string") walk(value, visit, node, k);
  }
}

/** `o["name"]` -> `o.name` where the key is a plain identifier. */
function dotProperties(program) {
  walk(program, (node) => {
    if (node.type !== "MemberExpression" || !node.computed) return;
    const prop = node.property;
    if (prop.type !== "StringLiteral" || !IDENT_RE.test(prop.value) || RESERVED_PROPS.has(prop.value)) return;
    node.computed = false;
    node.property = t.identifier(prop.value);
  });
  walk(program, (node) => {
    if (node.type !== "ObjectProperty" || !node.computed) return;
    const key = node.key;
    if (key.type !== "StringLiteral" || !IDENT_RE.test(key.value)) return;
    node.computed = false;
    node.key = t.identifier(key.value);
  });
}

function terminates(stmt) {
  if (!stmt) return false;
  return ["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(stmt.type);
}
function lastOf(list) { return list.length ? list[list.length - 1] : null; }

/** `if (c) { ...; return } else { rest }` -> `if (c) { ...; return } rest` */
function flattenElse(program) {
  const visitBody = (body) => {
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      if (stmt.type !== "IfStatement" || !stmt.alternate) continue;
      const cons = stmt.consequent.type === "BlockStatement" ? stmt.consequent.body : [stmt.consequent];
      if (!terminates(lastOf(cons))) continue;
      const alt = stmt.alternate.type === "BlockStatement" ? stmt.alternate.body : [stmt.alternate];
      stmt.alternate = null;
      body.splice(i + 1, 0, ...alt);
    }
  };
  walk(program, (node) => {
    if (node.type === "BlockStatement" || node.type === "Program") visitBody(node.body);
  });
}

/** Drops a trailing bare `return;` and unreachable statements after a jump. */
function trimDeadTails(program) {
  walk(program, (node) => {
    if (node.type !== "BlockStatement" && node.type !== "Program") return;
    const body = node.body;
    for (let i = 0; i < body.length; i++) {
      if (terminates(body[i])) { body.length = i + 1; break; }
    }
  });
  walk(program, (node) => {
    if (node.type !== "FunctionExpression" && node.type !== "FunctionDeclaration") return;
    const body = node.body.body;
    while (body.length && body[body.length - 1].type === "ReturnStatement" && !body[body.length - 1].argument) body.pop();
  });
}

/** `x = <expr>` on a declared local becomes its initializer when it is the first write. */
function inlineDeclarations(program) {
  walk(program, (node) => {
    if (node.type !== "BlockStatement" && node.type !== "Program") return;
    const body = node.body;
    if (!body.length || body[0].type !== "VariableDeclaration") return;
    const decl = body[0];
    for (const declarator of decl.declarations) {
      if (declarator.init) continue;
      const name = declarator.id.name;
      // the first statement after the declaration that mentions the variable
      let index = -1;
      for (let i = 1; i < body.length; i++) {
        let mentions = false;
        walk(body[i], (n) => { if (n.type === "Identifier" && n.name === name) mentions = true; });
        if (mentions) { index = i; break; }
        if (body[i].type !== "ExpressionStatement" && body[i].type !== "VariableDeclaration") break;
      }
      if (index < 0) continue;
      const stmt = body[index];
      if (stmt.type !== "ExpressionStatement" || stmt.expression.type !== "AssignmentExpression") continue;
      const assign = stmt.expression;
      if (assign.operator !== "=" || assign.left.type !== "Identifier" || assign.left.name !== name) continue;
      let usesSelf = false;
      walk(assign.right, (n) => { if (n.type === "Identifier" && n.name === name) usesSelf = true; });
      if (usesSelf) continue;
      // only hoist when nothing in between could observe the variable
      let blocked = false;
      for (let i = 1; i < index; i++) if (body[i].type !== "ExpressionStatement" && body[i].type !== "VariableDeclaration") blocked = true;
      if (blocked) continue;
      // turn the assignment into its own declaration and drop the bare name
      body[index] = t.variableDeclaration("var", [t.variableDeclarator(t.identifier(name), assign.right)]);
      decl.declarations = decl.declarations.filter((d) => d !== declarator);
    }
  });
}

/** `x + -5` -> `x - 5`, purely cosmetic. */
function normalizeNegativeAdds(program) {
  walk(program, (node) => {
    if (node.type !== "BinaryExpression") return;
    const right = node.right;
    if (!right || right.type !== "UnaryExpression" || right.operator !== "-" || right.argument.type !== "NumericLiteral") return;
    if (node.operator === "+") { node.operator = "-"; node.right = right.argument; }
    else if (node.operator === "-") { node.operator = "+"; node.right = right.argument; }
  });
}

/** Removes `return;` that sits at the very end of a function. */
function dropTailReturns(program) {
  const trimTail = (body) => {
    while (body.length) {
      const last = body[body.length - 1];
      if (last.type === "ReturnStatement" && !last.argument) { body.pop(); continue; }
      if (last.type === "IfStatement") {
        if (last.consequent.type === "BlockStatement") trimTail(last.consequent.body);
        if (last.alternate && last.alternate.type === "BlockStatement") trimTail(last.alternate.body);
      }
      break;
    }
  };
  walk(program, (node) => {
    if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") trimTail(node.body.body);
  });
  trimTail(program.body);
}

/** Empty declarations left over after hoisting. */
function dropEmptyDeclarations(program) {
  walk(program, (node) => {
    if (node.type !== "BlockStatement" && node.type !== "Program") return;
    node.body = node.body.filter((st) => !(st.type === "VariableDeclaration" && st.declarations.length === 0));
  });
}

function polish(program) {
  dotProperties(program);
  flattenElse(program);
  trimDeadTails(program);
  inlineDeclarations(program);
  dropEmptyDeclarations(program);
  flattenElse(program);
  trimDeadTails(program);
  normalizeNegativeAdds(program);
  dropTailReturns(program);
  return program;
}

module.exports = { polish, walk };
