"use strict";
/*
 * Structured emitter: recovers real control flow (if/else, while, try/catch,
 * for-in) from the VM's basic-block CFG, then folds the VM's three-address
 * temporaries back into nested expressions, producing idiomatic JavaScript.
 *
 * Structuring relies on the CFG being reducible (JS-Confuser compiles structured
 * source). Anything that does not fit the recognized well-nested patterns throws
 * `Unstructurable`, making vm.js fall back to the guaranteed-correct dispatcher.
 *
 * Folding is a conservative, per-basic-block copy/expression propagation:
 *   - a register def is inlined into its use only when provably safe
 *     (no reassignment of dependencies in between; side-effecting values inlined
 *      only into a single use with no intervening side effects; pure/duplicable
 *      values may be inlined into several uses).
 *   - registers that stay live across blocks remain as named local variables.
 * Correctness is validated end-to-end by verify.js (input.js vs output.js).
 */
const parser = require("@babel/parser");

class Unstructurable extends Error {}

module.exports = function createStructuredEmitter(deps) {
  const { OP, BINOP, UNOP, VOID_OP, litNode, buildBlocks, successors, t } = deps;
  const clone = (n) => (t.cloneDeepWithoutLoc ? t.cloneDeepWithoutLoc(n) : JSON.parse(JSON.stringify(n)));
  const stmt = (code) => parser.parse(code).program.body[0];

  function emitProgram(instrs, funcs, vm) {
    const byStart = new Map(funcs.map((f) => [f.start, f]));
    const hasClosures = funcs.some((f) => f.caps && f.caps.length > 0);
    const prefixOf = (f) => (hasClosures ? "f" + f.fid + "_" : "");
    let needForIn = false;

    function emitFunc(f, upvalNodes) {
      const prefix = prefixOf(f);
      const reg = (n) => t.identifier(prefix + "r" + n);
      const model = buildModel(instrs, f);
      const liveOut = computeLiveness(instrs, f, model);

      const ctx = {
        f, prefix, reg, model, instrs, liveOut,
        upval: (idx) => clone(upvalNodes[idx]),
        setUpval: (idx, valNode) => t.assignmentExpression("=", clone(upvalNodes[idx]), valNode),
        isTop: f.top,
        markForIn() { needForIn = true; },
        emitChild(startPc) {
          const child = byStart.get(startPc);
          const defIns = f.body.map((pc) => instrs[pc]).find((i) => i.op === OP.DEFINE_FUNCTION && i.fT === startPc);
          const caps = defIns ? defIns.caps : [];
          const childUpvals = caps.map((c) => (c.Y ? reg(c.M) : clone(upvalNodes[c.M])));
          return emitFunc(child, childUpvals);
        },
        labelCounter: 0,
        emitted: new Set(),
        consumed: new Set(),
        materialized: new Set(),
      };

      const bodyStmts = emitSeq(f.start, Infinity, [], ctx);

      for (const addr of model.order) {
        if (!ctx.emitted.has(addr) && !ctx.consumed.has(addr)) {
          throw new Unstructurable("block " + addr + " not emitted in fn@" + f.start);
        }
      }

      const prologue = buildPrologue(f, prefix, ctx.materialized, instrs);
      const fnBody = t.blockStatement(prologue.concat(bodyStmts));
      return t.functionExpression(null, buildParams(f, prefix), fnBody);
    }

    const topFn = emitFunc(byStart.get(0), []);
    const programBody = [];
    if (needForIn) {
      programBody.push(stmt("function __forInKeys(o) { var keys = []; if (o != null) for (var k in o) keys.push(k); return { keys: keys, i: 0 }; }"));
    }
    programBody.push(t.expressionStatement(t.callExpression(topFn, [])));
    const file = t.file(t.program(programBody));
    beautify(file);
    return file;
  }

  // =========================================================================
  // Function model: blocks + terminators + loops + try regions
  // =========================================================================
  function buildModel(instrs, f) {
    const { blocks: rawBlocks, leaderList } = buildBlocks(instrs, f);
    const blocks = new Map();
    for (const ld of leaderList) {
      const list = rawBlocks.get(ld).instrs;
      const last = list[list.length - 1];
      const endAddr = last.start + last.size;
      let side, term;
      switch (last.op) {
        case OP.JUMP: side = list.slice(0, -1); term = { kind: "jump", target: last.target }; break;
        case OP.JUMP_IF_FALSE: side = list.slice(0, -1); term = { kind: "branch", cond: last.cond, whenTrue: endAddr, whenFalse: last.target }; break;
        case OP.JUMP_IF_TRUE: side = list.slice(0, -1); term = { kind: "branch", cond: last.cond, whenTrue: last.target, whenFalse: endAddr }; break;
        case OP.RETURN: side = list.slice(0, -1); term = { kind: "return", val: last.val }; break;
        case OP.THROW: side = list.slice(0, -1); term = { kind: "throw", val: last.val }; break;
        case OP.FORIN_NEXT: side = list.slice(0, -1); term = { kind: "forin", f: last.f, iter: last.iter, target: last.target, next: endAddr }; break;
        case OP.JUMP_DYN: throw new Unstructurable("JUMP_DYN (finally) not structurable");
        default: side = list; term = { kind: "fall", target: endAddr };
      }
      blocks.set(ld, { addr: ld, side, term, endAddr });
    }
    const order = [...blocks.keys()].sort((a, b) => a - b);

    const loops = new Map();
    for (const addr of order) {
      const b = blocks.get(addr);
      for (const tgt of termTargets(b.term)) {
        if (tgt <= addr && blocks.has(tgt)) {
          const cur = loops.get(tgt) || { header: tgt, end: 0 };
          cur.end = Math.max(cur.end, b.endAddr);
          loops.set(tgt, cur);
        }
      }
    }
    for (const lp of loops.values()) lp.exit = lp.end;

    const regions = [];
    const regionByStart = new Map();
    const stack = [];
    for (const addr of order) {
      for (const ins of blocks.get(addr).side) {
        if (ins.op === OP.TRY_CATCH) {
          stack.push({ type: "catch", tryFrom: ins.start + ins.size, catchPc: ins.catchPc, catchReg: ins.catchReg });
        } else if (ins.op === OP.TRY_FINALLY) {
          throw new Unstructurable("try/finally not structurable");
        } else if (ins.op === OP.TRY_POP) {
          const r = stack.pop();
          if (!r) throw new Unstructurable("unbalanced TRY_POP");
          r.popAddr = ins.start;
          r.popBlock = addr;
          r.afterAddr = resolveAfter(blocks.get(addr));
          regions.push(r);
          regionByStart.set(r.tryFrom, r);
        }
      }
    }
    if (stack.length) throw new Unstructurable("unbalanced TRY_CATCH");

    return { blocks, order, loops, regions, regionByStart };
  }

  function resolveAfter(popBlock) {
    if (popBlock.term.kind === "jump") return popBlock.term.target;
    if (popBlock.term.kind === "fall") return popBlock.term.target;
    throw new Unstructurable("unexpected terminator after TRY_POP");
  }

  function termTargets(term) {
    switch (term.kind) {
      case "jump": return [term.target];
      case "branch": return [term.whenTrue, term.whenFalse];
      case "forin": return [term.target, term.next];
      case "fall": return [term.target];
      default: return [];
    }
  }

  // =========================================================================
  // Liveness (register granularity), incl. exception edges into catch blocks
  // =========================================================================
  function computeLiveness(instrs, f, model) {
    const { blocks, order } = model;
    const useSet = new Map(), defSet = new Map(), succ = new Map();

    for (const addr of order) {
      const blk = blocks.get(addr);
      const defined = new Set(), uses = new Set();
      const consume = (regs) => { for (const r of regs) if (!defined.has(r)) uses.add(r); };
      for (const ins of blk.side) {
        if (ins.op === OP.TRY_CATCH || ins.op === OP.TRY_POP || ins.op === OP.TRY_FINALLY) continue;
        consume(instrReads(ins));
        const d = instrDef(ins);
        if (d != null) defined.add(d);
      }
      consume(terminatorReads(blk.term));
      useSet.set(addr, uses);
      defSet.set(addr, defined);

      const s = new Set();
      for (const tgt of termTargets(blk.term)) if (blocks.has(tgt)) s.add(tgt);
      succ.set(addr, s);
    }
    // Exception edges: every block inside a try region can branch to its catch.
    for (const r of model.regions) {
      for (const addr of order) {
        if (addr >= r.tryFrom && addr < r.popAddr && blocks.has(r.catchPc)) succ.get(addr).add(r.catchPc);
      }
    }

    const liveIn = new Map(), liveOut = new Map();
    for (const addr of order) { liveIn.set(addr, new Set()); liveOut.set(addr, new Set()); }
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = order.length - 1; i >= 0; i--) {
        const addr = order[i];
        const out = new Set();
        for (const s of succ.get(addr)) for (const r of liveIn.get(s)) out.add(r);
        const inn = new Set(useSet.get(addr));
        for (const r of out) if (!defSet.get(addr).has(r)) inn.add(r);
        if (!sameSet(out, liveOut.get(addr)) || !sameSet(inn, liveIn.get(addr))) {
          liveOut.set(addr, out); liveIn.set(addr, inn); changed = true;
        }
      }
    }
    return liveOut;
  }
  function sameSet(a, b) { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }

  // =========================================================================
  // Structured emission
  // =========================================================================
  function emitSeq(from, to, loopStack, ctx) {
    const out = [];
    let addr = from, guard = 0;
    while (addr != null && addr < to && addr !== Infinity) {
      if (++guard > 100000) throw new Unstructurable("emitSeq runaway");

      const region = ctx.model.regionByStart.get(addr);
      if (region && !ctx.consumed.has(region.popBlock)) {
        emitTryRegion(region, loopStack, ctx, out);
        addr = region.afterAddr;
        continue;
      }
      const lp = ctx.model.loops.get(addr);
      if (lp && !loopStack.some((l) => l.header === addr)) {
        out.push(emitLoop(lp, loopStack, ctx));
        addr = lp.end;
        continue;
      }
      const blk = ctx.model.blocks.get(addr);
      if (!blk) throw new Unstructurable("no block at " + addr);
      if (ctx.emitted.has(addr)) throw new Unstructurable("block re-emitted: " + addr);
      ctx.emitted.add(addr);

      const folded = foldBlock(blk, ctx);
      out.push(...folded.stmts);
      addr = emitTerminator(blk, folded.termNodes, to, loopStack, ctx, out);
    }
    return out;
  }

  function emitTryRegion(region, loopStack, ctx, out) {
    ctx.consumed.add(region.popBlock);
    const tryBody = emitSeq(region.tryFrom, region.popAddr, loopStack, ctx);
    let catchBody = [];
    if (region.catchPc !== region.afterAddr) {
      catchBody = emitSeq(region.catchPc, region.afterAddr, loopStack, ctx);
    }
    out.push(t.tryStatement(t.blockStatement(tryBody), t.catchClause(ctx.reg(region.catchReg), t.blockStatement(catchBody))));
  }

  function emitLoop(lp, loopStack, ctx) {
    const label = t.identifier("L" + ctx.labelCounter++);
    const myCtx = { header: lp.header, exit: lp.exit, label };
    const body = emitSeq(lp.header, lp.end, loopStack.concat([myCtx]), ctx);
    while (body.length && t.isContinueStatement(body[body.length - 1]) && !body[body.length - 1].label) body.pop();
    return t.labeledStatement(label, t.whileStatement(t.booleanLiteral(true), t.blockStatement(body)));
  }

  function emitTerminator(blk, termNodes, to, loopStack, ctx, out) {
    const term = blk.term;
    switch (term.kind) {
      case "fall": return term.target;
      case "jump": {
        const j = translate(term.target, loopStack);
        if (j.kind === "continue") { out.push(t.continueStatement(j.label)); return null; }
        if (j.kind === "break") { out.push(t.breakStatement(j.label)); return null; }
        if (term.target >= to) return term.target;
        if (term.target <= blk.addr) throw new Unstructurable("irreducible back jump @" + blk.addr);
        return term.target;
      }
      case "return": out.push(t.returnStatement(termNodes.get(term.val))); return null;
      case "throw": out.push(t.throwStatement(termNodes.get(term.val))); return null;
      case "forin": return emitForIn(blk, term, termNodes, to, loopStack, ctx, out);
      case "branch": return emitBranch(blk, term, termNodes, to, loopStack, ctx, out);
      default: throw new Unstructurable("unknown terminator " + term.kind);
    }
  }

  function translate(target, loopStack) {
    for (let i = loopStack.length - 1; i >= 0; i--) {
      const l = loopStack[i];
      const label = i === loopStack.length - 1 ? null : l.label; // unlabeled for innermost
      if (target === l.header) return { kind: "continue", label };
      if (target === l.exit) return { kind: "break", label };
    }
    return { kind: "goto" };
  }
  function jumpStmt(act) {
    if (act.kind === "continue") return t.continueStatement(act.label);
    if (act.kind === "break") return t.breakStatement(act.label);
    throw new Unstructurable("jumpStmt on goto");
  }

  function emitBranch(blk, term, termNodes, to, loopStack, ctx, out) {
    const next = blk.endAddr;
    const condNode = termNodes.get(term.cond);
    const tAct = translate(term.whenTrue, loopStack);
    const fAct = translate(term.whenFalse, loopStack);

    if (tAct.kind !== "goto" && term.whenFalse === next) {
      out.push(t.ifStatement(condNode, jumpStmt(tAct)));
      return next;
    }
    if (fAct.kind !== "goto" && term.whenTrue === next) {
      out.push(t.ifStatement(notNode(condNode), jumpStmt(fAct)));
      return next;
    }

    let cond, bodyStart, J;
    if (term.whenTrue === next) { cond = condNode; bodyStart = next; J = term.whenFalse; }
    else if (term.whenFalse === next) { cond = notNode(condNode); bodyStart = next; J = term.whenTrue; }
    else throw new Unstructurable("branch with no fallthrough @" + blk.addr);

    if (J <= blk.addr) throw new Unstructurable("backward branch not in loop @" + blk.addr);
    if (J > to) throw new Unstructurable("branch target escapes region @" + blk.addr);

    const elseInfo = detectElse(bodyStart, J, to, loopStack, ctx);
    const thenStmts = emitSeq(bodyStart, J, loopStack, ctx);
    if (elseInfo) {
      const elseStmts = emitSeq(J, elseInfo.merge, loopStack, ctx);
      out.push(t.ifStatement(cond, t.blockStatement(thenStmts), t.blockStatement(elseStmts)));
      return elseInfo.merge;
    }
    out.push(t.ifStatement(cond, t.blockStatement(thenStmts)));
    return J;
  }

  function detectElse(bodyStart, J, to, loopStack, ctx) {
    let lastAddr = -1;
    for (const a of ctx.model.order) if (a >= bodyStart && a < J) lastAddr = a;
    if (lastAddr < 0) return null;
    const lb = ctx.model.blocks.get(lastAddr);
    if (lb.term.kind === "jump") {
      const m = lb.term.target;
      if (translate(m, loopStack).kind === "goto" && m > J && m <= to) return { merge: m };
    }
    return null;
  }

  function emitForIn(blk, term, termNodes, to, loopStack, ctx, out) {
    ctx.markForIn();
    const iter = termNodes.get(term.iter);
    const cond = t.binaryExpression(">=",
      t.memberExpression(clone(iter), t.identifier("i")),
      t.memberExpression(t.memberExpression(clone(iter), t.identifier("keys")), t.identifier("length")));
    const assign = t.expressionStatement(t.assignmentExpression("=", ctx.reg(term.f),
      t.memberExpression(t.memberExpression(clone(iter), t.identifier("keys")),
        t.updateExpression("++", t.memberExpression(clone(iter), t.identifier("i")), false), true)));
    ctx.materialized.add(term.f);
    const exitAct = translate(term.target, loopStack);
    if (exitAct.kind !== "goto") {
      out.push(t.ifStatement(t.unaryExpression("!", cond), t.blockStatement([assign]), t.blockStatement([jumpStmt(exitAct)])));
      return term.next;
    }
    throw new Unstructurable("for-in exit not handled @" + blk.addr);
  }

  function notNode(node) {
    if (t.isUnaryExpression(node) && node.operator === "!") return node.argument;
    if (t.isBinaryExpression(node)) {
      const flip = { "===": "!==", "!==": "===", "==": "!=", "!=": "==", "<": ">=", ">": "<=", "<=": ">", ">=": "<" };
      if (flip[node.operator]) return t.binaryExpression(flip[node.operator], node.left, node.right);
    }
    return t.unaryExpression("!", node);
  }

  // =========================================================================
  // Per-block expression folding
  // =========================================================================
  function foldBlock(blk, ctx) {
    const liveOut = ctx.liveOut.get(blk.addr) || new Set();
    const ops = [];
    for (const ins of blk.side) {
      if (ins.op === OP.TRY_CATCH || ins.op === OP.TRY_POP || ins.op === OP.TRY_FINALLY) continue;
      ops.push(irForInstr(ins, ctx));
    }
    ops.push({ def: null, reads: terminatorReads(blk.term), effect: false, terminator: true });

    const n = ops.length;
    const lastDef = new Map();
    const useCount = new Array(n).fill(0);
    const usePositions = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (const r of ops[i].reads) {
        if (lastDef.has(r)) { const di = lastDef.get(r); useCount[di]++; usePositions[di].push(i); }
      }
      if (ops[i].def != null) lastDef.set(ops[i].def, i);
    }
    const finalDefIndex = new Map(lastDef);

    const stmts = [];
    const inlined = new Map(); // reg -> {node, deps:Set, effect:bool, globals:Set, dup:bool}
    const termNodes = new Map();

    const resolveRead = (r) => {
      if (inlined.has(r)) {
        const e = inlined.get(r);
        if (e.dup) return { node: clone(e.node), deps: e.deps, effect: e.effect, globals: e.globals };
        inlined.delete(r);
        return e;
      }
      return { node: ctx.reg(r), deps: new Set([r]), effect: false, globals: new Set() };
    };

    const safeDefer = (i, uses, deps, effect, globals) => {
      for (const u of uses) {
        for (let k = i + 1; k < u; k++) {
          const ok = ops[k];
          if (ok.def != null && deps.has(ok.def)) return false;
          if (effect && ok.effect) return false;
          if (ok.def == null && ok.effect && ok.storesGlobal && globals.has(ok.storesGlobal)) return false;
        }
      }
      return true;
    };

    for (let i = 0; i < n; i++) {
      const op = ops[i];
      const resolved = op.reads.map(resolveRead);
      const readNodes = resolved.map((x) => x.node);
      const deps = new Set();
      const globals = new Set(op.globals || []);
      let effect = !!op.effect;
      for (const x of resolved) {
        for (const d of x.deps) deps.add(d);
        for (const g of x.globals) globals.add(g);
        if (x.effect) effect = true;
      }

      if (op.terminator) {
        for (let k = 0; k < op.reads.length; k++) termNodes.set(op.reads[k], readNodes[k]);
        continue;
      }
      if (op.def == null) {
        stmts.push(op.make(readNodes));
        continue;
      }

      const d = op.def;
      const node = op.make(readNodes);
      const isLast = finalDefIndex.get(d) === i;
      const liveOutDef = isLast && liveOut.has(d);

      if (useCount[i] === 0) {
        if (!liveOutDef) {
          if (effect) stmts.push(t.expressionStatement(node)); // keep side effect, drop value
          inlined.delete(d);
          continue;
        }
      }

      let doInline = false;
      if (!op.noInline && !liveOutDef && useCount[i] >= 1) {
        if (useCount[i] === 1 || (op.dup && !effect)) {
          doInline = safeDefer(i, usePositions[i], deps, effect, globals);
        }
      }

      if (doInline) {
        inlined.set(d, { node, deps, effect, globals, dup: !!op.dup && useCount[i] > 1 });
      } else {
        stmts.push(t.expressionStatement(t.assignmentExpression("=", ctx.reg(d), node)));
        ctx.materialized.add(d);
        inlined.delete(d);
      }
    }
    return { stmts, termNodes };
  }

  // =========================================================================
  // IR for a single data instruction (folding-friendly)
  // =========================================================================
  function irForInstr(ins, ctx) {
    const mk = (def, reads, make, opts) => Object.assign({ def, reads, make, effect: false, dup: false, globals: [] }, opts || {});
    switch (ins.op) {
      case OP.LOAD_CONST: return mk(ins.f, [], () => litNode(ins.k), { dup: true });
      case OP.LOAD_IMM: return mk(ins.f, [], () => litNode(ins.k), { dup: true });
      case OP.LOAD_GLOBAL: return mk(ins.f, [], () => identRef(ins.name), { dup: true, globals: [ins.name] });
      case OP.LOAD_THIS: return mk(ins.f, [], () => (ctx.isTop ? t.identifier("undefined") : t.thisExpression()), { dup: true });
      case OP.LOAD_UPVAL: return mk(ins.f, [], () => ctx.upval(ins.idx), { effect: true });
      case OP.MOVE: return mk(ins.f, [ins.src], (nd) => nd[0]);
      case OP.STORE_UPVAL: return mk(null, [ins.src], (nd) => t.expressionStatement(ctx.setUpval(ins.idx, nd[0])), { effect: true });
      case OP.STORE_GLOBAL: return mk(null, [ins.src], (nd) => t.expressionStatement(t.assignmentExpression("=", identRef(ins.name), nd[0])), { effect: true, storesGlobal: ins.name });
      case OP.GET_PROP: return mk(ins.f, [ins.obj, ins.key], (nd) => member(nd[0], nd[1]), { effect: true });
      case OP.SET_PROP: return mk(null, [ins.obj, ins.key, ins.val], (nd) => t.expressionStatement(t.assignmentExpression("=", member(nd[0], nd[1]), nd[2])), { effect: true });
      case OP.DELETE_PROP: return mk(ins.f, [ins.obj, ins.key], (nd) => t.unaryExpression("delete", member(nd[0], nd[1])), { effect: true });
      case OP.POW: return mk(ins.f, [ins.a, ins.b], (nd) => t.binaryExpression("**", nd[0], nd[1]));
      case OP.TYPEOF_GLOBAL: return mk(ins.f, [], () => t.unaryExpression("typeof", identRef(ins.name)), { dup: true, globals: [ins.name] });
      case OP.CALL: {
        const reads = [ins.fn].concat(argRegs(ins.args));
        return mk(ins.f, reads, (nd) => t.callExpression(nd[0], argList(ins.args, nd.slice(1))), { effect: true });
      }
      case OP.CALL_METHOD: {
        const reads = [ins.fn, ins.recv].concat(argRegs(ins.args));
        return mk(ins.f, reads, (nd) => methodCall(nd[0], nd[1], ins.args, nd.slice(2)), { effect: true });
      }
      case OP.NEW: {
        const reads = [ins.fn].concat(argRegs(ins.args));
        return mk(ins.f, reads, (nd) => t.newExpression(nd[0], argList(ins.args, nd.slice(1))), { effect: true });
      }
      case OP.DEFINE_FUNCTION: return mk(ins.f, [], () => ctx.emitChild(ins.fT), { effect: false, noInline: true });
      case OP.NEW_ARRAY: return mk(ins.f, ins.elems.slice(), (nd) => t.arrayExpression(nd));
      case OP.NEW_OBJECT: {
        const reads = [];
        for (const p of ins.pairs) { reads.push(p.k, p.v); }
        return mk(ins.f, reads, (nd) => {
          const props = [];
          for (let i = 0; i < ins.pairs.length; i++) props.push(objProp(nd[i * 2], nd[i * 2 + 1]));
          return t.objectExpression(props);
        });
      }
      case OP.DEFINE_GETTER:
      case OP.DEFINE_SETTER: {
        const kind = ins.op === OP.DEFINE_GETTER ? "get" : "set";
        return mk(null, [ins.obj, ins.key, ins.fn], (nd) => t.expressionStatement(t.callExpression(
          t.memberExpression(t.identifier("Object"), t.identifier("defineProperty")),
          [nd[0], nd[1], t.objectExpression([
            t.objectProperty(t.identifier(kind), nd[2]),
            t.objectProperty(t.identifier("configurable"), t.booleanLiteral(true)),
            t.objectProperty(t.identifier("enumerable"), t.booleanLiteral(true)),
          ])])), { effect: true });
      }
      case OP.FORIN_INIT: return mk(ins.f, [ins.obj], (nd) => { ctx.markForIn(); return t.callExpression(t.identifier("__forInKeys"), [nd[0]]); }, { effect: true });
      case OP.DEBUGGER: return mk(null, [], () => t.debuggerStatement(), { effect: true });
      case OP.CODE_COPY: throw new Unstructurable("CODE_COPY not structurable");
      default: break;
    }
    if (BINOP[ins.op]) return mk(ins.f, [ins.a, ins.b], (nd) => t.binaryExpression(BINOP[ins.op], nd[0], nd[1]));
    if (UNOP[ins.op]) return mk(ins.f, [ins.a], (nd) => t.unaryExpression(UNOP[ins.op], nd[0], true));
    if (ins.op === VOID_OP) return mk(ins.f, [ins.a], (nd) => t.unaryExpression("void", nd[0]));
    throw new Unstructurable("no IR for op " + ins.op);
  }

  function argRegs(args) { return args.spread != null ? [args.spread] : args.list.slice(); }
  function argList(args, nodes) { return args.spread != null ? [t.spreadElement(nodes[0])] : nodes; }
  function methodCall(fnNode, recvNode, args, argNodes) {
    if (t.isMemberExpression(fnNode) && nodeEq(fnNode.object, recvNode)) {
      return t.callExpression(fnNode, argList(args, argNodes));
    }
    const arr = args.spread != null ? argNodes[0] : t.arrayExpression(argNodes);
    return t.callExpression(t.memberExpression(fnNode, t.identifier("apply")), [recvNode, arr]);
  }

  function member(obj, key) {
    if (t.isStringLiteral(key) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key.value)) {
      return t.memberExpression(obj, t.identifier(key.value));
    }
    return t.memberExpression(obj, key, true);
  }
  function objProp(keyNode, valNode) {
    if (t.isStringLiteral(keyNode) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(keyNode.value)) {
      return t.objectProperty(t.identifier(keyNode.value), valNode, false);
    }
    if (t.isStringLiteral(keyNode) || t.isNumericLiteral(keyNode)) {
      return t.objectProperty(keyNode, valNode, false);
    }
    return t.objectProperty(keyNode, valNode, true);
  }
  function identRef(name) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return t.identifier(name);
    return t.memberExpression(t.identifier("globalThis"), t.stringLiteral(name), true);
  }
  function nodeEq(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    switch (a.type) {
      case "Identifier": return a.name === b.name;
      case "ThisExpression": case "NullLiteral": return true;
      case "StringLiteral": case "NumericLiteral": case "BooleanLiteral": return a.value === b.value;
      case "MemberExpression": return a.computed === b.computed && nodeEq(a.object, b.object) && nodeEq(a.property, b.property);
      default: return false;
    }
  }

  // =========================================================================
  // Instruction reads / def (for liveness)
  // =========================================================================
  function instrReads(ins) {
    const r = [];
    const add = (x) => { if (typeof x === "number") r.push(x); };
    switch (ins.op) {
      case OP.MOVE: add(ins.src); break;
      case OP.STORE_GLOBAL: add(ins.src); break;
      case OP.STORE_UPVAL: add(ins.src); break;
      case OP.GET_PROP: add(ins.obj); add(ins.key); break;
      case OP.SET_PROP: add(ins.obj); add(ins.key); add(ins.val); break;
      case OP.DELETE_PROP: add(ins.obj); add(ins.key); break;
      case OP.POW: add(ins.a); add(ins.b); break;
      case OP.CALL: add(ins.fn); argRegs(ins.args).forEach(add); break;
      case OP.CALL_METHOD: add(ins.fn); add(ins.recv); argRegs(ins.args).forEach(add); break;
      case OP.NEW: add(ins.fn); argRegs(ins.args).forEach(add); break;
      case OP.NEW_ARRAY: ins.elems.forEach(add); break;
      case OP.NEW_OBJECT: ins.pairs.forEach((p) => { add(p.k); add(p.v); }); break;
      case OP.DEFINE_GETTER: case OP.DEFINE_SETTER: add(ins.obj); add(ins.key); add(ins.fn); break;
      case OP.FORIN_INIT: add(ins.obj); break;
      default:
        if (BINOP[ins.op]) { add(ins.a); add(ins.b); }
        else if (UNOP[ins.op] || ins.op === VOID_OP) { add(ins.a); }
    }
    return r;
  }
  function instrDef(ins) {
    switch (ins.op) {
      case OP.STORE_GLOBAL: case OP.STORE_UPVAL: case OP.SET_PROP:
      case OP.DEFINE_GETTER: case OP.DEFINE_SETTER: case OP.DEBUGGER: return null;
      default:
        if (typeof ins.f === "number") return ins.f;
        return null;
    }
  }
  function terminatorReads(term) {
    switch (term.kind) {
      case "branch": return [term.cond];
      case "return": case "throw": return [term.val];
      case "forin": return [term.iter];
      default: return [];
    }
  }

  // =========================================================================
  // Prologue / params / register declaration
  // =========================================================================
  function buildParams(f, prefix) {
    const params = [];
    const l = f.params;
    if (f.rest) {
      for (let n = 0; n < l - 1; n++) params.push(t.identifier(prefix + "r" + n));
      params.push(t.restElement(t.identifier(prefix + "r" + (l - 1))));
    } else {
      for (let n = 0; n < l; n++) params.push(t.identifier(prefix + "r" + n));
    }
    return params;
  }

  function buildPrologue(f, prefix, materialized, instrs) {
    const out = [];
    const l = f.params, i = f.frameSize;
    const isParam = (n) => (f.rest ? n < l : n < l);

    // The arguments slot (register l) holds the argument array, if read anywhere.
    let argsUsed = false;
    for (const pc of f.body) if (instrReads(instrs[pc]).includes(l)) argsUsed = true;

    const decls = [];
    const seen = new Set();
    if (l < i && argsUsed) {
      decls.push(t.variableDeclarator(t.identifier(prefix + "r" + l),
        t.callExpression(t.memberExpression(t.memberExpression(t.memberExpression(t.identifier("Array"), t.identifier("prototype")), t.identifier("slice")), t.identifier("call")), [t.identifier("arguments")])));
      seen.add(l);
    }
    const matSorted = [...materialized].sort((a, b) => a - b);
    for (const n of matSorted) {
      if (isParam(n) || seen.has(n)) continue;
      seen.add(n);
      decls.push(t.variableDeclarator(t.identifier(prefix + "r" + n)));
    }
    if (decls.length) out.push(t.variableDeclaration("var", decls));
    return out;
  }

  // =========================================================================
  // Light beautification
  // =========================================================================
  function beautify(file) {
    const traverse = require("@babel/traverse").default || require("@babel/traverse");
    // while(true){ if(!c) break; body } -> while(c){ body }   (unlabeled break)
    traverse(file, {
      WhileStatement(path) {
        const body = path.node.body;
        if (!t.isBlockStatement(body) || body.body.length === 0) return;
        const first = body.body[0];
        if (t.isIfStatement(first) && !first.alternate && isUnlabeledBreakOnly(first.consequent)) {
          path.node.test = notNode(first.test);
          body.body.shift();
        }
      },
    });
    // Drop labels that are never referenced.
    traverse(file, {
      LabeledStatement(path) {
        const name = path.node.label.name;
        let used = false;
        path.get("body").traverse({
          "BreakStatement|ContinueStatement"(p) { if (p.node.label && p.node.label.name === name) used = true; },
        });
        if (!used) path.replaceWith(path.node.body);
      },
    });
  }
  function isUnlabeledBreakOnly(node) {
    if (t.isBreakStatement(node)) return !node.label;
    if (t.isBlockStatement(node) && node.body.length === 1 && t.isBreakStatement(node.body[0])) return !node.body[0].label;
    return false;
  }

  return emitProgram;
};
