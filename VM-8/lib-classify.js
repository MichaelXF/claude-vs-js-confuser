'use strict';
// ---------------------------------------------------------------------------
// Numeric (black-box) identification of arithmetic handlers.
//
// JS-Confuser's MBA rewriting only produces an identity when the operands
// satisfy the low-nibble invariants the obfuscator assumed at build time
// (terms of the shape `Math.imul(x & 15 ^ N, K)` vanish exactly when
// `x & 15 === N`).  Probing therefore scans residue classes and keeps the
// interpretation that explains the most inputs: in the wrong class the real
// operands look dead, which makes the correct class easy to spot.
// ---------------------------------------------------------------------------
const { probe, tracer } = require('./lib-probe.js');

const THIS_MARK = { __thisMarker: true };

function regTracer(i, log) { return tracer('R' + i, log, ((i * 2654435761) | 0) | 1); }

function regId(v) {
  if (v && (typeof v === 'object' || typeof v === 'function')) {
    try {
      if (v.__isTracer) { const m = /^R(\d+)$/.exec(v.__id); return m ? +m[1] : null; }
    } catch (e) { /* not a tracer */ }
  }
  return null;
}

let SEED = 0x2545f491;
function rnd() { SEED ^= SEED << 13; SEED ^= SEED >>> 17; SEED ^= SEED << 5; return SEED | 0; }
function nib(v, n) { return n == null ? v : ((v & ~15) | n); }

const BINOPS = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
  '%': (a, b) => a % b, '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b, '**': (a, b) => a ** b,
};
const UNOPS = { 'id': a => a, '~': a => ~a, '-': a => -a, '!': a => !a, '+': a => +a };
const WRAPPABLE = ['+', '-', '*'];
const same = (x, y) => Object.is(x, y) || (x === 0 && y === 0);

// Values chosen so that comparisons, truthiness and bit tricks all flip.
const SAMPLES = [0, 1, -1, 2, 3, 7, 15, 16, -16, 255, -256, 65535, -65536,
  1073741824, -1073741824, 2147483647, -2147483648, 12345, -54321];

function numRun(M, site, fnInfo, regs) {
  return probe(M, { pc: site.pc, B: fnInfo.B, nregs: regs.length, regs, thisVal: THIS_MARK });
}
function writeAt(rec, dst) {
  const w = rec.writes.filter(x => x[0] - rec.regBase === dst).pop();
  return w ? w[1] : undefined;
}

function candidates(live, imms) {
  const out = [];
  if (live.length === 1) {
    const r = live[0];
    for (const [nm, f] of Object.entries(UNOPS)) {
      out.push({ kind: 'un', operator: nm, a: r, f: t => f(t.vals[r]) });
    }
    for (const iv of imms) {
      for (const [nm, f] of Object.entries(BINOPS)) {
        out.push({ kind: 'binimm', operator: nm, a: r, imm: iv, immFirst: false, f: t => f(t.vals[r], iv) });
        out.push({ kind: 'binimm', operator: nm, a: r, imm: iv, immFirst: true, f: t => f(iv, t.vals[r]) });
      }
      for (const nm of WRAPPABLE) {
        const f = BINOPS[nm];
        out.push({ kind: 'binimm', operator: nm, wrap: true, a: r, imm: iv, immFirst: false, f: t => f(t.vals[r], iv) | 0 });
      }
      out.push({ kind: 'binimm', operator: 'imul', a: r, imm: iv, immFirst: false, f: t => Math.imul(t.vals[r], iv) });
    }
  } else if (live.length === 2) {
    for (const [x, y] of [[live[0], live[1]], [live[1], live[0]]]) {
      for (const [nm, f] of Object.entries(BINOPS)) {
        out.push({ kind: 'bin', operator: nm, a: x, b: y, f: t => f(t.vals[x], t.vals[y]) });
      }
      for (const nm of WRAPPABLE) {
        const f = BINOPS[nm];
        out.push({ kind: 'bin', operator: nm, wrap: true, a: x, b: y, f: t => f(t.vals[x], t.vals[y]) | 0 });
      }
      out.push({ kind: 'bin', operator: 'imul', a: x, b: y, f: t => Math.imul(t.vals[x], t.vals[y]) });
    }
  }
  return out;
}

// The residue classes an MBA handler could possibly assume are visible in the
// shapes `x & 15 ^ N` / `x & 7 ^ N` it contains.  This is only a search order
// hint - the full 0..15 scan still runs if none of them fits.
const RESIDUE_RE = /&\s*(?:15|7)\s*\^\s*(\d+)/g;
const residueCache = new Map();
function residueHints(M, op) {
  if (residueCache.has(op)) return residueCache.get(op);
  let out = [];
  try {
    const src = String(M.proto[op]);
    const seen = new Set();
    let m;
    RESIDUE_RE.lastIndex = 0;
    while ((m = RESIDUE_RE.exec(src))) {
      const n = +m[1];
      if (n >= 0 && n < 16 && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  } catch (e) { out = []; }
  residueCache.set(op, out);
  return out;
}


// --- typed probing ---------------------------------------------------------
// Operators such as `in`, `instanceof`, `typeof` and string `+` are invisible
// to an all-numeric probe (some of them throw on numbers, others collapse to
// the identity), so handlers are first fitted over a mixed-type domain.
const TYPED = [0, 1, 2, -1, 3.5, NaN, 'a', '1', '', 'xy', true, false, null, undefined,
  { p: 1 }, [1, 2], Object, String];

const GEN_BIN = Object.assign({}, BINOPS, {
  '==': (a, b) => a == b,
  '!=': (a, b) => a != b,
  'in': (a, b) => a in b,
  'instanceof': (a, b) => a instanceof b,
});
const GEN_UN = Object.assign({}, UNOPS, {
  'typeof': a => typeof a,
  'void': a => void a,
});

function outcome(M, site, fnInfo, dst, regs) {
  const rec = numRun(M, site, fnInfo, regs);
  if (rec.threw) return { threw: true };
  return { value: writeAt(rec, dst) };
}
function expect(f, args) {
  try { return { value: f.apply(null, args) }; } catch (e) { return { threw: true }; }
}
function sameOutcome(a, b) {
  if (a.threw || b.threw) return !!a.threw === !!b.threw;
  return same(a.value, b.value);
}

function fitTyped(M, site, fnInfo, rd, dst) {
  const nregs = Math.max(fnInfo.nregs, 8) + 8;
  const base = () => { const r = new Array(nregs); for (let i = 0; i < nregs; i++) r[i] = TYPED[i % TYPED.length]; return r; };
  // With one or two register inputs there is nothing to disambiguate, and a
  // liveness pre-pass would be misleading anyway: `x in 3.5` throws for every
  // x, which makes a genuinely live operand look dead.
  let live;
  if (rd.length <= 2) live = rd.slice();
  else {
    live = [];
    for (const r of rd) {
      let vary = false;
      for (let shift = 0; shift < 3 && !vary; shift++) {
        const bg = new Array(nregs);
        for (let i = 0; i < nregs; i++) bg[i] = TYPED[(i + shift * 5) % TYPED.length];
        let first = null;
        for (const v of TYPED) {
          const g = bg.slice(); g[r] = v;
          const o = outcome(M, site, fnInfo, dst, g);
          if (first && !sameOutcome(first, o)) { vary = true; break; }
          if (!first) first = o;
        }
      }
      if (vary) live.push(r);
    }
  }
  if (!live.length || live.length > 2) return null;
  const trials = [];
  if (live.length === 1) {
    for (const v of TYPED) {
      const g = base(); g[live[0]] = v;
      trials.push({ vals: [v], out: outcome(M, site, fnInfo, dst, g) });
    }
  } else {
    for (const a of TYPED) for (const b of TYPED) {
      const g = base(); g[live[0]] = a; g[live[1]] = b;
      trials.push({ vals: [a, b], out: outcome(M, site, fnInfo, dst, g) });
    }
  }
  const cands = [];
  if (live.length === 1) {
    for (const [nm, f] of Object.entries(GEN_UN)) cands.push({ kind: 'un', operator: nm, a: live[0], f });
  } else {
    for (const [nm, f] of Object.entries(GEN_BIN)) {
      cands.push({ kind: 'bin', operator: nm, a: live[0], b: live[1], f });
      cands.push({ kind: 'bin', operator: nm, a: live[1], b: live[0], f, swap: true });
    }
  }
  const ok = cands.filter(c => trials.every(t => {
    const args = live.length === 1 ? [t.vals[0]] : (c.swap ? [t.vals[1], t.vals[0]] : [t.vals[0], t.vals[1]]);
    return sameOutcome(expect(c.f, args), t.out);
  }));
  if (!ok.length) return null;
  const c = Object.assign({}, ok[0]);
  delete c.f; delete c.swap;
  return Object.assign({ nibble: null, live, typed: true }, c);
}

function fitNumeric(M, site, fnInfo, rd, dst, classHint) {
  const nregs = Math.max(fnInfo.nregs, 8) + 8;
  const base = (n) => {
    const r = new Array(nregs);
    for (let i = 0; i < nregs; i++) r[i] = nib((i * 2654435761) | 0, n);
    return r;
  };
  const order = [null];
  if (classHint != null) order.push(classHint);
  for (const n of residueHints(M, site.op)) order.push(n);
  for (const n of [15, 6, 0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14]) order.push(n);

  const imms = [];
  for (const v of new Set(site.operands)) { imms.push(v); if (v > 0x7fffffff) imms.push(v | 0); }

  const seen = new Set();
  const results = [];
  for (const n of order) {
    if (seen.has(n)) continue;
    seen.add(n);
    const b0 = base(n);
    const probeVals = n == null ? SAMPLES : SAMPLES.slice(0, 8);
    const live = [];
    for (const r of rd) {
      const outs = new Set();
      let vary = false;
      for (const v of probeVals) {
        const g = b0.slice(); g[r] = nib(v, n);
        outs.add(String(writeAt(numRun(M, site, fnInfo, g), dst)));
        if (outs.size > 1) { vary = true; break; }
      }
      if (!vary) {
        for (let k = 0; k < 4 && !vary; k++) {
          const g = b0.slice(); g[r] = nib(rnd(), n);
          outs.add(String(writeAt(numRun(M, site, fnInfo, g), dst)));
          if (outs.size > 1) vary = true;
        }
      }
      if (!vary) {
        for (const o of rd) {
          if (o === r) continue;
          const g = b0.slice(); g[r] = b0[o];
          outs.add(String(writeAt(numRun(M, site, fnInfo, g), dst)));
          if (outs.size > 1) { vary = true; break; }
        }
      }
      if (vary) live.push(r);
    }
    const trials = [];
    for (let k = 0; k < 32; k++) {
      const g = b0.slice(); const vals = {};
      for (const r of live) { const v = nib(k < SAMPLES.length ? SAMPLES[k] : rnd(), n); g[r] = v; vals[r] = v; }
      if (live.length === 2 && k % 4 === 1) { g[live[1]] = g[live[0]]; vals[live[1]] = vals[live[0]]; }
      trials.push({ vals, out: writeAt(numRun(M, site, fnInfo, g), dst) });
    }
    if (live.length === 0) {
      const c = trials[0].out;
      if (trials.every(t => same(t.out, c))) results.push({ nibble: n, live, kind: 'const', value: c });
      continue;
    }
    const ok = candidates(live, imms).filter(c => trials.every(t => same(c.f(t), t.out)));
    if (ok.length) {
      const c = Object.assign({}, ok[0]);
      delete c.f;
      results.push(Object.assign({ nibble: n, live }, c));
      break; // a live fit is decisive; wrong residue classes make inputs look dead
    }
  }
  if (!results.length) return null;
  results.sort((a, b) => (b.live.length - a.live.length) || ((a.nibble == null ? -1 : 0) - (b.nibble == null ? -1 : 0)));
  return results[0];
}

// Evaluates a handler on a concrete (partly unknown) register environment.
// Unknown registers are randomized several times; if the destination is stable
// across all of them the instruction has a compile-time constant result.
const FILLERS = [0, 1, -1, 2, -16, 65535];
function oracle(M, site, fnInfo, dst, known, rounds = 12) {
  const nregs = Math.max(fnInfo.nregs, 8) + 8;
  let first;
  for (let k = 0; k < rounds; k++) {
    const regs = new Array(nregs);
    // Uniform fillers first (so comparisons between two unknowns stay stable
    // and boolean operators see a falsy case), then independent randoms.
    for (let i = 0; i < nregs; i++) {
      regs[i] = (i in known) ? known[i] : (k < FILLERS.length ? FILLERS[k] : rnd());
    }
    const v = writeAt(numRun(M, site, fnInfo, regs), dst);
    if (k === 0) first = v;
    else if (!same(v, first)) return { known: false };
  }
  return { known: true, value: first };
}

module.exports = {
  regTracer, regId, fitNumeric, fitTyped, oracle, THIS_MARK, writeAt, numRun, BINOPS, UNOPS,
};
