'use strict';
/**
 * vm.js -- AST deobfuscator / devirtualizer for JS-Confuser-VM samples.
 *
 *   node vm.js input.js output.js
 *   require('./vm.js')('input.js')   -> deobfuscated source string
 *
 * See NOTES.md for the reverse-engineered VM architecture.  Short version:
 *
 *   - the payload is a register machine: `new g(bytecode, constantPool, global)`
 *     driven by `z(...)`, with one method per opcode on `g.prototype`
 *   - opcode numbers are randomized per sample, so every handler is identified
 *     by *behavior*, not by number: we probe each handler in a synthetic frame
 *     to learn its operand layout, then fit its semantics with typed + numeric
 *     probes (this is what defeats the keyed MBA arithmetic)
 *   - the compiled program is control-flow-flattened: each basic block ends by
 *     jumping to a shared dispatcher that hashes three registers into the next
 *     pc.  We rebuild the CFG by symbolically executing blocks and evaluating
 *     the dispatcher, forking on the single unknown a branch depends on.
 *   - the recovered CFG is then re-structured into if/else/while and printed
 *     with @babel/generator.
 */

const fs = require('fs');
const path = require('path');
const vmMod = require('vm');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

/* ------------------------------------------------------------------ *
 * 1. loading: capture the VM internals without running the program
 * ------------------------------------------------------------------ */

function findBootstrap(ast) {
  // the payload always ends with  z(new g(bytes, pool, globals), this, args, new t({...}))
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const st = body[i];
    if (st.type !== 'ExpressionStatement') continue;
    const e = st.expression;
    if (e.type !== 'CallExpression' || e.callee.type !== 'Identifier') continue;
    if (e.arguments.length !== 4) continue;
    const a0 = e.arguments[0], a3 = e.arguments[3];
    if (a0.type !== 'NewExpression' || a3.type !== 'NewExpression') continue;
    if (a0.arguments.length !== 3 || a3.arguments.length !== 1) continue;
    if (a3.arguments[0].type !== 'ObjectExpression') continue;
    return { stmt: st, expr: e, index: i };
  }
  return null;
}

function loadVM(file, src, extraGlobals) {
  src = src === undefined ? fs.readFileSync(file, 'utf8') : src;
  let ast;
  try { ast = parser.parse(src, { sourceType: 'script' }); }
  catch (e) { ast = parser.parse(src, { sourceType: 'module' }); }
  const boot = findBootstrap(ast);
  if (!boot) return null;

  boot.expr.callee = t.identifier('__cap');
  const code = 'var __boot;var __cap=function(){__boot=[].slice.call(arguments)};\n' +
    generate(ast, { compact: false }).code;

  const sandbox = {
    console, Math, Object, Array, String, Number, Boolean, JSON, Reflect, WeakMap, WeakSet,
    Uint8Array, Uint32Array, Int32Array, Buffer, Error, TypeError, ReferenceError, RangeError,
    SyntaxError, EvalError, URIError, Function, Symbol, Date, RegExp, Promise, Map, Set, Proxy,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI,
    decodeURI, Infinity, NaN, undefined,
  };
  if (extraGlobals) Object.assign(sandbox, extraGlobals);
  const ctx = vmMod.createContext(sandbox);
  vmMod.runInContext(code, ctx, { filename: file || 'input.js', timeout: 10000 });
  const captured = ctx.__boot;
  if (!captured) return null;

  const L = { ctx, vm: captured[0], thisArg: captured[1], args: captured[2], tmpl: captured[3] };
  // the opcode table lives on the prototype of the machine constructor
  L.G = captured[0].constructor;
  L.A = L.G.prototype;
  L.T = captured[3].constructor;
  // helper functions are top-level declarations in the payload's scope
  for (const name of Object.keys(ctx)) {
    const v = ctx[name];
    if (typeof v !== 'function') continue;
    const s = String(v);
    if (/return \w+\.i\[\w+\.g\[\w+\.d \+ 2\]\+\+\]/.test(s)) L.W = v;               // read next word
    else if (/2654435769/.test(s) && /fromCharCode/.test(s)) L.V = v;               // read constant
  }
  for (const name of Object.keys(ctx)) {
    const v = ctx[name];
    if (typeof v === 'function' && /\.t\(\w+, ?24, ?\[\], ?\w+, ?0,/.test(String(v))) L.Z = v;
  }
  if (!L.V || !L.Z) {
    // fall back to scanning every context value
    for (const name of Object.keys(ctx)) {
      const v = ctx[name];
      if (typeof v !== 'function') continue;
      const s = String(v);
      if (!L.Z && /catch/.test(s) && /\.t\(/.test(s) && /for \(;;\)|for\(;;\)/.test(s)) L.Z = v;
    }
  }
  return L;
}

/* ------------------------------------------------------------------ *
 * 2. handler probing: operand layout + semantics
 * ------------------------------------------------------------------ */

const REGBASE = 500;
const FRAMESZ = 2200;
const SPREAD = 2329202881;

function makeEnv(L, opts) {
  const bc = new Array(96).fill(0);
  const words = opts.words || [];
  for (let i = 0; i < words.length; i++) bc[i] = words[i];
  const raw = new Array(FRAMESZ).fill(undefined);
  const log = { reads: [], writes: [] };
  raw[0] = 0; raw[1] = REGBASE; raw[2] = 0;
  raw[4] = opts.C === undefined ? 0 : opts.C;
  raw[6] = opts.thisVal;
  raw[9] = opts.tmpl || { x: {}, l: [], prototype: {} };
  raw[10] = 0; raw[13] = 1000;
  if (opts.regs) for (const k of Object.keys(opts.regs)) raw[REGBASE + Number(k)] = opts.regs[k];
  const frames = new Proxy(raw, {
    get(tgt, p) {
      if (typeof p === 'string' && p.charCodeAt(0) >= 48 && p.charCodeAt(0) <= 57) {
        const i = +p; if (i >= REGBASE) log.reads.push(i - REGBASE);
      }
      return tgt[p];
    },
    set(tgt, p, v) {
      if (typeof p === 'string' && p.charCodeAt(0) >= 48 && p.charCodeAt(0) <= 57) {
        const i = +p; if (i >= REGBASE) log.writes.push({ reg: i - REGBASE, val: v });
      }
      tgt[p] = v; return true;
    },
  });
  const inst = new L.G(bc, opts.pool || L.vm.A, opts.globals || {});
  inst.g = frames; inst.d = 0; inst.j = 1000;
  return { inst, raw, log };
}

// Probe a handler in a synthetic frame to learn how many bytecode words it
// eats, which of them are register indices and which one it writes back to.
// Several register fillings are tried because some handlers throw on the wrong
// operand types (`in`, `instanceof`, member access, ...) and would otherwise
// look like they never write anything.
function probeLayout(L, op) {
  const words = [];
  for (let i = 0; i < 24; i++) words.push(7 + i * 5);
  const fills = [1, {}, 'abc', function probe() { }, [1, 2], Object];
  const reads = new Set(), writes = new Set();
  let consumed = null, err = null, ok = false;
  for (const fill of fills) {
    const regs = {};
    for (let i = 0; i < 300; i++) regs[i] = fill;
    const env = makeEnv(L, { words, regs, C: 1 });
    let threw = null;
    try { L.A[op].call(env.inst); } catch (e) { threw = e; }
    const pos = (v) => words.indexOf(v);
    for (const r of env.log.reads) { const j = pos(r); if (j >= 0) reads.add(j); }
    for (const w of env.log.writes) { const j = pos(w.reg); if (j >= 0) writes.add(j); }
    if (typeof env.raw[2] === 'number' && (consumed === null || !ok)) consumed = env.raw[2];
    if (!threw) { ok = true; } else if (!err) err = threw;
    if (ok && writes.size) break;
  }
  return {
    consumed,
    reads: [...reads].sort((a, b) => a - b),
    writes: [...writes].sort((a, b) => a - b),
    err: ok ? null : err,
  };
}

const BINOPS = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '<', '>', '<=', '>=',
  '==', '!=', '===', '!==', '**'];
const UNOPS = ['-', '+', '~', '!', 'typeof', 'void'];
const MEMBER = '[]';

function applyBin(o, x, y) {
  switch (o) {
    case '+': return x + y; case '-': return x - y; case '*': return x * y;
    case '/': return x / y; case '%': return x % y; case '&': return x & y;
    case '|': return x | y; case '^': return x ^ y; case '<<': return x << y;
    case '>>': return x >> y; case '>>>': return x >>> y; case '<': return x < y;
    case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y;
    case '==': return x == y; case '!=': return x != y; case '===': return x === y;
    case '!==': return x !== y; case '**': return Math.pow(x, y);
    case MEMBER: return x[y]; case 'in': return x in y; case 'instanceof': return x instanceof y;
  }
}
function applyUn(o, x) {
  switch (o) {
    case 'id': return x; case '-': return -x; case '+': return +x; case '~': return ~x;
    case '!': return !x; case 'typeof': return typeof x; case 'void': return void x;
  }
}

const PROBE_VALUES = [0, 1, 2, 3, 5, 7, 8, 15, 16, 31, 100, 255, 256, 1000, 65535, 65536,
  -1, -2, -3, -7, -16, -100, -1000, -65536, 123456789, -123456789, 2147483647, -2147483648,
  1073741824, -1073741824, 4, 6, 9, 12, 21, 42, 77, 99, -5, -21, -42];
const TYPED_X = [5, -3, 0, 2, 'abc', 'a', true, false, null, undefined, { a: 1 }, [1, 2], Math.max, NaN];
const TYPED_Y = [2, 0, 5, -1, 'a', 'abc', true, false, null, undefined, {}, Object, Array, [1, 2]];

function tryv(f) { try { return { ok: true, v: f() }; } catch (e) { return { ok: false }; } }
function sameRes(a, b) {
  if (!a.ok || !b.ok) return a.ok === b.ok;
  if (typeof a.v === 'number' && typeof b.v === 'number' && isNaN(a.v) && isNaN(b.v)) return true;
  return Object.is(a.v, b.v);
}

function inputGroups(words, layout) {
  const uniq = new Map();
  for (const p of layout.reads) { const r = words[p]; if (!uniq.has(r)) uniq.set(r, uniq.size); }
  return uniq;
}

function makeEvaluator(L, op, words, layout, C) {
  const uniq = inputGroups(words, layout);
  const w2 = words.slice();
  for (const p of layout.reads) w2[p] = 900 + uniq.get(words[p]);
  if (layout.writes.length) w2[layout.writes[0]] = 950;
  const ev = function (vals) {
    const regs = {};
    for (let i = 0; i < uniq.size; i++) regs[900 + i] = vals[i];
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

  // stage 0 -- exact match against a real JS operator (the "plain" handlers)
  if (n === 2) {
    const hits = [];
    for (const o of BINOPS.concat([MEMBER, 'in', 'instanceof'])) {
      let ok = true, seen = 0;
      for (const x of TYPED_X) {
        for (const y of TYPED_Y) {
          const h = tryv(() => { const r = ev([x, y]); if (r.err) throw r.err; return r.val; });
          const e = tryv(() => applyBin(o, x, y));
          if (!sameRes(h, e)) { ok = false; break; }
          seen++;
        }
        if (!ok) break;
      }
      if (ok && seen > 100) hits.push(o);
    }
    if (hits.length === 1) return { kind: 'BINARY', op: hits[0], a: 0, b: 1, exact: true };
  } else if (n === 1) {
    const hits = [];
    for (const o of ['id'].concat(UNOPS)) {
      let ok = true;
      for (const x of TYPED_X) {
        const h = tryv(() => { const r = ev([x]); if (r.err) throw r.err; return r.val; });
        const e = tryv(() => applyUn(o, x));
        if (!sameRes(h, e)) { ok = false; break; }
      }
      if (ok) hits.push(o);
    }
    if (hits.includes('id')) return { kind: 'MOV', a: 0, exact: true };
    if (hits.length === 1) return { kind: 'UNARY', op: hits[0], a: 0, exact: true };
  }

  // stage 1 -- numeric fit for the MBA-obfuscated handlers.  the probe set
  // includes this site's own immediates so comparisons against them are hit.
  const extra = [];
  for (const w of words) extra.push(w | 0, w >>> 0, (w | 0) + 1, (w | 0) - 1);
  const values = PROBE_VALUES.concat(extra);
  const rnd = (i) => values[((i % values.length) + values.length) % values.length];

  // The probe set has to contain tuples whose operands are *equal* to each other
  // and to the instruction's immediates, otherwise comparison opcodes look like
  // constants (they are false almost everywhere).
  const bases = [];
  for (let k = 0; k < 26; k++) { const v = []; for (let j = 0; j < n; j++) v.push(rnd(k * 13 + j * 29)); bases.push(v); }
  for (let k = 0; k < 14; k++) bases.push(new Array(n).fill(rnd(k * 7 + 3)));
  if (n > 1) for (let k = 0; k < 14; k++) {
    const v = []; for (let j = 0; j < n; j++) v.push(rnd(k * 5 + j * 11));
    for (let j = 1; j < n; j++) if ((k + j) % 2 === 0) v[j] = v[0];
    bases.push(v);
  }

  const essential = [];
  for (let i = 0; i < n; i++) {
    let diff = false;
    for (let k = 0; k < bases.length && !diff; k++) {
      const a = bases[k];
      for (let m = 0; m < 4 && !diff; m++) {
        const b = a.slice();
        b[i] = rnd(k * 13 + i * 29 + m * 37 + 7);
        if (b[i] === a[i]) b[i] = (a[i] + 1) | 0;
        const ra = ev(a), rb = ev(b);
        if (ra.err || rb.err) { diff = true; break; }
        if (!Object.is(ra.val, rb.val)) diff = true;
      }
    }
    if (diff) essential.push(i);
  }

  const samples = [];
  for (const vals of bases) {
    const r = ev(vals);
    if (r.err) return { kind: 'ERR', err: String(r.err) };
    samples.push({ vals, out: r.val });
  }
  const base = bases[0];
  const eq = (a, b) => Object.is(a, b) || (typeof a === 'number' && typeof b === 'number' && a === b);

  if (essential.length === 0) {
    const c = samples[0].out;
    if (samples.every(s => eq(s.out, c))) return { kind: 'CONST', value: c };
    return { kind: 'UNKNOWN', essential };
  }
  if (essential.length === 1) {
    const i = essential[0];
    for (const o of UNOPS)
      if (samples.every(s => eq(s.out, applyUn(o, s.vals[i])) || eq(s.out, applyUn(o, s.vals[i]) | 0)))
        return { kind: 'UNARY', op: o, a: i };
    const consts = new Set([0, 1, 2, -1]);
    for (const w of words) { consts.add(w | 0); consts.add(w >>> 0); }
    const probe0 = base.slice(); probe0[i] = 0;
    const z = ev(probe0);
    if (typeof z.val === 'number') { consts.add(z.val | 0); consts.add((-z.val) | 0); consts.add(~z.val | 0); }
    for (const o of BINOPS) for (const k of consts) {
      if (samples.every(s => eq(s.out, applyBin(o, s.vals[i], k)) || eq(s.out, applyBin(o, s.vals[i], k) | 0)))
        return { kind: 'BINCONST', op: o, a: i, k, side: 'right' };
      if (samples.every(s => eq(s.out, applyBin(o, k, s.vals[i])) || eq(s.out, applyBin(o, k, s.vals[i]) | 0)))
        return { kind: 'BINCONST', op: o, a: i, k, side: 'left' };
    }
    return { kind: 'UNKNOWN', essential };
  }
  if (essential.length === 2) {
    const [i, j] = essential;
    for (const o of BINOPS) {
      if (samples.every(s => eq(s.out, applyBin(o, s.vals[i], s.vals[j])) || eq(s.out, applyBin(o, s.vals[i], s.vals[j]) | 0)))
        return { kind: 'BINARY', op: o, a: i, b: j };
      if (samples.every(s => eq(s.out, applyBin(o, s.vals[j], s.vals[i])) || eq(s.out, applyBin(o, s.vals[j], s.vals[i]) | 0)))
        return { kind: 'BINARY', op: o, a: j, b: i };
    }
    // three-address forms: (x <op> y) <op2> k   with a literal third operand
    const two = fitOuter(samples, (s) => [s.vals[i], s.vals[j]], eq);
    if (two) return { kind: 'BINARY2', op: two.op, a: two.swap ? j : i, b: two.swap ? i : j, op2: two.op2, k: two.k };
    return { kind: 'UNKNOWN', essential };
  }
  if (essential.length === 3) {
    const [i, j, m] = essential;
    const orders = [[i, j, m], [i, m, j], [j, m, i], [j, i, m], [m, i, j], [m, j, i]];
    for (const [x, y, z] of orders) {
      for (const o of BINOPS) for (const o2 of BINOPS) {
        if (samples.every(s => {
          const v = applyBin(o2, applyBin(o, s.vals[x], s.vals[y]), s.vals[z]);
          return eq(s.out, v) || eq(s.out, v | 0);
        })) return { kind: 'BINARY3', op: o, a: x, b: y, op2: o2, c: z };
      }
    }
    return { kind: 'UNKNOWN', essential };
  }
  return { kind: 'UNKNOWN', essential };
}

// try to match  f(x, y) == (x <op> y) <op2> k  by solving for k directly
function fitOuter(samples, pick, eq) {
  const int32 = (v) => v | 0;
  for (const swap of [false, true]) {
    for (const op of BINOPS) {
      const vs = samples.map(s => { const [x, y] = pick(s); return applyBin(op, swap ? y : x, swap ? x : y); });
      if (vs.some(v => typeof v !== 'number' || !isFinite(v))) continue;
      const outs = samples.map(s => s.out);
      if (outs.some(o => typeof o !== 'number')) continue;
      const cands = [
        { op2: '+', k: int32(outs[0] - vs[0]) },
        { op2: '-', k: int32(vs[0] - outs[0]) },
        { op2: '^', k: int32(int32(outs[0]) ^ int32(vs[0])) },
      ];
      for (const c of cands) {
        if (!isFinite(c.k)) continue;
        if (samples.every((s, n) => {
          const v = applyBin(c.op2, vs[n], c.k);
          return eq(s.out, v) || eq(s.out, int32(v));
        })) return { op, op2: c.op2, k: c.k, swap };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 3. classifying the structural opcodes
 * ------------------------------------------------------------------ */

function structuralKind(code) {
  const has = (re) => re.test(code);
  if (has(/\bdebugger\b/)) return 'DEBUGGER';
  if (has(/this\.i\[/)) return 'DECRYPT';
  if (has(/\bnew t\(|new \w+\({\s*o:/) || has(/\w+\.set\(\w+, ?\w+\)[\s\S]*prototype/)) return 'MAKEFUNC';
  if (has(/this\.t\(/)) {
    if (has(/Reflect\.construct/)) return 'NEW';
    if (has(/\.apply\(null,/)) return 'CALL';
    return 'CALLMETHOD';
  }
  if (has(/\w+\(this, ?\[\], ?\w+\)/)) return 'RETURN';
  if (has(/\bthrow\b/) && !has(/ReferenceError/)) return 'THROW';
  if (has(/\.pop\(\)/)) return 'POPTRY';
  if (has(/\.push\(\{/)) return has(/\bp:/) ? 'TRYFIN' : 'TRYCATCH';
  if (has(/Object\.getOwnPropertyNames/)) return 'FORIN_INIT';
  if (has(/\.q >= /)) return 'FORIN_NEXT';
  if (has(/Object\.defineProperty/)) return has(/get: \w+,/) ? 'DEFGET' : 'DEFSET';
  if (has(/Reflect\.set/)) return 'SETMEMBER';
  if (has(/\bdelete\b/)) return 'DELETE';
  if (has(/ReferenceError/)) return 'LOADGLOBAL';
  if (has(/hasOwnProperty/)) return 'TYPEOFGLOBAL';
  if (has(/this\.h\[\w+\(this\)\] =/)) return 'STOREGLOBAL';
  if (has(/\.l\[/)) return has(/\.v \? \w+\.u =/) ? 'STORECELL' : 'LOADCELL';
  if (has(/= \{\}[,;]/) && has(/for \(/)) return 'OBJECT';
  if (has(/Array\(\w+\)/) && has(/for \(/)) return 'ARRAY';
  if (/\[[^\]]+\+ 2\] = w?\w*\(this\)/.test(code)) return 'JMP';
  if (/\[[^\]]+\+ 2\] = \w+\[\w+\[[^\]]+\+ 1\] \+ \w+\(this\)\]/.test(code)) return 'JMPDYN';
  if (/&& \(\w+\[[^\]]+\+ 2\] = \w+\)/.test(code)) return 'JMPIF';
  if (/\|\| \(\w+\[[^\]]+\+ 2\] = \w+\)/.test(code)) return 'JMPIFNOT';
  if (/\[\w+ \+ 6\]/.test(code)) return 'LOADTHIS';
  if (/\w+\(this\)/.test(code) && /= \w+\(this\);?\s*}$/.test(code.replace(/\s+/g, ' '))) return null;
  return null;
}

const FIXED_LAYOUT = {
  LOADTHIS: ['dst'],
  LOADCONST: ['dst', 'pool', 'key'],
  LOADCELL: ['dst', 'cell'],
  STORECELL: ['cell', 'src'],
  LOADGLOBAL: ['dst', 'pool', 'key'],
  TYPEOFGLOBAL: ['dst', 'pool', 'key'],
  STOREGLOBAL: ['pool', 'key', 'src'],
  SETMEMBER: ['obj', 'key', 'val'],
  DELETE: ['dst', 'obj', 'key'],
  DEFGET: ['obj', 'key', 'fn'],
  DEFSET: ['obj', 'key', 'fn'],
  RETURN: ['src'],
  THROW: ['src'],
  JMP: ['target'],
  JMPIF: ['cond', 'target'],
  JMPIFNOT: ['cond', 'target'],
  JMPDYN: ['reg'],
  TRYCATCH: ['catchPC', 'catchReg'],
  TRYFIN: ['finPC', 'typeReg', 'valReg', 'marker'],
  POPTRY: [],
  DEBUGGER: [],
  FORIN_INIT: ['dst', 'obj'],
  FORIN_NEXT: ['dst', 'iter', 'doneTarget'],
  DECRYPT: ['dst', 'from', 'to', 'key'],
};

function buildOpTable(L) {
  const table = {};
  for (const key of Object.getOwnPropertyNames(L.A)) {
    const op = Number(key);
    if (!Number.isInteger(op)) continue;
    const fn = L.A[key];
    if (typeof fn !== 'function') continue;
    const code = String(fn);
    let kind = structuralKind(code);
    if (!kind && /\w+\(this\)/.test(code) && /= \w+\(this\)[;)]/.test(code) &&
        !/\[\w+ \+ w?\w*\(this\)\]/.test(code)) kind = null;
    if (!kind && /this\.h/.test(code)) kind = 'LOADGLOBAL';
    const layout = probeLayout(L, op);
    if (!kind) {
      // constant loads use the string decoder v(); it consumes two words
      const usesDecoder = layout.consumed === 3 && layout.reads.length === 0 && layout.writes.length === 1
        && !/w\(this\)[\s\S]*w\(this\)[\s\S]*w\(this\)/.test(code);
      if (usesDecoder) kind = 'LOADCONST';
    }
    table[op] = { op, kind: kind || 'DATA', layout, code };
  }
  return table;
}

/* ------------------------------------------------------------------ *
 * 4. decoding
 * ------------------------------------------------------------------ */

function decodeAt(T, code, pc) {
  const op = code[pc];
  const info = T[op];
  if (!info) return null;
  const kind = info.kind;
  const ins = { pc, op, kind };
  let p = pc + 1;
  const take = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(code[p++]); return a; };
  if (FIXED_LAYOUT[kind]) {
    const names = FIXED_LAYOUT[kind];
    const vals = take(names.length);
    names.forEach((nm, i) => { ins[nm] = vals[i]; });
    ins.words = vals;
  } else if (kind === 'ARRAY') {
    const [dst, count] = take(2); ins.dst = dst; ins.count = count; ins.elems = take(count);
  } else if (kind === 'OBJECT') {
    const [dst, count] = take(2); ins.dst = dst; ins.count = count;
    ins.pairs = []; for (let i = 0; i < count; i++) ins.pairs.push(take(2));
  } else if (kind === 'CALL' || kind === 'NEW') {
    const [dst, fn, argc] = take(3); ins.dst = dst; ins.fn = fn;
    if (argc === SPREAD) { ins.spread = true; ins.args = take(1); } else { ins.argc = argc; ins.args = take(argc); }
  } else if (kind === 'CALLMETHOD') {
    const [dst, thisr, fn, argc] = take(4); ins.dst = dst; ins.thisReg = thisr; ins.fn = fn;
    if (argc === SPREAD) { ins.spread = true; ins.args = take(1); } else { ins.argc = argc; ins.args = take(argc); }
  } else if (kind === 'MAKEFUNC') {
    const [dst, entry, nparams, nregs, ncells, hasRest, newC] = take(7);
    ins.dst = dst; ins.entry = entry; ins.nparams = nparams; ins.nregs = nregs;
    ins.hasRest = hasRest; ins.newC = newC; ins.cells = [];
    for (let i = 0; i < ncells; i++) { const [isNew, idx] = take(2); ins.cells.push({ isNew, idx }); }
  } else {
    ins.words = take(info.layout.consumed);
    ins.dst = ins.words[info.layout.writes[0]];
    ins.srcRegs = info.layout.reads.map(i => ins.words[i]);
  }
  ins.len = p - pc;
  ins.next = p;
  return ins;
}

function makeAnalyzer(L) {
  const T = buildOpTable(L);
  const code = Array.from(L.vm.i);
  const fitCache = new Map();
  const essCache = new Map();
  const A = {
    L, T, code,
    decode: (pc) => decodeAt(T, code, pc),
    readConst(poolIdx, key) {
      const env = makeEnv(L, { words: [poolIdx, key], C: 0 });
      return L.V(env.inst);
    },
    inputsOf(ins) {
      const info = T[ins.op];
      const seen = [];
      for (const p of info.layout.reads) if (!seen.includes(ins.words[p])) seen.push(ins.words[p]);
      return seen;
    },
    fit(ins, C) {
      const info = T[ins.op];
      const groups = new Map();
      for (const p of info.layout.reads) if (!groups.has(ins.words[p])) groups.set(ins.words[p], groups.size);
      const key = ins.op + '|' + C + '|' + ins.words.map((w, i) =>
        info.layout.reads.includes(i) ? 'R' + groups.get(w) : i === info.layout.writes[0] ? 'D' : w).join(',');
      if (fitCache.has(key)) return fitCache.get(key);
      const r = fitSite(L, ins.op, ins.words, info.layout, C);
      fitCache.set(key, r);
      return r;
    },
    // MBA handlers take "junk" register operands that provably cancel out.
    // Knowing which operands actually matter keeps constant propagation alive.
    essentialMask(ins, C) {
      const key = ins.pc;
      if (essCache.has(key)) return essCache.get(key);
      const f = A.fit(ins, C);
      const inputs = A.inputsOf(ins);
      let live;
      if (f.kind === 'CONST') live = new Set();
      else if (f.kind === 'MOV' || f.kind === 'UNARY' || f.kind === 'BINCONST') live = new Set([inputs[f.a]]);
      else if (f.kind === 'BINARY' || f.kind === 'BINARY2') live = new Set([inputs[f.a], inputs[f.b]]);
      else if (f.kind === 'BINARY3') live = new Set([inputs[f.a], inputs[f.b], inputs[f.c]]);
      else live = new Set(inputs);
      const mask = ins.srcRegs.map(r => live.has(r));
      essCache.set(key, mask);
      return mask;
    },
    execData(ins, C, regFile) {
      const env = makeEnv(L, { words: ins.words, C, regs: regFile });
      L.A[ins.op].call(env.inst);
      const wr = env.log.writes.filter(x => x.reg === ins.dst);
      return wr.length ? wr[wr.length - 1].val : undefined;
    },
    // run one of the program's own functions concretely -- only used to
    // evaluate the control-flow dispatcher
    callVMFunction(fnIns, args) {
      if (fnIns.cells.length) throw new Error('closure fn');
      const tmpl = new L.T({ o: fnIns.nparams, m: fnIns.nregs, F: fnIns.entry, C: fnIns.newC, H: !!fnIns.hasRest });
      return L.Z(new L.G(L.vm.i, L.vm.A, L.vm.h), undefined, args, tmpl);
    },
  };
  return A;
}

/* ------------------------------------------------------------------ *
 * 5. CFG recovery -- symbolic execution through the flattening dispatcher
 * ------------------------------------------------------------------ */

const CONST = (v) => ({ t: 'c', v });
const MAXNODES = 400;

function valSize(v, n = 0) {
  if (n > MAXNODES) return n;
  if (v.t === 'op') { n++; for (const a of v.args) n = valSize(a, n); return n; }
  if (v.t === 'call') { n++; n = valSize(v.fnVal, n); for (const a of v.args) n = valSize(a, n); return n; }
  return n + 1;
}

function valEq(a, b) {
  if (a === b) return true;
  if (!a || !b || a.t !== b.t) return false;
  switch (a.t) {
    case 'c': return Object.is(a.v, b.v);
    case 'u': return a.id === b.id;
    case 'func': return a.entry === b.entry;
    case 'op': return a.ins === b.ins && a.args.length === b.args.length && a.args.every((x, i) => valEq(x, b.args[i]));
    case 'call': return a.ins === b.ins && valEq(a.fnVal, b.fnVal) &&
      a.args.length === b.args.length && a.args.every((x, i) => valEq(x, b.args[i]));
    default: return false;
  }
}

// evaluate a symbolic value; `overrides` maps node objects to concrete values
function evaluate(A, val, overrides) {
  if (overrides && overrides.has(val)) return overrides.get(val);
  switch (val.t) {
    case 'c': return val.v;
    case 'u': throw new Error('unknown ' + val.id);
    case 'func': throw new Error('function value');
    case 'op': {
      const regFile = {};
      const mask = A.essentialMask(val.ins, val.C);
      val.srcs.forEach((r, i) => { if (mask[i]) regFile[r] = evaluate(A, val.args[i], overrides); });
      val.srcs.forEach((r, i) => { if (!mask[i] && !(r in regFile)) regFile[r] = 0; });
      return A.execData(val.ins, val.C, regFile);
    }
    case 'call': {
      if (val.fnVal.t !== 'func') throw new Error('not a vm function');
      return A.callVMFunction(val.fnVal.ins, val.args.map(a => evaluate(A, a, overrides)));
    }
    default: throw new Error('cannot evaluate');
  }
}

// candidate fork points, best first: boolean results computed inside this block
function forkCandidates(A, val, C, blockPCs) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (seen.has(v) || depth > 60) return;
    seen.add(v);
    if (v.t === 'op') {
      const f = A.fit(v.ins, v.C);
      const bool = (f.kind === 'UNARY' && f.op === '!') ||
        ((f.kind === 'BINARY' || f.kind === 'BINCONST') && ['<', '>', '<=', '>=', '==', '!=', '===', '!==', 'in', 'instanceof'].includes(f.op));
      out.push({ node: v, inBlock: blockPCs.has(v.ins.pc), bool, depth });
      const mask = A.essentialMask(v.ins, v.C);
      v.args.forEach((a, i) => { if (mask[i]) walk(a, depth + 1); });
    } else if (v.t === 'call') {
      v.args.forEach(a => walk(a, depth + 1));
    } else if (v.t === 'u') {
      out.push({ node: v, inBlock: false, bool: false, depth });
    }
  };
  walk(val, 0);
  out.sort((x, y) => (y.inBlock - x.inBlock) || (y.bool - x.bool) || (x.depth - y.depth));
  return out;
}

// re-evaluate a whole register state under "fork node == value"; anything that
// becomes computable turns into a constant, which is what un-flattens the CFG
function hasCall(v, seen = new Set()) {
  if (!v || seen.has(v)) return false;
  seen.add(v);
  if (v.t === 'call') return true;
  if (v.t === 'op') return v.args.some(a => hasCall(a, seen));
  return false;
}

function refineState(A, state, node, value) {
  const out = new Map();
  const ov = new Map([[node, value]]);
  for (const [r, v] of state) {
    if (v.t === 'c' || v.t === 'func') { out.set(r, v); continue; }
    if (hasCall(v) || valSize(v) > MAXNODES) { out.set(r, v); continue; }
    try { out.set(r, CONST(evaluate(A, v, ov))); }
    catch (e) { out.set(r, v); }
  }
  return out;
}

function resolveDyn(A, val, C, blockPCs, codeLen, exitState, ctrlRegs) {
  const okPC = (pc) => Number.isInteger(pc) && pc >= 0 && pc < codeLen && A.decode(pc);
  try {
    const pc = evaluate(A, val, null);
    if (okPC(pc)) return { kind: 'goto', target: pc };
  } catch (e) { /* needs a fork */ }
  const cands = forkCandidates(A, val, C, blockPCs);
  let best = null;
  for (const c of cands) {
    for (const pair of [[false, true], [0, 1]]) {
      let ok = true; const res = [];
      for (const cv of pair) {
        let pc;
        try { pc = evaluate(A, val, new Map([[c.node, cv]])); } catch (e) { ok = false; break; }
        if (!okPC(pc)) { ok = false; break; }
        res.push(pc);
      }
      if (!ok) continue;
      // prefer the fork that pins the flattening state down on both edges: that
      // is the one that corresponds to a real `if` in the original program
      let concrete = 0, differs = res[0] !== res[1];
      if (exitState && ctrlRegs && ctrlRegs.length) {
        const sf = refineState(A, exitState, c.node, pair[0]);
        const st = refineState(A, exitState, c.node, pair[1]);
        for (const r of ctrlRegs) {
          const a = sf.get(r), b = st.get(r);
          if (a && a.t === 'c' && b && b.t === 'c') concrete++;
          if (a && b && !valEq(a, b)) differs = true;
        }
      }
      const cand = { kind: 'branch', node: c.node, falseTarget: res[0], trueTarget: res[1],
        falseValue: pair[0], trueValue: pair[1],
        score: concrete * 10 + (differs ? 1 : 0), differs, inBlock: c.inBlock, depth: c.depth };
      if (!best || cand.score > best.score) best = cand;
      break;
    }
  }
  if (!best) return { kind: 'unresolved' };
  if (!best.differs) return { kind: 'goto', target: best.falseTarget };
  return best;
}

function volatileRegs(A, entry) {
  const set = new Set();
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    let pc = stack.pop();
    for (;;) {
      if (seen.has(pc) || pc >= A.code.length) break;
      seen.add(pc);
      const ins = A.decode(pc);
      if (!ins) break;
      if (ins.kind === 'MAKEFUNC') for (const c of ins.cells) if (c.isNew) set.add(c.idx);
      if (ins.kind === 'JMP') { pc = ins.target; continue; }
      if (ins.kind === 'JMPIF' || ins.kind === 'JMPIFNOT') stack.push(ins.target);
      if (ins.kind === 'TRYCATCH') stack.push(ins.catchPC);
      if (ins.kind === 'TRYFIN') stack.push(ins.finPC);
      if (ins.kind === 'FORIN_NEXT') stack.push(ins.doneTarget);
      if (['RETURN', 'THROW', 'JMPDYN'].includes(ins.kind)) break;
      pc = ins.next;
    }
  }
  return set;
}

// Path-sensitivity: a flattened program keeps its "current block" in one or two
// state registers.  Cloning blocks per distinct state value un-flattens them,
// because the dispatcher comparison then folds to a constant.
// canonical identity for a symbolic value, so that two paths reaching a block
// with the *same* pending expression share one clone
function valHash(v, depth) {
  if (!v || depth > 12) return '~';
  switch (v.t) {
    case 'c': return typeof v.v === 'object' && v.v !== null ? '#obj' : JSON.stringify(v.v);
    case 'u': return 'u:' + v.id;
    case 'func': return 'f:' + v.entry;
    case 'op': return 'o' + v.ins.pc + '(' + v.args.map(a => valHash(a, depth + 1)).join(',') + ')';
    case 'call': return 'c' + v.ins.pc + '(' + valHash(v.fnVal, depth + 1) + ';' +
      v.args.map(a => valHash(a, depth + 1)).join(',') + ')';
    default: return '?';
  }
}

function stateKey(pc, state, ctrlRegs) {
  if (!ctrlRegs || !ctrlRegs.length) return String(pc);
  const parts = [];
  for (const r of ctrlRegs) {
    const v = state.get(r);
    parts.push(v ? valHash(v, 0) : '?');
  }
  return pc + '|' + parts.join(',');
}

function exploreFunction(A, func, ctrlRegs, maxClones) {
  ctrlRegs = ctrlRegs || [];
  maxClones = maxClones || 400;
  const vol = volatileRegs(A, func.entry);
  const blocks = new Map();
  const entryStates = new Map();
  const children = new Map();
  const dispatchers = new Set();
  const clones = new Map();          // pc -> number of instances

  const init = new Map();
  for (let r = 0; r < func.nregs; r++) {
    if (r <= func.nparams) continue;              // params + `arguments`
    if (vol.has(r)) continue;
    init.set(r, CONST(undefined));
  }
  const keyOf = (pc, state) => {
    let k = stateKey(pc, state, ctrlRegs);
    if (!blocks.has(k) && !entryStates.has(k)) {
      const n = (clones.get(pc) || 0);
      if (n >= maxClones) k = String(pc) + '|*';  // give up on precision here
      else clones.set(pc, n + 1);
    }
    return k;
  };
  const rootKey = keyOf(func.entry, init);
  entryStates.set(rootKey, init);
  const pcOfKey = new Map([[rootKey, func.entry]]);
  const work = [rootKey];
  const queued = new Set([rootKey]);
  const push = (k) => { if (!queued.has(k)) { queued.add(k); work.push(k); } };
  const merge = (key, state) => {
    const cur = entryStates.get(key);
    if (!cur) { entryStates.set(key, new Map(state)); return true; }
    let changed = false;
    for (const [r, v] of cur) if (!valEq(state.get(r), v)) { cur.delete(r); changed = true; }
    return changed;
  };

  let rounds = 0;
  while (work.length) {
    if (++rounds > 200000) throw new Error('CFG exploration did not converge');
    const key = work.shift();
    queued.delete(key);
    const start = pcOfKey.get(key);
    const entry = entryStates.get(key) || new Map();
    const regs = new Map(entry);
    const stmts = [];
    const blockPCs = new Set();
    const block = { pc: start, key, stmts, term: null, succs: [] };
    blocks.set(key, block);
    const get = (r) => (!vol.has(r) && regs.has(r)) ? regs.get(r)
      : { t: 'u', id: 'live#' + r + '@' + start, reg: r, live: true };
    const set = (r, v) => { regs.set(r, valSize(v) > MAXNODES ? { t: 'u', id: 'big@' + r + '#' + start } : v); };
    let pc = start, stop = false;

    for (;;) {
      if (blockPCs.has(pc)) { block.term = { kind: 'goto', target: pc }; break; }
      blockPCs.add(pc);
      const ins = A.decode(pc);
      if (!ins) { block.term = { kind: 'bad', pc }; break; }
      const K = func.C;
      switch (ins.kind) {
        case 'DATA': {
          const srcs = ins.srcRegs, args = srcs.map(get);
          const mask = A.essentialMask(ins, K);
          let val;
          if (args.every((a, i) => !mask[i] || a.t === 'c')) {
            const regFile = {};
            srcs.forEach((r, i) => { if (mask[i]) regFile[r] = args[i].v; });
            srcs.forEach((r, i) => { if (!mask[i] && !(r in regFile)) regFile[r] = 0; });
            let v, bad = false;
            try { v = A.execData(ins, K, regFile); } catch (e) { bad = true; }
            val = bad ? { t: 'u', id: 'err@' + pc, ins } : CONST(v);
          } else val = { t: 'op', ins, C: K, srcs, args };
          set(ins.dst, val); stmts.push(ins); break;
        }
        case 'LOADCONST': set(ins.dst, CONST(A.readConst(ins.pool, ins.key))); stmts.push(ins); break;
        case 'LOADTHIS': case 'LOADGLOBAL': case 'TYPEOFGLOBAL': case 'LOADCELL':
        case 'ARRAY': case 'OBJECT': case 'FORIN_INIT': case 'DELETE':
          set(ins.dst, { t: 'u', id: 'u@' + pc, ins }); stmts.push(ins); break;
        case 'FORIN_NEXT':
          set(ins.dst, { t: 'u', id: 'u@' + pc, ins });
          stmts.push(ins);
          block.term = { kind: 'forin', ins, trueTarget: ins.next, falseTarget: ins.doneTarget };
          stop = true; break;
        case 'MAKEFUNC':
          set(ins.dst, { t: 'func', entry: ins.entry, ins });
          children.set(ins.entry, ins); stmts.push(ins); break;
        case 'CALL': case 'CALLMETHOD': case 'NEW':
          set(ins.dst, { t: 'call', fnVal: get(ins.fn), args: (ins.args || []).map(get), ins });
          stmts.push(ins); break;
        case 'STOREGLOBAL': case 'SETMEMBER': case 'STORECELL': case 'DEFGET': case 'DEFSET':
        case 'POPTRY': case 'DEBUGGER': case 'DECRYPT':
          stmts.push(ins); break;
        case 'TRYCATCH': stmts.push(ins); block.tryTargets = (block.tryTargets || []).concat(ins.catchPC); break;
        case 'TRYFIN': stmts.push(ins); block.tryTargets = (block.tryTargets || []).concat(ins.finPC); break;
        case 'RETURN': block.term = { kind: 'return', reg: ins.src }; stop = true; break;
        case 'THROW': block.term = { kind: 'throw', reg: ins.src }; stop = true; break;
        case 'JMP': pc = ins.target; continue;
        case 'JMPIF': case 'JMPIFNOT':
          block.term = { kind: 'branch', condReg: ins.cond,
            trueTarget: ins.kind === 'JMPIF' ? ins.target : ins.next,
            falseTarget: ins.kind === 'JMPIF' ? ins.next : ins.target };
          stop = true; break;
        case 'JMPDYN': {
          const val = get(ins.reg);
          block.dynLive = [...liveRegsIn(A, val)];
          block.slicePCs = new Set();
          (function slice(v, seen) {
            if (!v || seen.has(v)) return; seen.add(v);
            if (v.t === 'op') { block.slicePCs.add(v.ins.pc); v.args.forEach(a => slice(a, seen)); }
            else if (v.t === 'call') {
              block.slicePCs.add(v.ins.pc);
              if (v.fnVal.t === 'func') dispatchers.add(v.fnVal.entry);
              slice(v.fnVal, seen); v.args.forEach(a => slice(a, seen));
            } else if (v.t === 'u' && v.ins) block.slicePCs.add(v.ins.pc);
          })(val, new Set());
          const exitPreview = new Map();
          for (const [rr, vv] of regs) if (!vol.has(rr)) exitPreview.set(rr, vv);
          const r = resolveDyn(A, val, K, blockPCs, A.code.length, exitPreview, ctrlRegs);
          if (r.kind === 'branch') {
            const src = r.node.t === 'op' ? r.node.ins : (r.node.ins || null);
            block.term = { kind: 'branch', condIns: src, condNode: r.node,
              condTrue: r.trueValue, condFalse: r.falseValue,
              trueTarget: r.trueTarget, falseTarget: r.falseTarget };
          } else if (r.kind === 'goto') {
            block.term = { kind: 'goto', target: r.target };
          } else {
            block.term = { kind: 'unresolved', val };
          }
          stop = true; break;
        }
        default: stmts.push(ins); break;
      }
      if (stop) break;
      pc = ins.next;
    }

    const term = block.term || { kind: 'bad' };
    const exit = new Map();
    for (const [r, v] of regs) if (!vol.has(r)) exit.set(r, v);
    // each outgoing edge carries a state refined by what the branch decided
    const edges = [];
    if (term.kind === 'goto') edges.push({ pc: term.target, state: exit, slot: 'targetKey' });
    else if (term.kind === 'forin') {
      edges.push({ pc: term.trueTarget, state: exit, slot: 'trueKey' });
      edges.push({ pc: term.falseTarget, state: exit, slot: 'falseKey' });
    } else if (term.kind === 'branch') {
      if (term.condNode) {
        edges.push({ pc: term.trueTarget, state: refineState(A, exit, term.condNode, term.condTrue), slot: 'trueKey' });
        edges.push({ pc: term.falseTarget, state: refineState(A, exit, term.condNode, term.condFalse), slot: 'falseKey' });
      } else {
        edges.push({ pc: term.trueTarget, state: exit, slot: 'trueKey' });
        edges.push({ pc: term.falseTarget, state: exit, slot: 'falseKey' });
      }
    }
    block.succs = [];
    for (const e of edges) {
      const sk = keyOf(e.pc, e.state);
      pcOfKey.set(sk, e.pc);
      term[e.slot] = sk;
      block.succs.push(sk);
      if (merge(sk, e.state) || !blocks.has(sk)) push(sk);
    }
    for (const s of (block.tryTargets || [])) {
      const empty = new Map();
      const sk = keyOf(s, empty);
      pcOfKey.set(sk, s);
      block.tryKeys = block.tryKeys || {};
      block.tryKeys[s] = sk;
      if (merge(sk, empty) || !blocks.has(sk)) push(sk);
    }
    block.exit = exit;
  }
  return { blocks, children: [...children.values()], vol, rootKey, dispatchers };
}

function liveRegsIn(A, val, out = new Set(), seen = new Set()) {
  if (!val || seen.has(val)) return out;
  seen.add(val);
  if (val.t === 'u' && val.live) out.add(val.reg);
  else if (val.t === 'op') {
    const mask = A.essentialMask(val.ins, val.C);
    val.args.forEach((a, i) => { if (mask[i]) liveRegsIn(A, a, out, seen); });
  } else if (val.t === 'call') {
    liveRegsIn(A, val.fnVal, out, seen); val.args.forEach(a => liveRegsIn(A, a, out, seen));
  }
  return out;
}

function exploreOne(A, func) {
  // pass 1: no path sensitivity -- find which registers the flattening keys on
  const first = exploreFunction(A, func, []);
  const ctrl = new Set();
  for (const b of first.blocks.values()) if (b.dynLive) for (const r of b.dynLive) ctrl.add(r);
  if (!ctrl.size) return first;
  // pass 2: clone blocks per distinct value of those registers -> un-flattened
  const ctrlRegs = [...ctrl].sort((a, b) => a - b);
  try {
    const second = exploreFunction(A, func, ctrlRegs);
    let bad = 0;
    for (const b of second.blocks.values()) if (b.term && b.term.kind === 'unresolved') bad++;
    let bad1 = 0;
    for (const b of first.blocks.values()) if (b.term && b.term.kind === 'unresolved') bad1++;
    if (bad <= bad1) { second.ctrlRegs = ctrlRegs; return second; }
  } catch (e) { /* fall back to the imprecise CFG */ }
  return first;
}

function exploreAll(A) {
  const x = A.L.tmpl.x;
  const root = { entry: x.F, nparams: x.o, nregs: x.m, C: x.C, cells: [], hasRest: !!x.H, isRoot: true };
  const out = new Map();
  const queue = [root];
  while (queue.length) {
    const f = queue.shift();
    if (out.has(f.entry)) continue;
    const r = exploreOne(A, f);
    out.set(f.entry, Object.assign({ func: f }, r));
    for (const c of r.children)
      queue.push({ entry: c.entry, nparams: c.nparams, nregs: c.nregs, C: c.newC,
        cells: c.cells, hasRest: !!c.hasRest, ins: c });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. lifting: blocks of opcodes -> IR statements over register variables
 * ------------------------------------------------------------------ */

const E = {
  reg: (r) => ({ e: 'reg', r }),
  lit: (v) => ({ e: 'lit', v }),
  self: () => ({ e: 'this' }),
  global: (name) => ({ e: 'global', name }),
  cell: (idx) => ({ e: 'cell', idx }),
  bin: (op, a, b) => ({ e: 'bin', op, a, b }),
  un: (op, a) => ({ e: 'un', op, a }),
  member: (obj, prop) => ({ e: 'member', obj, prop }),
};

function exprUses(x, out = new Set()) {
  if (!x || typeof x !== 'object') return out;
  if (x.e === 'reg') { out.add(x.r); return out; }
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (Array.isArray(v)) v.forEach(y => exprUses(y, out));
    else if (v && typeof v === 'object' && v.e) exprUses(v, out);
    else if (Array.isArray(v)) v.forEach(y => exprUses(y, out));
  }
  if (x.e === 'object') for (const p of x.props) { exprUses(p.key, out); exprUses(p.value, out); }
  return out;
}

function exprPure(x) {
  if (!x || typeof x !== 'object') return true;
  switch (x.e) {
    case 'reg': case 'lit': case 'this': case 'cell': case 'func': return true;
    case 'global': return true;                      // a bare global read
    case 'bin': return exprPure(x.a) && exprPure(x.b);
    case 'un': return exprPure(x.a);
    case 'member': return exprPure(x.obj) && exprPure(x.prop);
    case 'array': return x.elems.every(exprPure);
    case 'object': return x.props.every(p => exprPure(p.key) && exprPure(p.value));
    case 'forinkeys': case 'forinnext': case 'forinmore': return true;
    default: return false;                           // calls, new, delete, ...
  }
}

function liftFunction(A, all, entry, ctx) {
  const rec = all.get(entry);
  const func = rec.func;
  const C = func.C;
  const fnId = ctx.idOf(entry);
  const cellResolve = ctx.cellResolve || (() => ({ e: 'lit', v: undefined }));

  const stmt = (o) => {
    o.uses = new Set();
    if (o.expr) exprUses(o.expr, o.uses);
    if (o.value) exprUses(o.value, o.uses);
    if (o.target && o.target.obj) { exprUses(o.target.obj, o.uses); exprUses(o.target.prop, o.uses); }
    if (o.target && o.target.ref) exprUses(o.target.ref, o.uses);
    if (o.obj) exprUses(o.obj, o.uses);
    if (o.prop) exprUses(o.prop, o.uses);
    if (o.fn) exprUses(o.fn, o.uses);
    return o;
  };

  const R = (r) => ({ e: 'reg', r, fn: fnId });

  function liftIns(ins) {
    switch (ins.kind) {
      case 'DATA': {
        const f = A.fit(ins, C);
        const inputs = A.inputsOf(ins);
        const S = (i) => R(inputs[i]);
        let expr;
        if (f.kind === 'MOV') expr = S(f.a);
        else if (f.kind === 'CONST') expr = E.lit(f.value);
        else if (f.kind === 'UNARY') expr = E.un(f.op, S(f.a));
        else if (f.kind === 'BINCONST') expr = f.side === 'right'
          ? E.bin(f.op, S(f.a), E.lit(f.k)) : E.bin(f.op, E.lit(f.k), S(f.a));
        else if (f.kind === 'BINARY') expr = f.op === '[]'
          ? E.member(S(f.a), S(f.b)) : E.bin(f.op, S(f.a), S(f.b));
        else if (f.kind === 'BINARY2') expr = E.bin(f.op2, E.bin(f.op, S(f.a), S(f.b)), E.lit(f.k));
        else if (f.kind === 'BINARY3') expr = E.bin(f.op2, E.bin(f.op, S(f.a), S(f.b)), S(f.c));
        else expr = { e: 'unknown', ins, args: inputs.map(r => R(r)) };
        return stmt({ op: 'assign', dst: ins.dst, expr, ins });
      }
      case 'LOADCONST': return stmt({ op: 'assign', dst: ins.dst, expr: E.lit(A.readConst(ins.pool, ins.key)), ins });
      case 'LOADTHIS': return stmt({ op: 'assign', dst: ins.dst,
        expr: ctx.isRoot ? E.lit(ctx.rootThis) : E.self(), ins });
      case 'LOADGLOBAL': return stmt({ op: 'assign', dst: ins.dst, expr: E.global(A.readConst(ins.pool, ins.key)), ins });
      case 'TYPEOFGLOBAL': return stmt({ op: 'assign', dst: ins.dst, expr: E.un('typeof', E.global(A.readConst(ins.pool, ins.key))), ins });
      case 'STOREGLOBAL': return stmt({ op: 'store', target: { kind: 'global', name: A.readConst(ins.pool, ins.key) }, value: R(ins.src), ins });
      case 'LOADCELL': return stmt({ op: 'assign', dst: ins.dst, expr: cellResolve(ins.cell), ins });
      case 'STORECELL': return stmt({ op: 'store', target: { kind: 'cellRef', ref: cellResolve(ins.cell) }, value: R(ins.src), ins });
      case 'SETMEMBER': return stmt({ op: 'store', target: { kind: 'member', obj: R(ins.obj), prop: R(ins.key) }, value: R(ins.val), ins });
      case 'DELETE': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'delete', obj: R(ins.obj), prop: R(ins.key) }, ins });
      case 'ARRAY': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'array', elems: ins.elems.map(R) }, ins });
      case 'OBJECT': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'object', props: ins.pairs.map(([k, v]) => ({ key: R(k), value: R(v) })) }, ins });
      case 'CALL': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'call', callee: R(ins.fn), args: ins.args.map(R), spread: !!ins.spread }, ins });
      case 'CALLMETHOD': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'method', thisArg: R(ins.thisReg), fn: R(ins.fn), args: ins.args.map(R), spread: !!ins.spread }, ins });
      case 'NEW': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'new', callee: R(ins.fn), args: ins.args.map(R), spread: !!ins.spread }, ins });
      case 'FORIN_INIT': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'forinkeys', obj: R(ins.obj) }, ins });
      case 'FORIN_NEXT': return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'forinnext', iter: R(ins.iter) }, ins });
      case 'DEFGET': return stmt({ op: 'defineAccessor', accessor: 'get', obj: R(ins.obj), prop: R(ins.key), fn: R(ins.fn), ins });
      case 'DEFSET': return stmt({ op: 'defineAccessor', accessor: 'set', obj: R(ins.obj), prop: R(ins.key), fn: R(ins.fn), ins });
      case 'MAKEFUNC': {
        const child = liftFunction(A, all, ins.entry, {
          idOf: ctx.idOf,
          dispatchers: ctx.dispatchers,
          cellResolve: (i) => {
            const c = ins.cells[i];
            if (!c) return E.lit(undefined);
            return c.isNew ? R(c.idx) : cellResolve(c.idx);
          },
        });
        return stmt({ op: 'assign', dst: ins.dst, expr: { e: 'func', fn: child }, ins });
      }
      case 'POPTRY': return stmt({ op: 'poptry', ins });
      case 'DEBUGGER': case 'DECRYPT': case 'TRYFIN':
        return stmt({ op: 'nop', ins });
      default:
        return stmt({ op: 'nop', ins });
    }
  }

  // a dyn branch's condition is computed some instructions earlier and its
  // register may be reused before the jump, so snapshot it into a temp
  const condTemp = new Map();
  for (const b of rec.blocks.values()) {
    const term = b.term;
    if (term && term.kind === 'branch' && term.condIns)
      condTemp.set(term.condIns.pc, 1000000 + term.condIns.pc);
  }

  const ctrl = new Set(rec.ctrlRegs || []);
  const catchRegs = new Set();
  const blocks = new Map();
  for (const [key, b] of rec.blocks) {
    const stmts = [];
    const slice = b.slicePCs || new Set();
    for (const ins of b.stmts) {
      let s;
      if (ins.kind === 'TRYCATCH') {
        s = stmt({ op: 'trycatch', ins, catchReg: ins.catchReg,
          catchKey: (b.tryKeys || {})[ins.catchPC] });
        catchRegs.add(ins.catchReg);
      } else s = liftIns(ins);
      // statements that only exist to feed the flattening dispatcher are pure
      if (slice.has(ins.pc) || (s.op === 'assign' && ctrl.has(s.dst))) s.flattening = true;
      stmts.push(s);
      if (condTemp.has(ins.pc) && ins.dst !== undefined)
        stmts.push(stmt({ op: 'assign', dst: condTemp.get(ins.pc), expr: R(ins.dst), temp: true }));
    }
    const term = b.term || { kind: 'bad' };
    let t;
    if (term.kind === 'return') t = { kind: 'return', value: R(term.reg) };
    else if (term.kind === 'throw') t = { kind: 'throw', value: R(term.reg) };
    else if (term.kind === 'goto') t = { kind: 'goto', target: term.targetKey };
    else if (term.kind === 'forin') {
      t = { kind: 'branch', cond: { e: 'forinmore', a: R(term.ins.dst) },
        trueTarget: term.trueKey, falseTarget: term.falseKey };
    }
    else if (term.kind === 'branch') {
      let cond;
      if (term.condIns) cond = R(condTemp.get(term.condIns.pc));
      else if (term.condReg !== undefined) cond = R(term.condReg);
      else cond = E.lit(true);
      t = { kind: 'branch', cond, trueTarget: term.trueKey, falseTarget: term.falseKey };
    } else t = { kind: 'stop' };
    const tu = new Set();
    if (t.value) exprUses(t.value, tu);
    if (t.cond) exprUses(t.cond, tu);
    t.uses = tu;
    blocks.set(key, { key, pc: b.pc, stmts, term: t });
  }

  return {
    entry, fnId, func, blocks, rootKey: rec.rootKey, catchRegs,
    nparams: func.nparams, hasRest: !!func.hasRest, nregs: func.nregs,
  };
}

/* ------------------------------------------------------------------ *
 * 7. CFG cleanup: reachability, dead code, block merging
 * ------------------------------------------------------------------ */

function succsOf(b) {
  const t = b.term;
  if (t.kind === 'goto' || t.kind === 'endtry') return [t.target];
  if (t.kind === 'branch') return [t.trueTarget, t.falseTarget];
  if (t.kind === 'try') return [t.bodyTarget, t.catchTarget];
  return [];
}

// Turn the try-handler push/pop markers into real block boundaries:
//   ... TRYCATCH ...   ->  block ends with {kind:'try', body, catch}
//   ... POPTRY ...     ->  block ends with {kind:'endtry', target}
function splitTryBlocks(fn) {
  let seq = 0;
  let again = true;
  while (again) {
    again = false;
    for (const [key, b] of [...fn.blocks]) {
      const iTry = b.stmts.findIndex(s => s.op === 'trycatch');
      const iPop = b.stmts.findIndex(s => s.op === 'poptry');
      const i = (iTry >= 0 && (iPop < 0 || iTry < iPop)) ? iTry : iPop;
      if (i < 0) continue;
      const marker = b.stmts[i];
      const tailKey = key + '#t' + (seq++);
      const tail = { key: tailKey, pc: b.pc, stmts: b.stmts.slice(i + 1), term: b.term };
      fn.blocks.set(tailKey, tail);
      b.stmts = b.stmts.slice(0, i);
      b.term = marker.op === 'trycatch'
        ? { kind: 'try', bodyTarget: tailKey, catchTarget: marker.catchKey,
            catchReg: marker.catchReg, uses: new Set() }
        : { kind: 'endtry', target: tailKey, uses: new Set() };
      again = true;
    }
  }
}

function pruneUnreachable(fn) {
  const seen = new Set();
  const stack = [fn.rootKey];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k) || !fn.blocks.has(k)) continue;
    seen.add(k);
    for (const s of succsOf(fn.blocks.get(k))) stack.push(s);
  }
  for (const k of [...fn.blocks.keys()]) if (!seen.has(k)) fn.blocks.delete(k);
}

function stmtPure(s) {
  if (s.op === 'nop') return true;
  if (s.op === 'assign') {
    if (s.flattening) return true;      // dispatcher bookkeeping only
    return exprPure(s.expr);
  }
  return false;
}

function deadCodeElim(fn, volatileRegs) {
  const liveIn = new Map();
  for (const k of fn.blocks.keys()) liveIn.set(k, new Set());
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    for (const [k, b] of fn.blocks) {
      const live = new Set();
      for (const s of succsOf(b)) for (const r of (liveIn.get(s) || [])) live.add(r);
      for (const r of b.term.uses || []) live.add(r);
      for (let i = b.stmts.length - 1; i >= 0; i--) {
        const s = b.stmts[i];
        if (s.op === 'assign' && !volatileRegs.has(s.dst)) live.delete(s.dst);
        for (const r of s.uses) live.add(r);
      }
      const cur = liveIn.get(k);
      if (live.size !== cur.size || [...live].some(r => !cur.has(r))) { liveIn.set(k, live); changed = true; }
    }
  }
  for (const [k, b] of fn.blocks) {
    const live = new Set();
    for (const s of succsOf(b)) for (const r of (liveIn.get(s) || [])) live.add(r);
    for (const r of b.term.uses || []) live.add(r);
    const keep = [];
    for (let i = b.stmts.length - 1; i >= 0; i--) {
      const s = b.stmts[i];
      const dead = s.op === 'nop' ||
        (s.op === 'assign' && !live.has(s.dst) && !volatileRegs.has(s.dst) && stmtPure(s));
      if (dead) continue;
      if (s.op === 'assign' && !live.has(s.dst) && !volatileRegs.has(s.dst)) {
        keep.push({ op: 'effect', expr: s.expr, uses: s.uses, ins: s.ins });
        for (const r of s.uses) live.add(r);
        continue;
      }
      keep.push(s);
      if (s.op === 'assign' && !volatileRegs.has(s.dst)) live.delete(s.dst);
      for (const r of s.uses) live.add(r);
    }
    keep.reverse();
    b.stmts = keep;
  }
  fn.liveIn = liveIn;
}

// The flattening bookkeeping is self-referential (state = state + delta), so
// plain liveness can never kill it.  Registers that no *real* statement reads
// are pure dispatcher state and can be deleted outright.
function removeFlatteningChains(fn, vol) {
  const real = new Set();
  for (const b of fn.blocks.values()) {
    for (const s of b.stmts) if (!s.flattening) for (const r of s.uses) real.add(r);
    for (const r of b.term.uses || []) real.add(r);
  }
  for (const b of fn.blocks.values())
    b.stmts = b.stmts.filter(s => !(s.flattening && s.op === 'assign' && !real.has(s.dst) && !vol.has(s.dst)));
}

function predecessors(fn) {
  const pred = new Map();
  for (const k of fn.blocks.keys()) pred.set(k, []);
  for (const [k, b] of fn.blocks) for (const s of succsOf(b)) if (pred.has(s)) pred.get(s).push(k);
  return pred;
}

function mergeBlocks(fn) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    // 1. forward empty goto-only blocks
    const redirect = new Map();
    for (const [k, b] of fn.blocks)
      if (b.stmts.length === 0 && b.term.kind === 'goto' && b.term.target !== k) redirect.set(k, b.term.target);
    if (redirect.size) {
      const resolve = (k) => { const seen = new Set(); while (redirect.has(k) && !seen.has(k)) { seen.add(k); k = redirect.get(k); } return k; };
      for (const b of fn.blocks.values()) {
        if (b.term.kind === 'goto' || b.term.kind === 'endtry') b.term.target = resolve(b.term.target);
        else if (b.term.kind === 'branch') { b.term.trueTarget = resolve(b.term.trueTarget); b.term.falseTarget = resolve(b.term.falseTarget); }
        else if (b.term.kind === 'try') { b.term.bodyTarget = resolve(b.term.bodyTarget); b.term.catchTarget = resolve(b.term.catchTarget); }
      }
      const newRoot = resolve(fn.rootKey);
      if (newRoot !== fn.rootKey) { fn.rootKey = newRoot; }
      pruneUnreachable(fn);
      changed = true;
    }
    // 2. splice single-successor / single-predecessor pairs
    const pred = predecessors(fn);
    for (const [k, b] of fn.blocks) {
      if (b.term.kind !== 'goto') continue;
      const s = b.term.target;
      if (s === k || !fn.blocks.has(s)) continue;
      if ((pred.get(s) || []).length !== 1) continue;
      if (s === fn.rootKey) continue;
      const sb = fn.blocks.get(s);
      b.stmts = b.stmts.concat(sb.stmts);
      b.term = sb.term;
      fn.blocks.delete(s);
      changed = true;
      break;
    }
  }
  pruneUnreachable(fn);
}

/* ------------------------------------------------------------------ *
 * 8. structuring: CFG -> if/else/while
 * ------------------------------------------------------------------ */

function reversePostOrder(fn) {
  const order = [];
  const seen = new Set();
  const visit = (k) => {
    if (seen.has(k) || !fn.blocks.has(k)) return;
    seen.add(k);
    for (const s of succsOf(fn.blocks.get(k))) visit(s);
    order.push(k);
  };
  visit(fn.rootKey);
  order.reverse();
  return order;
}

function dominators(fn) {
  const rpo = reversePostOrder(fn);
  const idx = new Map(rpo.map((k, i) => [k, i]));
  const pred = predecessors(fn);
  const idom = new Map();
  idom.set(fn.rootKey, fn.rootKey);
  const intersect = (a, b) => {
    while (a !== b) {
      while (idx.get(a) > idx.get(b)) a = idom.get(a);
      while (idx.get(b) > idx.get(a)) b = idom.get(b);
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of rpo) {
      if (k === fn.rootKey) continue;
      let newIdom = null;
      for (const p of pred.get(k) || []) {
        if (!idx.has(p) || !idom.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(p, newIdom);
      }
      if (newIdom !== null && idom.get(k) !== newIdom) { idom.set(k, newIdom); changed = true; }
    }
  }
  const dominates = (a, b) => { let x = b; for (;;) { if (x === a) return true; const n = idom.get(x); if (n === undefined || n === x) return false; x = n; } };
  return { idom, rpo, idx, dominates, pred };
}

function findLoops(fn, dom) {
  const loops = new Map();     // header -> Set(body)
  for (const [k, b] of fn.blocks) {
    for (const s of succsOf(b)) {
      if (!fn.blocks.has(s)) continue;
      if (dom.dominates(s, k)) {
        if (!loops.has(s)) loops.set(s, new Set([s]));
        const body = loops.get(s);
        const stack = [k];
        while (stack.length) {
          const n = stack.pop();
          if (body.has(n)) continue;
          body.add(n);
          for (const p of dom.pred.get(n) || []) stack.push(p);
        }
      }
    }
  }
  return loops;
}

function structureFunction(fn) {
  pruneUnreachable(fn);
  const dom = dominators(fn);
  const loops = findLoops(fn, dom);
  const postIdx = new Map(dom.rpo.map((k, i) => [k, i]));
  let labelSeq = 0;

  // immediate post-dominator, computed on demand over the reachable subgraph
  const ipdomCache = new Map();
  function ipdom(node) {
    if (ipdomCache.has(node)) return ipdomCache.get(node);
    // walk both branches breadth-first, first node reached by every path wins
    const b = fn.blocks.get(node);
    const paths = succsOf(b).map(s => reachSet(s));
    let best = null, bestIdx = Infinity;
    if (paths.length === 2) {
      for (const cand of paths[0]) {
        if (!paths[1].has(cand)) continue;
        const i = postIdx.has(cand) ? postIdx.get(cand) : Infinity;
        if (i < bestIdx) { bestIdx = i; best = cand; }
      }
    }
    ipdomCache.set(node, best);
    return best;
  }
  const reachCache = new Map();
  function reachSet(start) {
    if (reachCache.has(start)) return reachCache.get(start);
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k) || !fn.blocks.has(k)) continue;
      seen.add(k);
      for (const s of succsOf(fn.blocks.get(k))) stack.push(s);
    }
    reachCache.set(start, seen);
    return seen;
  }

  const emitted = new Set();

  function jumpTo(node, frames) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (f.kind === 'loop' && f.header === node) {
        const inner = frames.slice(i).every(g => g.kind !== 'loop' || g === f);
        if (!inner) f.needsLabel = true;
        return [t.continueStatement(inner ? null : t.identifier(f.label))];
      }
      if (f.kind === 'loop' && f.exit === node) {
        const innermost = frames.slice(i + 1).every(g => g.kind !== 'loop');
        if (!innermost) f.needsLabel = true;
        return [t.breakStatement(innermost ? null : t.identifier(f.label))];
      }
      if (f.kind === 'join' && f.node === node) {
        if (i === frames.length - 1 && !f.isTry) return [];   // simple fall-through
        f.needsLabel = true;
        return [t.breakStatement(t.identifier(f.label))];
      }
    }
    return null;    // caller decides: inline (duplicate) the target
  }

  function emitFrom(node, frames, depth, skipFirst, path) {
    const out = [];
    let cur = node;
    let first = !!skipFirst;
    path = new Set(path || []);
    while (cur) {
      const entering = first;      // re-entering a loop header on purpose
      first = false;
      if (!entering) {
        const jump = jumpTo(cur, frames);
        if (jump) { out.push(...jump); break; }
        // every back edge should have been caught as a loop; if one was not,
        // the graph is irreducible and we would emit an infinite unrolling
        if (path.has(cur)) throw new Error('unstructured control flow at block ' + cur);
      }
      path.add(cur);
      const b = fn.blocks.get(cur);
      if (!b) break;

      if (loops.has(cur) && !frames.some(f => f.kind === 'loop' && f.header === cur)) {
        const body = loops.get(cur);
        const exits = new Set();
        for (const n of body) for (const s of succsOf(fn.blocks.get(n))) if (!body.has(s) && fn.blocks.has(s)) exits.add(s);
        let exit = null, ei = Infinity;
        for (const e of exits) { const i = postIdx.has(e) ? postIdx.get(e) : Infinity; if (i < ei) { ei = i; exit = e; } }
        const frame = { kind: 'loop', header: cur, exit, label: 'L' + (labelSeq++) };
        const inner = emitFrom(cur, frames.concat([frame]), depth + 1, true, path);
        let loopStmt = t.whileStatement(t.booleanLiteral(true), t.blockStatement(inner));
        if (frame.needsLabel) loopStmt = t.labeledStatement(t.identifier(frame.label), loopStmt);
        out.push(loopStmt);
        cur = exit;
        continue;
      }

      out.push(...b.stmts.map(s => fn.emitStmt(s)).filter(Boolean));
      const term = b.term;
      if (term.kind === 'try') {
        // find where the protected region rejoins normal control flow
        const region = reachSet(term.bodyTarget);
        let after = null;
        for (const n of region) {
          const nb = fn.blocks.get(n);
          if (nb && nb.term.kind === 'endtry') { after = nb.term.target; break; }
        }
        const frame = { kind: 'join', node: after, label: 'T' + (labelSeq++), emitting: true, isTry: true };
        const sub = frames.concat(after ? [frame] : []);
        const body = emitFrom(term.bodyTarget, sub, depth + 1, false, path);
        const cvar = t.identifier('__e' + depth);
        const catchBody = [t.expressionStatement(t.assignmentExpression('=',
          t.identifier(fn.nameOf(fn.fnId, term.catchReg)), cvar))]
          .concat(emitFrom(term.catchTarget, sub, depth + 1, false, path));
        frame.emitting = false;
        const tryStmt = t.tryStatement(t.blockStatement(body),
          t.catchClause(cvar, t.blockStatement(catchBody)));
        out.push(frame.needsLabel
          ? t.labeledStatement(t.identifier(frame.label), t.blockStatement([tryStmt]))
          : tryStmt);
        cur = after;
        continue;
      }
      if (term.kind === 'endtry') {
        // leaving the protected region: break out of the labeled try block
        const jump = jumpTo(term.target, frames);
        if (jump && jump.length) out.push(...jump);
        else if (jump) { /* falls through */ }
        else { cur = term.target; continue; }
        break;
      }
      if (term.kind === 'return') { out.push(t.returnStatement(fn.emitExpr(term.value))); break; }
      if (term.kind === 'throw') { out.push(t.throwStatement(fn.emitExpr(term.value))); break; }
      if (term.kind === 'goto') { cur = term.target; continue; }
      if (term.kind === 'branch') {
        const join = ipdom(cur);
        const frame = { kind: 'join', node: join, label: 'B' + (labelSeq++), emitting: true };
        const sub = frames.concat(join ? [frame] : []);
        const thenS = emitFrom(term.trueTarget, sub, depth + 1, false, path);
        const elseS = emitFrom(term.falseTarget, sub, depth + 1, false, path);
        frame.emitting = false;
        let ifStmt = t.ifStatement(fn.emitExpr(term.cond), t.blockStatement(thenS),
          elseS.length ? t.blockStatement(elseS) : null);
        if (frame.needsLabel) ifStmt = t.labeledStatement(t.identifier(frame.label), t.blockStatement([ifStmt]));
        out.push(ifStmt);
        cur = join;
        continue;
      }
      break;
    }
    return out;
  }

  return emitFrom(fn.rootKey, [], 0, false, null);
}

/* ------------------------------------------------------------------ *
 * 9. IR simplification: copy propagation, folding, method-call rebuild
 * ------------------------------------------------------------------ */

const CHEAP = new Set(['lit', 'global', 'this', 'reg']);

function sameExpr(a, b) {
  if (a === b) return true;
  if (!a || !b || a.e !== b.e) return false;
  switch (a.e) {
    case 'reg': return a.r === b.r && a.fn === b.fn;
    case 'lit': return Object.is(a.v, b.v);
    case 'this': return true;
    case 'global': return a.name === b.name;
    case 'member': return sameExpr(a.obj, b.obj) && sameExpr(a.prop, b.prop);
    default: return false;
  }
}

function mapExpr(x, f) {
  if (!x || typeof x !== 'object' || !x.e) return x;
  const r = f(x);
  if (r !== x) return r;
  const out = Object.assign({}, x);
  let changed = false;
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (Array.isArray(v)) {
      const nv = v.map(y => (y && y.e) ? mapExpr(y, f)
        : (y && y.key ? { key: mapExpr(y.key, f), value: mapExpr(y.value, f) } : y));
      if (nv.some((y, i) => y !== v[i])) { out[k] = nv; changed = true; }
    } else if (v && typeof v === 'object' && v.e) {
      const nv = mapExpr(v, f);
      if (nv !== v) { out[k] = nv; changed = true; }
    }
  }
  return changed ? out : x;
}

function substReg(x, reg, val) {
  return mapExpr(x, (n) => (n.e === 'reg' && n.r === reg) ? val : n);
}

function countReg(x, reg) {
  let n = 0;
  mapExpr(x, (y) => { if (y.e === 'reg' && y.r === reg) n++; return y; });
  return n;
}

function foldExpr(x) {
  return mapExpr(x, (n) => {
    if (n.e === 'bin' && n.a.e === 'lit' && n.b.e === 'lit' && n.op !== '[]') {
      try { const v = applyBin(n.op, n.a.v, n.b.v); if (typeof v !== 'object' || v === null) return E.lit(v); } catch (e) { }
    }
    if (n.e === 'un' && n.a.e === 'lit' && n.op !== 'delete') {
      try { const v = applyUn(n.op, n.a.v); if (typeof v !== 'object' || v === null) return E.lit(v); } catch (e) { }
    }
    return n;
  });
}

function rebuildMethodCalls(x) {
  return mapExpr(x, (n) => {
    if (n.e === 'method' && n.fn.e === 'member' && sameExpr(n.fn.obj, n.thisArg) && CHEAP.has(n.thisArg.e))
      return { e: 'call', callee: n.fn, args: n.args, spread: n.spread };
    if (n.e === 'method' && n.thisArg.e === 'lit' && n.thisArg.v === undefined)
      return { e: 'call', callee: n.fn, args: n.args, spread: n.spread };
    return n;
  });
}

function simplifyBlock(b, liveOut, vol) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (let i = 0; i < b.stmts.length; i++) {
      const s = b.stmts[i];
      if (s.op !== 'assign' || vol.has(s.dst)) continue;
      const dst = s.dst;
      // where is dst used / redefined after this?
      const uses = [];
      let redef = b.stmts.length, impureBetween = false;
      for (let j = i + 1; j < b.stmts.length; j++) {
        const u = b.stmts[j];
        let n = 0;
        if (u.expr) n += countReg(u.expr, dst);
        if (u.value) n += countReg(u.value, dst);
        if (u.obj) n += countReg(u.obj, dst) + countReg(u.prop, dst) + countReg(u.fn, dst);
        if (u.target && u.target.obj) n += countReg(u.target.obj, dst) + countReg(u.target.prop, dst);
        if (u.target && u.target.ref) n += countReg(u.target.ref, dst);
        if (n) uses.push({ j, n });
        if (u.op === 'assign' && u.dst === dst) { redef = j; break; }
      }
      const termUse = (redef === b.stmts.length)
        ? (countReg(b.term.cond || E.lit(0), dst) + countReg(b.term.value || E.lit(0), dst)) : 0;
      const total = uses.reduce((a, u) => a + u.n, 0) + termUse;
      const liveAfter = liveOut.has(dst) && redef === b.stmts.length;
      if (liveAfter) continue;
      if (total === 0) continue;                        // DCE handles this

      const cheap = CHEAP.has(s.expr.e) && (s.expr.e !== 'reg' || !vol.has(s.expr.r));
      const operands = [...exprUses(s.expr)];
      const firstUse = uses.length ? uses[0].j : b.stmts.length;
      // operands must not be reassigned between the definition and the last use
      const lastUse = termUse ? b.stmts.length : (uses.length ? uses[uses.length - 1].j : i);
      let clobbered = false;
      for (let j = i + 1; j < Math.min(lastUse, b.stmts.length); j++) {
        const u = b.stmts[j];
        if (u.op === 'assign' && operands.includes(u.dst)) { clobbered = true; break; }
      }
      if (clobbered) continue;
      let pureBetween = true;
      for (let j = i + 1; j < firstUse; j++) if (!stmtPure(b.stmts[j])) { pureBetween = false; break; }

      const single = total === 1;
      if (!cheap && !single) continue;
      if (!cheap && !exprPure(s.expr) && !pureBetween) continue;
      if (cheap && !exprPure(s.expr)) continue;

      const val = s.expr;
      for (const u of uses) {
        const st = b.stmts[u.j];
        if (st.expr) st.expr = substReg(st.expr, dst, val);
        if (st.value) st.value = substReg(st.value, dst, val);
        if (st.obj) { st.obj = substReg(st.obj, dst, val); st.prop = substReg(st.prop, dst, val); st.fn = substReg(st.fn, dst, val); }
        if (st.target && st.target.obj) { st.target.obj = substReg(st.target.obj, dst, val); st.target.prop = substReg(st.target.prop, dst, val); }
        if (st.target && st.target.ref) st.target.ref = substReg(st.target.ref, dst, val);
        st.uses = new Set();
        if (st.expr) exprUses(st.expr, st.uses);
        if (st.value) exprUses(st.value, st.uses);
        if (st.obj) { exprUses(st.obj, st.uses); exprUses(st.prop, st.uses); exprUses(st.fn, st.uses); }
        if (st.target && st.target.obj) { exprUses(st.target.obj, st.uses); exprUses(st.target.prop, st.uses); }
        if (st.target && st.target.ref) exprUses(st.target.ref, st.uses);
      }
      if (termUse) {
        if (b.term.cond) b.term.cond = substReg(b.term.cond, dst, val);
        if (b.term.value) b.term.value = substReg(b.term.value, dst, val);
        b.term.uses = new Set();
        if (b.term.cond) exprUses(b.term.cond, b.term.uses);
        if (b.term.value) exprUses(b.term.value, b.term.uses);
      }
      b.stmts.splice(i, 1);
      i--;
      changed = true;
    }
    // fold and rebuild method calls
    for (const s of b.stmts) {
      if (s.expr) { const n = rebuildMethodCalls(foldExpr(s.expr)); if (n !== s.expr) { s.expr = n; changed = true; } }
      if (s.value) s.value = foldExpr(s.value);
    }
    if (b.term.cond) b.term.cond = foldExpr(b.term.cond);
    if (b.term.value) b.term.value = foldExpr(b.term.value);
  }
}

/* ------------------------------------------------------------------ *
 * 10. emitting Babel AST
 * ------------------------------------------------------------------ */

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(('break case catch class const continue debugger default delete do else export ' +
  'extends finally for function if import in instanceof new return super switch this throw try typeof var ' +
  'void while with yield let static enum await implements package protected interface private public ' +
  'null true false').split(' '));

function litNode(v) {
  if (v === undefined) return t.identifier('undefined');
  if (v === null) return t.nullLiteral();
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return t.identifier('NaN');
    if (v === Infinity) return t.identifier('Infinity');
    if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
    if (v < 0 || Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(-v));
    return t.numericLiteral(v);
  }
  if (typeof v === 'bigint') return t.bigIntLiteral(String(v));
  return t.identifier('undefined');
}

function makeEmitter(fn, ctx) {
  const nameOf = ctx.nameOf;
  function ex(x) {
    if (!x) return t.identifier('undefined');
    switch (x.e) {
      case 'reg': return t.identifier(nameOf(x.fn === undefined ? fn.fnId : x.fn, x.r));
      case 'lit': return litNode(x.v);
      case 'this': return t.thisExpression();
      case 'global': return IDENT_RE.test(x.name) && !RESERVED.has(x.name)
        ? t.identifier(x.name)
        : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(x.name), true);
      case 'bin': return t.binaryExpression(x.op, ex(x.a), ex(x.b));
      case 'un': return t.unaryExpression(x.op, ex(x.a), x.op !== 'typeof' && x.op !== 'void' && x.op !== 'delete');
      case 'member': {
        const p = x.prop;
        if (p.e === 'lit' && typeof p.v === 'string' && IDENT_RE.test(p.v) && !RESERVED.has(p.v))
          return t.memberExpression(ex(x.obj), t.identifier(p.v), false);
        return t.memberExpression(ex(x.obj), ex(p), true);
      }
      case 'call': return t.callExpression(ex(x.callee), argList(x));
      case 'new': return t.newExpression(ex(x.callee), argList(x));
      case 'method': return t.callExpression(
        t.memberExpression(ex(x.fn), t.identifier(x.spread ? 'apply' : 'call'), false),
        x.spread ? [ex(x.thisArg), ex(x.args[0])] : [ex(x.thisArg)].concat(x.args.map(ex)));
      case 'array': return t.arrayExpression(x.elems.map(ex));
      case 'object': return t.objectExpression(x.props.map(p => {
        if (p.key.e === 'lit' && typeof p.key.v === 'string' && IDENT_RE.test(p.key.v))
          return t.objectProperty(t.identifier(p.key.v), ex(p.value));
        return t.objectProperty(ex(p.key), ex(p.value), true);
      }));
      case 'delete': return t.unaryExpression('delete', memberOf(x), false);
      case 'func': return ctx.emitFunction(x.fn);
      case 'forinkeys': return t.callExpression(t.identifier(ctx.helper('forIn')), [ex(x.obj)]);
      case 'forinnext': { ctx.helper('forIn'); return t.callExpression(t.identifier('__forInNext'), [ex(x.iter)]); }
      case 'forinmore': { ctx.helper('forIn'); return t.binaryExpression('!==', ex(x.a), t.identifier('__forInDone')); }
      case 'unknown': return t.callExpression(t.identifier(ctx.helper('unknownOp')),
        [t.numericLiteral(x.ins.op)].concat(x.args.map(ex)));
      default: return t.identifier('undefined');
    }
  }
  function memberOf(x) {
    const p = x.prop;
    if (p.e === 'lit' && typeof p.v === 'string' && IDENT_RE.test(p.v) && !RESERVED.has(p.v))
      return t.memberExpression(ex(x.obj), t.identifier(p.v), false);
    return t.memberExpression(ex(x.obj), ex(p), true);
  }
  function argList(x) {
    if (x.spread) return [t.spreadElement(ex(x.args[0]))];
    return x.args.map(ex);
  }
  function st(s) {
    switch (s.op) {
      case 'assign': {
        if (s.expr.e === 'func' && s.expr.fn) ctx.noteFunctionName(s.expr.fn, s.dst, fn.fnId);
        return t.expressionStatement(t.assignmentExpression('=',
          t.identifier(nameOf(fn.fnId, s.dst)), ex(s.expr)));
      }
      case 'store': {
        const tg = s.target;
        if (tg.kind === 'global')
          return t.expressionStatement(t.assignmentExpression('=',
            IDENT_RE.test(tg.name) && !RESERVED.has(tg.name) ? t.identifier(tg.name)
              : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(tg.name), true), ex(s.value)));
        if (tg.kind === 'member')
          return t.expressionStatement(t.assignmentExpression('=', memberOf(tg), ex(s.value)));
        return t.expressionStatement(t.assignmentExpression('=', ex(tg.ref), ex(s.value)));
      }
      case 'defineAccessor':
        return t.expressionStatement(t.callExpression(
          t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
          [ex(s.obj), ex(s.prop), t.objectExpression([
            t.objectProperty(t.identifier(s.accessor), ex(s.fn)),
            t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
            t.objectProperty(t.identifier('enumerable'), t.booleanLiteral(true)),
          ])]));
      case 'effect': return t.expressionStatement(ex(s.expr));
      case 'nop': return null;
      default: return null;
    }
  }
  fn.emitExpr = ex;
  fn.emitStmt = st;
  fn.nameOf = nameOf;
  return { ex, st };
}

/* ------------------------------------------------------------------ *
 * 11. driver
 * ------------------------------------------------------------------ */

const HELPERS = {
  forIn: `function __forInKeys(o) {
  var out = [], seen = Object.create(null);
  if (o === null || o === undefined) return out;
  for (o = Object(o); o !== null; o = Object.getPrototypeOf(o)) {
    var names = Object.getOwnPropertyNames(o);
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      if (k in seen) continue;
      seen[k] = true;
      var d = Object.getOwnPropertyDescriptor(o, k);
      if (d && d.enumerable) out.push(k);
    }
  }
  return out;
}
var __forInDone = {};
function __forIn(o) { return { k: __forInKeys(o), i: 0 }; }
function __forInNext(it) { return it.i < it.k.length ? it.k[it.i++] : __forInDone; }`,
  unknownOp: `function __unknownOp(op) { throw new Error('unrecognized vm opcode ' + op); }`,
};

// Anything we cannot devirtualize faithfully must abort the whole conversion:
// handing back the original file is bad, but emitting subtly wrong code is worse.
function auditRecovery(A, all) {
  const problems = [];
  let unresolved = 0, unknownOps = 0, tryOps = 0, decryptOps = 0;
  for (const [entry, rec] of all) {
    for (const b of rec.blocks.values()) {
      if (b.term && b.term.kind === 'unresolved') unresolved++;
      for (const ins of b.stmts) {
        if (ins.kind === 'TRYFIN') tryOps++;
        if (ins.kind === 'DECRYPT') decryptOps++;
        if (ins.kind === 'DATA') {
          const f = A.fit(ins, rec.func.C);
          if (f.kind === 'UNKNOWN' || f.kind === 'ERR') unknownOps++;
        }
      }
    }
  }
  if (unresolved) problems.push(unresolved + ' unresolved dynamic jump(s)');
  if (unknownOps) problems.push(unknownOps + ' opcode(s) with unrecognized semantics');
  if (tryOps) problems.push(tryOps + ' try/finally region(s) (not reconstructed yet)');
  if (decryptOps) problems.push(decryptOps + ' self-decrypting bytecode region(s)');
  return problems;
}

function deobfuscate(file, src) {
  const L = loadVM(file, src);
  if (!L) return null;                       // not a JS-Confuser-VM payload
  const A = makeAnalyzer(L);
  const all = exploreAll(A);
  const problems = auditRecovery(A, all);
  if (problems.length) throw new Error('cannot fully devirtualize: ' + problems.join('; '));

  let fnSeq = 0;
  const idMap = new Map();
  const idOf = (entry) => { if (!idMap.has(entry)) idMap.set(entry, fnSeq++); return idMap.get(entry); };
  idOf(A.L.tmpl.x.F);

  const dispatchers = new Set();
  for (const r of all.values()) for (const d of (r.dispatchers || [])) dispatchers.add(d);

  const root = liftFunction(A, all, A.L.tmpl.x.F,
    { idOf, dispatchers, isRoot: true, rootThis: A.L.thisArg });

  // ---- optimize every lifted function -------------------------------------
  const names = new Map();          // "fnId:reg" -> name
  const declared = new Map();       // fnId -> Set(regs)
  const funcNames = new Map();      // lifted fn -> preferred name
  let nameSeq = 0;
  const nameOf = (fnId, reg) => {
    const key = fnId + ':' + reg;
    if (!names.has(key)) names.set(key, 'v' + fnId + '_' + reg);
    if (!declared.has(fnId)) declared.set(fnId, new Set());
    declared.get(fnId).add(reg);
    return names.get(key);
  };

  const usedHelpers = new Set();
  const ctx = {
    nameOf,
    helper: (n) => { usedHelpers.add(n); return '__' + n; },
    noteFunctionName: () => { },
    emitFunction: (child) => emitFunctionExpression(child),
  };

  function optimize(fn) {
    const vol = new Set((all.get(fn.entry) || {}).vol || []);
    for (const r of fn.catchRegs || []) vol.add(r);   // written by the catch clause
    splitTryBlocks(fn);
    pruneUnreachable(fn);
    for (let round = 0; round < 5; round++) {
      const before = fn.blocks.size + [...fn.blocks.values()].reduce((a, b) => a + b.stmts.length, 0);
      deadCodeElim(fn, vol);
      removeFlatteningChains(fn, vol);
      deadCodeElim(fn, vol);
      mergeBlocks(fn);
      deadCodeElim(fn, vol);
      for (const b of fn.blocks.values()) {
        const liveOut = new Set();
        for (const s of succsOf(b)) for (const r of (fn.liveIn.get(s) || [])) liveOut.add(r);
        for (const r of vol) liveOut.add(r);
        simplifyBlock(b, liveOut, vol);
      }
      deadCodeElim(fn, vol);
      const after = fn.blocks.size + [...fn.blocks.values()].reduce((a, b) => a + b.stmts.length, 0);
      if (after === before) break;
    }
    mergeBlocks(fn);
  }

  function collectFuncs(x, out) {
    if (!x || typeof x !== 'object') return;
    if (x.e === 'func') { out.push(x.fn); return; }
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (Array.isArray(v)) v.forEach(y => collectFuncs(y, out));
      else if (v && typeof v === 'object') collectFuncs(v, out);
    }
  }

  function walkFns(fn, visit) {
    visit(fn);
    const kids = [];
    for (const b of fn.blocks.values()) {
      for (const s of b.stmts) collectFuncs(s, kids);
      collectFuncs(b.term, kids);
    }
    for (const k of kids) walkFns(k, visit);
  }

  walkFns(root, optimize);

  function emitFunctionExpression(fn) {
    makeEmitter(fn, ctx);
    const body = structureFunction(fn);
    const params = [];
    for (let i = 0; i < fn.nparams; i++) {
      const id = t.identifier(nameOf(fn.fnId, i));
      params.push(fn.hasRest && i === fn.nparams - 1 ? t.restElement(id) : id);
    }
    const decls = [...(declared.get(fn.fnId) || [])]
      .filter(r => r >= fn.nparams)
      .sort((a, b) => a - b);
    const pre = [];
    const argReg = fn.nparams;
    if (decls.includes(argReg))
      pre.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(nameOf(fn.fnId, argReg)), t.identifier('arguments'))]));
    const rest = decls.filter(r => r !== argReg);
    if (rest.length)
      pre.push(t.variableDeclaration('var', rest.map(r => t.variableDeclarator(t.identifier(nameOf(fn.fnId, r))))));
    return t.functionExpression(null, params, t.blockStatement(pre.concat(body)));
  }

  // the root "function" is the module body itself
  makeEmitter(root, ctx);
  const rootBody = structureFunction(root);
  const rootDecls = [...(declared.get(root.fnId) || [])].sort((a, b) => a - b);
  const program = [];
  for (const h of usedHelpers) program.push(...parser.parse(HELPERS[h]).program.body);
  const moduleBody = [];
  if (rootDecls.length)
    moduleBody.push(t.variableDeclaration('var', rootDecls.map(r => t.variableDeclarator(t.identifier(nameOf(root.fnId, r))))));
  moduleBody.push(...rootBody);
  // a trailing `return undefined` at module level is just the vm epilogue
  while (moduleBody.length) {
    const last = moduleBody[moduleBody.length - 1];
    if (last.type !== 'ReturnStatement') break;
    if (last.argument && !(last.argument.type === 'Identifier' && last.argument.name === 'undefined')) break;
    moduleBody.pop();
  }
  const hasTopLevelReturn = (function scan(nodes) {
    for (const n of nodes) {
      if (!n || typeof n.type !== 'string') continue;
      if (n.type === 'ReturnStatement') return true;
      if (t.isFunction(n)) continue;                 // belongs to an inner scope
      const keys = t.VISITOR_KEYS[n.type] || [];
      for (const k of keys) {
        const v = n[k];
        if (Array.isArray(v)) { if (scan(v)) return true; }
        else if (v && typeof v === 'object' && scan([v])) return true;
      }
    }
    return false;
  })(moduleBody);
  if (hasTopLevelReturn)
    program.push(t.expressionStatement(t.callExpression(
      t.functionExpression(null, [], t.blockStatement(moduleBody)), [])));
  else program.push(...moduleBody);

  const ast = t.file(t.program(program));
  prettify(ast);
  return generate(ast, { comments: true, jsescOption: { minimal: true } }).code + '\n';
}

/* ------------------------------------------------------------------ *
 * 12. final AST tidy-up: drop trailing `return undefined`, rename vars
 * ------------------------------------------------------------------ */

function prettify(ast) {
  // `if (!c) {} else { ... }`  ->  `if (c) { ... }`
  traverse(ast, {
    IfStatement: {
      exit(p) {
        const n = p.node;
        const empty = (b) => !b || (b.type === 'BlockStatement' && b.body.length === 0);
        if (empty(n.consequent) && n.alternate && !empty(n.alternate)) {
          n.consequent = n.alternate;
          n.alternate = null;
          n.test = n.test.type === 'UnaryExpression' && n.test.operator === '!'
            ? n.test.argument : t.unaryExpression('!', n.test);
        }
        if (empty(n.alternate)) n.alternate = null;
      },
    },
  });
  // `while (true) { if (c) { body; continue; } break; }`  ->  `while (c) { body }`
  // `while (true) { if (!c) break; body }`                ->  `while (c) { body }`
  traverse(ast, {
    WhileStatement: {
      exit(p) {
        const n = p.node;
        if (!(n.test.type === 'BooleanLiteral' && n.test.value === true)) return;
        if (n.body.type !== 'BlockStatement') return;
        const body = n.body.body;
        const bare = (s, type) => s && s.type === type && !s.label;
        if (body.length === 2 && body[0].type === 'IfStatement' && !body[0].alternate &&
            bare(body[1], 'BreakStatement')) {
          const cons = body[0].consequent;
          const inner = cons.type === 'BlockStatement' ? cons.body : [cons];
          if (inner.length && bare(inner[inner.length - 1], 'ContinueStatement')) {
            n.test = body[0].test;
            n.body = t.blockStatement(inner.slice(0, -1));
            return;
          }
        }
        if (body.length >= 1 && body[0].type === 'IfStatement' && !body[0].alternate) {
          const cons = body[0].consequent;
          const inner = cons.type === 'BlockStatement' ? cons.body : [cons];
          if (inner.length === 1 && bare(inner[0], 'BreakStatement')) {
            const test = body[0].test;
            n.test = test.type === 'UnaryExpression' && test.operator === '!'
              ? test.argument : t.unaryExpression('!', test);
            n.body = t.blockStatement(body.slice(1));
          }
        }
      },
    },
  });
  traverse(ast, {
    ReturnStatement(p) {
      if (p.node.argument && p.node.argument.type === 'Identifier' && p.node.argument.name === 'undefined') {
        const fnParent = p.getFunctionParent();
        const body = fnParent ? fnParent.node.body.body : p.scope.block.body;
        if (Array.isArray(body) && body[body.length - 1] === p.node) p.remove();
        else p.replaceWith(t.returnStatement());
      }
    },
    VariableDeclaration(p) {
      p.node.declarations = p.node.declarations.filter(d => {
        if (d.init) return true;
        const b = p.scope.getBinding(d.id.name);
        return !b || b.references > 0 || b.constantViolations.length > 0;
      });
      if (!p.node.declarations.length) p.remove();
    },
  });
  // `var x; x = e;`  ->  `var x = e;`   (only when the assignment follows directly)
  traverse(ast, {
    VariableDeclaration(p) {
      const decls = p.node.declarations;
      if (!decls.length || decls[decls.length - 1].init) return;
      let next = p.getSibling(p.key + 1);
      while (next.node && decls.some(d => !d.init)) {
        const st = next.node;
        if (st.type !== 'ExpressionStatement' || st.expression.type !== 'AssignmentExpression') break;
        const a = st.expression;
        if (a.operator !== '=' || a.left.type !== 'Identifier') break;
        const d = decls.find(x => x.id.name === a.left.name && !x.init);
        if (!d) break;
        // only safe if nothing between declares/uses it -- it is directly adjacent
        d.init = a.right;
        const idx = decls.indexOf(d);
        decls.splice(idx, 1);
        decls.push(d);
        next.remove();
        next = p.getSibling(p.key + 1);
      }
    },
  });
  // `x + -3`  ->  `x - 3`
  traverse(ast, {
    BinaryExpression(p) {
      const n = p.node;
      if ((n.operator === '+' || n.operator === '-') && n.right.type === 'UnaryExpression' &&
          n.right.operator === '-' && n.right.argument.type === 'NumericLiteral') {
        n.operator = n.operator === '+' ? '-' : '+';
        n.right = n.right.argument;
      }
    },
  });
  // drop trailing bare `return;` -- including the tail of a trailing if/else
  const stripTail = (body) => {
    while (body.length) {
      const last = body[body.length - 1];
      if (last.type === 'ReturnStatement' && !last.argument) { body.pop(); continue; }
      if (last.type === 'IfStatement') {
        const arm = (b) => (b && b.type === 'BlockStatement') ? stripTail(b.body) : undefined;
        arm(last.consequent);
        arm(last.alternate);
        if (last.alternate && last.alternate.type === 'BlockStatement' && !last.alternate.body.length)
          last.alternate = null;
        if (last.consequent.type === 'BlockStatement' && !last.consequent.body.length && !last.alternate) {
          if (isPureTest(last.test)) { body.pop(); continue; }
        }
      }
      break;
    }
    return body;
  };
  const isPureTest = (n) => n && (n.type === 'Identifier' || n.type === 'UnaryExpression' && isPureTest(n.argument));
  traverse(ast, {
    Function(p) { if (p.node.body && p.node.body.body) stripTail(p.node.body.body); },
    Program(p) { stripTail(p.node.body); },
  });
  // readable names
  const used = new Set();
  traverse(ast, { Identifier(p) { if (!/^v\d+_\d+$/.test(p.node.name)) used.add(p.node.name); } });
  const pool = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const c of letters) pool.push(c);
  for (const c of letters) for (const d of letters) pool.push(c + d);
  let pi = 0;
  const nextName = () => { let n; do { n = pool[pi++] || ('t' + pi); } while (used.has(n) || RESERVED.has(n)); used.add(n); return n; };
  traverse(ast, {
    Scopable(p) {
      for (const name of Object.keys(p.scope.bindings)) {
        if (!/^v\d+_\d+$/.test(name)) continue;
        p.scope.rename(name, nextName());
      }
    },
  });
}

function run(inputFile, outputFile) {
  const src = fs.readFileSync(inputFile, 'utf8');
  let out;
  try { out = deobfuscate(inputFile, src); }
  catch (e) {
    if (process.env.VM_DEBUG) throw e;
    process.stderr.write('vm.js: ' + e.message + ' -- passing the file through unchanged\n');
    out = null;
  }
  if (out === null) {
    // not a VM payload (or we could not devirtualize it): pass the file through,
    // normalized through the same parse/print pipeline so it stays valid JS
    const ast = parser.parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
    out = generate(ast, { comments: true }).code + '\n';
  }
  if (outputFile) fs.writeFileSync(outputFile, out);
  return out;
}

module.exports = run;
module.exports.run = run;
module.exports.deobfuscate = deobfuscate;
module.exports.internals = { loadVM, makeAnalyzer, makeEnv, fitSite, decodeAt, exploreAll,
  exploreFunction, liftFunction, exprUses, exprPure, pruneUnreachable, deadCodeElim, mergeBlocks,
  structureFunction, simplifyBlock, makeEmitter, succsOf, E, SPREAD };

if (require.main === module) {
  const [, , inFile, outFile] = process.argv;
  if (!inFile) { console.error('usage: node vm.js <input.js> [output.js]'); process.exit(1); }
  const out = run(inFile, outFile || 'output.js');
  if (!outFile) process.stdout.write(out);
}
