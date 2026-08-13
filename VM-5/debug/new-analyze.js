/**
 * One step of the analysis: execute the instruction at `pc` against the (partly known)
 * register state and return the successor states.
 *
 * The analysis is *path sensitive*: successor states are handed out per edge and the
 * caller decides how to key them.  Control-flow flattening reuses one dispatcher block
 * for every basic block in the function, so merging states at that block would destroy
 * the very constants needed to resolve its computed jump; keeping paths apart (and
 * duplicating the shared block per state) keeps them alive.
 */
function stepState(env, pc, state) {
  const ins = instrAt(env, pc);
  const k = ins.k, o = ins.operands;
  const out = new Map(state);
  const children = [];

  const setUnknownWrites = () => {
    const r = execConcrete(env, ins, state);
    for (const [reg] of r.writes) out.set(reg, UNKNOWN);
  };

  switch (ins.kind) {
    case 'make_function': {
      const ref = funcRef(env, o);
      out.set(o[env.meta.dstSlot], ref);
      children.push(ref);
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
      if (obj && obj !== UNKNOWN && !obj.__fn && typeof obj === 'object' &&
          key !== undefined && key !== UNKNOWN && Object.prototype.hasOwnProperty.call(obj, key)) {
        out.set(o[k.dst], obj[key]);
      } else out.set(o[k.dst], UNKNOWN);
      break;
    }
    case 'expr': case 'array': case 'object': {
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
  let succ = [], unresolved = false, resolvedTo;
  if (ins.kind === 'jmp_reg') {
    const v = state.get(o[0]);
    if (typeof v === 'number' && v >= 0 && v < env.code.length) { succ = [v]; resolvedTo = v; }
    else unresolved = true;
  } else if (ins.kind === 'jz' || ins.kind === 'jnz') {
    const c = state.get(o[k.cond]);
    if (c !== undefined && c !== UNKNOWN) {
      const taken = ins.kind === 'jz' ? !c : !!c;
      succ = [taken ? o[k.target] : ins.next];
      resolvedTo = succ[0];
    } else succ = [o[k.target], ins.next];
  } else {
    succ = successorsOf(env, ins, null);
  }
  succ = succ.filter(s => typeof s === 'number' && s >= 0 && s < env.code.length);
  return { ins, out, succ: succ.map(p => ({ pc: p, st: out })), children, unresolved, resolvedTo };
}

/**
 * Analyse one function.  Nodes are (pc, state) pairs, so a block that is reachable with
 * different constant states is analysed — and later emitted — once per state.  That is
 * what un-flattens the control flow: the shared dispatcher tail is specialised back into
 * each of its callers, where its computed jump is a compile-time constant again.
 */
function analyzeFunction(env, fn) {
  const nodes = new Map();           // nodeId -> {pc, state, ins, succ:[nodeId], resolvedTo}
  const perPc = new Map();           // pc -> [nodeId]
  const children = new Map();        // entry -> funcRef
  const unresolved = [];
  const MAX_STATES = env.maxStatesPerPc || 200;
  const MAX_NODES = env.maxNodes || 60000;

  const keyOf = (pc, st) => {
    const parts = [];
    for (const [r, v] of st) {
      if (v === UNKNOWN || v === undefined) continue;
      parts.push(r + ':' + (v && v.__fn ? 'f' + v.entry : (typeof v === 'object' ? 'o' : typeof v === 'string' ? 's' + v : String(v))));
    }
    parts.sort();
    return pc + '|' + parts.join(',');
  };

  const entryNode = { pc: fn.entry, state: new Map(), id: keyOf(fn.entry, new Map()) };
  const work = [entryNode];
  nodes.set(entryNode.id, entryNode);
  perPc.set(fn.entry, [entryNode]);

  while (work.length) {
    const node = work.pop();
    if (node.done) continue;
    node.done = true;
    if (nodes.size > MAX_NODES) throw new Error('analysis blew up (too many states)');
    const r = stepState(env, node.pc, node.state);
    node.ins = r.ins;
    node.resolvedTo = r.resolvedTo;
    if (r.unresolved) unresolved.push(node.pc);
    for (const ref of r.children) if (!children.has(ref.entry)) children.set(ref.entry, ref);
    node.succ = [];
    for (const s of r.succ) {
      let st = s.st;
      const list = perPc.get(s.pc) || [];
      if (list.length >= MAX_STATES) st = new Map();          // give up on precision here
      const id = keyOf(s.pc, st);
      let next = nodes.get(id);
      if (!next) {
        next = { pc: s.pc, state: st, id };
        nodes.set(id, next);
        list.push(next);
        perPc.set(s.pc, list);
        work.push(next);
      }
      node.succ.push(next.id);
    }
  }
  return { nodes, perPc, children: [...children.values()], unresolved, entryId: entryNode.id };
}

/** Discover every function in the program, starting from the main template. */
