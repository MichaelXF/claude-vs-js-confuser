"use strict";
/**
 * Control-flow structuring: turns a reducible block graph back into
 * if/else statements and loops, using dominators, post-dominators and natural
 * loop detection. If a graph cannot be structured (irreducible control flow)
 * the caller can fall back to an explicit state machine.
 */

const t = require("@babel/types");

class StructureError extends Error {}

function collect(entry, succsOf) {
  const nodes = [];
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    nodes.push(n);
    for (const s of succsOf(n)) if (s) stack.push(s);
  }
  return nodes;
}

function reversePostOrder(entry, succsOf) {
  const order = [];
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const s of succsOf(n)) if (s) visit(s);
    order.push(n);
  };
  visit(entry);
  order.reverse();
  return order;
}

/** Cooper-Harvey-Kennedy iterative dominators. */
function dominators(entry, nodes, predsOf, succsOf) {
  const rpo = reversePostOrder(entry, succsOf);
  const index = new Map(rpo.map((n, i) => [n, i]));
  const idom = new Map([[entry, entry]]);
  const intersect = (a, b) => {
    while (a !== b) {
      while (index.get(a) > index.get(b)) a = idom.get(a);
      while (index.get(b) > index.get(a)) b = idom.get(b);
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of rpo) {
      if (n === entry) continue;
      let newIdom = null;
      for (const p of predsOf(n)) {
        if (!index.has(p) || !idom.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(p, newIdom);
      }
      if (newIdom !== null && idom.get(n) !== newIdom) { idom.set(n, newIdom); changed = true; }
    }
  }
  return idom;
}

/**
 * Structures the graph reachable from `entry`.
 *
 * api = {
 *   succs(node)   -> array of successors,
 *   stmts(node)   -> array of babel statements for the block body,
 *   term(node)    -> { kind: "return"|"throw"|"goto"|"branch", ... },
 * }
 */
function structureGraph(entry, api) {
  const succsOf = (n) => api.succs(n);
  const nodes = collect(entry, succsOf);
  const preds = new Map(nodes.map((n) => [n, []]));
  for (const n of nodes) for (const s of succsOf(n)) if (s && preds.has(s)) preds.get(s).push(n);
  const predsOf = (n) => preds.get(n) || [];

  const idom = dominators(entry, nodes, predsOf, succsOf);
  const dominates = (a, b) => {
    let cur = b;
    for (;;) {
      if (cur === a) return true;
      const next = idom.get(cur);
      if (!next || next === cur) return false;
      cur = next;
    }
  };

  // post-dominators: dominators of the reversed graph with a virtual exit
  const EXIT = { virtual: true };
  const rsuccs = new Map(nodes.map((n) => [n, []]));
  const rpreds = new Map(nodes.map((n) => [n, []]));
  rsuccs.set(EXIT, []);
  rpreds.set(EXIT, []);
  for (const n of nodes) {
    const ss = succsOf(n).filter(Boolean);
    if (!ss.length) { rsuccs.get(EXIT).push(n); rpreds.get(n).push(EXIT); }
    for (const s of ss) { rsuccs.get(s).push(n); rpreds.get(n).push(s); }
  }
  const ipdom = dominators(EXIT, [EXIT, ...nodes], (n) => rpreds.get(n) || [], (n) => rsuccs.get(n) || []);

  // natural loops
  const loopHeaders = new Map(); // header -> Set(body)
  for (const n of nodes) {
    for (const s of succsOf(n)) {
      if (!s || !dominates(s, n)) continue;
      const body = loopHeaders.get(s) || new Set([s]);
      const stack = [n];
      while (stack.length) {
        const x = stack.pop();
        if (body.has(x)) continue;
        body.add(x);
        for (const p of predsOf(x)) stack.push(p);
      }
      loopHeaders.set(s, body);
    }
  }
  const loopExits = new Map();
  for (const [header, body] of loopHeaders) {
    const targets = new Map();
    for (const n of body) for (const s of succsOf(n)) if (s && !body.has(s)) targets.set(s, (targets.get(s) || 0) + 1);
    let chosen = null;
    const pd = ipdom.get(header);
    if (pd && targets.has(pd)) chosen = pd;
    else if (targets.size) chosen = [...targets.entries()].sort((a, b) => b[1] - a[1])[0][0];
    loopExits.set(header, chosen);
  }

  // --- emission ---
  let labelSeq = 0;
  const emitting = new Set();
  let budget = 20000;

  const lookup = (ctx, node) => {
    for (let i = ctx.length - 1; i >= 0; i--) {
      const frame = ctx[i];
      if (frame.node !== node) continue;
      if (frame.kind === "join") return { stop: true, stmts: [] };
      const innermostLoop = [...ctx].reverse().find((f) => f.kind !== "join");
      const needsLabel = !innermostLoop || innermostLoop.loop !== frame.loop;
      if (needsLabel) frame.labelUsed = true;
      const label = needsLabel ? t.identifier(frame.label) : null;
      return { stop: true, stmts: [frame.kind === "continue" ? t.continueStatement(label) : t.breakStatement(label)] };
    }
    return null;
  };

  const emitFrom = (start, ctx, skipLoopCheck) => {
    const out = [];
    let cur = start;
    let first = true;
    while (cur) {
      if (--budget < 0) throw new StructureError("structuring budget exhausted");
      if (!(first && skipLoopCheck)) {
        const action = lookup(ctx, cur);
        if (action) { out.push(...action.stmts); return out; }
        if (loopHeaders.has(cur)) {
          const { stmt, exit } = emitLoop(cur, ctx);
          out.push(stmt);
          cur = exit;
          first = false;
          continue;
        }
      }
      first = false;
      if (emitting.has(cur)) throw new StructureError("unstructured control flow at block " + (cur.pc !== undefined ? cur.pc : ""));
      emitting.add(cur);
      try {
        out.push(...api.stmts(cur));
        const term = api.term(cur);
        if (term.kind === "return") { out.push(t.returnStatement(term.argument || null)); return out; }
        if (term.kind === "throw") { out.push(t.throwStatement(term.argument)); return out; }
        if (term.kind === "goto") { cur = term.target; continue; }
        if (term.kind === "branch") {
          let join = ipdom.get(cur);
          if (join === EXIT || !join) join = null;
          const inner = join ? [...ctx, { node: join, kind: "join" }] : ctx;
          const consequent = emitFrom(term.then, inner, false);
          const alternate = emitFrom(term.else, inner, false);
          out.push(makeIf(term.test, consequent, alternate));
          if (!join) return out;
          cur = join;
          continue;
        }
        throw new StructureError("unknown terminator " + term.kind);
      } finally {
        emitting.delete(cur);
      }
    }
    return out;
  };

  const emitLoop = (header, ctx) => {
    const exit = loopExits.get(header) || null;
    const label = "loop" + labelSeq++;
    const loopId = label;
    const frames = [{ node: header, kind: "continue", label, loop: loopId }];
    if (exit) frames.push({ node: exit, kind: "break", label, loop: loopId });
    const inner = [...ctx, ...frames];
    const body = emitFrom(header, inner, true);
    let stmt = t.whileStatement(t.booleanLiteral(true), t.blockStatement(body));
    if (frames.some((f) => f.labelUsed)) stmt = t.labeledStatement(t.identifier(label), stmt);
    return { stmt: simplifyLoop(stmt), exit };
  };

  return emitFrom(entry, [], false);
}

/** Recovers `while (c) { ... }` from the two shapes the lifter can produce. */
function simplifyLoop(stmt) {
  const loop = stmt.type === "LabeledStatement" ? stmt.body : stmt;
  const body = loop.body.body;
  if (!body.length) return stmt;
  const head = body[0];
  // while (true) { if (!c) break; ... }
  if (head.type === "IfStatement" && !head.alternate && head.consequent.type === "BlockStatement" &&
      head.consequent.body.length === 1 && head.consequent.body[0].type === "BreakStatement" &&
      !head.consequent.body[0].label) {
    loop.test = negate(head.test);
    body.shift();
    return stmt;
  }
  // while (true) { if (c) { ...; continue; } break; }
  if (body.length === 2 && head.type === "IfStatement" && !head.alternate &&
      head.consequent.type === "BlockStatement" && body[1].type === "BreakStatement" && !body[1].label) {
    const inner = head.consequent.body;
    const last = inner[inner.length - 1];
    if (last && last.type === "ContinueStatement" && !last.label) {
      inner.pop();
      loop.test = head.test;
      loop.body = t.blockStatement(inner);
    }
  }
  return stmt;
}

function negate(expr) {
  if (expr.type === "UnaryExpression" && expr.operator === "!") return expr.argument;
  if (expr.type === "BinaryExpression") {
    const inverse = { "===": "!==", "!==": "===", "==": "!=", "!=": "==", "<": ">=", ">=": "<", ">": "<=", "<=": ">" }[expr.operator];
    if (inverse) return t.binaryExpression(inverse, expr.left, expr.right);
  }
  return t.unaryExpression("!", expr, true);
}

function makeIf(test, consequent, alternate) {
  // `if (c) {} else { ... }` reads better as `if (!c) { ... }`
  if (!consequent.length && alternate.length) return t.ifStatement(negate(test), t.blockStatement(alternate));
  return t.ifStatement(test, t.blockStatement(consequent), alternate.length ? t.blockStatement(alternate) : null);
}

module.exports = { structureGraph, StructureError, negate };
