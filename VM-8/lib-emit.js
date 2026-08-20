'use strict';
// ---------------------------------------------------------------------------
// Graph cleanup (chain merging + dead code elimination) and reconstruction of
// structured JavaScript from the recovered CFG.
// ---------------------------------------------------------------------------
const t = require('@babel/types');

// --- register uses / defs --------------------------------------------------
function keyRegs(k) { return k && k.reg !== undefined ? [k.reg] : []; }

function usesOf(s) {
  switch (s.kind) {
    case 'const': case 'this': case 'getglobal': case 'typeofglobal': case 'getupval':
    case 'closure': case 'debugger': case 'nop': return [];
    case 'select': return [s.cond.reg];
    case 'mov': return [s.src];
    case 'bin': return [s.a, s.b];
    case 'binimm': return [s.a];
    case 'un': return [s.src];
    case 'setglobal': case 'setupval': return [s.src];
    case 'getprop': return [s.obj, ...keyRegs(s.key)];
    case 'setprop': return [s.obj, s.src, ...keyRegs(s.key)];
    case 'delete': return [s.obj, ...keyRegs(s.key)];
    case 'array': return s.items.slice();
    case 'object': return [].concat(...s.pairs.map(p => [...keyRegs(p[0]), p[1]]));
    case 'call': return [s.callee, ...s.args];
    case 'mcall': return [s.callee, s.thisReg, ...s.args];
    case 'new': return [s.callee, ...s.args];
    case 'forin': case 'forinnext': return [s.obj];
    case 'defgetter': case 'defsetter': return [s.obj, s.fn, ...keyRegs(s.key)];
    case 'opaque': return s.srcs.slice();
    default: return [];
  }
}
const SIDE_EFFECTS = new Set(['call', 'mcall', 'new', 'setprop', 'setglobal', 'setupval',
  'delete', 'defgetter', 'defsetter', 'debugger', 'opaque', 'forinnext']);

function defOf(s) { return s.dst !== undefined ? s.dst : null; }

function succNodes(n) {
  const tm = n.term;
  if (!tm) return [];
  switch (tm.type) {
    case 'goto': return [tm.target];
    case 'if': return [tm.then, tm.else];
    case 'trycatch': return [tm.body, tm.handler];
    case 'tryend': return [tm.target];
    case 'iter': return [tm.body, tm.done];
    default: return [];
  }
}

// --- 1. merge single-entry chains -----------------------------------------
function recomputePreds(entry) {
  const seen = new Set();
  const stack = [entry];
  const all = [];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n); all.push(n); n.preds = 0;
    for (const s of succNodes(n)) stack.push(s);
  }
  for (const n of all) for (const s of succNodes(n)) s.preds++;
  entry.preds++;
  return all;
}

function mergeChains(entry) {
  let changed = true;
  while (changed) {
    changed = false;
    const all = recomputePreds(entry);
    for (const n of all) {
      const tm = n.term;
      if (tm && tm.type === 'goto' && tm.target !== n && tm.target.preds === 1 && tm.target !== entry) {
        n.stmts = n.stmts.concat(tm.target.stmts);
        n.term = tm.target.term;
        changed = true;
      }
    }
  }
  return recomputePreds(entry);
}

function remapUses(s, map) {
  const m = (r) => (map.has(r) ? map.get(r) : r);
  const key = (k) => (k && k.reg !== undefined ? { reg: m(k.reg) } : k);
  switch (s.kind) {
    case 'select': s.cond = { reg: m(s.cond.reg), neg: s.cond.neg }; break;
    case 'mov': s.src = m(s.src); break;
    case 'bin': s.a = m(s.a); s.b = m(s.b); break;
    case 'binimm': s.a = m(s.a); break;
    case 'un': s.src = m(s.src); break;
    case 'setglobal': case 'setupval': s.src = m(s.src); break;
    case 'getprop': s.obj = m(s.obj); s.key = key(s.key); break;
    case 'setprop': s.obj = m(s.obj); s.src = m(s.src); s.key = key(s.key); break;
    case 'delete': s.obj = m(s.obj); s.key = key(s.key); break;
    case 'array': s.items = s.items.map(m); break;
    case 'object': s.pairs = s.pairs.map(([k, v]) => [key(k), m(v)]); break;
    case 'call': s.callee = m(s.callee); s.args = s.args.map(m); break;
    case 'mcall':
      s.callee = m(s.callee); s.thisReg = m(s.thisReg); s.args = s.args.map(m);
      if (s.member) s.member = { obj: m(s.member.obj), key: key(s.member.key) };
      break;
    case 'new': s.callee = m(s.callee); s.args = s.args.map(m); break;
    case 'forin': case 'forinnext': s.obj = m(s.obj); break;
    case 'defgetter': case 'defsetter': s.obj = m(s.obj); s.fn = m(s.fn); s.key = key(s.key); break;
    case 'opaque': s.srcs = s.srcs.map(m); break;
    default: break;
  }
}

// Rename block-local register versions to fresh virtual registers so that the
// later single-assignment/single-use inlining can re-nest expressions.
function introduceTemps(entry, pinned, firstVirtual) {
  const { all, liveOut } = liveness(entry, pinned);
  let next = firstVirtual;
  const origin = new Map();
  for (const n of all) {
    const lastDef = new Map();
    n.stmts.forEach((s, i) => { const d = defOf(s); if (d !== null) lastDef.set(d, i); });
    const cur = new Map();
    const out = liveOut.get(n);
    n.stmts.forEach((s, i) => {
      remapUses(s, cur);
      const d = defOf(s);
      if (d === null) return;
      if (!pinned.has(d) && (i < lastDef.get(d) || !out.has(d))) {
        const v = next++;
        origin.set(v, d);
        cur.set(d, v);
        s.dst = v;
      } else cur.delete(d);
    });
    const tm = n.term;
    if (tm && tm.type === 'if' && cur.has(tm.cond.reg)) {
      n.term = { type: 'if', cond: { reg: cur.get(tm.cond.reg), neg: tm.cond.neg }, then: tm.then, else: tm.else };
    }
    if (tm && tm.type === 'iter' && cur.has(tm.dst)) {
      n.term = Object.assign({}, tm, { dst: cur.get(tm.dst) });
    }
    if (tm && (tm.type === 'ret' || tm.type === 'throw') && tm.value != null && cur.has(tm.value)) {
      n.term = { type: tm.type, value: cur.get(tm.value) };
    }
  }
  return { next, origin };
}

function liveness(entry, pinned) {
  const all = recomputePreds(entry);
  const liveIn = new Map();
  for (const n of all) liveIn.set(n, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i];
      const out = new Set();
      for (const s of succNodes(n)) for (const r of liveIn.get(s)) out.add(r);
      const tm = n.term;
      if (tm) {
        if (tm.type === 'if') out.add(tm.cond.reg);
        if (tm.type === 'iter') out.add(tm.dst);
        if ((tm.type === 'ret' || tm.type === 'throw') && tm.value != null) out.add(tm.value);
      }
      for (let j = n.stmts.length - 1; j >= 0; j--) {
        const s = n.stmts[j];
        const d = defOf(s);
        if (d !== null && !SIDE_EFFECTS.has(s.kind) && !out.has(d) && !pinned.has(d)) continue;
        if (d !== null) out.delete(d);
        for (const u of usesOf(s)) out.add(u);
      }
      const cur = liveIn.get(n);
      let grew = false;
      for (const r of out) if (!cur.has(r)) { cur.add(r); grew = true; }
      if (grew) changed = true;
    }
  }
  // Live *after* the block: successors only.  A value consumed by this block's
  // own terminator is still block-local and may be renamed to a temporary.
  const liveOut = new Map();
  for (const n of all) {
    const out = new Set(pinned);
    for (const s of succNodes(n)) for (const r of liveIn.get(s)) out.add(r);
    liveOut.set(n, out);
  }
  return { all, liveIn, liveOut };
}

// --- 2. dead code elimination ---------------------------------------------
function dce(entry, pinned) {
  const all = recomputePreds(entry);
  const liveIn = new Map();
  for (const n of all) liveIn.set(n, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i];
      const out = new Set();
      for (const s of succNodes(n)) for (const r of liveIn.get(s)) out.add(r);
      const tm = n.term;
      if (tm) {
        if (tm.type === 'if') out.add(tm.cond.reg);
        if (tm.type === 'iter') out.add(tm.dst);
        if (tm.type === 'ret' && tm.value != null) out.add(tm.value);
        if (tm.type === 'throw' && tm.value != null) out.add(tm.value);
      }
      for (let j = n.stmts.length - 1; j >= 0; j--) {
        const s = n.stmts[j];
        const d = defOf(s);
        if (d !== null && !SIDE_EFFECTS.has(s.kind)) {
          if (!out.has(d) && !pinned.has(d)) continue; // dead, contributes nothing
          out.delete(d);
        } else if (d !== null) out.delete(d);
        for (const u of usesOf(s)) out.add(u);
      }
      const cur = liveIn.get(n);
      let grew = false;
      for (const r of out) if (!cur.has(r)) { cur.add(r); grew = true; }
      if (grew) changed = true;
    }
  }
  // second pass: drop the dead statements
  for (const n of all) {
    const out = new Set();
    for (const s of succNodes(n)) for (const r of liveIn.get(s)) out.add(r);
    const tm = n.term;
    if (tm) {
      if (tm.type === 'if') out.add(tm.cond.reg);
      if (tm.type === 'iter') out.add(tm.dst);
      if ((tm.type === 'ret' || tm.type === 'throw') && tm.value != null) out.add(tm.value);
    }
    const keep = [];
    for (let j = n.stmts.length - 1; j >= 0; j--) {
      const s = n.stmts[j];
      const d = defOf(s);
      if (d !== null && !SIDE_EFFECTS.has(s.kind) && !out.has(d) && !pinned.has(d)) continue;
      if (d !== null) out.delete(d);
      for (const u of usesOf(s)) out.add(u);
      keep.push(s);
    }
    keep.reverse();
    n.stmts = keep;
  }
  return recomputePreds(entry);
}

// --- 3. structuring --------------------------------------------------------
function analyzeGraph(entry) {
  const all = recomputePreds(entry);
  const order = [];
  const seen = new Set();
  (function dfs(n) {
    if (seen.has(n)) return;
    seen.add(n);
    for (const s of succNodes(n)) dfs(s);
    order.push(n);
  })(entry);
  const rpo = order.slice().reverse();
  const idx = new Map(rpo.map((n, i) => [n, i]));
  const preds = new Map(all.map(n => [n, []]));
  for (const n of all) for (const s of succNodes(n)) preds.get(s).push(n);

  // iterative dominators
  const idom = new Map();
  idom.set(entry, entry);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of rpo) {
      if (n === entry) continue;
      let newIdom = null;
      for (const p of preds.get(n)) {
        if (!idom.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(p, newIdom);
      }
      if (newIdom && idom.get(n) !== newIdom) { idom.set(n, newIdom); changed = true; }
    }
  }
  function intersect(a, b) {
    while (a !== b) {
      while (idx.get(a) > idx.get(b)) a = idom.get(a);
      while (idx.get(b) > idx.get(a)) b = idom.get(b);
    }
    return a;
  }
  const dominates = (a, b) => { let x = b; while (x !== entry) { if (x === a) return true; x = idom.get(x); } return a === entry; };

  // back edges -> loop headers and bodies
  const loops = new Map();
  for (const n of all) {
    for (const s of succNodes(n)) {
      if (dominates(s, n)) {
        if (!loops.has(s)) loops.set(s, new Set([s]));
        const body = loops.get(s);
        const stack = [n];
        while (stack.length) {
          const x = stack.pop();
          if (body.has(x)) continue;
          body.add(x);
          for (const p of preds.get(x)) stack.push(p);
        }
      }
    }
  }
  // loop exits
  const loopInfo = new Map();
  for (const [h, body] of loops) {
    const exits = new Set();
    for (const x of body) for (const s of succNodes(x)) if (!body.has(s)) exits.add(s);
    loopInfo.set(h, { body, exits: [...exits] });
  }
  return { all, rpo, idx, preds, idom, dominates, loopInfo };
}

function structureGraph(entry, ctxNames) {
  const G = analyzeGraph(entry);
  const emitted = new Set();
  const labels = new Map();
  let labelCount = 0;
  let failed = false;
  let duplicated = 0;

  const endsWithJump = (arr) => {
    const last = arr[arr.length - 1];
    return last && (t.isContinueStatement(last) || t.isBreakStatement(last) ||
      t.isReturnStatement(last) || t.isThrowStatement(last));
  };

  function region(n, stops, loopStack, skipFirstJump) {
    const out = [];
    let cur = n;
    let first = true;
    while (cur) {
      const skip = first && skipFirstJump;
      first = false;
      if (!skip) {
        const j = jumpTo(cur, loopStack);
        if (j) { out.push(j); return out; }
        if (stops.has(cur)) return out;
        const li = G.loopInfo.get(cur);
        if (li && !loopStack.some(l => l.header === cur)) {
          out.push(...emitLoop(cur, li, stops, loopStack));
          return out;
        }
      }
      if (emitted.has(cur) && duplicated++ > 500) {
        failed = true;
        out.push(t.throwStatement(t.stringLiteral('unstructured control flow')));
        return out;
      }
      emitted.add(cur);
      out.push(...cur.stmts.map(s => ctxNames.stmt(s)));
      const tm = cur.term;
      if (!tm) return out;
      if (tm.type === 'ret') {
        out.push(t.returnStatement(tm.value == null ? null : ctxNames.reg(tm.value)));
        return out;
      }
      if (tm.type === 'throw') { out.push(t.throwStatement(ctxNames.reg(tm.value))); return out; }
      if (tm.type === 'goto') { cur = tm.target; continue; }
      if (tm.type === 'tryend') { cur = tm.target; continue; }
      if (tm.type === 'unresolved') {
        failed = true;
        out.push(t.throwStatement(t.stringLiteral('unresolved computed jump')));
        return out;
      }
      if (tm.type === 'trycatch') {
        const end = findTryEnd(tm.body);
        const cont = end && end.term ? end.term.target : null;
        const inner = new Set(stops);
        if (cont) inner.add(cont);
        const tryBody = region(tm.body, inner, loopStack);
        const handler = [];
        if (tm.flagReg !== undefined) handler.push(ctxNames.assignConst(tm.flagReg, tm.flagValue));
        handler.push(ctxNames.assignExc(tm.excReg));
        handler.push(...region(tm.handler, inner, loopStack));
        out.push(t.tryStatement(t.blockStatement(tryBody),
          t.catchClause(t.identifier(ctxNames.excName()), t.blockStatement(handler))));
        if (cont) { cur = cont; continue; }
        return out;
      }
      if (tm.type === 'iter') {
        const doneS = region(tm.done, new Set([...stops, tm.body]), loopStack);
        out.push(t.ifStatement(
          t.binaryExpression('===', ctxNames.reg(tm.dst), t.identifier('__ITER_DONE')),
          t.blockStatement(doneS.length ? doneS : [t.breakStatement()])));
        cur = tm.body;
        continue;
      }
      // conditional
      const join = findJoin(cur, stops, loopStack);
      const innerStops = new Set(stops);
      if (join) innerStops.add(join);
      const thenS = region(tm.then, innerStops, loopStack);
      const elseS = region(tm.else, innerStops, loopStack);
      let test = ctxNames.reg(tm.cond.reg);
      if (tm.cond.neg) test = t.unaryExpression('!', test);
      if (elseS.length === 0) out.push(t.ifStatement(test, t.blockStatement(thenS)));
      else if (thenS.length === 0) out.push(t.ifStatement(t.unaryExpression('!', test), t.blockStatement(elseS)));
      else out.push(t.ifStatement(test, t.blockStatement(thenS), t.blockStatement(elseS)));
      if (!join) return out;
      cur = join;
    }
    return out;
  }

  // first `trypop` at the same nesting depth as the `trypush` that opened it
  function findTryEnd(start) {
    const seen = new Set();
    const stack = [[start, 0]];
    while (stack.length) {
      const [n, depth] = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      const tm = n.term;
      if (!tm) continue;
      if (tm.type === 'tryend') { if (depth === 0) return n; stack.push([tm.target, depth - 1]); continue; }
      if (tm.type === 'trycatch') { stack.push([tm.body, depth + 1], [tm.handler, depth]); continue; }
      for (const s of succNodes(n)) stack.push([s, depth]);
    }
    return null;
  }

  function jumpTo(target, loopStack) {
    for (let i = loopStack.length - 1; i >= 0; i--) {
      const l = loopStack[i];
      if (l.header === target) {
        return i === loopStack.length - 1 ? t.continueStatement() : t.continueStatement(t.identifier(labelFor(l)));
      }
      if (l.follow === target) {
        return i === loopStack.length - 1 ? t.breakStatement() : t.breakStatement(t.identifier(labelFor(l)));
      }
    }
    return null;
  }
  function labelFor(l) {
    if (!labels.has(l)) labels.set(l, 'L' + (labelCount++));
    return labels.get(l);
  }

  function emitLoop(header, li, stops, loopStack) {
    let follow = null;
    const outside = li.exits.filter(e => !li.body.has(e));
    if (outside.length === 1) follow = outside[0];
    else if (outside.length > 1) {
      // pick the exit that post-dominates the others (approximated by RPO order)
      follow = outside.slice().sort((a, b) => G.idx.get(a) - G.idx.get(b)).pop();
    }
    const l = { header, follow };
    const inner = new Set(stops);
    if (follow) inner.add(follow);
    const body = region(header, inner, loopStack.concat([l]), true);
    if (!body.length || !endsWithJump(body)) body.push(t.breakStatement());
    let loopStmt = t.whileStatement(t.booleanLiteral(true), t.blockStatement(body));
    if (labels.has(l)) loopStmt = t.labeledStatement(t.identifier(labels.get(l)), loopStmt);
    const out = [loopStmt];
    if (follow) {
      const j = jumpTo(follow, loopStack);
      if (j) out.push(j);
      else if (!stops.has(follow)) out.push(...region(follow, stops, loopStack));
    }
    return out;
  }

  // immediate post-dominator of a branch, restricted to nodes it dominates
  function findJoin(n, stops, loopStack) {
    const reach = (start) => {
      const seen = new Set(); const st = [start];
      while (st.length) {
        const x = st.pop();
        if (seen.has(x) || stops.has(x)) { if (stops.has(x)) seen.add(x); continue; }
        seen.add(x);
        for (const s of succNodes(x)) st.push(s);
      }
      return seen;
    };
    const tm = n.term;
    const a = reach(tm.then), b = reach(tm.else);
    const common = [...a].filter(x => b.has(x));
    if (!common.length) return null;
    common.sort((x, y) => G.idx.get(x) - G.idx.get(y));
    for (const c of common) if (G.dominates(n, c) && c !== n) return c;
    return null;
  }

  const body = region(entry, new Set(), []);
  return { body, failed };
}

module.exports = { mergeChains, dce, structureGraph, analyzeGraph, usesOf, defOf, succNodes, recomputePreds, liveness, introduceTemps, remapUses };
