/* ------------------------------------------------------------------ *
 * Symbolic booleans
 *
 * Control-flow flattening does not branch with a jump: every basic block computes the key
 * of its successor *arithmetically*, e.g.  key = A + (B - A) * (+!cond), and hands it to
 * the dispatcher.  Constants alone therefore cannot resolve a real `if`.  The analysis
 * models up to three unknown booleans exactly: whenever an opcode that is known to return
 * a boolean is applied to unknown data the result becomes a fresh symbolic variable, and
 * from then on every instruction is evaluated once per combination of those variables.
 * When the jump key finally differs between the two assignments of a variable, that *is*
 * the original if/else, and it is emitted as a branch on the register holding it.
 * ------------------------------------------------------------------ */

const MAX_SYM_VARS = 3;
let symCounter = 0;

const isSym = v => !!(v && typeof v === 'object' && v.__sym === true);

function makeSym(vars, table) {
  if (table.every(x => sameValue(x, table[0]))) return table[0];
  // drop variables the table does not actually depend on
  for (let i = vars.length - 1; i >= 0; i--) {
    const bit = 1 << i;
    let independent = true;
    for (let m = 0; m < table.length; m++) {
      if (m & bit) continue;
      if (!sameValue(table[m], table[m | bit])) { independent = false; break; }
    }
    if (independent) {
      const nv = vars.slice(); nv.splice(i, 1);
      const nt = [];
      for (let m = 0; m < table.length; m++) {
        if (m & bit) continue;
        let idx = 0, b = 0;
        for (let j = 0; j < vars.length; j++) { if (j === i) continue; if (m & (1 << j)) idx |= 1 << b; b++; }
        nt[idx] = table[m];
      }
      return makeSym(nv, nt);
    }
  }
  return { __sym: true, vars, table };
}

/** value of a symbolic (or plain) value under an assignment of `vars` given by `mask` */
function pickValue(v, vars, mask) {
  if (!isSym(v)) return v;
  let idx = 0;
  for (let i = 0; i < v.vars.length; i++) {
    const at = vars.indexOf(v.vars[i]);
    if (at < 0) return UNKNOWN;
    if (mask & (1 << at)) idx |= 1 << i;
  }
  return v.table[idx];
}

function collectVars(values) {
  const vars = [];
  for (const v of values) if (isSym(v)) for (const id of v.vars) if (!vars.includes(id)) vars.push(id);
  return vars;
}

/** registers an instruction reads (best effort, from the opcode's operand roles) */
function readRegisters(env, ins) {
  const k = ins.k, o = ins.operands;
  if (!k) return [];
  const regs = [];
  switch (ins.kind) {
    case 'call': case 'call_method': case 'new': {
      if (k.calleeSlot >= 0) regs.push(o[k.calleeSlot]);
      if (k.thisSlot >= 0) regs.push(o[k.thisSlot]);
      const argc = o[k.countSlot];
      const n = argc === env.spreadMagic ? 1 : argc;
      for (let i = 0; i < n; i++) regs.push(o[k.countSlot + 1 + i]);
      break;
    }
    case 'array': {
      const count = o[k.countSlot];
      for (let i = 0; i < count; i++) regs.push(o[k.countSlot + 1 + i]);
      break;
    }
    case 'object': {
      const count = o[k.countSlot];
      for (let i = 0; i < count * 2; i++) regs.push(o[k.countSlot + 1 + i]);
      break;
    }
    default:
      for (let i = 0; i < k.roles.length; i++) if (k.roles[i] === 'reg') regs.push(o[i]);
      // slots recorded by the classifier that the generic role scan may have missed
      for (const key of ['objSlot', 'keySlot', 'valueSlot', 'iterSlot', 'srcSlot', 'cond'])
        if (typeof k[key] === 'number' && k[key] >= 0) regs.push(o[k[key]]);
      break;
  }
  return [...new Set(regs)];
}

/**
 * Evaluate `fn` under every combination of the symbolic variables the instruction depends
 * on, and fold the results back into (possibly symbolic) values.
 */
function symbolicEval(env, state, readRegs, fn) {
  const vars = collectVars(readRegs.map(r => state.get(r)));
  if (vars.length > MAX_SYM_VARS) return null;
  if (!vars.length) return { vars: [], results: [fn(state, 0)] };
  const results = [];
  for (let mask = 0; mask < (1 << vars.length); mask++) {
    const concrete = new Map();
    for (const [r, v] of state) concrete.set(r, isSym(v) ? pickValue(v, vars, mask) : v);
    results.push(fn(concrete, mask));
  }
  return { vars, results };
}

/** substitute a decided variable into every value of a state */
function specialize(state, varId, value) {
  const out = new Map();
  for (const [r, v] of state) {
    if (!isSym(v) || !v.vars.includes(varId)) { out.set(r, v); continue; }
    const i = v.vars.indexOf(varId);
    const nv = v.vars.slice(); nv.splice(i, 1);
    const nt = [];
    for (let m = 0; m < v.table.length; m++) {
      const bit = (m >> i) & 1;
      if (bit !== (value ? 1 : 0)) continue;
      let idx = 0, b = 0;
      for (let j = 0; j < v.vars.length; j++) { if (j === i) continue; if (m & (1 << j)) idx |= 1 << b; b++; }
      nt[idx] = v.table[m];
    }
    out.set(r, nv.length ? makeSym(nv, nt) : nt[0]);
  }
  return out;
}

/** find a register that currently holds exactly `varId` (or its negation) */
function findConditionRegister(state, varId) {
  let neg = null;
  for (const [r, v] of state) {
    if (!isSym(v) || v.vars.length !== 1 || v.vars[0] !== varId) continue;
    if (v.table[0] === false && v.table[1] === true) return { reg: r, negate: false };
    if (v.table[0] === true && v.table[1] === false) neg = { reg: r, negate: true };
  }
  return neg;
}

/** does this opcode always produce a boolean?  (probed once per opcode) */
function opcodeReturnsBoolean(env, kind) {
  if (kind.booleanResult !== undefined) return kind.booleanResult;
  const regSlots = kind.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
  if (!regSlots.length || kind.kind !== 'expr') return (kind.booleanResult = false);
  const values = [0, 1, -5, 65536, 2.5, 'a', '', true, false, null, {}, [1]];
  let seen = 0;
  for (let i = 0; i < 24; i++) {
    const operands = kind.roles.map((r, s) => (r === 'dst' ? 0 : (s < kind.n ? (Math.random() * 0xffffffff) >>> 0 : 0)));
    for (let s = 0; s < kind.n; s++) if (kind.roles[s] !== 'imm') operands[s] = s + 1;
    const regs = {};
    for (const s of regSlots) regs[operands[s]] = values[(i + s * 3) % values.length];
    const m = runHandler(env, kind.op, { code: [kind.op, ...operands], ip: 1, regs, regValue: () => 0 });
    if (m.rec.error) continue;
    const w = m.rec.regWrites[m.rec.regWrites.length - 1];
    if (!w) continue;
    if (typeof w[1] !== 'boolean') return (kind.booleanResult = false);
    seen++;
  }
  return (kind.booleanResult = seen >= 4);
}

