// debug/ops.js -- build the opcode table: structural kind + operand layout + per-site semantic fitting
const { structuralKind, jumpKind } = require('./classify');

const REGBASE = 500;
const FRAMESZ = 2000;

function makeEnv(L, opts) {
  const bc = new Array(80).fill(0);
  const words = opts.words || [];
  for (let i = 0; i < words.length; i++) bc[i] = words[i];
  const raw = new Array(FRAMESZ).fill(undefined);
  const log = { reads: [], writes: [] };
  raw[0] = 0; raw[1] = REGBASE; raw[2] = 0;
  raw[4] = opts.C === undefined ? 0 : opts.C;
  raw[6] = opts.thisVal;
  raw[9] = opts.tmpl || { x: {}, l: [], prototype: {} };
  raw[10] = 0; raw[13] = 900;
  if (opts.regs) for (const k of Object.keys(opts.regs)) raw[REGBASE + Number(k)] = opts.regs[k];
  const frames = new Proxy(raw, {
    get(t, p) {
      if (typeof p === 'string' && /^\d+$/.test(p)) { const i = +p; if (i >= REGBASE) log.reads.push(i - REGBASE); }
      return t[p];
    },
    set(t, p, v) {
      if (typeof p === 'string' && /^\d+$/.test(p)) { const i = +p; if (i >= REGBASE) log.writes.push({ reg: i - REGBASE, val: v }); }
      t[p] = v; return true;
    },
  });
  const inst = new L.G(bc, opts.pool || L.vm.A, opts.globals || {});
  inst.g = frames; inst.d = 0; inst.j = 900; inst.__raw = raw;
  return { inst, raw, log };
}

// ---- layout probing ---------------------------------------------------------
function probeLayout(L, op) {
  const words = [];
  for (let i = 0; i < 24; i++) words.push(7 + i * 5);
  const regs = {};
  for (let i = 0; i < 300; i++) regs[i] = 1;
  const env = makeEnv(L, { words, regs, C: 1 });
  let err = null;
  try { L.A[op].call(env.inst); } catch (e) { err = e; }
  const consumed = typeof env.raw[2] === 'number' ? env.raw[2] : null;
  const pos = (v) => words.indexOf(v);
  const reads = [], writes = [];
  for (const r of env.log.reads) { const j = pos(r); if (j >= 0) reads.push(j); }
  for (const w of env.log.writes) { const j = pos(w.reg); if (j >= 0) writes.push(j); }
  return { consumed, reads: [...new Set(reads)], writes: [...new Set(writes)], err };
}

// ---- semantic fitting for data-processing opcodes ---------------------------
const BINOPS = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '<', '>', '<=', '>=', '==', '!=', '===', '!==', '**'];
const UNOPS = ['-', '+', '~', '!', 'typeof', 'void'];

function applyBin(o, x, y) {
  switch (o) {
    case '+': return x + y; case '-': return x - y; case '*': return x * y;
    case '/': return x / y; case '%': return x % y; case '&': return x & y;
    case '|': return x | y; case '^': return x ^ y; case '<<': return x << y;
    case '>>': return x >> y; case '>>>': return x >>> y; case '<': return x < y;
    case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y;
    case '==': return x == y; case '!=': return x != y; case '===': return x === y;
    case '!==': return x !== y; case '**': return Math.pow(x, y);
  }
}
function applyUn(o, x) {
  switch (o) {
    case '-': return -x; case '+': return +x; case '~': return ~x; case '!': return !x;
    case 'typeof': return typeof x; case 'void': return void x;
  }
}

const PROBE_VALUES = [0, 1, 2, 3, 5, 7, 8, 15, 16, 31, 100, 255, 256, 1000, 65535, 65536,
  -1, -2, -3, -7, -16, -100, -1000, -65536, 123456789, -123456789, 2147483647, -2147483648,
  1073741824, -1073741824, 4, 6, 9, 12, 21, 42, 77, 99, -5, -21, -42];

// typed probes let us recognize the "plain" (non-MBA) handlers exactly
const TYPED_X = [5, -3, 0, 2, 'abc', 'a', true, false, null, undefined, { a: 1 }, [1, 2], Math.max, NaN];
const TYPED_Y = [2, 0, 5, -1, 'a', 'abc', true, false, null, undefined, {}, Object, Array, [1, 2]];
const MEMBER = '[]';

function tryv(f) { try { return { ok: true, v: f() }; } catch (e) { return { ok: false }; } }
function same(a, b) {
  if (!a.ok || !b.ok) return a.ok === b.ok;
  if (typeof a.v === 'number' && typeof b.v === 'number' && isNaN(a.v) && isNaN(b.v)) return true;
  return Object.is(a.v, b.v);
}

function typedBinary(ev) {
  const cands = BINOPS.concat([MEMBER, 'in', 'instanceof']);
  const hits = [];
  for (const o of cands) {
    let ok = true, seen = 0;
    for (const x of TYPED_X) {
      for (const y of TYPED_Y) {
        const h = tryv(() => { const r = ev([x, y]); if (r.err) throw r.err; return r.val; });
        const e = tryv(() => o === MEMBER ? x[y] : o === 'in' ? (x in y) : o === 'instanceof' ? (x instanceof y) : applyBin(o, x, y));
        if (!same(h, e)) { ok = false; break; }
        seen++;
      }
      if (!ok) break;
    }
    if (ok && seen > 100) hits.push(o);
  }
  return hits;
}

function typedUnary(ev) {
  const cands = ['id'].concat(UNOPS);
  const hits = [];
  for (const o of cands) {
    let ok = true, seen = 0;
    for (const x of TYPED_X) {
      const h = tryv(() => { const r = ev([x]); if (r.err) throw r.err; return r.val; });
      const e = tryv(() => o === 'id' ? x : applyUn(o, x));
      if (!same(h, e)) { ok = false; break; }
      seen++;
    }
    if (ok && seen >= TYPED_X.length) hits.push(o);
  }
  return hits;
}

function rnd(i) { return PROBE_VALUES[i % PROBE_VALUES.length]; }

// evaluate a data op at a concrete site; register operands are re-pointed at
// fresh independent registers so that we can vary them one at a time.
// register operands that name the same register at a site must stay aliased,
// otherwise `x - x` would look like a two-input operation
function inputGroups(words, layout) {
  const uniq = new Map();
  for (const p of layout.reads) { const r = words[p]; if (!uniq.has(r)) uniq.set(r, uniq.size); }
  return uniq;
}

function makeEvaluator(L, op, words, layout, C) {
  const uniq = inputGroups(words, layout);
  const w2 = words.slice();
  const freshBase = 900;
  for (const p of layout.reads) w2[p] = freshBase + uniq.get(words[p]);
  if (layout.writes.length) w2[layout.writes[0]] = 950;
  const ev = function (vals) {
    const regs = {};
    for (let i = 0; i < uniq.size; i++) regs[freshBase + i] = vals[i];
    const env = makeEnv(L, { words: w2, regs, C });
    try { L.A[op].call(env.inst); } catch (e) { return { err: e }; }
    const wr = env.log.writes.filter(x => x.reg === 950);
    return { val: wr.length ? wr[wr.length - 1].val : undefined };
  };
  ev.inputs = [...uniq.keys()];
  return ev;
}

function fitSite(L, op, words, layout, C) {
  const ev = makeEvaluator(L, op, words, layout, C);
  const n = ev.inputs.length;

  // stage 0: exact match against a real JS operator using typed probes
  if (n === 2) {
    const hits = typedBinary(ev);
    if (hits.length === 1) return { kind: 'BINARY', op: hits[0], a: 0, b: 1, exact: true , inputs: ev.inputs };
  } else if (n === 1) {
    const hits = typedUnary(ev);
    if (hits.length === 1) return hits[0] === 'id'
      ? { kind: 'MOV', a: 0, exact: true, inputs: ev.inputs }
      : { kind: 'UNARY', op: hits[0], a: 0, exact: true, inputs: ev.inputs };
    if (hits.length > 1 && hits.includes('id')) return { kind: 'MOV', a: 0, exact: true , inputs: ev.inputs };
  }

  // stage 1: numeric fit (MBA-obfuscated handlers).  the probe set includes the
  // instruction's own immediates so that comparisons against them are exercised.
  const extra = [];
  for (const w of words) { extra.push(w | 0, w >>> 0, (w | 0) + 1, (w | 0) - 1); }
  const values = PROBE_VALUES.concat(extra);
  const rnd = (i) => values[((i % values.length) + values.length) % values.length];
  const base = [];
  for (let i = 0; i < n; i++) base.push(rnd(i * 3 + 1));
  // essential inputs
  const essential = [];
  for (let i = 0; i < n; i++) {
    let diff = false;
    for (let t = 0; t < 40 && !diff; t++) {
      const a = base.slice(); const b = base.slice();
      for (let j = 0; j < n; j++) { a[j] = rnd(t * 13 + j * 29); b[j] = a[j]; }
      b[i] = rnd(t * 13 + i * 29 + 7);
      if (b[i] === a[i]) b[i] = (a[i] + 1) | 0;
      const ra = ev(a), rb = ev(b);
      if (ra.err || rb.err) { diff = true; break; }
      if (!Object.is(ra.val, rb.val)) diff = true;
    }
    if (diff) essential.push(i);
  }
  const NP = 60;
  const samples = [];
  for (let t = 0; t < NP; t++) {
    const vals = [];
    for (let j = 0; j < n; j++) vals.push(rnd(t * 11 + j * 17 + 1));
    const r = ev(vals);
    if (r.err) return { kind: 'ERR', err: String(r.err) };
    samples.push({ vals, out: r.val });
  }
  const eq = (a, b) => Object.is(a, b) || (typeof a === 'number' && typeof b === 'number' && a === b);

  if (essential.length === 0) {
    const c = samples[0].out;
    if (samples.every(s => eq(s.out, c))) return { kind: 'CONST', value: c, inputs: ev.inputs };
    return { kind: 'UNKNOWN0', inputs: ev.inputs };
  }
  if (essential.length === 1) {
    const i = essential[0];
    // pure unary?
    for (const o of UNOPS) {
      if (samples.every(s => eq(s.out, applyUn(o, s.vals[i])) || eq(s.out, applyUn(o, s.vals[i]) | 0)))
        return { kind: 'UNARY', op: o, a: i , inputs: ev.inputs };
    }
    // binary with a constant operand
    const consts = new Set([0, 1, 2, -1]);
    for (let p = 0; p < words.length; p++) { consts.add(words[p] | 0); consts.add(words[p] >>> 0); }
    const zero = ev(samples.map(() => 0).slice(0, n).map((_, j) => (j === i ? 0 : samples[0].vals[j])));
    if (typeof zero.val === 'number') { consts.add(zero.val | 0); consts.add(-zero.val | 0); consts.add(~zero.val | 0); }
    for (const o of BINOPS) {
      for (const k of consts) {
        if (samples.every(s => eq(s.out, applyBin(o, s.vals[i], k)) || eq(s.out, applyBin(o, s.vals[i], k) | 0)))
          return { kind: 'BINCONST', op: o, a: i, k, side: 'right' , inputs: ev.inputs };
        if (samples.every(s => eq(s.out, applyBin(o, k, s.vals[i])) || eq(s.out, applyBin(o, k, s.vals[i]) | 0)))
          return { kind: 'BINCONST', op: o, a: i, k, side: 'left' , inputs: ev.inputs };
      }
    }
    return { kind: 'UNKNOWN1', essential , inputs: ev.inputs };
  }
  if (essential.length === 2) {
    const [i, j] = essential;
    for (const o of BINOPS) {
      if (samples.every(s => eq(s.out, applyBin(o, s.vals[i], s.vals[j])) || eq(s.out, applyBin(o, s.vals[i], s.vals[j]) | 0)))
        return { kind: 'BINARY', op: o, a: i, b: j , inputs: ev.inputs };
      if (samples.every(s => eq(s.out, applyBin(o, s.vals[j], s.vals[i])) || eq(s.out, applyBin(o, s.vals[j], s.vals[i]) | 0)))
        return { kind: 'BINARY', op: o, a: j, b: i , inputs: ev.inputs };
    }
    return { kind: 'UNKNOWN2', essential , inputs: ev.inputs };
  }
  return { kind: 'UNKNOWNN', essential , inputs: ev.inputs };
}

function buildOpTable(L) {
  const table = {};
  for (const key of Object.keys(L.A)) {
    const op = Number(key);
    if (isNaN(op)) continue;
    const fn = L.A[key];
    const code = String(fn);
    let kind = structuralKind(code);
    if (!kind) { const j = jumpKind(code); if (j) kind = { kind: j }; }
    if (!kind && /\[\w+ \+ 6\]/.test(code)) kind = { kind: 'LOADTHIS' };
    if (!kind && /v\(this\)/.test(code)) kind = { kind: 'LOADCONST' };
    const layout = probeLayout(L, op);
    table[op] = { op, kind: kind ? kind.kind : 'DATA', layout, code };
  }
  return table;
}

module.exports = { buildOpTable, fitSite, makeEnv, probeLayout, REGBASE };
