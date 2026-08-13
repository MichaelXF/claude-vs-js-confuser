/* ================================================================== *
 * Frame-size discovery
 *
 * The MBA-obfuscated handlers mix `frame[sizeSlot] - header` (i.e. the number of locals
 * of the *calling function*) into their key material, and the identities only collapse
 * for the value the obfuscator compiled them with.  Evaluating a handler with the wrong
 * frame size silently produces wrong numbers, so the layout has to be recovered exactly.
 *
 * It is found with an oracle: build a tiny synthetic bytecode program
 *      r1 = X ; r2 = Y ; r3 = <the instruction under test> ; return r3
 * run it on the *real* interpreter with a chosen local count, and search for the
 * (slot, header) pair that makes the mock agree with it.
 * ================================================================== */

function findOpcodeByKind(env, pred) {
  for (const [op, k] of env.kinds) if (pred(k, op)) return { op, k };
  return null;
}

/** the opcode that loads a raw immediate into a register */
function findLoadImmOpcode(env) {
  for (const [op, k] of env.kinds) {
    if (k.kind !== 'expr' || k.n !== 2) continue;
    const dst = k.roles.indexOf('dst');
    const imm = k.roles.indexOf('imm');
    if (dst < 0 || imm < 0) continue;
    const operands = [];
    operands[dst] = 1; operands[imm] = 1234567;
    const m = runHandler(env, op, { code: [op, ...operands], ip: 1 });
    const w = m.rec.regWrites[0];
    if (w && w[0] === 1 && w[1] === 1234567) return { op, k, dst, imm };
  }
  return null;
}

function runRealVM(env, code, l, args = []) {
  const K = env.templateKeys;
  const P = env.cap.state.constructor;
  const T = env.cap.template.constructor;
  const state = new P(code, env.pureGlobals, env.pool);
  const tmpl = new T({ [K.m]: 0, [K.l]: l, [K.entry]: 0, [K.rest]: 0 });
  return env.cap.runner(state, undefined, tmpl, undefined, args, []);
}

function discoverFrameLayout(env) {
  const li = findLoadImmOpcode(env);
  const ret = findOpcodeByKind(env, k => k.kind === 'ret');
  if (!li || !ret) return { sizeSlot: 5, header: 13, verified: false };

  // pick an instruction whose result depends on a frame slot other than the base
  let probe = null;
  for (const [op, k] of env.kinds) {
    if (k.kind !== 'expr') continue;
    const dst = k.roles.indexOf('dst');
    const regs = k.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
    if (dst < 0 || regs.length < 1) continue;
    const operands = k.roles.map((r, i) => (r === 'imm' ? 0x51ab73c1 : 0));
    operands[dst] = 3;
    regs.forEach((s, i) => { operands[s] = i + 1; });
    const base = runHandler(env, op, { code: [op, ...operands], ip: 1, regs: { 1: 123456, 2: 654321 }, frameSize: 100 });
    const alt = runHandler(env, op, { code: [op, ...operands], ip: 1, regs: { 1: 123456, 2: 654321 }, frameSize: 200 });
    const w1 = base.rec.regWrites[0], w2 = alt.rec.regWrites[0];
    if (w1 && w2 && !sameValue(w1[1], w2[1])) { probe = { op, k, dst, regs, operands }; break; }
  }
  if (!probe) return { sizeSlot: 5, header: 13, verified: false };

  // build the oracle program
  const build = () => {
    const code = [];
    const emit = (op, operands) => { code.push(op, ...operands); };
    const liOps1 = []; liOps1[li.dst] = 1; liOps1[li.imm] = 123456;
    const liOps2 = []; liOps2[li.dst] = 2; liOps2[li.imm] = 654321;
    emit(li.op, liOps1);
    emit(li.op, liOps2);
    emit(probe.op, probe.operands);
    emit(ret.op, [3]);
    return code;
  };
  const code = build();

  const truths = [];
  for (const l of [8, 24, 47]) {
    let v;
    try { v = runRealVM(env, code, l); } catch (e) { v = undefined; }
    truths.push([l, v]);
  }
  if (truths.every(([, v]) => v === undefined)) return { sizeSlot: 5, header: 13, verified: false };

  for (let slot = 0; slot < FRAME_SLOTS; slot++) {
    if (slot === env.PC || slot === env.slots.base) continue;
    for (let header = 0; header <= 32; header++) {
      let ok = true;
      for (const [l, truth] of truths) {
        const m = runHandler(env, probe.op, {
          code: [probe.op, ...probe.operands], ip: 1, regs: { 1: 123456, 2: 654321 },
          frame: { [slot]: header + l },
        });
        const w = m.rec.regWrites[0];
        if (!w || !sameValue(w[1], truth)) { ok = false; break; }
      }
      if (ok) return { sizeSlot: slot, header, verified: true };
    }
  }
  return { sizeSlot: 5, header: 13, verified: false };
}
