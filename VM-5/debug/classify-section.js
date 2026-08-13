function classifyOne(env, op) {
  const src = Function.prototype.toString.call(env.proto[op]);
  const R = probeRoles(env, op);
  let n = R.nOperands;
  const roles = R.roles;
  const base = { op, n, roles, src };
  const dst = roles.indexOf('dst');
  const regSlots = roles.map((x, i) => (x === 'reg' ? i : -1)).filter(i => i >= 0);
  const rec = R.rec;
  const jumped = r => typeof r.jump === 'number' && Number.isFinite(r.jump);

  /* ---- no operands ---- */
  if (n === 0) {
    if (/\.pop\(\)/.test(src)) return { ...base, kind: 'pop_try' };
    if (/\bdebugger\b/.test(src)) return { ...base, kind: 'debugger' };
    return { ...base, kind: 'nop' };
  }

  /* ---- self modifying bytecode ---- */
  {
    const code = [op].concat(seq(128));
    const p = runHandler(env, op, { code, ip: 1, watchCode: true });
    if (p.rec.codeWrites.length) return { ...base, kind: 'decrypt' };
  }

  /* ---- return: tears the whole frame down ---- */
  if (n === 1 && rec.slotWrites.length > 4 && rec.regWrites.length > 4) {
    return { ...base, kind: 'ret', reg: 0 };
  }

  /* ---- control flow ---- */
  if (jumped(rec) && n === 1 && regSlots.length === 0) return { ...base, kind: 'jmp', target: 0 };
  if (n === 1 && regSlots.length === 1) {
    const p = probeWith(env, op, [0], { 0: 4242 });
    if (p.rec.jump === 4242) return { ...base, kind: 'jmp_reg', reg: 0 };
    const thrown = probeWith(env, op, [0], { 0: 'PROBE_THROW_VALUE' });
    if (thrown.rec.error === 'PROBE_THROW_VALUE') return { ...base, kind: 'throw', reg: 0 };
  }
  if (n === 2 && regSlots.length === 1 && regSlots[0] === 0) {
    const truthy = probeWith(env, op, [0, 1], { 0: 1 });
    const falsy = probeWith(env, op, [0, 1], { 0: 0 });
    const jt = jumped(truthy.rec), jf = jumped(falsy.rec);
    if (jt !== jf) return { ...base, kind: jt ? 'jnz' : 'jz', cond: 0, target: 1 };
  }

  /* ---- exception table ---- */
  if (/\.push\(/.test(src) && [...rec.slotReads].some(s => s !== 0)) {
    const p = probeWith(env, op, seq(n), {}, { frame: { [env.slots.try]: [] } });
    const pushed = p.frame.get(env.slots.try);
    if (Array.isArray(pushed) && pushed.length === 1 && pushed[0] && typeof pushed[0] === 'object') {
      const shape = {};                       // property -> operand slot
      for (const k of Object.keys(pushed[0])) shape[k] = p.rec.operands.indexOf(pushed[0][k]);
      return { ...base, n: p.rec.ipEnd - 1, kind: 'push_try', shape };
    }
  }

  /* ---- globals ---- */
  if (rec.globalWrites.length) return { ...base, kind: 'store_global', valueSlot: regSlots[0] };
  if (rec.globalReads.length || rec.globalHas.length) {
    if (rec.globalReads.length === 0 || /typeof/.test(src)) return { ...base, kind: 'typeof_global', dst };
    return { ...base, kind: 'load_global', dst };
  }

  /* ---- `this` ---- */
  if (dst >= 0 && n === 1) {
    const w = rec.regWrites[0];
    if (w && typeof w[1] === 'number' && w[1] === SLOT_SENT(env.slots.this)) {
      return { ...base, kind: 'this', dst: 0 };
    }
  }

  /* ---- closures (upvalues) ---- */
  if ([...rec.slotReads].includes(env.slots.template)) {
    const cellWrites = [];
    const idxSeen = [];
    const cell = new Proxy({}, {
      get(_, k) { return typeof k === 'symbol' ? undefined : 'CELLVAL'; },
      set(_, k, v) { cellWrites.push([k, v]); return true; },
    });
    const tmplProxy = makeTemplateProxy(idxSeen, cell);
    const p = probeWith(env, op, seq(n), {}, { frame: { [env.slots.template]: tmplProxy } });
    n = p.rec.ipEnd - 1;
    const idxSlot = idxSeen.length ? p.rec.operands.indexOf(idxSeen[0]) : -1;
    const valueWrite = cellWrites.find(([, v]) => typeof v !== 'object');
    if (valueWrite) {
      const vSlot = p.rec.operands.findIndex((o, i) => i !== idxSlot && p.rec.regReads.includes(o));
      return { ...base, n, kind: 'store_closure', idxSlot, valueSlot: vSlot };
    }
    if (p.rec.regWrites.length) {
      return { ...base, n, kind: 'load_closure', idxSlot, dst: p.rec.operands.indexOf(p.rec.regWrites[0][0]) };
    }
  }

  /* ---- calls / new ---- */
  {
    const calls = [];
    const fn = function (...args) { calls.push({ nt: new.target, this: this, args }); return 'PROBE_RESULT'; };
    const regVals = {};
    for (const s of regSlots) regVals[R.operands[s]] = fn;
    probeWith(env, op, seq(n), regVals);
    if (calls.length) return classifyCall(env, op, base, R, regSlots);
  }

  /* ---- member access ---- */
  if (regSlots.length >= 2) {
    const m = classifyMember(env, op, base, R, regSlots, dst);
    if (m) return m;
  }

  /* ---- aggregate construction ---- */
  if (dst >= 0) {
    const p = probeWith(env, op, seq(n), {}, { regValue: r => 'V' + r });
    const w = p.rec.regWrites[0];
    if (w) {
      const v = w[1];
      if (typeof v === 'function') return { ...base, kind: 'make_function', dst };
      if (Array.isArray(v)) return { ...base, kind: 'array', dst, countSlot: findCountSlot(env, op, R) };
      if (v && typeof v === 'object') {
        const props = Object.keys(v);
        const arrProp = props.find(k => Array.isArray(v[k]));
        if (arrProp && props.length >= 2 && regSlots.length === 1) {
          return { ...base, kind: 'forin_init', dst, srcSlot: regSlots[0], keysProp: arrProp, idxProp: props.find(k => typeof v[k] === 'number') };
        }
        return { ...base, kind: 'object', dst, countSlot: findCountSlot(env, op, R) };
      }
    }
  }

  /* ---- for-in iteration step ---- */
  if (env.forin && regSlots.length === 1) {
    const K = env.forin.keysProp, I = env.forin.idxProp;
    const it = { [K]: ['K0', 'K1'], [I]: 0 };
    const p = probeWith(env, op, seq(n), { [R.operands[regSlots[0]]]: it });
    if (p.rec.regWrites.length && p.rec.regWrites[0][1] === 'K0') {
      const p2 = probeWith(env, op, seq(n), { [R.operands[regSlots[0]]]: { [K]: [], [I]: 0 } });
      return {
        ...base, kind: 'forin_next',
        dst: R.operands.indexOf(p.rec.regWrites[0][0]),
        iterSlot: regSlots[0],
        targetSlot: jumped(p2.rec) ? R.operands.indexOf(p2.rec.jump) : -1,
      };
    }
  }

  /* ---- everything else: pure data ops (constants, arithmetic, comparison) ---- */
  return { ...base, kind: 'expr', dst, regSlots };
}

function makeTemplateProxy(idxSeen, cell) {
  const q = new Proxy([], {
    get(tg, k) {
      if (typeof k !== 'symbol' && !isNaN(Number(k))) { idxSeen.push(Number(k)); return cell; }
      return tg[k];
    },
  });
  return new Proxy({}, { get(tg, k) { return typeof k === 'symbol' ? undefined : q; } });
}

/** find the operand that says how many (register) operands follow */
function findCountSlot(env, op, R) {
  for (let i = 0; i < R.nOperands; i++) {
    if (R.roles[i] !== 'imm') continue;
    const ops = R.operands.slice();
    ops[i] = R.operands[i] + 1;
    const p = runHandler(env, op, { code: [op, ...ops, 90, 91, 92, 93], ip: 1 });
    if (p.rec.ipEnd - 1 > R.nOperands) return i;
  }
  return -1;
}

function classifyCall(env, op, base, R, regSlots) {
  const n = R.nOperands;
  const calls = [];
  const fn = function (...args) { calls.push({ nt: new.target, this: this, args }); return 'PROBE_RESULT'; };
  let calleeSlot = -1;
  for (const s of regSlots) {
    calls.length = 0;
    const regs = {};
    for (const s2 of regSlots) regs[R.operands[s2]] = s2 === s ? fn : 'ARG' + s2;
    probeWith(env, op, seq(n), regs);
    if (calls.length) { calleeSlot = s; break; }
  }
  const c = calls[0] || {};
  const isNew = typeof c.nt === 'function';
  let thisSlot = -1;
  if (typeof c.this === 'string' && c.this.startsWith('ARG')) thisSlot = Number(c.this.slice(3));
  const argSlots = (c.args || []).map(a => (typeof a === 'string' && a.startsWith('ARG') ? Number(a.slice(3)) : -1));
  const countSlot = findCountSlot(env, op, R);
  // where does the result go?  (native path writes it straight into a register)
  const regs = {};
  for (const s2 of regSlots) regs[R.operands[s2]] = s2 === calleeSlot ? fn : 'ARG' + s2;
  const p = probeWith(env, op, seq(n), regs);
  const w = p.rec.regWrites.find(x => x[1] === 'PROBE_RESULT' || (isNew && typeof x[1] === 'object'));
  const dstSlot = w ? R.operands.indexOf(w[0]) : R.roles.indexOf('imm');
  return {
    ...base, kind: isNew ? 'new' : (thisSlot >= 0 ? 'call_method' : 'call'),
    dstSlot, calleeSlot, thisSlot, countSlot, argSlots, regSlots,
  };
}

function classifyMember(env, op, base, R, regSlots, dst) {
  const n = R.nOperands;
  const key = 'PROBE_KEY';
  if (regSlots.length === 2) {
    const obj = { [key]: 'PROBE_VALUE' };
    const regs = {};
    regs[R.operands[regSlots[0]]] = obj;
    regs[R.operands[regSlots[1]]] = key;
    const p = probeWith(env, op, seq(n), regs);
    const w = p.rec.regWrites[0];
    if (w && w[1] === 'PROBE_VALUE') {
      return { ...base, kind: 'get_member', dst: R.operands.indexOf(w[0]), objSlot: regSlots[0], keySlot: regSlots[1] };
    }
    if (w && w[1] === true && !(key in obj)) {
      return { ...base, kind: 'delete_member', dst: R.operands.indexOf(w[0]), objSlot: regSlots[0], keySlot: regSlots[1] };
    }
  }
  if (regSlots.length === 3) {
    for (const value of ['PROBE_VALUE', function probeAccessor() { return 'PROBE_VALUE'; }]) {
      const obj = {};
      const regs = {};
      regs[R.operands[regSlots[0]]] = obj;
      regs[R.operands[regSlots[1]]] = key;
      regs[R.operands[regSlots[2]]] = value;
      probeWith(env, op, seq(n), regs);
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc) continue;
      const common = { objSlot: regSlots[0], keySlot: regSlots[1], valueSlot: regSlots[2] };
      if (desc.value === value) return { ...base, kind: 'set_member', ...common };
      if (typeof desc.get === 'function') return { ...base, kind: 'define_getter', ...common };
      if (typeof desc.set === 'function') return { ...base, kind: 'define_setter', ...common };
    }
  }
  return null;
}

