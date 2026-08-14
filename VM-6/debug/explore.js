// debug/explore.js -- symbolic execution + constant propagation to rebuild the CFG.
// The bytecode is control-flow-flattened: every branch computes its target through
// a hash "dispatcher" function, so targets must be evaluated statically.
const path = require('path');
const fs = require('fs');
const { analyze } = require('./analyze');
const { makeEnv } = require('./ops');

const CONST = (v) => ({ t: 'c', v });

function makeMachine(A) {
  const { L } = A;
  function execData(ins, C, regFile) {
    const env = makeEnv(L, { words: ins.words, C, regs: regFile });
    L.A[ins.op].call(env.inst);
    const wr = env.log.writes.filter(x => x.reg === ins.dst);
    return wr.length ? wr[wr.length - 1].val : undefined;
  }
  return { execData };
}

function evaluate(A, M, val, asg) {
  switch (val.t) {
    case 'c': return val.v;
    case 'u': if (!(val.id in asg)) throw new Error('unbound ' + val.id); return asg[val.id];
    case 'op': {
      const regFile = {};
      val.srcs.forEach((r, i) => { regFile[r] = evaluate(A, M, val.args[i], asg); });
      return M.execData(val.ins, val.C, regFile);
    }
    case 'call': {
      if (val.fnVal.t !== 'func') throw new Error('not a vm function');
      return A.callVMFunction(val.fnVal, val.args.map(a => evaluate(A, M, a, asg)));
    }
    default: throw new Error('cannot evaluate ' + val.t);
  }
}

function freeUnknowns(val, out = new Set()) {
  if (val.t === 'u') out.add(val.id);
  else if (val.t === 'op') val.args.forEach(a => freeUnknowns(a, out));
  else if (val.t === 'call') { freeUnknowns(val.fnVal, out); val.args.forEach(a => freeUnknowns(a, out)); }
  return out;
}

const sameVal = (a, b) => a && b && a.t === b.t &&
  (a.t === 'c' ? Object.is(a.v, b.v) : a.t === 'func' ? a.entry === b.entry : false);

function resolveDyn(A, M, val, free, codeLen) {
  const ok = (pc) => Number.isInteger(pc) && pc >= 0 && pc < codeLen;
  if (free.length === 0) {
    try { const pc = evaluate(A, M, val, {}); return ok(pc) ? [{ pc, cond: null }] : []; }
    catch (e) { return []; }
  }
  if (free.length === 1) {
    for (const cand of [[false, true], [0, 1]]) {
      const res = []; let good = true;
      for (const c of cand) {
        try {
          const pc = evaluate(A, M, val, { [free[0]]: c });
          if (!ok(pc)) { good = false; break; }
          res.push({ pc, cond: { id: free[0], value: c } });
        } catch (e) { good = false; break; }
      }
      if (good) {
        if (res.length === 2 && res[0].pc === res[1].pc) return [{ pc: res[0].pc, cond: null }];
        return res;
      }
    }
  }
  return [];
}

// which registers of this function are captured by closure cells (an inner
// function may write to them behind our back -> never treat them as constant)
function volatileRegs(A, func) {
  const set = new Set();
  const seen = new Set();
  const stack = [func.entry];
  while (stack.length) {
    const pc0 = stack.pop();
    let pc = pc0;
    for (let guard = 0; guard < 100000; guard++) {
      if (seen.has(pc) || pc >= A.code.length) break;
      seen.add(pc);
      const ins = A.decode(pc);
      if (!ins) break;
      if (ins.kind === 'MAKEFUNC') for (const c of ins.cells) if (c.isNew) set.add(c.idx);
      if (ins.kind === 'JMP') { pc = ins.target; continue; }
      if (['RETURN', 'THROW', 'JMPDYN'].includes(ins.kind)) break;
      if (ins.kind === 'JMPIF' || ins.kind === 'JMPIFNOT') stack.push(ins.target);
      if (ins.kind === 'TRYCATCH') stack.push(ins.catchPC);
      if (ins.kind === 'TRYFIN') stack.push(ins.finPC);
      if (ins.kind === 'FORIN_NEXT') stack.push(ins.doneTarget);
      pc = ins.next;
    }
  }
  return set;
}

function explore(A, func) {
  const M = makeMachine(A);
  const { code } = A;
  const vol = volatileRegs(A, func);
  const blocks = new Map();
  const entryStates = new Map();
  const childFuncs = new Map();
  let uid = 0;

  // entry block: params + `arguments` are unknown, everything else is undefined
  const initState = new Map();
  for (let r = 0; r < func.nregs; r++) {
    if (r <= func.nparams) continue;      // params 0..n-1 and `arguments` at n
    if (vol.has(r)) continue;
    initState.set(r, CONST(undefined));
  }
  entryStates.set(func.entry, initState);
  const work = [func.entry];
  const inWork = new Set([func.entry]);

  const merge = (target, state) => {
    const cur = entryStates.get(target);
    if (!cur) { entryStates.set(target, new Map(state)); return true; }
    let changed = false;
    for (const [r, v] of cur) {
      if (!sameVal(state.get(r), v)) { cur.delete(r); changed = true; }
    }
    return changed;
  };
  const push = (pc) => { if (!inWork.has(pc)) { inWork.add(pc); work.push(pc); } };

  let rounds = 0;
  while (work.length) {
    if (++rounds > 20000) throw new Error('explore: no fixpoint');
    const start = work.shift();
    inWork.delete(start);
    const entry = entryStates.get(start) || new Map();
    const regs = new Map(entry);
    const stmts = [];
    const visited = new Set();
    const block = { pc: start, stmts, term: null, succs: [], entry: new Map(entry) };
    blocks.set(start, block);
    const get = (r) => (!vol.has(r) && regs.has(r)) ? regs.get(r) : { t: 'u', id: 'r' + r + '@' + start, kind: 'live' };
    const mkUnk = (kind, ins) => ({ t: 'u', id: 'u' + (uid++), kind, ins });
    let pc = start, stop = false;

    for (;;) {
      if (visited.has(pc)) { block.term = { kind: 'goto', target: pc }; block.succs = [pc]; break; }
      visited.add(pc);
      const ins = A.decode(pc);
      if (!ins) { block.term = { kind: 'bad', pc }; break; }
      const K = func.C;
      switch (ins.kind) {
        case 'DATA': {
          const srcs = ins.srcRegs, args = srcs.map(get);
          let val;
          if (args.every(a => a.t === 'c')) {
            const regFile = {}; srcs.forEach((r, i) => { regFile[r] = args[i].v; });
            let v; try { v = M.execData(ins, K, regFile); } catch (e) { v = undefined; }
            val = CONST(v);
          } else val = { t: 'op', ins, C: K, srcs, args };
          regs.set(ins.dst, val); stmts.push(ins); break;
        }
        case 'LOADCONST': regs.set(ins.dst, CONST(A.readConst(ins.pool, ins.key))); stmts.push(ins); break;
        case 'LOADTHIS': case 'LOADGLOBAL': case 'TYPEOFGLOBAL': case 'LOADCELL':
        case 'ARRAY': case 'OBJECT': case 'FORIN_INIT': case 'FORIN_NEXT': case 'DELETE':
          regs.set(ins.dst, mkUnk(ins.kind, ins)); stmts.push(ins); break;
        case 'MAKEFUNC':
          regs.set(ins.dst, { t: 'func', entry: ins.entry, ins });
          childFuncs.set(ins.entry, ins); stmts.push(ins); break;
        case 'CALL': case 'CALLMETHOD': case 'NEW':
          regs.set(ins.dst, { t: 'call', fnVal: get(ins.fn), args: (ins.args || []).map(get), ins, spread: ins.spread });
          stmts.push(ins); break;
        case 'STOREGLOBAL': case 'SETMEMBER': case 'STORECELL': case 'DEFGET': case 'DEFSET':
        case 'POPTRY': case 'DEBUGGER': case 'TRYCATCH': case 'TRYFIN':
          stmts.push(ins);
          if (ins.kind === 'TRYCATCH') { block.tryTargets = (block.tryTargets || []).concat(ins.catchPC); }
          if (ins.kind === 'TRYFIN') { block.tryTargets = (block.tryTargets || []).concat(ins.finPC); }
          break;
        case 'RETURN': block.term = { kind: 'return', reg: ins.src, val: get(ins.src) }; stop = true; break;
        case 'THROW': block.term = { kind: 'throw', reg: ins.src, val: get(ins.src) }; stop = true; break;
        case 'JMP': pc = ins.target; continue;
        case 'JMPIF': case 'JMPIFNOT':
          block.term = { kind: ins.kind, cond: ins.cond, target: ins.target, next: ins.next };
          block.succs = [ins.target, ins.next]; stop = true; break;
        case 'JMPDYN': {
          const val = get(ins.reg);
          const free = [...freeUnknowns(val)];
          const targets = resolveDyn(A, M, val, free, code.length);
          block.term = { kind: 'dyn', val, free, targets, ins, unresolved: targets.length === 0 };
          block.succs = targets.map(t => t.pc);
          stop = true; break;
        }
        default: stmts.push(ins); break;
      }
      if (stop) break;
      pc = ins.next;
    }
    // propagate the exit state to successors
    const exitState = new Map();
    for (const [r, v] of regs) if ((v.t === 'c' || v.t === 'func') && !vol.has(r)) exitState.set(r, v);
    for (const s of block.succs.concat(block.tryTargets || [])) {
      if (merge(s, exitState) || !blocks.has(s)) push(s);
    }
    block.exit = exitState;
  }
  return { blocks, childFuncs: [...childFuncs.values()], vol };
}

function exploreAll(A) {
  const root = { entry: A.L.tmpl.x.F, nparams: A.L.tmpl.x.o, nregs: A.L.tmpl.x.m, C: A.L.tmpl.x.C, cells: [], hasRest: 0 };
  const funcs = [root];
  const done = new Map();
  while (funcs.length) {
    const f = funcs.shift();
    if (done.has(f.entry)) continue;
    const res = explore(A, f);
    done.set(f.entry, { func: f, ...res });
    for (const c of res.childFuncs)
      funcs.push({ entry: c.entry, nparams: c.nparams, nregs: c.nregs, C: c.newC, cells: c.cells, hasRest: c.hasRest, ins: c });
  }
  return done;
}

module.exports = { explore, exploreAll, evaluate, makeMachine, freeUnknowns };

if (require.main === module) {
  const A = analyze(path.join(__dirname, '..', 'input.js'));
  A.callVMFunction = function (fnVal, args) {
    const ins = fnVal.ins;
    if (ins.cells.length) throw new Error('closure fn');
    const tmpl = new A.L.T({ o: ins.nparams, m: ins.nregs, F: ins.entry, C: ins.newC, H: !!ins.hasRest });
    return A.L.Z(new A.L.G(A.L.vm.i, A.L.vm.A, A.L.vm.h), undefined, args, tmpl);
  };
  const all = exploreAll(A);
  const out = [];
  for (const [entry, r] of all) {
    out.push(`\n===== fn@${entry} params=${r.func.nparams} regs=${r.func.nregs} blocks=${r.blocks.size} volatile=[${[...r.vol]}]`);
    for (const pc of [...r.blocks.keys()].sort((a, b) => a - b)) {
      const b = r.blocks.get(pc);
      const t = b.term || {};
      out.push(`  b${pc}: ${b.stmts.length} stmts -> ${t.kind}` +
        (t.kind === 'dyn' ? ` free=[${t.free}] targets=${JSON.stringify(t.targets.map(x => x.pc))}` : '') +
        (t.kind === 'goto' ? ` ${t.target}` : ''));
    }
  }
  console.log(out.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'cfg.txt'), out.join('\n'));
}
