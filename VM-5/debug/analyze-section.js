/* ================================================================== *
 * 11.  Whole-program analysis
 *
 * Every function is walked with a constant-propagation dataflow analysis.  That is what
 * defeats the control-flow flattening: each basic block ends by computing a numeric key
 * from an opaque predicate, handing it to a "dispatcher" function and jumping to whatever
 * program counter comes back.  Because the keys are compile-time constants, propagating
 * constants through the block resolves the computed jump into an ordinary edge (the
 * dispatcher call itself then becomes dead code and is removed later).
 * ================================================================== */

const UNKNOWN = Symbol('unknown');

/** A VM function value produced by `make_function`. */
function funcRef(env, operands) {
  const M = env.meta;
  const count = operands[M.countSlot];
  const upvals = [];
  for (let i = 0; i < count; i++) {
    upvals.push({ local: !!operands[M.pairsStart + i * 2], index: operands[M.pairsStart + i * 2 + 1] });
  }
  return {
    __fn: true, entry: operands[M.entry], m: operands[M.m], l: operands[M.l],
    rest: !!operands[M.rest], upvals,
  };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.__fn && b.__fn) return a.entry === b.entry && a.m === b.m;
    return false;
  }
  return false;
}

function mergeStates(a, b) {
  if (!a) return new Map(b);
  let changed = false;
  const out = new Map();
  for (const [k, v] of a) {
    if (!b.has(k)) { changed = true; continue; }
    const w = b.get(k);
    if (sameValue(v, w)) out.set(k, v);
    else { changed = true; if (v === UNKNOWN) out.set(k, UNKNOWN); }
  }
  for (const [k] of a) if (out.has(k) !== a.has(k)) changed = true;
  if (out.size !== a.size) changed = true;
  return { state: out, changed };
}

/** Decode (and cache) the instruction at `pc`. */
function instrAt(env, pc) {
  if (env.decoded.has(pc)) return env.decoded.get(pc);
  const op = env.code[pc];
  const kind = env.kinds.get(op);
  if (kind === undefined) {
    const bad = { pc, op, kind: 'invalid', k: null, operands: [], next: pc + 1 };
    env.decoded.set(pc, bad);
    return bad;
  }
  const m = runHandler(env, op, { code: env.code, ip: pc + 1, regValue: () => 1, globalValue: () => undefined });
  const operands = m.rec.operands;
  const ins = {
    pc, op, kind: kind.kind, k: kind, operands, next: pc + 1 + operands.length,
    globalName: m.rec.globalReads[0] !== undefined ? m.rec.globalReads[0]
      : (m.rec.globalHas[0] !== undefined ? m.rec.globalHas[0]
        : (m.rec.globalWrites[0] !== undefined ? m.rec.globalWrites[0][0] : undefined)),
  };
  env.decoded.set(pc, ins);
  return ins;
}

/** Execute an instruction against concrete register values (used by the const-prop pass). */
function execConcrete(env, ins, regs) {
  let unknownRead = false;
  const regsObj = {};
  for (const [k, v] of regs) if (v !== UNKNOWN && !(v && v.__fn)) regsObj[k] = v;
  const m = runHandler(env, ins.op, {
    code: env.code, ip: ins.pc + 1, regs: regsObj,
    regValue: () => { unknownRead = true; return 0; },
    globalValue: () => { unknownRead = true; return undefined; },
  });
  return { writes: m.rec.regWrites, unknownRead: unknownRead || !!m.rec.error, error: m.rec.error };
}

/** Is this VM function safe to evaluate at analysis time? (used for dispatcher helpers) */
function isPureFunction(env, entry, seen = new Set()) {
  if (seen.has(entry)) return true;
  seen.add(entry);
  const SAFE = new Set(['expr', 'const', 'object', 'array', 'get_member', 'ret', 'jmp', 'jz', 'jnz', 'this', 'nop']);
  const work = [entry], done = new Set();
  let count = 0;
  while (work.length) {
    const pc = work.pop();
    if (done.has(pc) || pc >= env.code.length) continue;
    done.add(pc);
    if (++count > 400) return false;
    const ins = instrAt(env, pc);
    if (ins.kind === 'load_global') { work.push(ins.next); continue; }   // Math etc.
    if (!SAFE.has(ins.kind)) return false;
    for (const s of successorsOf(env, ins, null)) if (typeof s === 'number') work.push(s);
  }
  return true;
}

function successorsOf(env, ins, resolvedTarget) {
  const o = ins.operands, k = ins.k;
  switch (ins.kind) {
    case 'jmp': return [o[k.target]];
    case 'jz': case 'jnz': return [o[k.target], ins.next];
    case 'forin_next': return [o[k.targetSlot], ins.next];
    case 'ret': case 'throw': case 'invalid': return [];
    case 'jmp_reg': return resolvedTarget === undefined || resolvedTarget === null ? [] : [resolvedTarget];
    case 'push_try': return [ins.next, o[k.shape ? Object.values(k.shape)[0] : 0]];
    default: return [ins.next];
  }
}

/** Run a pure VM function with the real interpreter (used to resolve dispatcher keys). */
function callVMFunction(env, fn, args) {
  const K = env.templateKeys;
  const P = env.cap.state.constructor;
  const T = env.cap.template.constructor;
  const state = new P(env.code, env.pureGlobals, env.pool);
  const tmpl = new T({ [K.m]: fn.m, [K.l]: fn.l, [K.entry]: fn.entry, [K.rest]: fn.rest ? 1 : 0 });
  return env.cap.runner(state, undefined, tmpl, undefined, args, []);
}

/**
 * Analyse one function: decode every reachable instruction, resolving computed jumps by
 * constant propagation.  Returns the instruction map plus the resolved edges.
 */
function analyzeFunction(env, fn) {
  const states = new Map();          // pc -> Map<reg, value>
  const instrs = new Map();
  const edges = new Map();           // pc -> [successor pcs]
  const resolved = new Map();        // pc -> resolved computed-jump target
  const children = [];
  const unresolved = [];
  const work = [fn.entry];
  states.set(fn.entry, new Map());
  let guard = 0;
  while (work.length) {
    if (++guard > 200000) throw new Error('analysis did not converge');
    const pc = work.pop();
    if (pc === undefined || pc < 0 || pc >= env.code.length) continue;
    const ins = instrAt(env, pc);
    instrs.set(pc, ins);
    const state = new Map(states.get(pc) || []);
    const k = ins.k, o = ins.operands;

    // ---- transfer function
    let out = state;
    const setUnknownWrites = () => {
      const r = execConcrete(env, ins, state);
      for (const [reg] of r.writes) out.set(reg, UNKNOWN);
    };
    switch (ins.kind) {
      case 'make_function': {
        const ref = funcRef(env, o);
        out.set(o[env.meta.dstSlot], ref);
        children.push({ ref, pc });
        break;
      }
      case 'call': {
        const callee = state.get(o[k.calleeSlot]);
        const dst = o[k.dstSlot];
        let done = false;
        if (callee && callee.__fn && !callee.upvals.length && isPureFunction(env, callee.entry)) {
          const argc = o[k.countSlot];
          const args = [];
          let ok = argc !== env.spreadMagic;
          for (let i = 0; ok && i < argc; i++) {
            const v = state.get(o[k.countSlot + 1 + i]);
            if (v === undefined || v === UNKNOWN || (v && v.__fn)) ok = false;
            else args.push(v);
          }
          if (ok) {
            try { out.set(dst, callVMFunction(env, callee, args)); done = true; }
            catch (e) { /* fall through to UNKNOWN */ }
          }
        }
        if (!done) out.set(dst, UNKNOWN);
        break;
      }
      case 'get_member': {
        const obj = state.get(o[k.objSlot]), key = state.get(o[k.keySlot]);
        if (obj && obj !== UNKNOWN && !obj.__fn && key !== undefined && key !== UNKNOWN &&
            (typeof obj === 'object') && Object.prototype.hasOwnProperty.call(obj, key)) {
          out.set(o[k.dst], obj[key]);
        } else out.set(o[k.dst], UNKNOWN);
        break;
      }
      case 'expr': {
        const r = execConcrete(env, ins, state);
        for (const [reg, val] of r.writes) out.set(reg, r.unknownRead ? UNKNOWN : val);
        break;
      }
      case 'array': case 'object': {
        const r = execConcrete(env, ins, state);
        for (const [reg, val] of r.writes) out.set(reg, r.unknownRead ? UNKNOWN : val);
        break;
      }
      case 'call_method': case 'new':
        out.set(o[k.dstSlot], UNKNOWN); break;
      case 'load_global': case 'typeof_global': case 'this': case 'load_closure':
      case 'forin_init': case 'forin_next': case 'delete_member':
        setUnknownWrites(); break;
      default: break;
    }

    // ---- successors
    let succ;
    if (ins.kind === 'jmp_reg') {
      const v = state.get(o[0]);
      if (typeof v === 'number' && v >= 0 && v < env.code.length) {
        resolved.set(pc, v);
        succ = [v];
      } else { unresolved.push(pc); succ = []; }
    } else if (ins.kind === 'jz' || ins.kind === 'jnz') {
      const c = state.get(o[k.cond]);
      if (c !== undefined && c !== UNKNOWN) {
        const taken = ins.kind === 'jz' ? !c : !!c;
        succ = [taken ? o[k.target] : ins.next];
        resolved.set(pc, succ[0]);
      } else succ = [o[k.target], ins.next];
    } else {
      succ = successorsOf(env, ins, null);
    }
    edges.set(pc, succ);

    for (const s of succ) {
      if (typeof s !== 'number' || s < 0 || s >= env.code.length) continue;
      const prev = states.get(s);
      if (!prev) { states.set(s, new Map(out)); work.push(s); continue; }
      let changed = false;
      const merged = new Map();
      for (const [reg, val] of prev) {
        if (!out.has(reg)) { changed = true; merged.set(reg, UNKNOWN); continue; }
        const w = out.get(reg);
        if (sameValue(val, w)) merged.set(reg, val);
        else { merged.set(reg, UNKNOWN); if (val !== UNKNOWN) changed = true; }
      }
      for (const [reg] of out) if (!prev.has(reg)) { /* new info is ignored: prev already ⊑ */ }
      if (changed) { states.set(s, merged); work.push(s); }
    }
  }
  return { instrs, edges, resolved, children, unresolved, states };
}

/** Discover every function in the program, starting from the main template. */
function analyzeProgram(env) {
  const K = env.templateKeys;
  const mainMeta = env.mainTemplate[K.metaProp];
  const main = {
    id: 0, entry: mainMeta[K.entry], m: mainMeta[K.m], l: mainMeta[K.l],
    rest: !!mainMeta[K.rest], upvals: [], parent: null, main: true,
  };
  const funcs = new Map([[main.entry, main]]);
  const order = [main];
  const queue = [main];
  let nextId = 1;
  while (queue.length) {
    const fn = queue.shift();
    const res = analyzeFunction(env, fn);
    Object.assign(fn, res);
    for (const child of res.children) {
      const ref = child.ref;
      let f = funcs.get(ref.entry);
      if (!f) {
        f = {
          id: nextId++, entry: ref.entry, m: ref.m, l: ref.l, rest: ref.rest,
          upvals: ref.upvals, parent: fn, createdAt: child.pc,
        };
        funcs.set(ref.entry, f);
        order.push(f);
        queue.push(f);
      }
      child.func = f;
    }
  }
  return { funcs, order, main };
}

