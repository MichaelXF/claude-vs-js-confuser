/**
 * One step of the analysis: execute the instruction at `pc` against the (partly known,
 * possibly symbolic) register state and return the successor states.
 *
 * The analysis is *path sensitive*: successor states are handed out per edge and the
 * caller keys nodes by (pc, state).  Control-flow flattening reuses a single dispatcher
 * block for every basic block in the function, so merging states there would destroy the
 * constants needed to resolve its computed jump; keeping paths apart (and duplicating the
 * shared block per state) keeps them alive.
 */
function stepState(env, pc, state) {
  const ins = instrAt(env, pc);
  const k = ins.k, o = ins.operands;
  let out = new Map(state);
  const children = [];
  const readRegs = readRegisters(env, ins);

  const runOnce = (concrete, kindOverride) => {
    // returns Map<reg, value> of writes, or null when the result is not determined
    switch (ins.kind) {
      case 'call': {
        const callee = concrete.get(o[k.calleeSlot]);
        if (!(callee && callee.__fn && !callee.upvals.length)) return null;
        const argc = o[k.countSlot];
        if (argc === env.spreadMagic) return null;
        const args = [];
        for (let i = 0; i < argc; i++) {
          const v = concrete.get(o[k.countSlot + 1 + i]);
          if (v === undefined || v === UNKNOWN || (v && v.__fn)) return null;
          args.push(v);
        }
        const r = evalPure(env, callee, args);
        if (r === FAIL) return null;
        return new Map([[o[k.dstSlot], r]]);
      }
      case 'get_member': {
        const obj = concrete.get(o[k.objSlot]), key = concrete.get(o[k.keySlot]);
        if (!(obj && obj !== UNKNOWN && !obj.__fn && typeof obj === 'object' &&
              key !== undefined && key !== UNKNOWN && Object.prototype.hasOwnProperty.call(obj, key))) return null;
        return new Map([[o[k.dst], obj[key]]]);
      }
      case 'expr': case 'array': case 'object': {
        const r = execConcrete(env, ins, concrete);
        if (r.unknownRead) return null;
        return new Map(r.writes);
      }
      default: return null;
    }
  };

  let symResult = null;
  if (['call', 'get_member', 'expr', 'array', 'object'].includes(ins.kind)) {
    symResult = symbolicEval(env, state, readRegs, concrete => runOnce(concrete));
  }

  if (symResult) {
    const { vars, results } = symResult;
    if (results.every(r => r !== null)) {
      const written = new Set();
      for (const r of results) for (const reg of r.keys()) written.add(reg);
      for (const reg of written) {
        const table = results.map(r => (r.has(reg) ? r.get(reg) : UNKNOWN));
        out.set(reg, vars.length ? makeSym(vars, table) : table[0]);
      }
    } else {
      symResult = null;
    }
  }

  if (!symResult) {
    // could not determine the value: every register the instruction writes becomes unknown
    switch (ins.kind) {
      case 'make_function': {
        const ref = funcRef(env, o);
        out.set(o[env.meta.dstSlot], ref);
        children.push(ref);
        break;
      }
      case 'call': case 'call_method': case 'new':
        out.set(o[k.dstSlot], UNKNOWN); break;
      case 'expr': {
        // an unresolved data op still yields a *boolean* when the opcode is a comparison:
        // that is where the real if/else conditions of the program come from
        const r = execConcrete(env, ins, state);
        const boolean = opcodeReturnsBoolean(env, k);
        for (const [reg] of r.writes) {
          out.set(reg, boolean ? makeSym([++symCounter], [false, true]) : UNKNOWN);
        }
        if (!r.writes.length && k.dst >= 0) out.set(o[k.dst], UNKNOWN);
        break;
      }
      default: {
        const r = execConcrete(env, ins, state);
        for (const [reg] of r.writes) out.set(reg, UNKNOWN);
        if (ins.kind === 'get_member' && k.dst >= 0) out.set(o[k.dst], UNKNOWN);
        break;
      }
    }
  }

  // ---- successors
  let succ = [], unresolved = false, resolvedTo, branch = null;
  const finish = list => list.filter(s => typeof s.pc === 'number' && s.pc >= 0 && s.pc < env.code.length);

  if (ins.kind === 'jmp_reg') {
    const v = state.get(o[0]);
    if (typeof v === 'number' && v >= 0 && v < env.code.length) {
      succ = [{ pc: v, st: out }]; resolvedTo = v;
    } else if (isSym(v)) {
      // the successor depends on a symbolic boolean: this is a real branch
      const varId = v.vars[0];
      const cond = findConditionRegister(state, varId);
      const tVal = pickValue(v, [varId], 1), fVal = pickValue(v, [varId], 0);
      if (cond && typeof tVal === 'number' && typeof fVal === 'number' &&
          tVal < env.code.length && fVal < env.code.length) {
        branch = { reg: cond.reg, negate: cond.negate, truePc: tVal, falsePc: fVal, varId };
        succ = [
          { pc: tVal, st: specialize(out, varId, true) },
          { pc: fVal, st: specialize(out, varId, false) },
        ];
      } else unresolved = true;
    } else unresolved = true;
  } else if (ins.kind === 'jz' || ins.kind === 'jnz') {
    const c = state.get(o[k.cond]);
    if (isSym(c)) {
      const varId = c.vars[0];
      const tTaken = ins.kind === 'jz' ? !pickValue(c, [varId], 1) : !!pickValue(c, [varId], 1);
      const fTaken = ins.kind === 'jz' ? !pickValue(c, [varId], 0) : !!pickValue(c, [varId], 0);
      succ = [
        { pc: tTaken ? o[k.target] : ins.next, st: specialize(out, varId, true) },
        { pc: fTaken ? o[k.target] : ins.next, st: specialize(out, varId, false) },
      ];
      if (succ[0].pc === succ[1].pc) succ = [succ[0]];
    } else if (c !== undefined && c !== UNKNOWN) {
      const taken = ins.kind === 'jz' ? !c : !!c;
      succ = [{ pc: taken ? o[k.target] : ins.next, st: out }];
      resolvedTo = succ[0].pc;
    } else {
      succ = [{ pc: o[k.target], st: out }, { pc: ins.next, st: out }];
    }
  } else {
    succ = successorsOf(env, ins, null).map(p => ({ pc: p, st: out }));
  }
  return { ins, out, succ: finish(succ), children, unresolved, resolvedTo, branch };
}
