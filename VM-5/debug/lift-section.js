/* ================================================================== *
 * 12.  Lifting: bytecode -> IR -> JavaScript
 * ================================================================== */

/**
 * Merge analysis nodes back together.  The path-sensitive analysis produces one node per
 * (pc, state); nodes that share a pc and behave identically (same successors, recursively)
 * are the same block again.  Partition refinement gives the coarsest such merge, which
 * removes the duplication introduced purely to resolve the dispatcher.
 */
function mergeNodes(fn) {
  let key = new Map();
  for (const [id, n] of fn.nodes) key.set(id, 'p' + n.pc);
  for (let iter = 0; iter < 40; iter++) {
    const raw = new Map();
    for (const [id, n] of fn.nodes) {
      const b = n.branch ? `?${n.branch.reg}:${n.branch.negate ? 1 : 0}` : '';
      raw.set(id, 'p' + n.pc + b + '>' + (n.succ || []).map(s => key.get(s)).join(','));
    }
    const classes = new Map();
    const next = new Map();
    for (const [id, k] of raw) {
      if (!classes.has(k)) classes.set(k, 'c' + classes.size);
      next.set(id, classes.get(k));
    }
    const before = new Set(key.values()).size;
    key = next;
    if (classes.size === before) break;
  }
  const blocks = new Map();          // classId -> {id, node, succ:[classId]}
  for (const [id, n] of fn.nodes) {
    const c = key.get(id);
    if (!blocks.has(c)) {
      blocks.set(c, {
        id: c, pc: n.pc, ins: n.ins, branch: n.branch,
        succ: (n.succ || []).map(s => key.get(s)),
      });
    }
  }
  return { blocks, entry: key.get(fn.entryId), classOf: key };
}

/** Chain single-entry/single-exit instruction nodes into basic blocks. */
function buildBasicBlocks(merged) {
  const { blocks, entry } = merged;
  const preds = new Map();
  for (const [id, b] of blocks) for (const s of b.succ) {
    if (!preds.has(s)) preds.set(s, []);
    preds.get(s).push(id);
  }
  const leaders = new Set([entry]);
  for (const [id, b] of blocks) {
    if (b.succ.length !== 1) for (const s of b.succ) leaders.add(s);
    if ((preds.get(id) || []).length > 1) leaders.add(id);
  }
  const bbOf = new Map();
  const bbs = new Map();
  for (const id of leaders) {
    const list = [];
    let cur = id;
    while (true) {
      list.push(cur);
      bbOf.set(cur, id);
      const b = blocks.get(cur);
      if (b.succ.length !== 1) break;
      const nxt = b.succ[0];
      if (leaders.has(nxt) || bbOf.has(nxt)) break;
      cur = nxt;
    }
    const last = blocks.get(list[list.length - 1]);
    bbs.set(id, { id, nodes: list.map(x => blocks.get(x)), succ: last.succ.slice(), branch: last.branch });
  }
  for (const [, bb] of bbs) bb.succ = bb.succ.map(s => bbOf.get(s) !== undefined ? bbOf.get(s) : s);
  return { bbs, entry, preds };
}

/* ---------------- IR ---------------- */

const IR = {
  reg: i => ({ t: 'reg', i }),
  lit: v => ({ t: 'lit', v }),
  bin: (op, l, r) => ({ t: 'bin', op, l, r }),
  un: (op, a) => ({ t: 'un', op, a }),
};

function irUsesRegisters(e, out = []) {
  if (!e || typeof e !== 'object') return out;
  if (e.t === 'reg') { out.push(e.i); return out; }
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (Array.isArray(v)) v.forEach(x => irUsesRegisters(x, out));
    else if (v && typeof v === 'object' && v.t) irUsesRegisters(v, out);
  }
  return out;
}

const PURE_EXPR = new Set(['reg', 'lit', 'bin', 'un', 'array', 'object', 'func', 'this', 'closure']);
function irIsPure(e) {
  if (!e || typeof e !== 'object') return true;
  if (!PURE_EXPR.has(e.t)) return false;
  let ok = true;
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (Array.isArray(v)) v.forEach(x => { if (!irIsPure(x)) ok = false; });
    else if (v && typeof v === 'object' && v.t) { if (!irIsPure(v)) ok = false; }
  }
  return ok;
}

/* ---------------- instruction -> IR ---------------- */

function fitCacheKey(env, ins) { return ins.op + '@' + env.currentFrameSize; }

function fittedOp(env, ins) {
  const key = fitCacheKey(env, ins);
  if (!env.fitCache.has(key)) env.fitCache.set(key, fitDataOpcode(env, ins.k, ins.operands));
  let fit = env.fitCache.get(key);
  // verify the cached template against this instruction (immediates differ per instruction)
  if (!verifyFit(env, ins, fit)) {
    fit = fitDataOpcode(env, ins.k, ins.operands);
    env.fitCache.set(key, fit);
  }
  return fit;
}

function instantiate(fit, ins, part) {
  if (part.reg !== undefined) return IR.reg(ins.operands[part.reg]);
  return IR.lit(part.int ? ins.operands[part.imm] | 0 : ins.operands[part.imm]);
}

function verifyFit(env, ins, fit) {
  if (!fit || fit.form === 'unknown') return false;
  if (fit.form === 'const') {
    const v = evalHandler(env, ins.op, ins.operands, {});
    return v !== ERR && v !== NONE;
  }
  const regSlots = ins.k.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
  if (!regSlots.length) return false;
  const compute = vals => {
    const regs = {};
    regSlots.forEach((s, i) => { regs[ins.operands[s]] = vals[i]; });
    return evalHandler(env, ins.op, ins.operands, regs);
  };
  const evalTpl = vals => {
    const get = part => {
      if (part.reg !== undefined) return vals[regSlots.indexOf(part.reg)];
      return part.int ? ins.operands[part.imm] | 0 : ins.operands[part.imm];
    };
    try {
      if (fit.form === 'move') return vals[regSlots.indexOf(fit.src)];
      if (fit.form === 'unary') return applyUnary(fit.operator, vals[regSlots.indexOf(fit.arg)]);
      return applyBinary(fit.operator, get(fit.left), get(fit.right));
    } catch (e) { return ERR; }
  };
  const probes = [[3, 7], [0, 1], [123456, -7], [-1, 65535], [0x7fffffff, 2], [5, 5]];
  for (const p of probes) {
    const vals = regSlots.map((_, i) => p[i % p.length]);
    const got = compute(vals);
    if (got === ERR || got === NONE) continue;
    if (!same(got, evalTpl(vals))) return false;
  }
  return true;
}

function applyUnary(op, a) {
  switch (op) {
    case '-': return -a; case '+': return +a; case '~': return ~a; case '!': return !a;
    case '!!': return !!a; case 'typeof': return typeof a; case 'void': return void a;
    case '|0': return a | 0; case '>>>0': return a >>> 0;
  }
  throw new Error('unknown unary ' + op);
}
function applyBinary(op, a, b) {
  for (const [name, fn] of BINARY_CANDIDATES) if (name === op) return fn(a, b);
  throw new Error('unknown binary ' + op);
}

/** Translate one decoded instruction into IR statements. */
function liftInstruction(env, fn, ins, ctx) {
  const k = ins.k, o = ins.operands;
  const out = [];
  const assign = (reg, expr) => out.push({ kind: 'assign', dst: reg, expr, pc: ins.pc });
  const effect = expr => out.push({ kind: 'effect', expr, pc: ins.pc });

  switch (ins.kind) {
    case 'expr': {
      const fit = fittedOp(env, ins);
      if (fit.form === 'const') {
        const v = evalHandler(env, ins.op, o, {});
        assign(o[fit.dstSlot], IR.lit(v === ERR || v === NONE ? undefined : v));
      } else if (fit.form === 'move') {
        assign(o[fit.dstSlot], IR.reg(o[fit.src]));
      } else if (fit.form === 'unary') {
        assign(o[fit.dstSlot], IR.un(fit.operator, IR.reg(o[fit.arg])));
      } else if (fit.form === 'binary') {
        assign(o[fit.dstSlot], IR.bin(fit.operator, instantiate(fit, ins, fit.left), instantiate(fit, ins, fit.right)));
      } else {
        assign(o[fit.dstSlot >= 0 ? fit.dstSlot : 0], { t: 'unknown', op: ins.op, pc: ins.pc });
      }
      break;
    }
    case 'this': assign(o[0], { t: 'this' }); break;
    case 'load_global': assign(o[k.dst], { t: 'global', name: ins.globalName }); break;
    case 'typeof_global': assign(o[k.dst], { t: 'typeofglobal', name: ins.globalName }); break;
    case 'store_global': effect({ t: 'setglobal', name: ins.globalName, value: IR.reg(o[k.valueSlot]) }); break;
    case 'get_member': assign(o[k.dst], { t: 'member', obj: IR.reg(o[k.objSlot]), key: IR.reg(o[k.keySlot]) }); break;
    case 'set_member': effect({ t: 'setmember', obj: IR.reg(o[k.objSlot]), key: IR.reg(o[k.keySlot]), value: IR.reg(o[k.valueSlot]) }); break;
    case 'delete_member': assign(o[k.dst], { t: 'delete', obj: IR.reg(o[k.objSlot]), key: IR.reg(o[k.keySlot]) }); break;
    case 'define_getter': case 'define_setter':
      effect({ t: 'defineaccessor', accessor: ins.kind === 'define_getter' ? 'get' : 'set',
        obj: IR.reg(o[k.objSlot]), key: IR.reg(o[k.keySlot]), value: IR.reg(o[k.valueSlot]) });
      break;
    case 'array': {
      const count = o[k.countSlot];
      const els = [];
      for (let i = 0; i < count; i++) els.push(IR.reg(o[k.countSlot + 1 + i]));
      assign(o[k.dst], { t: 'array', els });
      break;
    }
    case 'object': {
      const count = o[k.countSlot];
      const props = [];
      for (let i = 0; i < count; i++) {
        props.push({ key: IR.reg(o[k.countSlot + 1 + i * 2]), value: IR.reg(o[k.countSlot + 2 + i * 2]) });
      }
      assign(o[k.dst], { t: 'object', props });
      break;
    }
    case 'call': case 'call_method': case 'new': {
      const argc = o[k.countSlot];
      const spread = argc === env.spreadMagic;
      const args = [];
      const n = spread ? 1 : argc;
      for (let i = 0; i < n; i++) args.push(IR.reg(o[k.countSlot + 1 + i]));
      const expr = {
        t: 'call', callee: IR.reg(o[k.calleeSlot]), args, spread,
        isNew: ins.kind === 'new',
        thisArg: k.thisSlot >= 0 ? IR.reg(o[k.thisSlot]) : null,
      };
      assign(o[k.dstSlot], expr);
      break;
    }
    case 'make_function': {
      const ref = funcRef(env, o);
      assign(o[env.meta.dstSlot], { t: 'func', entry: ref.entry, ref });
      break;
    }
    case 'load_closure': assign(o[k.dst], { t: 'closure', index: o[k.idxSlot] }); break;
    case 'store_closure': effect({ t: 'setclosure', index: o[k.idxSlot], value: IR.reg(o[k.valueSlot]) }); break;
    case 'forin_init': assign(o[k.dst], { t: 'forinkeys', obj: IR.reg(o[k.srcSlot]) }); break;
    case 'forin_next': assign(o[k.dst], { t: 'forinnext', iter: IR.reg(o[k.iterSlot]) }); break;
    case 'ret': out.push({ kind: 'ret', expr: IR.reg(o[0]), pc: ins.pc }); break;
    case 'throw': out.push({ kind: 'throw', expr: IR.reg(o[0]), pc: ins.pc }); break;
    case 'push_try': out.push({ kind: 'push_try', shape: k.shape, operands: o, pc: ins.pc }); break;
    case 'pop_try': out.push({ kind: 'pop_try', pc: ins.pc }); break;
    case 'debugger': out.push({ kind: 'debugger', pc: ins.pc }); break;
    case 'jmp': case 'jz': case 'jnz': case 'jmp_reg': case 'nop': case 'decrypt': break;
    default: out.push({ kind: 'comment', text: 'unhandled opcode ' + ins.op + ' (' + ins.kind + ')', pc: ins.pc });
  }
  return out;
}
