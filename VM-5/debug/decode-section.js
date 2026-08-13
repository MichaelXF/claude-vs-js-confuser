/* ================================================================== *
 * 9.  Semantics of the arithmetic / comparison opcodes
 *
 * These handlers are the MBA-obfuscated ones.  Their bodies are unreadable, but they are
 * pure functions of one or two registers (plus immediate operands that are either real
 * constants or junk keys), so they can simply be *fitted*: run the handler over a probe
 * set and find the JavaScript operator that reproduces every observation.  MBA identities
 * only hold for int32 inputs, so integer probes decide first and general (string / float /
 * object) probes are used to refine the answer when the handler tolerates them.
 * ================================================================== */

const INT_PROBES = [0, 1, 2, 3, 7, 33, 255, 1000, 65535, 123456, -1, -7, -100, -65536, 0x7fffffff, -0x80000000];
const INT_PAIRS_VALUES = [0, 1, 2, 7, 255, 65535, 123456, -1, -7, -65536, 0x7fffffff, -0x80000000];
const GEN_VALUES = [0, 1, -1, 2.5, NaN, '', 'abc', '5', true, false, null, undefined, { k: 1 }, [1, 2]];

const UNARY_CANDIDATES = [
  ['id', x => x],
  ['-', x => -x], ['+', x => +x], ['~', x => ~x], ['!', x => !x],
  ['!!', x => !!x], ['typeof', x => typeof x], ['void', x => void x],
  ['|0', x => x | 0], ['>>>0', x => x >>> 0],
];

const BINARY_CANDIDATES = [
  ['===', (a, b) => a === b], ['!==', (a, b) => a !== b],
  ['<', (a, b) => a < b], ['<=', (a, b) => a <= b], ['>', (a, b) => a > b], ['>=', (a, b) => a >= b],
  ['+', (a, b) => a + b], ['-', (a, b) => a - b], ['*', (a, b) => a * b],
  ['/', (a, b) => a / b], ['%', (a, b) => a % b], ['**', (a, b) => a ** b],
  ['&', (a, b) => a & b], ['|', (a, b) => a | b], ['^', (a, b) => a ^ b],
  ['<<', (a, b) => a << b], ['>>', (a, b) => a >> b], ['>>>', (a, b) => a >>> b],
  ['==', (a, b) => a == b], ['!=', (a, b) => a != b],
  ['in', (a, b) => a in b], ['instanceof', (a, b) => a instanceof b],
  ['+|0', (a, b) => (a + b) | 0], ['-|0', (a, b) => (a - b) | 0], ['*|0', (a, b) => Math.imul(a, b)],
];

const ERR = Symbol('error');
const NONE = Symbol('none');

function same(a, b) {
  if (a === b) return true;
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

function evalHandler(env, op, operands, regs) {
  const m = runHandler(env, op, { code: [op, ...operands], ip: 1, regs, regValue: () => 0 });
  if (m.rec.error) return ERR;
  const w = m.rec.regWrites[m.rec.regWrites.length - 1];
  return w ? w[1] : NONE;
}

/** Locate the destination register operand of a data opcode. */
function findDstSlot(env, kind, operands) {
  if (kind.roles.indexOf('dst') >= 0) return kind.roles.indexOf('dst');
  const regSlots = kind.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
  const trials = [
    { obj: { PROBE_KEY: 1 }, key: 'PROBE_KEY' },
  ];
  const sets = [
    () => ({}),
    () => { const r = {}; if (regSlots[0] !== undefined) r[operands[regSlots[0]]] = 'PROBE_KEY'; if (regSlots[1] !== undefined) r[operands[regSlots[1]]] = { PROBE_KEY: 1 }; return r; },
    () => { const r = {}; if (regSlots[0] !== undefined) r[operands[regSlots[0]]] = {}; if (regSlots[1] !== undefined) r[operands[regSlots[1]]] = Object; return r; },
  ];
  for (const mk of sets) {
    const m = runHandler(env, kind.op, { code: [kind.op, ...operands], ip: 1, regs: mk(), regValue: () => 1 });
    const w = m.rec.regWrites[m.rec.regWrites.length - 1];
    if (w) {
      const s = operands.indexOf(w[0]);
      if (s >= 0) return s;
    }
  }
  return -1;
}

/**
 * Fit one data opcode.  Returns a template that is instantiated per instruction:
 *   {form:'const'}                        value computed by running the handler
 *   {form:'move', src}                    dst = reg(src)
 *   {form:'unary', operator, arg}         dst = OP reg(arg)
 *   {form:'binary', operator, left,right} operands are {reg:slot} or {imm:slot,int:bool}
 */
function fitDataOpcode(env, kind, operands) {
  const op = kind.op;
  const dstSlot = findDstSlot(env, kind, operands);
  const regSlots = kind.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
  const immSlots = kind.roles.map((r, i) => (r !== 'reg' ? i : -1)).filter(i => i >= 0 && i !== dstSlot);

  // canonical operands: give every register operand its own register
  const canon = operands.slice();
  regSlots.forEach((s, i) => { canon[s] = 900 + i; });
  const regsFor = vals => { const r = {}; regSlots.forEach((s, i) => { r[canon[s]] = vals[i]; }); return r; };
  const run = (ops, vals) => evalHandler(env, op, ops, regsFor(vals));

  const baseVals = regSlots.map(() => 3);
  const baseline = run(canon, baseVals);

  // --- which inputs actually matter?
  const varDeps = [];
  regSlots.forEach((s, i) => {
    for (const v of [5, 100, -7, 65535]) {
      const vals = baseVals.slice(); vals[i] = v;
      if (!same(run(canon, vals), baseline)) { varDeps.push(i); return; }
    }
  });
  const immDeps = [];
  for (const s of immSlots) {
    for (const v of [(operands[s] + 1) >>> 0, (operands[s] ^ 0x5555) >>> 0, 12345]) {
      const ops = canon.slice(); ops[s] = v;
      if (!same(run(ops, baseVals), baseline)) { immDeps.push(s); break; }
    }
  }

  if (varDeps.length === 0) return { form: 'const', dstSlot };

  const probeRuns = [];
  if (varDeps.length === 1) {
    const i = varDeps[0];
    for (const v of INT_PROBES.concat(GEN_VALUES)) {
      const vals = baseVals.slice(); vals[i] = v;
      probeRuns.push({ inputs: [v], out: run(canon, vals), general: !(typeof v === 'number' && Number.isInteger(v)) });
    }
  } else if (varDeps.length === 2) {
    const [i, j] = varDeps;
    for (const a of INT_PAIRS_VALUES) for (const b of INT_PAIRS_VALUES) {
      const vals = baseVals.slice(); vals[i] = a; vals[j] = b;
      probeRuns.push({ inputs: [a, b], out: run(canon, vals), general: false });
    }
    for (const a of GEN_VALUES) for (const b of GEN_VALUES) {
      const vals = baseVals.slice(); vals[i] = a; vals[j] = b;
      probeRuns.push({ inputs: [a, b], out: run(canon, vals), general: true });
    }
  } else {
    return { form: 'unknown', dstSlot, reason: 'depends on ' + varDeps.length + ' registers' };
  }

  const constCandidates = [];
  for (const s of immDeps) {
    constCandidates.push({ imm: s, int: false, value: operands[s] });
    constCandidates.push({ imm: s, int: true, value: operands[s] | 0 });
  }

  const candidates = [];
  if (varDeps.length === 1) {
    for (const [name, fn] of UNARY_CANDIDATES) {
      if (immDeps.length) break;
      candidates.push({ tpl: name === 'id' ? { form: 'move', src: regSlots[varDeps[0]] } : { form: 'unary', operator: name, arg: regSlots[varDeps[0]] }, fn: v => fn(v[0]) });
    }
    for (const c of constCandidates) {
      for (const [name, fn] of BINARY_CANDIDATES) {
        candidates.push({
          tpl: { form: 'binary', operator: name, left: { reg: regSlots[varDeps[0]] }, right: { imm: c.imm, int: c.int } },
          fn: v => fn(v[0], c.value),
        });
        candidates.push({
          tpl: { form: 'binary', operator: name, left: { imm: c.imm, int: c.int }, right: { reg: regSlots[varDeps[0]] } },
          fn: v => fn(c.value, v[0]),
        });
      }
    }
  } else {
    const [i, j] = varDeps;
    for (const [name, fn] of BINARY_CANDIDATES) {
      candidates.push({ tpl: { form: 'binary', operator: name, left: { reg: regSlots[i] }, right: { reg: regSlots[j] } }, fn: v => fn(v[0], v[1]) });
      candidates.push({ tpl: { form: 'binary', operator: name, left: { reg: regSlots[j] }, right: { reg: regSlots[i] } }, fn: v => fn(v[1], v[0]) });
    }
  }

  const check = (cand, runs) => runs.every(r => {
    let want;
    try { want = cand.fn(r.inputs); } catch (e) { want = ERR; }
    if (r.out === ERR) return want === ERR || true;      // handler blew up: no information
    if (r.out === NONE) return false;
    return same(r.out, want);
  });

  const intRuns = probeRuns.filter(r => !r.general);
  const genRuns = probeRuns.filter(r => r.general && r.out !== ERR);
  let survivors = candidates.filter(c => check(c, intRuns));
  const refined = survivors.filter(c => check(c, genRuns));
  if (refined.length) survivors = refined;
  if (!survivors.length) return { form: 'unknown', dstSlot, reason: 'no operator matches' };
  survivors.sort((a, b) => rank(a.tpl) - rank(b.tpl));
  return { ...survivors[0].tpl, dstSlot, ambiguous: survivors.length > 1 ? survivors.map(s => s.tpl.operator || s.tpl.form) : undefined };
}

const RANK = ['id', '===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '**', '&', '|', '^',
  '<<', '>>', '>>>', '!', '!!', '~', 'typeof', 'void', '|0', '>>>0', '==', '!=', 'in', 'instanceof',
  '+|0', '-|0', '*|0'];
function rank(tpl) {
  const key = tpl.form === 'move' ? 'id' : tpl.operator;
  const i = RANK.indexOf(key);
  return i < 0 ? 99 : i;
}

/* ================================================================== *
 * 10.  Static decoding of the bytecode
 * ================================================================== */

function decodeAt(env, pc) {
  const op = env.code[pc];
  const kind = env.kinds.get(op);
  if (!kind) return { pc, op, kind: 'invalid', operands: [], next: pc + 1 };
  const m = runHandler(env, op, {
    code: env.code, ip: pc + 1, regValue: () => 1, globalValue: () => undefined,
  });
  const operands = m.rec.operands;
  const ins = { pc, op, kind: kind.kind, k: kind, operands, next: pc + 1 + operands.length, rec: m.rec };
  return ins;
}

module.exports_decode = true;
