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
        if (callee && callee.__fn && !callee.upvals.length) {
          const argc = o[k.countSlot];
          const args = [];
          let ok = argc !== env.spreadMagic;
          for (let i = 0; ok && i < argc; i++) {
            const v = state.get(o[k.countSlot + 1 + i]);
            if (v === undefined || v === UNKNOWN || (v && v.__fn)) ok = false;
            else args.push(v);
          }
          if (ok) {
            const r = evalPure(env, callee, args);
            if (r !== FAIL) { out.set(dst, r); done = true; }
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

