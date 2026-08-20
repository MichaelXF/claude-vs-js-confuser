'use strict';
// ---------------------------------------------------------------------------
// Partial evaluation of a devirtualized function.
//
// The bytecode still contains the source-level control-flow-flattening state
// machine: a dispatcher chain that compares an opaque state register against a
// sequence of constants.  Specializing the dispatcher on the state value folds
// every one of those comparisons and turns the state machine back into a real
// CFG.  Instruction results are folded by *executing the handler* (the oracle),
// which also resolves the MBA state-transition opcodes that have no readable
// closed form.
// ---------------------------------------------------------------------------
const { oracle } = require('./lib-classify.js');
const { successors } = require('./lib-analyze.js');

const PURE = new Set(['const', 'mov', 'bin', 'binimm', 'un', 'opaque', 'jmp', 'jf', 'jt', 'nop']);
const FOLDABLE = new Set(['bin', 'binimm', 'un', 'opaque']);

const TOP = { k: 'top' };
const con = (v) => ({ k: 'c', v });
// IR sites are shared between specializations; give every node its own copy.
const clone = (ir) => Object.assign({}, ir);

function inputsOf(ir) {
  switch (ir.kind) {
    case 'mov': return [ir.src];
    case 'bin': return [ir.a, ir.b];
    case 'binimm': case 'un': return [ir.src !== undefined ? ir.src : ir.a];
    case 'opaque': return ir.srcs.slice();
    default: return [];
  }
}

// --- dispatcher discovery --------------------------------------------------
function findDispatcher(fn) {
  const indeg = new Map();
  for (const ir of fn.sites.values()) {
    for (const s of successors(ir)) if (s != null) indeg.set(s, (indeg.get(s) || 0) + 1);
  }
  let head = null, best = 0;
  for (const [pc, n] of indeg) if (n > best && fn.sites.has(pc)) { best = n; head = pc; }
  if (head == null || best < 3) return null;

  // Walk the comparison chain: fall-through and conditional edges only, never
  // through an unconditional jump (those are the dispatcher's exits).
  const chain = new Set();
  const stack = [head];
  while (stack.length) {
    const pc = stack.pop();
    if (chain.has(pc)) continue;
    const ir = fn.sites.get(pc);
    if (!ir || !PURE.has(ir.kind)) continue;
    chain.add(pc);
    if (ir.kind === 'jmp') continue;
    if (ir.kind === 'jf' || ir.kind === 'jt') { stack.push(ir.next, ir.target); continue; }
    stack.push(ir.next);
  }
  if (chain.size < 5) return null;
  // live-in of the chain = registers read before being written inside it
  const written = new Set(), live = new Set();
  const order = [...chain].sort((a, b) => a - b);
  for (const pc of order) {
    const ir = fn.sites.get(pc);
    for (const r of inputsOf(ir)) if (!written.has(r)) live.add(r);
    if (ir.kind === 'jf' || ir.kind === 'jt') { if (!written.has(ir.cond)) live.add(ir.cond); }
    if (ir.dst !== undefined) written.add(ir.dst);
  }
  if (live.size === 0 || live.size > 4) return null;
  return { head, chain, state: [...live] };
}

// --- evaluation ------------------------------------------------------------
function pevalFunction(M, fn) {
  const disp = findDispatcher(fn);
  const memo = new Map();
  const nodes = [];
  const visits = new Map();
  let counter = 0;

  const knownFrom = (env) => {
    const k = {};
    for (const [r, av] of env) if (av.k === 'c') k[r] = av.v;
    return k;
  };
  const envKey = (env) => {
    const parts = [];
    for (const [r, av] of [...env].sort((a, b) => a[0] - b[0])) {
      if (av.k === 'c') parts.push(r + '=' + tag(av.v));
      else if (av.k === 'dom') parts.push(r + '?' + av.cond.reg + (av.cond.neg ? '!' : '') + ':' + tag(av.t) + '/' + tag(av.f));
    }
    return parts.join(',');
  };
  const tag = (v) => (typeof v === 'string' ? 's' + v : typeof v === 'object' && v !== null ? 'o' : String(v));

  function nodeFor(pc, env) {
    let e = env;
    if (disp && pc === disp.head) {
      const keep = new Map();
      for (const r of disp.state) if (e.has(r)) keep.set(r, e.get(r));
      e = keep;
    }
    const n = (visits.get(pc) || 0);
    if (n > 400) e = new Map(); // widening guard for non-flattened loops
    const key = pc + '#' + envKey(e);
    let node = memo.get(key);
    if (node) { node.preds++; return node; }
    node = { id: counter++, pc, env: e, key, stmts: [], term: null, preds: 1 };
    memo.set(key, node);
    visits.set(pc, n + 1);
    work.push(node);
    return node;
  }

  const work = [];
  const entry = nodeFor(fn.entry, new Map());

  while (work.length) {
    const node = work.pop();
    step(node);
  }

  function step(node) {
    const env = new Map(node.env);
    const ir = fn.sites.get(node.pc);
    if (!ir) { node.term = { type: 'ret', value: null }; return; }

    // A state value that is still conditional: split the path in two.
    if (disp && node.pc === disp.head) {
      for (const r of disp.state) {
        const av = env.get(r);
        if (av && av.k === 'dom') {
          const t = new Map(env); t.set(r, con(av.t));
          const f = new Map(env); f.set(r, con(av.f));
          node.term = { type: 'if', cond: av.cond, then: nodeFor(node.pc, t), else: nodeFor(node.pc, f) };
          return;
        }
      }
    }

    const invalidate = (reg) => {
      for (const [r, av] of env) if (av.k === 'dom' && av.cond.reg === reg && r !== reg) env.set(r, TOP);
    };

    switch (ir.kind) {
      case 'jmp':
        node.term = { type: 'goto', target: nodeFor(ir.target, env) };
        return;
      case 'jf': case 'jt': {
        // `jt` branches when the condition is truthy, `jf` when it is falsy;
        // either way `ir.target` is the taken edge.
        const av = env.get(ir.cond) || TOP;
        if (av.k === 'c') {
          const taken = ir.kind === 'jt' ? !!av.v : !av.v;
          node.term = { type: 'goto', target: nodeFor(taken ? ir.target : ir.next, env) };
          return;
        }
        node.term = {
          type: 'if',
          cond: { reg: ir.cond, neg: ir.kind === 'jf' },
          then: nodeFor(ir.target, env), else: nodeFor(ir.next, env),
        };
        return;
      }
      case 'ret':
        node.term = { type: 'ret', value: ir.src };
        return;
      case 'jreg': {
        const av = env.get(ir.src) || TOP;
        if (av.k === 'c' && fn.sites.has(av.v)) {
          node.term = { type: 'goto', target: nodeFor(av.v, env) };
        } else {
          node.term = { type: 'unresolved', reg: ir.src };
        }
        return;
      }
      case 'trypush': {
        if (ir.catchPc === undefined) { node.term = { type: 'unresolved' }; return; }
        const henv = new Map(env);
        henv.set(ir.excReg, TOP);
        if (ir.flagReg !== undefined) henv.set(ir.flagReg, con(ir.flagValue));
        node.term = {
          type: 'trycatch', excReg: ir.excReg, flagReg: ir.flagReg, flagValue: ir.flagValue,
          body: nodeFor(ir.next, env), handler: nodeFor(ir.catchPc, henv),
        };
        return;
      }
      case 'trypop':
        node.term = { type: 'tryend', target: nodeFor(ir.next, env) };
        return;
      case 'forinnext': {
        node.stmts.push(clone(ir));
        env.set(ir.dst, TOP);
        invalidate(ir.dst);
        node.term = { type: 'iter', dst: ir.dst, done: nodeFor(ir.target, env), body: nodeFor(ir.next, env) };
        return;
      }
      case 'throw':
        node.term = { type: 'throw', value: ir.src };
        return;
      case 'const':
        env.set(ir.dst, con(ir.value));
        invalidate(ir.dst);
        node.stmts.push(clone(ir));
        break;
      case 'mov':
        env.set(ir.dst, env.get(ir.src) || TOP);
        invalidate(ir.dst);
        node.stmts.push(clone(ir));
        break;
      default: {
        if (FOLDABLE.has(ir.kind)) {
          const known = knownFrom(env);
          const ins = inputsOf(ir);
          const res = oracle(M, ir, fn, ir.dst, known);
          if (res.known) {
            env.set(ir.dst, con(res.value));
            invalidate(ir.dst);
            node.stmts.push(ir.kind === 'opaque' ? { kind: 'const', dst: ir.dst, value: res.value, pc: ir.pc } : clone(ir));
            break;
          }
          // one conditional input -> conditional result
          const domReg = ins.find(r => (env.get(r) || TOP).k === 'dom');
          if (domReg !== undefined) {
            const d = env.get(domReg);
            const kt = Object.assign({}, known); kt[domReg] = d.t;
            const kf = Object.assign({}, known); kf[domReg] = d.f;
            const rt = oracle(M, ir, fn, ir.dst, kt);
            const rf = oracle(M, ir, fn, ir.dst, kf);
            if (rt.known && rf.known) {
              env.set(ir.dst, { k: 'dom', cond: d.cond, t: rt.value, f: rf.value });
              invalidate(ir.dst);
              node.stmts.push({ kind: 'select', dst: ir.dst, cond: d.cond, t: rt.value, f: rf.value, pc: ir.pc });
              break;
            }
          }
          if (ir.kind === 'opaque') {
            node.stmts.push(clone(ir)); // will be reported as unresolved
            env.set(ir.dst, TOP);
            invalidate(ir.dst);
            break;
          }
          // boolean producers seed conditional values
          const boolish = (ir.kind === 'un' && ir.operator === '!') ||
            (ir.kind === 'bin' && ['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(ir.operator)) ||
            (ir.kind === 'binimm' && ['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(ir.operator));
          node.stmts.push(clone(ir));
          invalidate(ir.dst);
          env.set(ir.dst, boolish ? { k: 'dom', cond: { reg: ir.dst, neg: false }, t: true, f: false } : TOP);
          break;
        }
        node.stmts.push(clone(ir));
        if (ir.dst !== undefined) { env.set(ir.dst, TOP); invalidate(ir.dst); }
        break;
      }
    }
    node.term = { type: 'goto', target: nodeFor(ir.next, env) };
  }

  for (const n of memo.values()) nodes.push(n);
  return { entry, nodes, dispatcher: disp };
}

module.exports = { pevalFunction, findDispatcher };
