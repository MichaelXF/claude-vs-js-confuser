/* ------------------------------------------------------------------ *
 * Control-flow structuring
 *
 * The flattened bytecode is an ordinary (reducible) control-flow graph once the
 * dispatcher has been resolved, so it can be turned back into if/else and loops with
 * dominator analysis.  Anything that will not structure cleanly falls back to a labelled
 * dispatch loop for that function, which is ugly but always correct.
 * ------------------------------------------------------------------ */

function computeDominators(bbs, entry) {
  const order = [];
  const seen = new Set();
  (function dfs(id) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const s of bbs.get(id).succ) if (bbs.has(s)) dfs(s);
    order.push(id);
  })(entry);
  const rpo = order.slice().reverse();
  const idx = new Map(rpo.map((id, i) => [id, i]));
  const preds = new Map();
  for (const id of rpo) preds.set(id, []);
  for (const id of rpo) for (const s of bbs.get(id).succ) if (preds.has(s)) preds.get(s).push(id);
  const idom = new Map([[entry, entry]]);
  const intersect = (a, b) => {
    while (a !== b) {
      while (idx.get(a) > idx.get(b)) a = idom.get(a);
      while (idx.get(b) > idx.get(a)) b = idom.get(b);
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of rpo) {
      if (id === entry) continue;
      let newIdom = null;
      for (const p of preds.get(id)) {
        if (!idom.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(p, newIdom);
      }
      if (newIdom !== null && idom.get(id) !== newIdom) { idom.set(id, newIdom); changed = true; }
    }
  }
  return { idom, rpo, idx, preds };
}

function findLoops(bbs, dom) {
  const { idom, idx, preds } = dom;
  const dominates = (a, b) => {
    let cur = b;
    while (true) {
      if (cur === a) return true;
      const nxt = idom.get(cur);
      if (nxt === undefined || nxt === cur) return false;
      cur = nxt;
    }
  };
  const loops = new Map();      // header -> {header, body:Set, latches:[]}
  for (const [id, bb] of bbs) {
    if (!idx.has(id)) continue;
    for (const s of bb.succ) {
      if (!bbs.has(s) || !idx.has(s)) continue;
      if (dominates(s, id)) {
        let loop = loops.get(s);
        if (!loop) { loop = { header: s, body: new Set([s]), latches: [] }; loops.set(s, loop); }
        loop.latches.push(id);
        const stack = [id];
        while (stack.length) {
          const n = stack.pop();
          if (loop.body.has(n)) continue;
          loop.body.add(n);
          for (const p of preds.get(n) || []) stack.push(p);
        }
      }
    }
  }
  for (const [, loop] of loops) {
    loop.exits = new Set();
    for (const n of loop.body) for (const s of bbs.get(n).succ) if (!loop.body.has(s) && bbs.has(s)) loop.exits.add(s);
  }
  return { loops, dominates };
}

/**
 * Emit a function body as structured statements.  Throws `RESTRUCTURE` when the graph
 * does not fit if/else + loops, so the caller can fall back to the dispatch loop.
 */
const RESTRUCTURE = Symbol('restructure');

function structureFunction(ctx, bbs, entry) {
  const dom = computeDominators(bbs, entry);
  const { loops, dominates } = findLoops(bbs, dom);
  const emitted = new Set();
  const loopStack = [];
  let labelCounter = 0;

  const postDominatorJoin = (a, b, stop) => {
    // first block reachable from both branches (approximated by the dominator tree)
    const seenA = new Set();
    let cur = a;
    while (cur !== undefined) { seenA.add(cur); cur = dom.idom.get(cur) === cur ? undefined : dom.idom.get(cur); }
    return null;
  };

  const emitSeq = (id, stop) => {
    const stmts = [];
    let cur = id;
    const guard = new Set();
    while (cur !== undefined && cur !== null) {
      if (stop.has(cur)) { stmts.push(...jumpTo(cur, stop)); return stmts; }
      const brk = breakOrContinue(cur);
      if (brk) { stmts.push(brk); return stmts; }
      if (guard.has(cur)) throw RESTRUCTURE;
      guard.add(cur);
      const loop = loops.get(cur);
      if (loop && !loopStack.some(l => l.header === cur)) {
        const { stmt, after } = emitLoop(loop, stop);
        stmts.push(stmt);
        cur = after;
        continue;
      }
      if (emitted.has(cur)) throw RESTRUCTURE;
      emitted.add(cur);
      const bb = bbs.get(cur);
      stmts.push(...ctx.blockStatements(bb));
      const term = ctx.terminator(bb);
      if (term.kind === 'return' || term.kind === 'throw') { stmts.push(term.stmt); return stmts; }
      if (term.kind === 'branch') {
        const join = findJoin(bb, stop);
        const innerStop = new Set(stop);
        if (join) innerStop.add(join);
        const consequent = emitSeq(term.trueTarget, innerStop);
        const alternate = term.falseTarget !== undefined ? emitSeq(term.falseTarget, innerStop) : [];
        stmts.push(ctx.makeIf(term.test, consequent, alternate));
        cur = join;
        continue;
      }
      cur = term.target;
    }
    return stmts;
  };

  const jumpTo = (target, stop) => {
    const brk = breakOrContinue(target);
    return brk ? [brk] : [];
  };

  const breakOrContinue = target => {
    for (let i = loopStack.length - 1; i >= 0; i--) {
      const l = loopStack[i];
      if (target === l.header) return ctx.makeContinue(i === loopStack.length - 1 ? null : l.label());
      if (target === l.exit) return ctx.makeBreak(i === loopStack.length - 1 ? null : l.label());
    }
    return null;
  };

  const findJoin = (bb, stop) => {
    // the nearest block dominated by bb that both successors reach
    const [t, f] = bb.succ;
    const reach = start => {
      const out = new Set();
      const work = [start];
      while (work.length) {
        const n = work.pop();
        if (n === undefined || out.has(n) || !bbs.has(n)) continue;
        out.add(n);
        for (const s of bbs.get(n).succ) work.push(s);
      }
      return out;
    };
    if (t === undefined || f === undefined) return undefined;
    const rt = reach(t), rf = reach(f);
    let best;
    for (const id of dom.rpo) {
      if (rt.has(id) && rf.has(id) && dominates(bb.id, id) && !emitted.has(id)) { best = id; break; }
    }
    return best;
  };

  const emitLoop = (loop, stop) => {
    const exits = [...loop.exits];
    const exit = exits.length ? exits[0] : undefined;
    let labelName = null;
    const entryCtx = {
      header: loop.header, exit,
      label: () => { if (!labelName) labelName = ctx.newLabel(); return labelName; },
    };
    loopStack.push(entryCtx);
    const innerStop = new Set(stop);
    for (const e of exits) innerStop.add(e);
    emitted.add(loop.header);
    const bb = bbs.get(loop.header);
    const body = [...ctx.blockStatements(bb)];
    const term = ctx.terminator(bb);
    if (term.kind === 'return' || term.kind === 'throw') body.push(term.stmt);
    else if (term.kind === 'branch') {
      const consequent = emitSeq(term.trueTarget, innerStop);
      const alternate = term.falseTarget !== undefined ? emitSeq(term.falseTarget, innerStop) : [];
      body.push(ctx.makeIf(term.test, consequent, alternate));
    } else if (term.target !== undefined) {
      body.push(...emitSeq(term.target, innerStop));
    }
    loopStack.pop();
    // exits other than the primary one need labelled breaks; they were emitted as breaks
    const stmt = ctx.makeLoop(body, labelName);
    return { stmt, after: exit !== undefined && !stop.has(exit) ? exit : undefined };
  };

  const body = emitSeq(entry, new Set());
  return body;
}
