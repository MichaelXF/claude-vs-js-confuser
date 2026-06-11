// DEBUG simulator — validates the VM model before building the full engine.
// Keep this file (per instructions).
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });

// ---- locate helpers ----
const top = {};
for (const n of ast.program.body) if (t.isFunctionDeclaration(n)) top[n.id.name] = n;
const decoderName = "I", sumName = "J", dispName = "K";
const K = top[dispName];
const stateParam = K.params[0].name; // "S"

// while + switch
let whileStmt = K.body.body.find((s) => t.isWhileStatement(s));
const terminal = whileStmt.test.right.value; // 143
const sw = whileStmt.body.body.find((s) => t.isSwitchStatement(s));

// ---- decoder ----
function decode(str, J) {
  let L = "";
  const M = (((J % 95) + 95) % 95);
  for (let N = 0; N < str.length; N++) {
    const Q = ((str.charCodeAt(N) - 32) - M + 95) % 95;
    L += String.fromCharCode(Q + 32);
  }
  return L;
}

// ---- concrete evaluator over tracked arrays ----
function memberKey(node) {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) {
    let prop;
    if (!node.computed && t.isIdentifier(node.property)) prop = node.property.name;
    else if (node.computed && t.isStringLiteral(node.property)) prop = node.property.value;
    else return null;
    const base = memberKey(node.object);
    return base ? base + "." + prop : null;
  }
  return null;
}

class NotConcrete extends Error {}

// env.arrays: { key: number[] }
function evalConst(node, env) {
  switch (node.type) {
    case "NumericLiteral": return { t: "n", v: node.value };
    case "StringLiteral": return { t: "s", v: node.value };
    case "UnaryExpression": {
      const a = evalConst(node.argument, env);
      if (node.operator === "-") return { t: "n", v: -num(a) };
      if (node.operator === "+") return { t: "n", v: +num(a) };
      if (node.operator === "!") return { t: "n", v: !num(a) };
      throw new NotConcrete();
    }
    case "BinaryExpression": {
      const l = num(evalConst(node.left, env));
      const r = num(evalConst(node.right, env));
      switch (node.operator) {
        case "+": return { t: "n", v: l + r };
        case "-": return { t: "n", v: l - r };
        case "*": return { t: "n", v: l * r };
        case "/": return { t: "n", v: l / r };
        case "%": return { t: "n", v: l % r };
        case "==": return { t: "b", v: l == r };
        case "===": return { t: "b", v: l === r };
        case "!=": return { t: "b", v: l != r };
        case "!==": return { t: "b", v: l !== r };
        case "<": return { t: "b", v: l < r };
        case ">": return { t: "b", v: l > r };
        case "<=": return { t: "b", v: l <= r };
        case ">=": return { t: "b", v: l >= r };
        default: throw new NotConcrete();
      }
    }
    case "LogicalExpression": {
      const l = evalConst(node.left, env);
      if (node.operator === "&&") return truthy(l) ? evalConst(node.right, env) : l;
      if (node.operator === "||") return truthy(l) ? l : evalConst(node.right, env);
      throw new NotConcrete();
    }
    case "MemberExpression": {
      const key = memberKey(node.object);
      if (key && env.arrays[key]) {
        const idx = num(evalConst(node.property, env));
        const arr = env.arrays[key];
        if (idx < 0 || idx >= arr.length) throw new NotConcrete();
        return { t: "n", v: arr[idx] };
      }
      throw new NotConcrete();
    }
    case "CallExpression": {
      if (t.isIdentifier(node.callee, { name: decoderName })) {
        const s = str(evalConst(node.arguments[0], env));
        const j = num(evalConst(node.arguments[1], env));
        return { t: "s", v: decode(s, j) };
      }
      throw new NotConcrete();
    }
    default: throw new NotConcrete();
  }
}
function num(r) { if (r.t === "n") return r.v; if (r.t === "b") return r.v; throw new NotConcrete(); }
function str(r) { if (r.t === "s") return r.v; throw new NotConcrete(); }
function truthy(r) { return !!r.v; }

// evaluate a case-label test against current state; returns the numeric label value or null
function evalLabel(testNode, env) {
  try {
    const r = evalConst(testNode, env);
    if (r.t === "b") return r.v ? 1 /*won't match numeric sum unless 1*/ : NaN;
    return r.v;
  } catch (e) { if (e instanceof NotConcrete) return undefined; throw e; }
}

// ---- classify a case body into a flat statement list (fall-through aware) ----
function gatherFrom(idx) {
  let out = [];
  for (let j = idx; j < sw.cases.length; j++) out = out.concat(sw.cases[j].consequent);
  return out;
}

function findCaseIndex(S, sum) {
  const env = { arrays: { [stateParam]: S } };
  for (let i = 0; i < sw.cases.length; i++) {
    const c = sw.cases[i];
    if (!c.test) continue; // default
    const v = evalLabel(c.test, env);
    if (v === sum) return i;
  }
  return -1;
}

// is statement (or seq element) an S-update?  S[idx] <op>= rhs
function isStateAssign(expr) {
  return t.isAssignmentExpression(expr) && t.isMemberExpression(expr.left) &&
    memberKey(expr.left.object) === stateParam;
}

function applyAssign(expr, S) {
  const env = { arrays: { [stateParam]: S } };
  const idx = num(evalConst(expr.left.property, env));
  const rhs = num(evalConst(expr.right, env));
  if (expr.operator === "+=") S[idx] += rhs;
  else if (expr.operator === "=") S[idx] = rhs;
  else if (expr.operator === "-=") S[idx] -= rhs;
  else throw new Error("op " + expr.operator);
}

// flatten a SequenceExpression / single expr into element list
function seqElems(expr) {
  return t.isSequenceExpression(expr) ? expr.expressions : [expr];
}

// ---- simulate one function from entry state ----
function simulate(entry, label) {
  const blocks = new Map();
  const order = [];
  const stack = [entry.slice()];
  let guard = 0;
  while (stack.length) {
    if (++guard > 20000) throw new Error("block explosion");
    const S = stack.pop();
    const key = S.join(",");
    if (blocks.has(key)) continue;
    const block = { key, S: S.slice(), term: null, caseIdx: -1, sum: 0 };
    blocks.set(key, block);
    order.push(key);

    const sum = S.reduce((a, b) => a + b, 0);
    block.sum = sum;
    if (sum === terminal) { block.term = { kind: "exit" }; continue; }
    const ci = findCaseIndex(S, sum);
    block.caseIdx = ci;
    if (ci < 0) { block.term = { kind: "nomatch" }; continue; }

    const stmts = gatherFrom(ci);
    const cur = S.slice();
    let done = false;
    for (const stmt of stmts) {
      if (done) break;
      if (t.isBreakStatement(stmt)) {
        const ns = cur.reduce((a, b) => a + b, 0);
        block.term = ns === terminal ? { kind: "exit" } : { kind: "goto", target: cur.join(",") };
        if (ns !== terminal) stack.push(cur.slice());
        done = true; break;
      }
      if (t.isReturnStatement(stmt)) { block.term = { kind: "return" }; done = true; break; }
      if (t.isExpressionStatement(stmt)) {
        for (const el of seqElems(stmt.expression)) {
          if (isStateAssign(el)) applyAssign(el, cur);
          // else: side-effect, ignore in debug
        }
        continue;
      }
      if (t.isIfStatement(stmt)) {
        // branch: both arms are transitions
        const targets = [];
        for (const arm of [stmt.consequent, stmt.alternate]) {
          const armS = cur.slice();
          const body = t.isBlockStatement(arm) ? arm.body : [arm];
          for (const bs of body) {
            if (t.isBreakStatement(bs)) break;
            if (t.isExpressionStatement(bs))
              for (const el of seqElems(bs.expression)) if (isStateAssign(el)) applyAssign(el, armS);
          }
          const ns = armS.reduce((a, b) => a + b, 0);
          targets.push(ns === terminal ? { kind: "exit" } : { target: armS.join(",") });
          if (ns !== terminal) stack.push(armS.slice());
        }
        block.term = { kind: "branch", then: targets[0], else: targets[1] };
        done = true; break;
      }
      if (t.isWhileStatement(stmt)) { block.term = { kind: "nestedVM" }; done = true; break; }
      if (t.isForStatement(stmt) || t.isVariableDeclaration(stmt)) continue; // side-effect
      // unknown
      block.note = "unknown stmt " + stmt.type;
    }
    if (!block.term) block.term = { kind: "fallthrough?" };
  }
  return { blocks, order, label, entry };
}

// entry states
const entries = {
  main: [-197, 230, -154, -172, -11, 219, -65],
  "o.d": [96, 1219, -553, -822, 111, -93, -206],
  "o.c": [180, -323, -116, -29, 595, -247, 140],
  "o.b": [182, -323, 838, -188, -422, -247, 140],
  "o.a": [182, -323, 838, -188, -422, -247, 77],
  "E.a": [96, 1219, -141, -822, 111, -111, -206],
};

for (const [name, e] of Object.entries(entries)) {
  const r = simulate(e, name);
  console.log(`\n===== ${name}  entry=[${e}]  blocks=${r.order.length} =====`);
  for (const k of r.order) {
    const b = r.blocks.get(k);
    let termStr;
    if (b.term.kind === "goto") termStr = `goto ${r.order.indexOf(b.term.target)}`;
    else if (b.term.kind === "branch")
      termStr = `branch then=${b.term.then.kind === "exit" ? "EXIT" : r.order.indexOf(b.term.then.target)} else=${b.term.else.kind === "exit" ? "EXIT" : r.order.indexOf(b.term.else.target)}`;
    else termStr = b.term.kind;
    console.log(`  #${r.order.indexOf(k)} sum=${b.sum} caseIdx=${b.caseIdx} -> ${termStr}${b.note ? "  [" + b.note + "]" : ""}`);
  }
}
