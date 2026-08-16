"use strict";
/**
 * Lifting: analyzed blocks -> JavaScript AST.
 *
 * Each block becomes a list of statements over "register" identifiers, the
 * dispatcher glue is dropped as dead code, the resulting graph is structured
 * back into if/else and loops, and the register temporaries are folded into
 * ordinary expressions.
 */

const t = require("@babel/types");
const { TOP } = require("./analyze");
const { fitInstruction } = require("./fit");
const { MAGIC_SPREAD, NREG } = require("./machine");

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "export", "extends", "finally", "for", "function", "if", "import", "in", "instanceof",
  "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while",
  "with", "yield", "let", "static", "enum", "await", "implements", "package", "protected",
  "interface", "private", "public", "null", "true", "false", "undefined", "NaN", "Infinity",
  "arguments", "eval",
]);

/** Builds a literal node for a concrete value. */
function literal(value) {
  if (value === undefined) return t.identifier("undefined");
  if (value === null) return t.nullLiteral();
  switch (typeof value) {
    case "boolean": return t.booleanLiteral(value);
    case "string": return t.stringLiteral(value);
    case "number":
      if (Number.isNaN(value)) return t.identifier("NaN");
      if (value === Infinity) return t.identifier("Infinity");
      if (value === -Infinity) return t.unaryExpression("-", t.identifier("Infinity"));
      if (value < 0 || Object.is(value, -0)) return t.unaryExpression("-", t.numericLiteral(-value));
      return t.numericLiteral(value);
    default:
      return null;
  }
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function member(objectNode, propNode) {
  if (t.isStringLiteral(propNode) && IDENT_RE.test(propNode.value) && !RESERVED.has(propNode.value)) {
    return t.memberExpression(objectNode, t.identifier(propNode.value), false);
  }
  return t.memberExpression(objectNode, propNode, true);
}

// --- purity -----------------------------------------------------------------

function isPureExpr(node) {
  if (!node) return true;
  switch (node.type) {
    case "NumericLiteral": case "StringLiteral": case "BooleanLiteral": case "NullLiteral":
    case "Identifier": case "ThisExpression": case "FunctionExpression": case "ArrowFunctionExpression":
    case "RegExpLiteral":
      return true;
    case "UnaryExpression":
      return node.operator !== "delete" && isPureExpr(node.argument);
    case "BinaryExpression":
      return isPureExpr(node.left) && isPureExpr(node.right);
    case "LogicalExpression":
      return isPureExpr(node.left) && isPureExpr(node.right);
    case "ConditionalExpression":
      return isPureExpr(node.test) && isPureExpr(node.consequent) && isPureExpr(node.alternate);
    case "ArrayExpression":
      return node.elements.every((e) => e === null || isPureExpr(e));
    case "ObjectExpression":
      return node.properties.every((p) => p.type === "ObjectProperty" && isPureExpr(p.key) && isPureExpr(p.value));
    case "SpreadElement":
      return isPureExpr(node.argument);
    default:
      return false;
  }
}

/** Visits sub-expressions in evaluation order. */
function walkEval(node, visit) {
  if (!node || typeof node.type !== "string") return;
  const kids = [];
  switch (node.type) {
    case "BinaryExpression": case "LogicalExpression": kids.push(node.left, node.right); break;
    case "UnaryExpression": kids.push(node.argument); break;
    case "MemberExpression": kids.push(node.object); if (node.computed) kids.push(node.property); break;
    case "CallExpression": case "NewExpression": kids.push(node.callee, ...node.arguments); break;
    case "AssignmentExpression": kids.push(node.left, node.right); break;
    case "ArrayExpression": kids.push(...node.elements.filter(Boolean)); break;
    case "ObjectExpression": for (const p of node.properties) { if (p.computed) kids.push(p.key); kids.push(p.value); } break;
    case "ConditionalExpression": kids.push(node.test, node.consequent, node.alternate); break;
    case "SequenceExpression": kids.push(...node.expressions); break;
    case "SpreadElement": kids.push(node.argument); break;
    case "ExpressionStatement": kids.push(node.expression); break;
    case "ReturnStatement": case "ThrowStatement": kids.push(node.argument); break;
    default: break;
  }
  visit(node);
  for (const k of kids) walkEval(k, visit);
}

function countIdent(node, name) {
  let n = 0;
  walkEval(node, (x) => { if (x.type === "Identifier" && x.name === name) n++; });
  return n;
}

function replaceIdent(node, name, replacement) {
  let done = false;
  const rec = (parent, key, child) => {
    if (!child || typeof child.type !== "string") return;
    if (!done && child.type === "Identifier" && child.name === name) {
      parent[key] = replacement;
      done = true;
      return;
    }
    for (const k of Object.keys(child)) {
      const v = child[k];
      if (Array.isArray(v)) v.forEach((item, i) => { if (item && item.type) rec(v, i, item); });
      else if (v && typeof v === "object" && typeof v.type === "string") rec(child, k, v);
    }
  };
  const holder = { root: node };
  rec(holder, "root", node);
  return holder.root;
}

// --- lifter -----------------------------------------------------------------

class Lifter {
  constructor(machine, analyzer, functions) {
    this.m = machine;
    this.a = analyzer;
    this.functions = functions;
    this.names = new Map(); // "fnEntry:reg" -> name
    this.usedNames = new Set(RESERVED);
    this.nameSeq = new Map(); // name prefix -> next number
    this.capturedSeq = new Map(); // function index -> next captured-cell number
    this.nameRole = new Map(); // generated name -> its prefix, used to renumber at the end
    this.fnIndex = new Map([...functions.keys()].map((entry, i) => [entry, i]));
    this.warnings = [];
    // warnings about a single lifted expression, reported only if that
    // expression survives the cleanup passes (the flattening glue does not)
    this.deferredWarnings = new Map(); // AST node -> message
    this.collectGlobalNames();
  }

  collectGlobalNames() {
    for (const ins of this.a.instrs.values()) {
      const kind = ins.kind.kind;
      if (kind === "getglobal" || kind === "typeofglobal") this.usedNames.add(String(this.m.decodeConst(ins.words[1], ins.words[2])));
      else if (kind === "setglobal") this.usedNames.add(String(this.m.decodeConst(ins.words[0], ins.words[1])));
    }
  }

  /** `prefix0`, `prefix1`, ... skipping anything the program already uses. */
  freshName(prefix) {
    for (;;) {
      const n = this.nameSeq.get(prefix) || 0;
      this.nameSeq.set(prefix, n + 1);
      const name = prefix + n;
      if (!this.usedNames.has(name)) {
        this.usedNames.add(name);
        this.nameRole.set(name, prefix);
        return name;
      }
    }
  }

  /**
   * Names a register after the role it plays, since the bytecode carries no
   * identifiers to recover:
   *
   *   `p0`     parameter
   *   `args0`  the array of all arguments, which the VM keeps in its own register
   *   `c1_0`   a variable captured by a nested function (`1` is the owning function)
   *   `v0`     an ordinary local
   *
   * Names are unique across the whole program rather than per function, so a
   * nested function can never shadow a captured variable it also reads.
   */
  regName(fnEntry, reg) {
    const key = fnEntry + ":" + reg;
    if (!this.names.has(key)) this.names.set(key, this.roleName(fnEntry, reg));
    return this.names.get(key);
  }

  roleName(fnEntry, reg) {
    const fn = this.functions.get(fnEntry);
    if (!fn) return this.freshName("v");
    const params = fn.desc.d | 0;
    if (reg < params) return this.freshName("p");
    if (fn.captured.has(reg)) {
      const index = this.fnIndex.get(fnEntry) || 0;
      const n = this.capturedSeq.get(index) || 0;
      this.capturedSeq.set(index, n + 1);
      const name = `c${index}_${n}`;
      if (!this.usedNames.has(name)) {
        this.usedNames.add(name);
        this.nameRole.set(name, `c${index}_`);
        return name;
      }
      return this.freshName(`c${index}_`);
    }
    if (reg === params) return this.freshName("args");
    return this.freshName("v");
  }

  reg(fn, r) {
    return t.identifier(this.regName(fn.entry, r));
  }

  // ---- per instruction ----------------------------------------------------

  /** Builds the expression an instruction produces, or a statement for side effects. */
  liftInstruction(fn, node, ins) {
    const w = ins.words;
    const kind = ins.kind.kind;
    const R = (r) => this.reg(fn, r);
    const dest = this.a.destOf(ins, fn.key);
    const folded = node.values.has(ins.pc) ? node.values.get(ins.pc) : undefined;
    const out = [];
    const assign = (expr) => out.push({ kind: "assign", reg: dest, expr });

    // a folded value is a concrete constant computed by the analyzer
    if (folded !== undefined && kind !== "func" && node.values.has(ins.pc)) {
      const lit = literal(folded);
      if (lit) { assign(lit); return out; }
    }

    switch (kind) {
      case "loadimm": assign(literal(w[1] | 0 === w[1] ? w[1] : w[1])); break;
      case "loadconst": {
        const value = this.m.decodeConst(w[1], w[2]);
        const lit = literal(value);
        assign(lit || t.identifier("undefined"));
        break;
      }
      case "this": assign(t.thisExpression()); break;
      case "void": assign(t.identifier("undefined")); break;
      case "getmember": assign(member(R(w[1]), R(w[2]))); break;
      case "setmember":
        out.push({ kind: "effect", expr: t.assignmentExpression("=", member(R(w[0]), R(w[1])), R(w[2])) });
        break;
      case "deletemember": assign(t.unaryExpression("delete", member(R(w[1]), R(w[2])))); break;
      case "getglobal": assign(t.identifier(String(this.m.decodeConst(w[1], w[2])))); break;
      case "typeofglobal": assign(t.unaryExpression("typeof", t.identifier(String(this.m.decodeConst(w[1], w[2]))))); break;
      case "setglobal":
        out.push({ kind: "effect", expr: t.assignmentExpression("=", t.identifier(String(this.m.decodeConst(w[0], w[1]))), R(w[2])) });
        break;
      case "getclosure": assign(this.closureRef(fn, w[1])); break;
      case "setclosure":
        out.push({ kind: "effect", expr: t.assignmentExpression("=", this.closureRef(fn, w[0]), R(w[1])) });
        break;
      case "array": assign(t.arrayExpression(w.slice(2).map((r) => R(r)))); break;
      case "object": {
        const props = [];
        for (let i = 2; i < w.length; i += 2) props.push(t.objectProperty(R(w[i]), R(w[i + 1]), true));
        assign(t.objectExpression(props));
        break;
      }
      case "definegetter": case "definesetter":
        out.push({
          kind: "effect",
          expr: t.callExpression(t.memberExpression(t.identifier("Object"), t.identifier("defineProperty")), [
            R(w[0]), R(w[1]),
            t.objectExpression([
              t.objectProperty(t.identifier(kind === "definegetter" ? "get" : "set"), R(w[2])),
              t.objectProperty(t.identifier("configurable"), t.booleanLiteral(true)),
              t.objectProperty(t.identifier("enumerable"), t.booleanLiteral(true)),
            ]),
          ]),
        });
        break;
      case "call": case "mcall": case "new": {
        const spreadFlag = kind === "mcall" ? w[3] : w[2];
        const argStart = kind === "mcall" ? 4 : 3;
        const spread = spreadFlag === MAGIC_SPREAD;
        const args = spread ? [t.spreadElement(R(w[argStart]))] : w.slice(argStart).map((r) => R(r));
        if (kind === "new") assign(t.newExpression(R(w[1]), args));
        else if (kind === "call") assign(t.callExpression(R(w[1]), args));
        else assign(t.callExpression(t.memberExpression(R(w[2]), t.identifier("call")), [R(w[1]), ...args]));
        break;
      }
      case "func": {
        assign(this.liftFunctionExpression(w[1]));
        break;
      }
      case "forininit":
        this.needsForInHelper = true;
        assign(t.callExpression(t.identifier(this.forInHelperName()), [R(w[1])]));
        break;
      case "debugger": out.push({ kind: "debugger" }); break;
      case "trypop": case "trycatch": case "tryfinally":
        this.warnings.push(`exception handling opcode (${kind}) at ${ins.pc} is not reconstructed`);
        break;
      case "decrypt":
        this.warnings.push(`self-modifying bytecode opcode at ${ins.pc} is not supported`);
        break;
      case "arith": {
        const inputs = node.inputs.get(ins.pc) || new Map();
        const srcs = this.a.srcRegs(ins);
        const fixed = new Map();
        for (const [r, v] of inputs) if (v !== TOP) fixed.set(r, v);
        let fit = fitInstruction(this.m, this.m.code, ins.pc, fn.key, srcs, fixed);
        if (fit.kind === "const") fit = fitInstruction(this.m, this.m.code, ins.pc, fn.key, srcs, new Map());
        if (fit.kind === "binary") assign(t.binaryExpression(fit.op, R(fit.a), R(fit.b)));
        else if (fit.kind === "unary" && fit.op === "") assign(R(fit.a));
        else if (fit.kind === "unary") assign(t.unaryExpression(fit.op, R(fit.a), true));
        else {
          const placeholder = t.identifier("undefined");
          this.deferredWarnings.set(placeholder, `could not identify the operator of opcode ${ins.op} at ${ins.pc}`);
          assign(placeholder);
        }
        break;
      }
      default:
        this.warnings.push(`unhandled opcode role "${kind}" at ${ins.pc}`);
        break;
    }
    return out;
  }

  /** If register `fnReg` was loaded as `objReg[prop]` in this block, report it. */
  memberSourceOf(node, ins, fnReg, thisReg) {
    let found = null;
    for (const other of node.instrs) {
      if (other.pc >= ins.pc) break;
      const d = this.a.destOf(other, node.fn.key);
      if (d === fnReg) found = other.kind.kind === "getmember" && other.words[1] === thisReg ? other : null;
      else if (d === thisReg) found = null; // `this` was recomputed in between
    }
    return found ? { obj: found.words[1], prop: found.words[2] } : null;
  }

  forInHelperName() {
    if (!this._forInName) this._forInName = this.freshName("forIn");
    return this._forInName;
  }

  closureRef(fn, index) {
    const cell = fn.closureMap && fn.closureMap[index];
    if (!cell) {
      this.warnings.push(`unresolved closure cell ${index} in function @${fn.entry}`);
      return t.identifier("undefined");
    }
    return t.identifier(this.regName(cell.fn, cell.reg));
  }
}

module.exports = { Lifter, literal, member, isPureExpr, walkEval, countIdent, replaceIdent, RESERVED, IDENT_RE };

// --- graph assembly, cleanup and emission ------------------------------------

const { structureGraph, StructureError } = require("./structure");

Object.assign(Lifter.prototype, {
  /** Builds the lifted block graph of one VM function. */
  buildGraph(fn) {
    const map = new Map();
    const nodeOf = (analysisNode) => {
      if (map.has(analysisNode)) return map.get(analysisNode);
      const lnode = { id: map.size, src: analysisNode, stmts: [], term: null, pc: analysisNode.pc };
      map.set(analysisNode, lnode);
      return lnode;
    };
    const start = nodeOf(fn.startNode);
    const queue = [fn.startNode];
    const seen = new Set([fn.startNode]);
    while (queue.length) {
      const src = queue.shift();
      const lnode = nodeOf(src);
      const consumed = new Set();
      const stmts = [];
      const terminator = src.instrs[src.instrs.length - 1];
      for (const ins of src.instrs) {
        if (ins === terminator && this.a.isTerminator(ins.kind)) break;
        for (const piece of this.liftInstruction(fn, src, ins)) stmts.push({ ...piece, pc: ins.pc });
      }
      lnode.stmts = stmts;
      lnode.term = this.buildTerm(fn, src, nodeOf);
      for (const s of src.succ || []) if (!seen.has(s)) { seen.add(s); queue.push(s); }
    }
    return { start, nodes: [...map.values()] };
  },

  /** `dest = next key of iter`, branching to `done` when the keys run out. */
  buildForIn(fn, outcome, nodeOf) {
    const iter = this.reg(fn, outcome.iter);
    const dest = this.reg(fn, outcome.dest);
    const test = t.binaryExpression("<", t.memberExpression(iter, t.identifier("i")),
      t.memberExpression(t.memberExpression(iter, t.identifier("keys")), t.identifier("length")));
    const body = nodeOf(outcome.nodes[1]);
    body.stmts = [{
      kind: "assign", reg: outcome.dest, pc: -1,
      expr: t.memberExpression(t.memberExpression(iter, t.identifier("keys")), t.updateExpression("++", t.memberExpression(iter, t.identifier("i")), false), true),
    }].concat(body.stmts);
    void dest;
    return { kind: "branch", test, then: body, else: nodeOf(outcome.nodes[0]) };
  },

  buildTerm(fn, src, nodeOf) {
    const outcomes = src.outcomes || [];
    const term = src.term;
    const R = (r) => this.reg(fn, r);
    if (!outcomes.length) return { kind: "return", expr: null };
    if (outcomes.length === 1) {
      const o = outcomes[0];
      if (o.kind === "return") return { kind: "return", expr: R(o.reg) };
      if (o.kind === "throw") return { kind: "throw", expr: R(o.reg) };
      if (o.kind === "dynamic") {
        this.warnings.push(`unresolved computed jump at ${term.pc}`);
        return { kind: "return", expr: null };
      }
      if (o.kind === "forinnext") return this.buildForIn(fn, o, nodeOf);
      if (o.kind === "branch") {
        const [target, fall] = o.nodes;
        return o.whenFalse
          ? { kind: "branch", test: t.unaryExpression("!", R(o.reg), true), then: nodeOf(target), else: nodeOf(fall) }
          : { kind: "branch", test: R(o.reg), then: nodeOf(target), else: nodeOf(fall) };
      }
      return { kind: "goto", target: nodeOf(o.nodes[0]) };
    }
    // two outcomes: the analyzer split on a boolean register
    const whenTrue = outcomes.find((o) => o.split && o.split.value === true);
    const whenFalse = outcomes.find((o) => o.split && o.split.value === false);
    if (whenTrue && whenFalse && whenTrue.nodes.length === 1 && whenFalse.nodes.length === 1) {
      return { kind: "branch", test: R(whenTrue.split.reg), then: nodeOf(whenTrue.nodes[0]), else: nodeOf(whenFalse.nodes[0]) };
    }
    const first = outcomes[0];
    if (first.kind === "branch") {
      const [target, fall] = first.nodes;
      return first.whenFalse
        ? { kind: "branch", test: t.unaryExpression("!", R(first.reg), true), then: nodeOf(target), else: nodeOf(fall) }
        : { kind: "branch", test: R(first.reg), then: nodeOf(target), else: nodeOf(fall) };
    }
    if (first.kind === "forinnext") return this.buildForIn(fn, first, nodeOf);
    this.warnings.push(`unexpected terminator shape at ${term.pc}`);
    return { kind: "goto", target: nodeOf(first.nodes[0]) };
  },
});

Object.assign(Lifter.prototype, {
  /** Registers used by a statement piece. */
  usesOf(piece) {
    const set = new Set();
    const expr = piece.kind === "assign" ? piece.expr : piece.expr;
    if (expr) walkEval(expr, (n) => { if (n.type === "Identifier") set.add(n.name); });
    return set;
  },

  /** Backward liveness over the lifted graph, in terms of emitted variable names. */
  liveSets(fn, graph) {
    const succs = new Map();
    for (const n of graph.nodes) succs.set(n, termSuccessors(n.term));
    const liveIn = new Map(graph.nodes.map((n) => [n, new Set()]));
    for (let round = 0; round < 1000; round++) {
      let changed = false;
      for (const n of graph.nodes) {
        const live = new Set();
        for (const s of succs.get(n)) for (const r of liveIn.get(s) || []) live.add(r);
        for (const r of termUses(n.term)) live.add(r);
        for (let i = n.stmts.length - 1; i >= 0; i--) {
          const piece = n.stmts[i];
          if (piece.kind === "assign") live.delete(this.regName(fn.entry, piece.reg));
          for (const r of this.usesOf(piece)) live.add(r);
        }
        const before = liveIn.get(n);
        if (live.size !== before.size || [...live].some((r) => !before.has(r))) { liveIn.set(n, live); changed = true; }
      }
      if (!changed) break;
    }
    return { liveIn, succs };
  },

  /** Removes assignments whose result is never read (the dispatcher glue). */
  eliminateDeadCode(fn, graph) {
    const alwaysLive = new Set([...fn.captured].map((r) => this.regName(fn.entry, r)));
    const { liveIn, succs } = this.liveSets(fn, graph);
    for (const n of graph.nodes) {
      const live = new Set(alwaysLive);
      for (const s of succs.get(n)) for (const r of liveIn.get(s) || []) live.add(r);
      for (const r of termUses(n.term)) live.add(r);
      const kept = [];
      for (let i = n.stmts.length - 1; i >= 0; i--) {
        const piece = n.stmts[i];
        if (piece.kind === "assign") {
          const name = this.regName(fn.entry, piece.reg);
          if (!live.has(name) && isPureExpr(piece.expr)) continue; // dead and side-effect free
          if (!live.has(name) && !isPureExpr(piece.expr)) {
            kept.push({ kind: "effect", expr: piece.expr, pc: piece.pc });
            for (const r of this.usesOf(piece)) live.add(r);
            continue;
          }
          live.delete(name);
        }
        kept.push(piece);
        for (const r of this.usesOf(piece)) live.add(r);
      }
      kept.reverse();
      n.stmts = kept;
    }
  },

  /** Folds single-use temporaries back into the expression that consumes them. */
  inlineTemporaries(fn, graph) {
    const succs = new Map();
    for (const n of graph.nodes) succs.set(n, termSuccessors(n.term));
    // live-out is computed on the lifted graph, so scratch registers that die
    // inside a block can be folded away
    const { liveIn } = this.liveSets(fn, graph);
    const liveOutOf = new Map();
    for (const n of graph.nodes) {
      const set = new Set();
      for (const s of succs.get(n)) for (const r of liveIn.get(s) || []) set.add(r);
      liveOutOf.set(n, set);
    }
    const captured = new Set([...fn.captured].map((r) => this.regName(fn.entry, r)));

    for (const n of graph.nodes) {
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = 0; i < n.stmts.length; i++) {
          const def = n.stmts[i];
          if (def.kind !== "assign") continue;
          const name = this.regName(fn.entry, def.reg);
          if (captured.has(name)) continue;
          let redefined = false;
          for (let j = i + 1; j < n.stmts.length; j++) {
            if (n.stmts[j].kind === "assign" && this.regName(fn.entry, n.stmts[j].reg) === name) { redefined = true; break; }
          }
          if (!redefined && liveOutOf.get(n).has(name)) continue; // still read afterwards
          // find the single use in this block
          let useIndex = -1;
          let uses = 0;
          for (let j = i + 1; j < n.stmts.length; j++) {
            const c = countIdent(n.stmts[j].expr, name);
            if (c) { uses += c; if (useIndex < 0) useIndex = j; }
            if (n.stmts[j].kind === "assign" && this.regName(fn.entry, n.stmts[j].reg) === name) break;
          }
          const inTerm = termUses(n.term).filter((r) => r === name).length;
          if (uses + inTerm !== 1) continue;
          const target = useIndex >= 0 ? n.stmts[useIndex] : null;
          if (!target && inTerm !== 1) continue;
          if (!this.canMove(fn, n, i, useIndex, def, name)) continue;
          if (target) target.expr = replaceIdent(target.expr, name, def.expr);
          else this.replaceInTerm(n.term, name, def.expr);
          n.stmts.splice(i, 1);
          progress = true;
          break;
        }
      }
    }
  },

  /** Registers live on entry to the analyzed block that starts at `pc`. */
  fnLiveIn(fn, pc) {
    const set = fn.liveIn && fn.liveIn.get(pc);
    if (set) return set;
    // unknown block: assume everything is live
    const all = [];
    for (let r = 0; r < fn.desc.Q; r++) all.push(r);
    return all;
  },

  replaceInTerm(term, name, expr) {
    if (term.kind === "branch") term.test = replaceIdent(term.test, name, expr);
    else if (term.kind === "return" || term.kind === "throw") { if (term.expr) term.expr = replaceIdent(term.expr, name, expr); }
  },

  /** Checks that moving a definition down to its use preserves evaluation order. */
  canMove(fn, node, defIndex, useIndex, def, name) {
    const defPure = isPureExpr(def.expr);
    // a plain property read only depends on its operands, so it may move past
    // statements that do not touch them
    const defReadOnly = !defPure && isReadOnlyExpr(def.expr);
    const defReads = this.usesOf(def);
    const last = useIndex < 0 ? node.stmts.length : useIndex;
    for (let k = defIndex + 1; k < last; k++) {
      const piece = node.stmts[k];
      if (piece.kind === "assign" && defReads.has(this.regName(fn.entry, piece.reg))) return false;
      if (!defPure && !defReadOnly && !isPureExpr(piece.expr)) return false;
      if (!defPure && !defReadOnly && piece.kind === "effect") return false;
    }
    if (defPure || useIndex < 0) return true;
    // an impure definition may only move into the first impure slot of its use:
    // nothing with side effects may be evaluated before the operand it replaces
    return !impureBeforeUse(node.stmts[useIndex].expr, name);
  },
});

/** Property reads: impure in principle (getters), but safe to reorder in practice. */
function isReadOnlyExpr(node) {
  if (!node) return true;
  if (isPureExpr(node)) return true;
  if (node.type === "MemberExpression") return isReadOnlyExpr(node.object) && (!node.computed || isReadOnlyExpr(node.property));
  return false;
}

/** Children of `node` in JavaScript evaluation order. */
function evalChildren(node) {
  switch (node.type) {
    case "BinaryExpression": case "LogicalExpression": return [node.left, node.right];
    case "UnaryExpression": return [node.argument];
    case "MemberExpression": return node.computed ? [node.object, node.property] : [node.object];
    case "CallExpression": case "NewExpression": return [node.callee, ...node.arguments];
    case "AssignmentExpression": return [node.left, node.right];
    case "ArrayExpression": return node.elements.filter(Boolean);
    case "ObjectExpression": {
      const out = [];
      for (const p of node.properties) { if (p.computed) out.push(p.key); out.push(p.value); }
      return out;
    }
    case "ConditionalExpression": return [node.test, node.consequent, node.alternate];
    case "SequenceExpression": return node.expressions;
    case "SpreadElement": return [node.argument];
    default: return [];
  }
}

/** True if something with side effects is evaluated before `name` is read. */
function impureBeforeUse(root, name) {
  let found = false;
  let blocked = false;
  const rec = (node) => {
    if (found || !node || typeof node.type !== "string") return;
    if (node.type === "Identifier" && node.name === name) { found = true; return; }
    const kids = evalChildren(node);
    for (const k of kids) { rec(k); if (found) return; }
    if (!isPureExpr(node)) blocked = true; // the operation itself runs after its operands
  };
  rec(root);
  return blocked;
}

function termSuccessors(term) {
  if (!term) return [];
  switch (term.kind) {
    case "goto": return [term.target];
    case "branch": return [term.then, term.else];
    case "forin": return [term.body, term.done];
    default: return [];
  }
}
function termUses(term) {
  if (!term) return [];
  const out = [];
  if (term.kind === "branch") walkEval(term.test, (n) => { if (n.type === "Identifier") out.push(n.name); });
  if ((term.kind === "return" || term.kind === "throw") && term.expr) walkEval(term.expr, (n) => { if (n.type === "Identifier") out.push(n.name); });
  return out;
}

require("./emit").install(Lifter, { isPureExpr, walkEval, termSuccessors, termUses });

module.exports.termSuccessors = termSuccessors;
module.exports.termUses = termUses;
module.exports.walkAll = require("./emit").walkAll;
