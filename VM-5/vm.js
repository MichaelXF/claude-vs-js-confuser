#!/usr/bin/env node
/**
 * vm.js — devirtualizer for the JS-Confuser-VM ("VM" / bytecode) obfuscation.
 *
 *   node vm.js input.js output.js
 *   require('./vm.js')('input.js')   ->  deobfuscated source (string)
 *
 * The obfuscated program is a register machine: a Uint32Array of bytecode, a table of
 * opcode handlers hung off the interpreter prototype and a pool of encrypted constants.
 * Opcode numbers, property names and handler bodies (heavy MBA) are randomized per build,
 * so nothing here keys off literal names or numbers.  Instead the VM is located
 * structurally, every handler is *probed* by running it against an instrumented mock
 * interpreter to learn what it does, and the bytecode is then statically decoded and
 * lifted back to JavaScript.   See NOTES.md for the full write-up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const nodeVm = require('vm');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');

/* ================================================================== *
 * 1.  Parsing + structural detection
 * ================================================================== */

function parseSource(src) {
  return parser.parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
}

/**
 * The bootstrap statement of a VM-obfuscated file looks like
 *     z(new p(D, B, [ ...pool ]), void 0, new t({m:0,l:6,t:0}), 48, null, {});
 * a top level call whose 1st argument builds the interpreter state (bytecode, globals,
 * constant pool) and whose 3rd argument builds the main function's template.
 */
function findBootstrap(ast) {
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const st = body[i];
    if (st.type !== 'ExpressionStatement') continue;
    const call = st.expression;
    if (!t.isCallExpression(call) || !t.isIdentifier(call.callee)) continue;
    if (call.arguments.length < 3) continue;
    const a0 = call.arguments[0];
    if (!t.isNewExpression(a0) || !t.isIdentifier(a0.callee) || a0.arguments.length !== 3) continue;
    if (!t.isArrayExpression(a0.arguments[2])) continue;
    const a2 = call.arguments[2];
    if (!t.isNewExpression(a2) || !a2.arguments.length || !t.isObjectExpression(a2.arguments[0])) continue;
    return { index: i, statement: st, call };
  }
  return null;
}

/** Count `X[<number>] = function(){...}` assignments — the opcode handler table. */
function countHandlerAssignments(ast) {
  let n = 0;
  const visit = e => {
    if (t.isAssignmentExpression(e) && t.isMemberExpression(e.left) && e.left.computed &&
        t.isNumericLiteral(e.left.property) && t.isFunctionExpression(e.right)) n++;
    else if (t.isSequenceExpression(e)) e.expressions.forEach(visit);
  };
  for (const st of ast.program.body) if (st.type === 'ExpressionStatement') visit(st.expression);
  return n;
}

/* ================================================================== *
 * 2.  Sandboxed load + capture of the interpreter state
 * ================================================================== */

function makeSandbox() {
  const sandbox = {
    Object, Array, String, Number, Boolean, Symbol, Math, JSON, Date, RegExp, Function,
    Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
    Map, Set, WeakMap, WeakSet, Promise, Proxy, Reflect, BigInt,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    Float32Array, Float64Array, ArrayBuffer, DataView,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    encodeURI, decodeURI, escape: global.escape, unescape: global.unescape,
    Buffer, atob: global.atob, btoa: global.btoa, isArray: Array.isArray,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function captureVM(ast) {
  const boot = findBootstrap(ast);
  const call = boot.call;
  const originalCallee = call.callee;
  call.arguments.unshift(originalCallee);
  call.callee = t.identifier('__capture');
  const code = generate(ast, { compact: true, comments: false }).code;
  call.callee = originalCallee;
  call.arguments.shift();

  const sandbox = makeSandbox();
  let captured = null;
  sandbox.__capture = function (runner, state, thisArg, template, ...rest) {
    captured = { runner, state, thisArg, template, rest };
  };
  const ctx = nodeVm.createContext(sandbox);
  nodeVm.runInContext(code, ctx, { filename: 'vm-input.js', timeout: 30000 });
  if (!captured) throw new Error('VM bootstrap did not run');
  captured.sandbox = sandbox;
  return captured;
}

/* ================================================================== *
 * 3.  Field discovery
 * ================================================================== */

function discoverFields(state, proto) {
  const opcodes = [];
  let readerName = null;
  for (const k of Object.getOwnPropertyNames(proto)) {
    if (/^\d+$/.test(k)) opcodes.push(Number(k));
    else if (typeof proto[k] === 'function' && k !== 'constructor') readerName = k;
  }
  if (readerName === null) throw new Error('operand reader not found on VM prototype');
  const readerSrc = Function.prototype.toString.call(proto[readerName]);
  const m = readerSrc.match(/this\.(\w+)\[this\.(\w+)\[this\.(\w+)\s*\+\s*(\d+)\]\+\+\]/);
  if (!m) throw new Error('unrecognised operand reader: ' + readerSrc);
  const fields = { code: m[1], stack: m[2], fp: m[3], reader: readerName };
  const PC = Number(m[4]);
  for (const k of Object.keys(state)) {
    if (k === fields.code || k === fields.stack || k === fields.fp) continue;
    const v = state[k];
    if (Array.isArray(v) && !fields.pool) fields.pool = k;
    else if (v && typeof v === 'object' && !Array.isArray(v) && !fields.globals) fields.globals = k;
  }
  return { fields, opcodes: opcodes.sort((a, b) => a - b), PC };
}

/* ================================================================== *
 * 4.  Mock interpreter (probing + decoding)
 * ================================================================== */

const REG_BASE = 1 << 20;
const FRAME_SLOTS = 16;
const SLOT_SENT = i => (2 << 20) + i * 4096;

function makeMock(env, opts = {}) {
  const { fields, PC } = env;
  const rec = {
    operands: [], regReads: [], regWrites: [], slotReads: new Set(), slotWrites: [],
    jump: null, globalReads: [], globalWrites: [], globalHas: [], codeWrites: [], error: null,
  };
  const regValue = opts.regValue || (r => 1000 + r);
  const frame = new Map();
  for (let i = 0; i < FRAME_SLOTS; i++) frame.set(i, SLOT_SENT(i));
  frame.set(0, REG_BASE);
  // once the special slots are known, give them values of the right *shape* so handlers
  // run to completion instead of blowing up half way through reading their operands
  if (env.frameDefaults && !opts.rawFrame) {
    for (const k of Object.keys(env.frameDefaults)) frame.set(Number(k), env.frameDefaults[k]());
  }
  if (env.frameLayout) {
    const fsz = opts.frameSize !== undefined ? opts.frameSize : env.currentFrameSize;
    if (fsz !== undefined) frame.set(env.frameLayout.sizeSlot, fsz);
  }
  if (opts.frame) for (const k of Object.keys(opts.frame)) frame.set(Number(k), opts.frame[k]);
  const regs = new Map();
  if (opts.regs) for (const k of Object.keys(opts.regs)) regs.set(Number(k), opts.regs[k]);

  const stack = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      const idx = Number(prop);
      if (!Number.isFinite(idx)) return undefined;
      if (idx >= REG_BASE) {
        const r = idx - REG_BASE;
        rec.regReads.push(r);
        if (!regs.has(r)) regs.set(r, regValue(r));
        return regs.get(r);
      }
      rec.slotReads.add(idx);
      return frame.get(idx);
    },
    set(_, prop, value) {
      const idx = Number(prop);
      if (!Number.isFinite(idx)) return true;
      if (idx >= REG_BASE) { rec.regWrites.push([idx - REG_BASE, value]); regs.set(idx - REG_BASE, value); }
      else { if (idx === PC) rec.jump = value; rec.slotWrites.push([idx, value]); frame.set(idx, value); }
      return true;
    },
    has() { return true; },
  });

  const globals = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      rec.globalReads.push(prop);
      return opts.globalValue ? opts.globalValue(prop) : undefined;
    },
    set(_, prop, value) { rec.globalWrites.push([prop, value]); return true; },
    has(_, prop) { rec.globalHas.push(prop); return true; },
    getOwnPropertyDescriptor(_, prop) {
      rec.globalHas.push(prop);
      return { value: undefined, writable: true, enumerable: true, configurable: true };
    },
  });

  let ip = opts.ip || 0;
  const rawCode = opts.code;
  const code = opts.watchCode ? new Proxy(rawCode, {
    set(target, prop, value) {
      const i = Number(prop);
      if (Number.isFinite(i)) rec.codeWrites.push([i, value]);
      target[prop] = value; return true;
    },
  }) : rawCode;

  const mock = Object.create(env.proto);
  mock[fields.stack] = stack;
  mock[fields.fp] = 0;
  mock[fields.code] = code;
  mock[fields.globals] = globals;
  mock[fields.pool] = opts.pool !== undefined ? opts.pool : env.pool;
  mock[fields.reader] = function () { const v = rawCode[ip++]; rec.operands.push(v); return v; };
  rec.getIp = () => ip;
  return { mock, rec, regs, frame };
}

function runHandler(env, op, opts) {
  const m = makeMock(env, opts);
  try { env.proto[op].call(m.mock); }
  catch (e) { m.rec.error = e; }
  m.rec.ipEnd = m.rec.getIp();
  return m;
}

function probeWith(env, op, operands, regs, extra = {}) {
  return runHandler(env, op, Object.assign({ code: [op, ...operands], ip: 1, regs }, extra));
}

const seq = n => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; };

/* ================================================================== *
 * 5.  Opcode classification
 * ================================================================== */

/** First pass: operand count and which operands are register indices. */
function probeRoles(env, op) {
  const N = 48;
  const code = [op, ...seq(N)];
  const { rec } = runHandler(env, op, { code, ip: 1, regValue: r => 1000 + r });
  const nOperands = rec.ipEnd - 1;
  const opnd = rec.operands;
  const roles = new Array(nOperands).fill('imm');
  for (const r of new Set(rec.regReads)) {
    const k = opnd.indexOf(r);
    if (k >= 0 && roles[k] === 'imm') roles[k] = 'reg';
  }
  for (const [r] of rec.regWrites) {
    const k = opnd.indexOf(r);
    if (k >= 0) roles[k] = 'dst';
  }
  return { op, nOperands, operands: opnd, roles, rec };
}

const PROBE_FN = () => {};

function classifyOpcodes(env) {
  const kinds = new Map();
  for (const op of env.opcodes) kinds.set(op, classifyOne(env, op));
  return kinds;
}

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

/* ================================================================== *
 * 6.  Frame-slot discovery
 * ================================================================== */

/**
 * Which frame slots hold the register base, the `this` value, the closure template and
 * the exception-handler stack.  Found by watching what handlers do with them.
 */
function discoverSlots(env) {
  const slots = { base: 0, this: 10, template: 12, try: 8 };
  // `base`: the slot whose value is used as the origin for register access.  makeMock
  // already assumes slot 0 (it stores REG_BASE there); verify by looking for handlers
  // that read registers at all.
  let ok = false;
  for (const op of env.opcodes) {
    const R = probeRoles(env, op);
    if (R.rec.regReads.length || R.rec.regWrites.length) { ok = true; break; }
  }
  if (!ok) throw new Error('could not locate the register base slot');

  // `this`: the handler that copies a frame slot straight into a register
  for (const op of env.opcodes) {
    const R = probeRoles(env, op);
    if (R.nOperands !== 1 || R.rec.regWrites.length !== 1) continue;
    const v = R.rec.regWrites[0][1];
    for (let i = 1; i < FRAME_SLOTS; i++) if (v === SLOT_SENT(i)) { slots.this = i; }
  }
  // `template` / `try`: slots that are used as objects (property access / array push)
  const objSlots = new Set();
  for (const op of env.opcodes) {
    const src = Function.prototype.toString.call(env.proto[op]);
    const R = probeRoles(env, op);
    const err = R.rec.error;
    if (!err) continue;
    for (const s of R.rec.slotReads) {
      if (s === 0 || s === env.PC) continue;
      if (err instanceof TypeError && new RegExp(String(SLOT_SENT(s))).test(String(err.message))) objSlots.add(s);
    }
    if (/\.push\(|\.pop\(\)/.test(src)) for (const s of R.rec.slotReads) if (s !== 0) slots.try = s;
  }
  for (const s of objSlots) if (s !== slots.try) slots.template = s;
  return slots;
}

/* ================================================================== *
 * 7.  Function template layout  (which make_function operand is what)
 * ================================================================== */

/**
 * `make_function` reads: dst, entry-pc, param-count, local-count, upvalue-count,
 * rest-flag, then <count> (isLocal, index) pairs — but the order is build specific.
 * Determine it by *building* a function whose body is a synthetic bytecode program that
 * reports every register of its own frame, then calling it.
 */
function discoverFunctionMeta(env) {
  const mkOp = [...env.kinds.entries()].find(([, k]) => k.kind === 'make_function');
  if (!mkOp) throw new Error('make_function opcode not found');
  const op = mkOp[0];
  const R = probeRoles(env, op);
  const n0 = R.nOperands;                       // with operands 0..N: n = 6 + 2*count
  // upvalue count slot: the operand v with n0 === 6 + 2v  (search all imm slots)
  let countSlot = -1;
  for (let i = 0; i < n0; i++) {
    if (R.roles[i] !== 'imm') continue;
    const ops = R.operands.slice();
    ops[i] = R.operands[i] + 1;
    const p = runHandler(env, op, { code: [op, ...ops, 0, 0, 0, 0], ip: 1 });
    if (p.rec.ipEnd - 1 === n0 + 2) { countSlot = i; break; }
  }
  if (countSlot < 0) throw new Error('make_function: upvalue count operand not found');

  const store = [...env.kinds.entries()].find(([, k]) => k.kind === 'store_global');
  const ret = [...env.kinds.entries()].find(([, k]) => k.kind === 'ret');
  if (!store || !ret) throw new Error('missing store_global/ret opcode');
  const storeOp = store[0], storeKind = store[1], retOp = ret[0];

  const ENTRY = 64, NREG = 12;
  const pool = [];
  const code = new Array(ENTRY).fill(0);
  for (let r = 0; r < NREG; r++) {
    const operands = new Array(storeKind.n).fill(0);
    operands[storeKind.valueSlot] = r;                       // register to read
    const immSlots = storeKind.roles.map((x, i) => (x === 'imm' ? i : -1)).filter(i => i >= 0);
    operands[immSlots[0]] = pool.length;                     // pool index of the name
    if (immSlots[1] !== undefined) operands[immSlots[1]] = 0; // no decryption key
    pool.push('R' + r);
    code.push(storeOp, ...operands);
  }
  code.push(retOp, 0);

  const others = [];
  for (let i = 0; i < n0; i++) if (i !== countSlot && R.roles[i] !== 'dst') others.push(i);
  const dstSlot = R.roles.indexOf('dst');

  const perms = [];
  for (const entry of others) {
    for (const m of others) {
      for (const rest of others) {
        for (const l of others) {
          if (new Set([entry, m, rest, l]).size !== 4) continue;
          perms.push({ entry, m, rest, l });
        }
      }
    }
  }
  for (const cand of perms) {
    const res = tryMeta(env, op, { dstSlot, countSlot, ...cand }, code, pool, ENTRY, NREG);
    if (res) return { op, dstSlot, countSlot, ...cand, pairsStart: Math.max(...others, countSlot, dstSlot) + 1 };
  }
  throw new Error('make_function: could not determine template layout');
}

function tryMeta(env, op, layout, code, pool, ENTRY, NREG) {
  const check = (mVal, restVal, args) => {
    const operands = new Array(6).fill(0);
    operands[layout.dstSlot] = 0;
    operands[layout.entry] = ENTRY;
    operands[layout.m] = mVal;
    operands[layout.l] = NREG;
    operands[layout.rest] = restVal;
    operands[layout.countSlot] = 0;
    const seen = {};
    const p = runHandler(env, op, {
      code: [op, ...operands].concat(code.slice(6 + 1)),
      ip: 1, pool,
      globalValue: () => undefined,
    });
    // the synthetic program lives in `code`; rebuild a full code array for the closure
    return null;
  };
  // build the code array so that instruction stream = [op, operands..., padding..., program@ENTRY]
  const operands = new Array(6).fill(0);
  operands[layout.dstSlot] = 0;
  operands[layout.entry] = ENTRY;
  operands[layout.m] = 2;
  operands[layout.l] = NREG;
  operands[layout.rest] = 0;
  operands[layout.countSlot] = 0;
  const full = code.slice();
  full[0] = op;
  for (let i = 0; i < operands.length; i++) full[1 + i] = operands[i];

  const writes = [];
  const m = runHandler(env, op, {
    code: full, ip: 1, pool,
    globalValue: () => undefined,
  });
  const fnWrite = m.rec.regWrites.find(w => typeof w[1] === 'function');
  if (!fnWrite) return null;
  const fn = fnWrite[1];
  // the closure re-reads `this.a/.i/.w` from the mock, so global writes land in our proxy
  const before = m.rec.globalWrites.length;
  try { fn(11, 22, 33); } catch (e) { return null; }
  const got = {};
  for (const [k, v] of m.rec.globalWrites.slice(before)) got[k] = v;
  if (got.R0 !== 11 || got.R1 !== 22) return null;
  if (!Array.isArray(got.R2) || got.R2.length !== 3 || got.R2[0] !== 11) return null;

  // verify the rest-parameter flag as well
  const operands2 = operands.slice();
  operands2[layout.rest] = 1;
  operands2[layout.m] = 2;
  const full2 = full.slice();
  for (let i = 0; i < operands2.length; i++) full2[1 + i] = operands2[i];
  const m2 = runHandler(env, op, { code: full2, ip: 1, pool, globalValue: () => undefined });
  const fn2 = (m2.rec.regWrites.find(w => typeof w[1] === 'function') || [])[1];
  if (!fn2) return null;
  const b2 = m2.rec.globalWrites.length;
  try { fn2(11, 22, 33); } catch (e) { return null; }
  const got2 = {};
  for (const [k, v] of m2.rec.globalWrites.slice(b2)) got2[k] = v;
  if (got2.R0 !== 11 || !Array.isArray(got2.R1) || got2.R1.length !== 2 || got2.R1[0] !== 22) return null;
  return true;
}

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
  const fallback = { sizeSlot: 5, header: 13, verified: false };
  if (!li || !ret) return fallback;

  // an instruction whose result depends on frame slot  (other than the base)
  const findProbe = slot => {
    for (const [op, k] of env.kinds) {
      if (k.kind !== 'expr') continue;
      const dst = k.roles.indexOf('dst');
      const regs = k.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
      if (dst < 0 || !regs.length) continue;
      const operands = k.roles.map(r => (r === 'imm' ? 0x51ab73c1 : 0));
      operands[dst] = 3;
      regs.forEach((sl, i) => { operands[sl] = i + 1; });
      const run = v => runHandler(env, op, {
        code: [op, ...operands], ip: 1, regs: { 1: 123456, 2: 654321 }, frame: { [slot]: v },
      }).rec.regWrites[0];
      const w1 = run(100), w2 = run(200);
      if (w1 && w2 && !sameValue(w1[1], w2[1])) return { op, k, dst, regs, operands };
    }
    return null;
  };

  for (let slot = 0; slot < FRAME_SLOTS; slot++) {
    if (slot === env.PC || slot === env.slots.base) continue;
    const probe = findProbe(slot);
    if (!probe) continue;
    // oracle: run the same instruction on the real interpreter for several local counts
    const code = [];
    const liOps1 = []; liOps1[li.dst] = 1; liOps1[li.imm] = 123456;
    const liOps2 = []; liOps2[li.dst] = 2; liOps2[li.imm] = 654321;
    code.push(li.op, ...liOps1, li.op, ...liOps2, probe.op, ...probe.operands, ret.op, 3);
    const truths = [];
    for (const l of [8, 24, 47]) {
      try { truths.push([l, runRealVM(env, code, l)]); } catch (e) { /* ignore */ }
    }
    if (truths.length < 2) continue;
    for (let header = 0; header <= 48; header++) {
      let ok = true;
      for (const [l, truth] of truths) {
        const m = runHandler(env, probe.op, {
          code: [probe.op, ...probe.operands], ip: 1, regs: { 1: 123456, 2: 654321 },
          frame: { [slot]: header + l },
        });
        const w = m.rec.regWrites[0];
        if (!w || !sameValue(w[1], truth)) { ok = false; break; }
      }
      if (ok) return { sizeSlot: slot, header, verified: true, probeOp: probe.op };
    }
  }
  return fallback;
}

/* ================================================================== *
 * 8.  Environment set-up
 * ================================================================== */

function buildEnv(src) {
  const ast = parseSource(src);
  const boot = findBootstrap(ast);
  if (!boot || countHandlerAssignments(ast) < 8) return null;
  const cap = captureVM(ast);
  const proto = Object.getPrototypeOf(cap.state);
  const { fields, opcodes, PC } = discoverFields(cap.state, proto);
  const env = {
    ast, cap, proto, fields, opcodes, PC,
    pool: cap.state[fields.pool],
    code: Array.from(cap.state[fields.code]),
    sandbox: cap.sandbox,
    slots: { base: 0, this: 10, template: 12, try: 8 },
  };
  env.slots = discoverSlots(env);
  // Now that the special slots are known, hand handlers values of the right shape so
  // they always run to completion (and therefore consume all of their operands).
  env.frameDefaults = {
    [env.slots.try]: () => [],
    [env.slots.template]: () => makeTemplateProxy([], new Proxy({}, {
      get(_, k) { return typeof k === 'symbol' ? undefined : undefined; },
      set() { return true; },
    })),
  };
  env.kinds = classifyOpcodes(env);
  // for-in needs a second pass (it depends on the shape produced by forin_init)
  for (const [, k] of env.kinds) if (k.kind === 'forin_init') env.forin = k;
  if (env.forin) {
    for (const op of env.opcodes) {
      if (env.kinds.get(op).kind === 'expr') {
        const k = classifyOne(env, op);
        if (k.kind === 'forin_next') env.kinds.set(op, k);
      }
    }
  }
  env.meta = discoverFunctionMeta(env);
  env.meta.pairsStart = Math.max(env.meta.dstSlot, env.meta.entry, env.meta.m, env.meta.l,
    env.meta.countSlot, env.meta.rest) + 1;
  env.templateKeys = discoverTemplateKeys(env);
  env.mainTemplate = cap.template;
  env.decoded = new Map();
  env.symOrigin = new Map();
  // side-effect-free globals, for evaluating dispatcher helper functions during analysis
  env.pureGlobals = {
    Math, Number, String, Boolean, Array, Object, JSON, Date, RegExp, isNaN, isFinite,
    parseInt, parseFloat, undefined: undefined, NaN, Infinity,
  };
  // calls encode "apply an array of arguments" with a magic argument count
  for (const [, k] of env.kinds) {
    if (k.kind === 'call' || k.kind === 'call_method' || k.kind === 'new') {
      const m = /===\s*(\d{5,})/.exec(k.src);
      if (m) env.spreadMagic = Number(m[1]);
    }
  }
  env.frameLayout = discoverFrameLayout(env);
  return env;
}

/**
 * Map the mangled property names of a function template ({m,l,t,B}) onto their roles, by
 * building a function with distinctive meta values and reading the template back out of
 * the VM's function->template WeakMap.
 */
function discoverTemplateKeys(env) {
  const wm = Object.values(env.sandbox).find(v => v instanceof WeakMap);
  const layout = env.meta;
  const marks = { entry: 411, m: 422, l: 433, rest: 444 };
  const operands = new Array(6).fill(0);
  operands[layout.dstSlot] = 0;
  operands[layout.entry] = marks.entry;
  operands[layout.m] = marks.m;
  operands[layout.l] = marks.l;
  operands[layout.rest] = marks.rest;
  operands[layout.countSlot] = 0;
  const p = runHandler(env, layout.op, { code: [layout.op, ...operands], ip: 1 });
  const w = p.rec.regWrites.find(x => typeof x[1] === 'function');
  if (!wm || !w) return null;
  const tmpl = wm.get(w[1]);
  if (!tmpl) return null;
  const metaObj = Object.values(tmpl).find(v => v && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v).some(x => x === marks.entry));
  if (!metaObj) return null;
  const keys = {};
  for (const k of Object.keys(metaObj)) {
    for (const role of Object.keys(marks)) if (metaObj[k] === marks[role]) keys[role] = k;
  }
  keys.metaProp = Object.keys(tmpl).find(k => tmpl[k] === metaObj);
  keys.upvalsProp = Object.keys(tmpl).find(k => Array.isArray(tmpl[k]));
  return keys;
}

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
  ['-|0', x => -x | 0], ['~|0', x => ~x | 0],
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
function fitDataOpcode(env, kind, operands, opts = {}) {
  if (!opts.canonical) {
    const direct = fitDataOpcodeInner(env, kind, operands, opts);
    if (direct.form !== 'unknown') return direct;
    const regSlots0 = kind.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
    const aliased = new Set(regSlots0.map(i => operands[i])).size !== regSlots0.length;
    if (!aliased) return direct;
    const canon = fitDataOpcodeInner(env, kind, operands, { canonical: true });
    return canon.form !== 'unknown' ? canon : direct;
  }
  return fitDataOpcodeInner(env, kind, operands, opts);
}

function fitDataOpcodeInner(env, kind, operands, opts = {}) {
  const op = kind.op;
  const dstSlot = findDstSlot(env, kind, operands);
  const regSlots = kind.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
  const immSlots = kind.roles.map((r, i) => (r !== 'reg' ? i : -1)).filter(i => i >= 0 && i !== dstSlot);

  // Use the instruction's own operands.  Canonicalising the register numbers can break
  // the MBA identities (the operand words also seed the junk terms) and would hide
  // aliasing such as `r15 = f(r13, r13)`; only fall back to canonical registers when
  // the real ones are ambiguous because two register operands are the same.
  const canon = operands.slice();
  if (opts.canonical) regSlots.forEach((s, i) => { canon[s] = 900 + i; });
  const regsFor = vals => { const r = {}; regSlots.forEach((s, i) => { r[canon[s]] = vals[i]; }); return r; };
  const run = (ops, vals) => evalHandler(env, op, ops, regsFor(vals));

  // --- which inputs actually matter?  (probed from several baselines: a single one can
  //     easily hide a dependency, e.g. `x >>> y` looks constant when x is small)
  const baseVals = regSlots.map(() => 3);
  const baselines = [
    regSlots.map(() => 3),
    regSlots.map((_, i) => [123456, 7, 19][i % 3]),
    regSlots.map((_, i) => [-5, 17, 3][i % 3]),
    regSlots.map((_, i) => [65535, 1, 255][i % 3]),
  ];
  const varDeps = [];
  regSlots.forEach((s, i) => {
    for (const base of baselines) {
      const b = run(canon, base);
      for (const v of [5, 100, -7, 65535, 0, 3, 12345678]) {
        const vals = base.slice(); vals[i] = v;
        if (!same(run(canon, vals), b)) { varDeps.push(i); return; }
      }
    }
  });
  const immDeps = [];
  for (const s of immSlots) {
    let found = false;
    for (const base of baselines) {
      const b = run(canon, base);
      for (const v of [(operands[s] + 1) >>> 0, (operands[s] ^ 0x5555) >>> 0, 12345, 7, 0]) {
        const ops = canon.slice(); ops[s] = v;
        if (!same(run(ops, base), b)) { found = true; break; }
      }
      if (found) break;
    }
    if (found) immDeps.push(s);
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
  '+|0', '-|0', '*|0', '~|0'];
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


/* ================================================================== *
 * 11.  Whole-program analysis
 *
 * Every function is walked with a constant-propagation dataflow analysis.  That is what
 * defeats the control-flow flattening: each basic block ends by computing a numeric key
 * from an opaque predicate, handing it to a "dispatcher" function and jumping to whatever
 * program counter comes back.  Because the keys are compile-time constants, propagating
 * constants through the block resolves the computed jump into an ordinary edge (the
 * dispatcher call itself then becomes dead code and is removed later).
 * ================================================================== */

const UNKNOWN = Symbol('unknown');

/** A VM function value produced by `make_function`. */
function funcRef(env, operands) {
  const M = env.meta;
  const count = operands[M.countSlot];
  const upvals = [];
  for (let i = 0; i < count; i++) {
    upvals.push({ local: !!operands[M.pairsStart + i * 2], index: operands[M.pairsStart + i * 2 + 1] });
  }
  return {
    __fn: true, entry: operands[M.entry], m: operands[M.m], l: operands[M.l],
    rest: !!operands[M.rest], upvals,
  };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.__fn && b.__fn) return a.entry === b.entry && a.m === b.m;
    return false;
  }
  return false;
}

function mergeStates(a, b) {
  if (!a) return new Map(b);
  let changed = false;
  const out = new Map();
  for (const [k, v] of a) {
    if (!b.has(k)) { changed = true; continue; }
    const w = b.get(k);
    if (sameValue(v, w)) out.set(k, v);
    else { changed = true; if (v === UNKNOWN) out.set(k, UNKNOWN); }
  }
  for (const [k] of a) if (out.has(k) !== a.has(k)) changed = true;
  if (out.size !== a.size) changed = true;
  return { state: out, changed };
}

/** Decode (and cache) the instruction at `pc`. */
function instrAt(env, pc) {
  if (env.decoded.has(pc)) return env.decoded.get(pc);
  const op = env.code[pc];
  const kind = env.kinds.get(op);
  if (kind === undefined) {
    const bad = { pc, op, kind: 'invalid', k: null, operands: [], next: pc + 1 };
    env.decoded.set(pc, bad);
    return bad;
  }
  const m = runHandler(env, op, { code: env.code, ip: pc + 1, regValue: () => 1, globalValue: () => undefined });
  const operands = m.rec.operands;
  const ins = {
    pc, op, kind: kind.kind, k: kind, operands, next: pc + 1 + operands.length,
    globalName: m.rec.globalReads[0] !== undefined ? m.rec.globalReads[0]
      : (m.rec.globalHas[0] !== undefined ? m.rec.globalHas[0]
        : (m.rec.globalWrites[0] !== undefined ? m.rec.globalWrites[0][0] : undefined)),
  };
  env.decoded.set(pc, ins);
  return ins;
}

/** Execute an instruction against concrete register values (used by the const-prop pass). */
function execConcrete(env, ins, regs) {
  let unknownRead = false;
  const regsObj = {};
  for (const [k, v] of regs) if (v !== UNKNOWN && !(v && v.__fn)) regsObj[k] = v;
  const m = runHandler(env, ins.op, {
    code: env.code, ip: ins.pc + 1, regs: regsObj,
    regValue: () => { unknownRead = true; return 0; },
    globalValue: () => { unknownRead = true; return undefined; },
  });
  return { writes: m.rec.regWrites, unknownRead: unknownRead || !!m.rec.error, error: m.rec.error };
}

/**
 * Bounded, side-effect-free interpreter for VM functions.  Used to evaluate the
 * "dispatcher" helpers that control-flow flattening calls to turn a block key into a
 * program counter.  Anything it cannot prove harmless (unknown global, non-whitelisted
 * callee, too many steps) makes it bail out, and the caller falls back to UNKNOWN.
 */
const FAIL = Symbol('fail');

function pureFunctionSet(env) {
  if (env.pureFns) return env.pureFns;
  const set = new Set();
  const visit = (obj, depth) => {
    if (!obj || depth > 2) return;
    let names;
    try { names = Object.getOwnPropertyNames(obj); } catch (e) { return; }
    for (const n of names) {
      let v;
      try { v = obj[n]; } catch (e) { continue; }
      if (typeof v === 'function') { set.add(v); if (depth < 2) visit(v.prototype, depth + 1); }
      else if (v && typeof v === 'object' && depth < 2) visit(v, depth + 1);
    }
  };
  for (const k of Object.keys(env.pureGlobals)) visit(env.pureGlobals[k], 1);
  for (const k of Object.keys(env.pureGlobals)) if (typeof env.pureGlobals[k] === 'function') set.add(env.pureGlobals[k]);
  env.pureFns = set;
  return set;
}

function evalPure(env, fn, args, budget = { steps: 20000 }) {
  const prevFrameSize = env.currentFrameSize;
  env.currentFrameSize = env.frameLayout.header + fn.l;
  try { return evalPureInner(env, fn, args, budget); } finally { env.currentFrameSize = prevFrameSize; }
}

function evalPureInner(env, fn, args, budget) {
  const regs = new Map();
  for (let i = 0; i < fn.m; i++) regs.set(i, fn.rest && i === fn.m - 1 ? args.slice(i) : args[i]);
  if (fn.m < fn.l) regs.set(fn.m, args.slice());
  const pureFns = pureFunctionSet(env);
  let pc = fn.entry;
  while (true) {
    if (--budget.steps < 0 || pc < 0 || pc >= env.code.length) return FAIL;
    const ins = instrAt(env, pc);
    const k = ins.k, o = ins.operands;
    const get = slot => regs.get(o[slot]);
    switch (ins.kind) {
      case 'expr': case 'array': case 'object': {
        const r = execConcrete(env, ins, regs);
        if (r.error) return FAIL;
        for (const [reg, val] of r.writes) regs.set(reg, val);
        break;
      }
      case 'this': { const r = execConcrete(env, ins, regs); for (const [reg] of r.writes) regs.set(reg, undefined); break; }
      case 'load_global': {
        if (!(ins.globalName in env.pureGlobals)) return FAIL;
        const r = execConcrete(env, ins, regs);
        for (const [reg] of r.writes) regs.set(reg, env.pureGlobals[ins.globalName]);
        break;
      }
      case 'get_member': {
        const obj = get(k.objSlot), key = get(k.keySlot);
        if (obj === undefined || obj === null) return FAIL;
        let v;
        try { v = obj[key]; } catch (e) { return FAIL; }
        regs.set(o[k.dst], v);
        break;
      }
      case 'call': case 'call_method': case 'new': {
        const callee = get(k.calleeSlot);
        const argc = o[k.countSlot];
        if (argc === env.spreadMagic) return FAIL;
        const cargs = [];
        for (let i = 0; i < argc; i++) cargs.push(regs.get(o[k.countSlot + 1 + i]));
        if (callee && callee.__fn) {
          const v = evalPure(env, callee, cargs, budget);
          if (v === FAIL) return FAIL;
          regs.set(o[k.dstSlot], v);
          break;
        }
        if (typeof callee !== 'function' || !pureFns.has(callee)) { ins.impureNative = true; return FAIL; }
        ins.pureNative = true;
        try {
          regs.set(o[k.dstSlot], ins.kind === 'new' ? Reflect.construct(callee, cargs)
            : callee.apply(ins.kind === 'call_method' ? get(k.thisSlot) : undefined, cargs));
        } catch (e) { return FAIL; }
        break;
      }
      case 'make_function': regs.set(o[env.meta.dstSlot], funcRef(env, o)); break;
      case 'jmp': pc = o[k.target]; continue;
      case 'jz': case 'jnz': {
        const c = get(k.cond);
        const taken = ins.kind === 'jz' ? !c : !!c;
        pc = taken ? o[k.target] : ins.next;
        continue;
      }
      case 'jmp_reg': { const v = get(0); if (typeof v !== 'number') return FAIL; pc = v; continue; }
      case 'ret': return get(0);
      case 'nop': break;
      default: return FAIL;
    }
    pc = ins.next;
  }
}

function successorsOf(env, ins, resolvedTarget) {
  const o = ins.operands, k = ins.k;
  switch (ins.kind) {
    case 'jmp': return [o[k.target]];
    case 'jz': case 'jnz': return [o[k.target], ins.next];
    case 'forin_next': return [o[k.targetSlot], ins.next];
    case 'ret': case 'throw': case 'invalid': return [];
    case 'jmp_reg': return resolvedTarget === undefined || resolvedTarget === null ? [] : [resolvedTarget];
    case 'push_try': return [ins.next, o[k.shape ? Object.values(k.shape)[0] : 0]];
    default: return [ins.next];
  }
}

/** Run a pure VM function with the real interpreter (used to resolve dispatcher keys). */
function callVMFunction(env, fn, args) {
  const K = env.templateKeys;
  const P = env.cap.state.constructor;
  const T = env.cap.template.constructor;
  const state = new P(env.code, env.pureGlobals, env.pool);
  const tmpl = new T({ [K.m]: fn.m, [K.l]: fn.l, [K.entry]: fn.entry, [K.rest]: fn.rest ? 1 : 0 });
  return env.cap.runner(state, undefined, tmpl, undefined, args, []);
}

/**
 * Analyse one function: decode every reachable instruction, resolving computed jumps by
 * constant propagation.  Returns the instruction map plus the resolved edges.
 */
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

/** registers an instruction writes (best effort; `expr` handlers may bake the dst in) */
function writtenRegisters(env, ins) {
  const k = ins.k, o = ins.operands;
  if (!k) return [];
  const regs = [];
  for (let i = 0; i < k.roles.length; i++) if (k.roles[i] === 'dst') regs.push(o[i]);
  for (const key of ['dst', 'dstSlot']) {
    const s = k[key];
    if (typeof s === 'number' && s >= 0 && s < o.length) regs.push(o[s]);
  }
  if (ins.kind === 'make_function' && env.meta) regs.push(o[env.meta.dstSlot]);
  if (!regs.length && ins.kind === 'expr') {
    // specialised handler: the destination is baked into the body, so probe for it
    const s = findDstSlot(env, k, o);
    if (s >= 0) regs.push(o[s]);
  }
  return [...new Set(regs)];
}

/**
 * Registers whose values decide where the block starting at `pc` goes next.
 *
 * This exists for widening.  Control-flow flattening funnels every basic block through
 * one shared dispatcher tail, so that handful of program points is reached with a
 * different state per block per path — the state set there is unbounded as soon as the
 * function contains a loop whose trip count is not statically known, because each
 * unrolled iteration carries a fresh induction-variable value.  Widening is what stops
 * the exploration, but a plain join widens *everything*, including the register carrying
 * the block key, which turns the dispatcher back into an unresolvable indirect jump.
 *
 * Keeping this slice concrete instead bounds the state set by the number of distinct
 * block keys (finite: one per flattened block) while still collapsing the data registers
 * that caused the explosion.
 */
function controlSlice(env, pc) {
  if (!env.ctrlSlice) env.ctrlSlice = new Map();
  if (env.ctrlSlice.has(pc)) return env.ctrlSlice.get(pc);
  env.ctrlSlice.set(pc, new Set());               // guard against cycles while computing

  const chain = [];
  let cur = pc, jumps = 0;
  for (let i = 0; i < 128; i++) {
    const ins = instrAt(env, cur);
    if (!ins || !ins.k) break;
    chain.push(ins);
    if (ins.kind === 'jmp') {
      if (++jumps > 4) break;
      const target = ins.operands[ins.k.target];
      if (!(typeof target === 'number' && target >= 0 && target < env.code.length)) break;
      cur = target;
      continue;
    }
    if (['jmp_reg', 'jz', 'jnz', 'forin_next', 'ret', 'throw', 'invalid'].includes(ins.kind)) break;
    cur = ins.next;
  }

  const live = new Set();
  const isTerm = k => k === 'jmp_reg' || k === 'jz' || k === 'jnz' || k === 'forin_next';
  for (let i = chain.length - 1; i >= 0; i--) {
    const ins = chain[i];
    let touches = isTerm(ins.kind);
    for (const w of writtenRegisters(env, ins)) if (live.delete(w)) touches = true;
    if (touches) for (const r of readRegisters(env, ins)) live.add(r);
  }
  env.ctrlSlice.set(pc, live);
  return live;
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
function findConditionRegister(state, varId, origin) {
  let neg = null;
  // prefer the register the boolean was computed into: that is the program's own
  // comparison, rather than the opaque predicate the flattening derived from it
  if (origin !== undefined) {
    const v = state.get(origin);
    if (isSym(v) && v.vars.length === 1 && v.vars[0] === varId) {
      if (v.table[0] === false && v.table[1] === true) return { reg: origin, negate: false };
      if (v.table[0] === true && v.table[1] === false) return { reg: origin, negate: true };
    }
  }
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
        if (callee && callee.__fn) ins.calleeEntry = ins.calleeEntry === undefined || ins.calleeEntry === callee.entry ? callee.entry : -1;
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
        if (r === FAIL) { ins.impureCall = true; return null; }
        ins.pureCall = true;
        return new Map([[o[k.dstSlot], r]]);
      }
      case 'get_member': {
        const obj = concrete.get(o[k.objSlot]), key = concrete.get(o[k.keySlot]);
        if (!(obj && obj !== UNKNOWN && !obj.__fn && typeof obj === 'object' &&
              key !== undefined && key !== UNKNOWN && Object.prototype.hasOwnProperty.call(obj, key))) { ins.impureMember = true; return null; }
        ins.pureMember = true;
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
          if (boolean) {
            const id = ++symCounter;
            env.symOrigin.set(id, reg);
            out.set(reg, makeSym([id], [false, true]));
          } else out.set(reg, UNKNOWN);
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
      const cond = findConditionRegister(state, varId, env.symOrigin.get(varId));
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
    const targetPc = o[k.target], nextPc = ins.next;
    if (isSym(c)) {
      const varId = c.vars[0];
      const takes = v => (ins.kind === 'jz' ? !pickValue(c, [varId], v) : !!pickValue(c, [varId], v));
      const tTrue = takes(1), tFalse = takes(0);
      if (tTrue === tFalse) {
        succ = [{ pc: tTrue ? targetPc : nextPc, st: out }];
        resolvedTo = succ[0].pc;
      } else {
        succ = [
          { pc: targetPc, st: specialize(out, varId, tTrue) },
          { pc: nextPc, st: specialize(out, varId, !tTrue) },
        ];
      }
    } else if (c !== undefined && c !== UNKNOWN) {
      const taken = ins.kind === 'jz' ? !c : !!c;
      succ = [{ pc: taken ? targetPc : nextPc, st: out }];
      resolvedTo = succ[0].pc;
    } else {
      succ = [{ pc: targetPc, st: out }, { pc: nextPc, st: out }];
    }
  } else {
    succ = successorsOf(env, ins, null).map(p => ({ pc: p, st: out }));
  }
  return { ins, out, succ: finish(succ), children, unresolved, resolvedTo, branch };
}

/**
 * Analyse one function.  Nodes are (pc, state) pairs, so a block that is reachable with
 * different constant states is analysed — and later emitted — once per state.  That is
 * what un-flattens the control flow: the shared dispatcher tail is specialised back into
 * each of its callers, where its computed jump is a compile-time constant again.
 */
function exploreFunction(env, fn, pinned) {
  const prevFrameSize = env.currentFrameSize;
  env.currentFrameSize = env.frameLayout.header + fn.l;
  const nodes = new Map();           // nodeId -> {pc, state, ins, succ:[nodeId], resolvedTo}
  const perPc = new Map();           // pc -> [nodeId]
  const children = new Map();        // entry -> funcRef
  const unresolved = [];
  const capped = new Set();          // program points that overflowed the state budget
  const MAX_STATES = env.maxStatesPerPc || 512;
  const HARD_STATES = MAX_STATES * 4;
  const MAX_NODES = env.maxNodes || 400000;

  const valueKey = v => v && v.__fn ? 'f' + v.entry
    : isSym(v) ? 'y[' + v.vars.join('.') + ']{' + v.table.map(x => (x && typeof x === 'object' ? 'o' : String(x))).join('|') + '}'
    : typeof v === 'object' ? 'o' : typeof v === 'string' ? 's' + v : String(v);
  const keyOf = (pc, st) => {
    const parts = [];
    for (const [r, v] of st) {
      if (v === UNKNOWN || v === undefined) continue;
      parts.push(r + ':' + valueKey(v));
    }
    parts.sort();
    return pc + '|' + parts.join(',');
  };

  // widening: when one pc is reached with too many different states, fold them into a
  // state that keeps only what every path agrees on.  The registers that decide where the
  // block goes next are exempt (see controlSlice) — those are what the flattening
  // dispatcher reads, and losing them costs a resolved jump; the data registers that
  // caused the explosion are folded as before.  If even that is not enough to converge,
  // the hard limit falls back to joining everything, so termination is still guaranteed.
  const widen = (list, st, pc, total) => {
    let keep = total ? null : controlSlice(env, pc);
    if (keep) {
      // When a kept register is symbolic the jump is a real branch, and emitting it needs
      // the register that holds the deciding boolean as well — widening that away leaves a
      // branch nobody can name, which is just as unresolvable as a widened jump target.
      const vars = new Set();
      for (const r of keep) { const v = st.get(r); if (isSym(v)) for (const id of v.vars) vars.add(id); }
      if (vars.size) {
        keep = new Set(keep);
        for (const id of vars) {
          const origin = env.symOrigin.get(id);
          if (origin !== undefined) keep.add(origin);
        }
        for (const [r, v] of st) {
          if (isSym(v) && v.vars.length === 1 && vars.has(v.vars[0]) &&
              typeof v.table[0] === 'boolean' && typeof v.table[1] === 'boolean') keep.add(r);
        }
      }
    }
    const out = new Map(st);
    for (const other of list) {
      for (const [r, v] of out) {
        if (keep && keep.has(r)) continue;
        const w = other.state.get(r);
        if (!sameValue(v, w)) out.set(r, UNKNOWN);
      }
    }
    return out;
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
    node.branch = r.branch;
    if (r.unresolved) unresolved.push(node.pc);
    for (const ref of r.children) if (!children.has(ref.entry)) children.set(ref.entry, ref);
    node.succ = [];
    for (const s of r.succ) {
      let st = s.st;
      // registers the driver has decided to abstract (see analyzeFunction)
      if (pinned && pinned.size) {
        let copy = null;
        for (const p of pinned) {
          if (st.has(p) && st.get(p) !== UNKNOWN) { copy = copy || new Map(st); copy.set(p, UNKNOWN); }
        }
        if (copy) st = copy;
      }
      const list = perPc.get(s.pc) || [];
      // too many paths: widen (control registers first, everything past the hard limit)
      if (list.length >= MAX_STATES) { capped.add(s.pc); st = widen(list, st, s.pc, list.length >= HARD_STATES); }

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
  env.currentFrameSize = prevFrameSize;
  return { nodes, perPc, children: [...children.values()], unresolved, entryId: entryNode.id, capped };
}

/**
 * Which registers should be abstracted before re-exploring?
 *
 * A program point overflows its state budget when the states reaching it are a *product*:
 * one factor per register that keeps taking new values.  For the flattening dispatcher —
 * the block every other block jumps through — one factor is the block key, which is finite
 * and must stay concrete, and the other is whatever a loop carries.  An induction variable
 * in a loop whose trip count is not statically known produces a fresh value every
 * iteration, so the product never converges and the budget is spent unrolling instead of
 * on the paths that matter.
 *
 * Registers that never decide control flow cannot cost a resolved jump, so abstracting the
 * exploding ones lets the loop reach a fixpoint after one iteration.  Registers that hold
 * function values are exempt: closure discovery and call resolution need them concrete.
 */
function explosionRegisters(env, res) {
  const control = new Set();
  for (const pc of res.perPc.keys()) for (const r of controlSlice(env, pc)) control.add(r);
  const functionValued = new Set();
  for (const [, n] of res.nodes) for (const [r, v] of n.state) if (v && v.__fn) functionValued.add(r);
  // a register that ever holds a symbolic boolean carries one of the program's own
  // conditions; abstracting it would turn a real if/else into an unresolved jump
  const conditional = new Set(env.symOrigin.values());
  for (const [, n] of res.nodes) for (const [r, v] of n.state) if (isSym(v)) conditional.add(r);

  const pin = new Set();
  for (const pc of res.capped) {
    const seen = new Map();
    for (const n of res.perPc.get(pc) || []) {
      for (const [r, v] of n.state) {
        if (v === UNKNOWN || v === undefined || isSym(v) || (v && typeof v === 'object')) continue;
        if (!seen.has(r)) seen.set(r, new Set());
        seen.get(r).add(v);
      }
    }
    for (const [r, values] of seen) {
      if (values.size > 1 && !control.has(r) && !functionValued.has(r) && !conditional.has(r)) pin.add(r);
    }
  }
  return pin;
}

/**
 * Analyse one function, abstracting the registers that make the exploration diverge and
 * retrying once.  The first pass is the precise one; it only needs redoing when some
 * program point overflowed, which in practice means a loop was being unrolled.
 */
function analyzeFunction(env, fn) {
  const first = exploreFunction(env, fn, null);
  if (!first.capped.size) return first;
  const pin = explosionRegisters(env, first);
  if (!pin.size) return first;
  const second = exploreFunction(env, fn, pin);
  // only take the retry if it actually helped: fewer unresolved jumps, and no new overflow
  if (second.unresolved.length <= first.unresolved.length && second.capped.size <= first.capped.size) {
    second.abstracted = pin;
    return second;
  }
  return first;
}

/** Discover every function in the program, starting from the main template. */
function analyzeProgram(env) {
  const K = env.templateKeys;
  const mainMeta = env.mainTemplate[K.metaProp];
  const main = {
    id: 0, entry: mainMeta[K.entry], m: mainMeta[K.m], l: mainMeta[K.l],
    rest: !!mainMeta[K.rest], upvals: [], parent: null, main: true,
  };
  const funcs = new Map([[main.entry, main]]);
  const order = [main];
  const queue = [main];
  let nextId = 1;
  while (queue.length) {
    const fn = queue.shift();
    const res = analyzeFunction(env, fn);
    Object.assign(fn, res);
    for (const ref of res.children) {
      let f = funcs.get(ref.entry);
      if (!f) {
        f = {
          id: nextId++, entry: ref.entry, m: ref.m, l: ref.l, rest: ref.rest,
          upvals: ref.upvals, parent: fn,
        };
        funcs.set(ref.entry, f);
        order.push(f);
        queue.push(f);
      }
    }
  }
  return { funcs, order, main };
}


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
  for (let iter = 0; iter < 5000; iter++) {
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
        id: c, pc: n.pc, ins: n.ins, branch: n.branch, state: n.state,
        succ: (n.succ || []).map(s => key.get(s)),
      });
    }
  }
  return { blocks, entry: key.get(fn.entryId), classOf: key };
}

/** Chain single-entry/single-exit instruction nodes into basic blocks. */
function pruneUnreachable(bbs, entry) {
  const seen = new Set();
  const work = [entry];
  while (work.length) {
    const id = work.pop();
    if (seen.has(id) || !bbs.has(id)) continue;
    seen.add(id);
    for (const sc of bbs.get(id).succ) work.push(sc);
  }
  for (const id of [...bbs.keys()]) if (!seen.has(id)) bbs.delete(id);
  return bbs;
}

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
  pruneUnreachable(bbs, entry);
  return { bbs, entry, preds };
}

/**
 * Tail-duplicate small join nodes.  Flattening reuses one node as the tail of many
 * blocks; duplicating those nodes (they are identical by construction) turns the graph
 * back into long straight-line runs, which is what lets expressions re-nest.
 */
function duplicateJoins(merged, limit = 6) {
  const { blocks } = merged;
  const originalSize = blocks.size;
  for (let round = 0; round < 6; round++) {
    const preds = new Map();
    for (const [id, b] of blocks) for (const sc of b.succ) {
      if (!preds.has(sc)) preds.set(sc, []);
      preds.get(sc).push(id);
    }
    // back edges (targets of a cycle) must not be duplicated
    const onStack = new Set(), visited = new Set(), backTargets = new Set();
    const dfs = id => {
      if (onStack.has(id)) { backTargets.add(id); return; }
      if (visited.has(id)) return;
      visited.add(id); onStack.add(id);
      for (const sc of blocks.get(id).succ) if (blocks.has(sc)) dfs(sc);
      onStack.delete(id);
    };
    dfs(merged.entry);
    let changed = false;
    for (const [id, b] of [...blocks]) {
      const ps = preds.get(id) || [];
      if (ps.length < 2 || backTargets.has(id) || id === merged.entry) continue;
      if (blocks.size > originalSize * 4) break;
      // clone for every predecessor but the first
      for (let i = 1; i < ps.length; i++) {
        const copy = { ...b, id: b.id + '#' + blocks.size, succ: b.succ.slice() };
        blocks.set(copy.id, copy);
        const pred = blocks.get(ps[i]);
        pred.succ = pred.succ.map(x => (x === id ? copy.id : x));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return merged;
}

/* ---------------- IR ---------------- */

const IR = {
  reg: i => ({ t: 'reg', i }),
  lit: v => ({ t: 'lit', v }),
  bin: (op, l, r) => ({ t: 'bin', op, l, r }),
  un: (op, a) => ({ t: 'un', op, a }),
};

/**
 * Once the member expression has been re-nested into the callee, a method call mentions
 * its object twice (as `this` and inside the callee).  Dropping the redundant `this`
 * lets the object expression itself be inlined.
 */
function normalizeCalls(node) {
  if (!node || typeof node !== 'object') return node;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(normalizeCalls);
    else if (v && typeof v === 'object' && v.t) normalizeCalls(v);
  }
  if (node.t === 'call' && node.thisArg && node.callee && node.callee.t === 'member' &&
      sameIR(node.callee.obj, node.thisArg)) {
    node.thisArg = null;
  }
  return node;
}

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

const DUPLICABLE = new Set(['lit', 'global', 'reg', 'this', 'typeofglobal']);
const PURE_EXPR = new Set(['reg', 'lit', 'bin', 'un', 'array', 'object', 'func', 'this', 'closure',
  'unknown', 'global', 'typeofglobal', 'opaque']);
function irIsPure(e) {
  if (!e || typeof e !== 'object') return true;
  // a call the analysis fully evaluated is a dispatcher helper: no side effects
  // reading a property of a value the analysis produced itself (or of the result of a
  // side-effect-free helper call) cannot run user code, so it may be dropped when dead
  if (e.t === 'call' && e.pure) { /* fall through to the operand scan */ }
  else if (e.t === 'member' && (e.pure || (e.obj && e.obj.t === 'call' && e.obj.pure))) { /* ditto */ }
  else if (!PURE_EXPR.has(e.t)) return false;
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
  if (op === '-|0') return -a | 0;
  if (op === '~|0') return ~a | 0;
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
function liftInstruction(env, fn, ins, node) {
  const state = (node && node.state) || new Map();
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
        // No JavaScript operator reproduces this handler (a multi-round MBA mixer).  Keep
        // the original handler verbatim behind a helper so the output still runs.
        const regSlots = ins.k.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
        assign(o[fit.dstSlot >= 0 ? fit.dstSlot : 0], {
          t: 'opaque', op: ins.op, operands: o.slice(),
          args: regSlots.map(sl => IR.reg(o[sl])),
          regSlots: regSlots.map(sl => o[sl]),
          dstReg: o[fit.dstSlot >= 0 ? fit.dstSlot : 0],
          frameSize: env.currentFrameSize,
        });
      }
      break;
    }
    case 'this': assign(o[0], { t: 'this' }); break;
    case 'load_global': assign(o[k.dst], { t: 'global', name: ins.globalName }); break;
    case 'typeof_global': assign(o[k.dst], { t: 'typeofglobal', name: ins.globalName }); break;
    case 'store_global': effect({ t: 'setglobal', name: ins.globalName, value: IR.reg(o[k.valueSlot]) }); break;
    case 'get_member': {
      const known = state.get(o[k.objSlot]);
      const pure = !!(known && known !== UNKNOWN && typeof known === 'object' && !known.__fn);
      assign(o[k.dst], { t: 'member', obj: IR.reg(o[k.objSlot]), key: IR.reg(o[k.keySlot]), pure });
      break;
    }
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
        pure: (() => {
          const c = state.get(o[k.calleeSlot]);
          return !!(c && c.__fn && env.effectFree && env.effectFree.has(c.entry));
        })(),
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

/* ------------------------------------------------------------------ *
 * Control-flow structuring
 *
 * The flattened bytecode is an ordinary (reducible) control-flow graph once the
 * dispatcher has been resolved, so it can be turned back into if/else and loops with
 * dominator analysis.  Anything that will not structure cleanly falls back to a labelled
 * dispatch loop for that function, which is ugly but always correct.
 * ------------------------------------------------------------------ */

function computeDominators(bbs, entry) {
  const order = [];
  const seen = new Set();
  (function dfs(id) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const s of bbs.get(id).succ) if (bbs.has(s)) dfs(s);
    order.push(id);
  })(entry);
  const rpo = order.slice().reverse();
  const idx = new Map(rpo.map((id, i) => [id, i]));
  const preds = new Map();
  for (const id of rpo) preds.set(id, []);
  for (const id of rpo) for (const s of bbs.get(id).succ) if (preds.has(s)) preds.get(s).push(id);
  const idom = new Map([[entry, entry]]);
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
    for (const id of rpo) {
      if (id === entry) continue;
      let newIdom = null;
      for (const p of preds.get(id)) {
        if (!idom.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(p, newIdom);
      }
      if (newIdom !== null && idom.get(id) !== newIdom) { idom.set(id, newIdom); changed = true; }
    }
  }
  return { idom, rpo, idx, preds };
}

function findLoops(bbs, dom) {
  const { idom, idx, preds } = dom;
  const dominates = (a, b) => {
    let cur = b;
    while (true) {
      if (cur === a) return true;
      const nxt = idom.get(cur);
      if (nxt === undefined || nxt === cur) return false;
      cur = nxt;
    }
  };
  const loops = new Map();      // header -> {header, body:Set, latches:[]}
  for (const [id, bb] of bbs) {
    if (!idx.has(id)) continue;
    for (const s of bb.succ) {
      if (!bbs.has(s) || !idx.has(s)) continue;
      if (dominates(s, id)) {
        let loop = loops.get(s);
        if (!loop) { loop = { header: s, body: new Set([s]), latches: [] }; loops.set(s, loop); }
        loop.latches.push(id);
        const stack = [id];
        while (stack.length) {
          const n = stack.pop();
          if (loop.body.has(n)) continue;
          loop.body.add(n);
          for (const p of preds.get(n) || []) stack.push(p);
        }
      }
    }
  }
  for (const [, loop] of loops) {
    loop.exits = new Set();
    for (const n of loop.body) for (const s of bbs.get(n).succ) if (!loop.body.has(s) && bbs.has(s)) loop.exits.add(s);
  }
  return { loops, dominates };
}

/**
 * Emit a function body as structured statements.  Throws `RESTRUCTURE` when the graph
 * does not fit if/else + loops, so the caller can fall back to the dispatch loop.
 */
const RESTRUCTURE = Symbol('restructure');

function structureFunction(ctx, bbs, entry) {
  const dom = computeDominators(bbs, entry);
  const { loops, dominates } = findLoops(bbs, dom);
  const emitted = new Set();
  const loopStack = [];
  let labelCounter = 0;

  const postDominatorJoin = (a, b, stop) => {
    // first block reachable from both branches (approximated by the dominator tree)
    const seenA = new Set();
    let cur = a;
    while (cur !== undefined) { seenA.add(cur); cur = dom.idom.get(cur) === cur ? undefined : dom.idom.get(cur); }
    return null;
  };

  const emitSeq = (id, stop) => {
    const stmts = [];
    let cur = id;
    const guard = new Set();
    while (cur !== undefined && cur !== null) {
      if (stop.has(cur)) { stmts.push(...jumpTo(cur, stop)); return stmts; }
      const brk = breakOrContinue(cur);
      if (brk) { stmts.push(brk); return stmts; }
      if (guard.has(cur)) throw RESTRUCTURE;
      guard.add(cur);
      const loop = loops.get(cur);
      if (loop && !loopStack.some(l => l.header === cur)) {
        const { stmt, after } = emitLoop(loop, stop);
        stmts.push(stmt);
        cur = after;
        continue;
      }
      if (emitted.has(cur)) throw RESTRUCTURE;
      emitted.add(cur);
      const bb = bbs.get(cur);
      stmts.push(...ctx.blockStatements(bb));
      const term = ctx.terminator(bb);
      if (term.kind === 'return' || term.kind === 'throw') { stmts.push(term.stmt); return stmts; }
      if (term.kind === 'branch') {
        const join = findJoin(bb, stop);
        const innerStop = new Set(stop);
        if (join) innerStop.add(join);
        const consequent = emitSeq(term.trueTarget, innerStop);
        const alternate = term.falseTarget !== undefined ? emitSeq(term.falseTarget, innerStop) : [];
        stmts.push(ctx.makeIf(term.test, consequent, alternate));
        cur = join;
        continue;
      }
      cur = term.target;
    }
    return stmts;
  };

  const jumpTo = (target, stop) => {
    const brk = breakOrContinue(target);
    return brk ? [brk] : [];
  };

  const breakOrContinue = target => {
    for (let i = loopStack.length - 1; i >= 0; i--) {
      const l = loopStack[i];
      if (target === l.header) return ctx.makeContinue(i === loopStack.length - 1 ? null : l.label());
      if (target === l.exit) return ctx.makeBreak(i === loopStack.length - 1 ? null : l.label());
    }
    return null;
  };

  const findJoin = (bb, stop) => {
    // the nearest block dominated by bb that both successors reach
    const [t, f] = bb.succ;
    const reach = start => {
      const out = new Set();
      const work = [start];
      while (work.length) {
        const n = work.pop();
        if (n === undefined || out.has(n) || !bbs.has(n)) continue;
        out.add(n);
        for (const s of bbs.get(n).succ) work.push(s);
      }
      return out;
    };
    if (t === undefined || f === undefined) return undefined;
    const rt = reach(t), rf = reach(f);
    let best;
    for (const id of dom.rpo) {
      if (rt.has(id) && rf.has(id) && dominates(bb.id, id) && !emitted.has(id)) { best = id; break; }
    }
    return best;
  };

  const emitLoop = (loop, stop) => {
    const exits = [...loop.exits];
    const exit = exits.length ? exits[0] : undefined;
    let labelName = null;
    const entryCtx = {
      header: loop.header, exit,
      label: () => { if (!labelName) labelName = ctx.newLabel(); return labelName; },
    };
    loopStack.push(entryCtx);
    const innerStop = new Set(stop);
    for (const e of exits) innerStop.add(e);
    emitted.add(loop.header);
    const bb = bbs.get(loop.header);
    const body = [...ctx.blockStatements(bb)];
    const term = ctx.terminator(bb);
    if (term.kind === 'return' || term.kind === 'throw') body.push(term.stmt);
    else if (term.kind === 'branch') {
      const consequent = emitSeq(term.trueTarget, innerStop);
      const alternate = term.falseTarget !== undefined ? emitSeq(term.falseTarget, innerStop) : [];
      body.push(ctx.makeIf(term.test, consequent, alternate));
    } else if (term.target !== undefined) {
      body.push(...emitSeq(term.target, innerStop));
    }
    loopStack.pop();
    // exits other than the primary one need labelled breaks; they were emitted as breaks
    const stmt = ctx.makeLoop(body, labelName);
    return { stmt, after: exit !== undefined && !stop.has(exit) ? exit : undefined };
  };

  const body = emitSeq(entry, new Set());
  return body;
}

/* ------------------------------------------------------------------ *
 * IR -> JavaScript
 * ------------------------------------------------------------------ */

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public', 'null', 'true', 'false']);

function varPrefix(id) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return id < 26 ? letters[id] : letters[id % 26] + Math.floor(id / 26);
}

function literalNode(v) {
  if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
  if (v === null) return t.nullLiteral();
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return t.identifier('NaN');
    if (v === Infinity) return t.identifier('Infinity');
    if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
    return v < 0 || Object.is(v, -0) ? t.unaryExpression('-', t.numericLiteral(Math.abs(v))) : t.numericLiteral(v);
  }
  if (Array.isArray(v)) return t.arrayExpression(v.map(literalNode));
  if (typeof v === 'object') {
    return t.objectExpression(Object.keys(v).map(kk => t.objectProperty(
      IDENT_RE.test(kk) && !RESERVED.has(kk) ? t.identifier(kk) : t.stringLiteral(kk), literalNode(v[kk]))));
  }
  return t.identifier('undefined');
}

const INT_OPS = { '+|0': '+', '-|0': '-' };

function makeEmitter(env, prog, fnInfo, helpers) {
  const prefix = varPrefix(fnInfo.id);
  const used = new Set();
  const regName = i => { used.add(i); return prefix + i; };

  const ownerOfUpvalue = (fn, index) => {
    // resolve upvalue `index` of `fn` to the (function, register) that really owns it
    let cur = fn, idx = index;
    while (cur && cur.upvals && cur.upvals[idx]) {
      const uv = cur.upvals[idx];
      if (uv.local) return { fn: cur.parent, reg: uv.index };
      cur = cur.parent; idx = uv.index;
    }
    return null;
  };

  const expr = e => {
    switch (e.t) {
      case 'reg': return t.identifier(regName(e.i));
      case 'lit': return literalNode(e.v);
      case 'this': return fnInfo.main ? t.identifier('undefined') : t.thisExpression();
      case 'bin': {
        if (e.op === '*|0') return t.callExpression(t.memberExpression(t.identifier('Math'), t.identifier('imul')), [expr(e.l), expr(e.r)]);
        if (INT_OPS[e.op]) return t.binaryExpression('|', t.binaryExpression(INT_OPS[e.op], expr(e.l), expr(e.r)), t.numericLiteral(0));
        return t.binaryExpression(e.op, expr(e.l), expr(e.r));
      }
      case 'un': {
        if (e.op === '!!') return t.unaryExpression('!', t.unaryExpression('!', expr(e.a)));
        if (e.op === '|0') return t.binaryExpression('|', expr(e.a), t.numericLiteral(0));
        if (e.op === '>>>0') return t.binaryExpression('>>>', expr(e.a), t.numericLiteral(0));
        if (e.op === '-|0') return t.binaryExpression('|', t.unaryExpression('-', expr(e.a)), t.numericLiteral(0));
        if (e.op === '~|0') return t.unaryExpression('~', expr(e.a));
        return t.unaryExpression(e.op, expr(e.a));
      }
      case 'member': {
        const key = e.key;
        if (key.t === 'lit' && typeof key.v === 'string' && IDENT_RE.test(key.v) && !RESERVED.has(key.v)) {
          return t.memberExpression(expr(e.obj), t.identifier(key.v));
        }
        return t.memberExpression(expr(e.obj), expr(key), true);
      }
      case 'global': return IDENT_RE.test(e.name) && !RESERVED.has(e.name)
        ? t.identifier(e.name)
        : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(e.name), true);
      case 'typeofglobal': return t.unaryExpression('typeof', IDENT_RE.test(e.name) && !RESERVED.has(e.name)
        ? t.identifier(e.name)
        : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(e.name), true));
      case 'array': return t.arrayExpression(e.els.map(expr));
      case 'object': return t.objectExpression(e.props.map(p => {
        if (p.key.t === 'lit' && typeof p.key.v === 'string' && IDENT_RE.test(p.key.v) && !RESERVED.has(p.key.v)) {
          return t.objectProperty(t.identifier(p.key.v), expr(p.value));
        }
        if (p.key.t === 'lit' && (typeof p.key.v === 'string' || typeof p.key.v === 'number')) {
          return t.objectProperty(literalNode(p.key.v), expr(p.value));
        }
        return t.objectProperty(expr(p.key), expr(p.value), true);
      }));
      case 'delete': {
        const m = expr({ t: 'member', obj: e.obj, key: e.key });
        return t.unaryExpression('delete', m);
      }
      case 'call': {
        const args = e.spread ? [t.spreadElement(expr(e.args[0]))] : e.args.map(expr);
        if (e.isNew) return t.newExpression(expr(e.callee), args);
        if (e.thisArg) {
          const callee = e.callee, thisArg = e.thisArg;
          // `obj.m(...)` when the callee is a member expression of the same object
          if (callee.t === 'member' && sameIR(callee.obj, thisArg)) return t.callExpression(expr(callee), args);
          if (callee.t === 'reg' && thisArg.t === 'reg' && callee.i === thisArg.i) return t.callExpression(expr(callee), args);
          const call = t.memberExpression(expr(callee), t.identifier(e.spread ? 'apply' : 'call'));
          return t.callExpression(call, e.spread
            ? [expr(thisArg), expr(e.args[0])]
            : [expr(thisArg), ...args]);
        }
        return t.callExpression(expr(e.callee), args);
      }
      case 'func': return helpers.functionExpression(e.ref);
      case 'closure': {
        const owner = ownerOfUpvalue(fnInfo, e.index);
        if (!owner || !owner.fn) return t.identifier('undefined');
        return t.identifier(varPrefix(owner.fn.id) + owner.reg);
      }
      case 'forinkeys': return t.callExpression(t.identifier(helpers.forInHelper()), [expr(e.obj)]);
      case 'forinnext': return t.callExpression(t.memberExpression(expr(e.iter), t.identifier('next')), []);
      case 'unknown': return t.identifier('__vm_unknown_' + e.op);
      case 'opaque': return t.callExpression(t.identifier(helpers.opaqueHelper(e)), e.args.map(expr));
      default: throw new Error('cannot emit expression ' + e.t);
    }
  };

  const statement = s => {
    switch (s.kind) {
      case 'assign': return t.expressionStatement(t.assignmentExpression('=', t.identifier(regName(s.dst)), expr(s.expr)));
      case 'effect': {
        const e = s.expr;
        if (e.t === 'setglobal') {
          const target = IDENT_RE.test(e.name) && !RESERVED.has(e.name)
            ? t.identifier(e.name)
            : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(e.name), true);
          return t.expressionStatement(t.assignmentExpression('=', target, expr(e.value)));
        }
        if (e.t === 'setmember') {
          return t.expressionStatement(t.assignmentExpression('=', expr({ t: 'member', obj: e.obj, key: e.key }), expr(e.value)));
        }
        if (e.t === 'setclosure') {
          const owner = ownerOfUpvalue(fnInfo, e.index);
          const target = owner && owner.fn ? t.identifier(varPrefix(owner.fn.id) + owner.reg) : t.identifier('__vm_upvalue');
          return t.expressionStatement(t.assignmentExpression('=', target, expr(e.value)));
        }
        if (e.t === 'defineaccessor') {
          return t.expressionStatement(t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
            [expr(e.obj), expr(e.key), t.objectExpression([
              t.objectProperty(t.identifier(e.accessor), expr(e.value)),
              t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
              t.objectProperty(t.identifier('enumerable'), t.booleanLiteral(true)),
            ])]));
        }
        return t.expressionStatement(expr(e));
      }
      case 'ret': {
        const v = s.expr;
        if (v && v.t === 'lit' && v.v === undefined) return t.returnStatement(null);
        return t.returnStatement(expr(v));
      }
      case 'throw': return t.throwStatement(expr(s.expr));
      case 'debugger': return t.debuggerStatement();
      case 'trap': {
        const st = t.throwStatement(t.newExpression(t.identifier('Error'),
          [t.stringLiteral('vm.js: unresolved computed jump at bytecode offset ' + s.pc)]));
        t.addComment(st, 'leading', ' the flattening dispatcher could not be resolved here (dead opaque-predicate path) ');
        return st;
      }
      case 'comment': {
        const st = t.emptyStatement();
        t.addComment(st, 'leading', ' ' + s.text + ' ');
        return st;
      }
      case 'push_try': case 'pop_try': return null;
      default: throw new Error('cannot emit statement ' + s.kind);
    }
  };

  return { expr, statement, regName, used, prefix };
}

function sameIR(a, b) {
  if (!a || !b) return false;
  if (a.t !== b.t) return false;
  if (a.t === 'reg') return a.i === b.i;
  if (a.t === 'lit') return sameValue(a.v, b.v);
  if (a.t === 'global' || a.t === 'typeofglobal') return a.name === b.name;
  if (a.t === 'this') return true;
  if (a.t === 'member') return sameIR(a.obj, b.obj) && sameIR(a.key, b.key);
  return false;
}

/* ------------------------------------------------------------------ *
 * Optimisation passes on the IR (dead code + expression re-nesting)
 * ------------------------------------------------------------------ */

/**
 * Whole-function dead code elimination.
 *
 * Liveness alone cannot remove the flattening's state variable: every block updates it
 * from its own previous value, so it keeps itself alive even though nothing ever reads
 * it.  This marks the statements that are actually needed (side effects, returns, branch
 * conditions, captured variables) and works backwards through the def/use graph; whatever
 * is left over is deleted no matter how it is entangled with itself.
 */
function globalDeadCode(bbs, capturedRegs) {
  const defsOf = new Map();          // register -> [statement]
  const all = [];
  for (const [, bb] of bbs) {
    for (const st of bb.ir) {
      all.push({ st, bb });
      if (st.kind === 'assign') {
        if (!defsOf.has(st.dst)) defsOf.set(st.dst, []);
        defsOf.get(st.dst).push(st);
      }
    }
  }
  const needed = new Set();
  const neededRegs = new Set(capturedRegs);
  const work = [];
  const need = st => { if (!needed.has(st)) { needed.add(st); work.push(st); } };
  for (const { st } of all) {
    if (st.kind !== 'assign') need(st);                       // effects, returns, throws…
    else if (!irIsPure(st.expr)) need(st);
    else if (capturedRegs.has(st.dst)) need(st);
  }
  if (process.env.VMDEBUG_GDCE) { const seeds=[]; for (const {st} of all) if (needed.has(st)) seeds.push(st.kind+(st.dst!==undefined?":r"+st.dst:"")+" reads "+statementReads(st).join(",")+" "+JSON.stringify(st.expr).slice(0,70)); console.error("[gdce] seeds:", seeds.slice(0,12).join(" || ")); }
  for (const [, bb] of bbs) if (bb.term && bb.term.test) for (const r of irUsesRegisters(bb.term.test)) neededRegs.add(r);
  for (const r of neededRegs) for (const st of defsOf.get(r) || []) need(st);
  while (work.length) {
    const st = work.pop();
    for (const r of statementReads(st)) {
      if (neededRegs.has(r)) continue;
      neededRegs.add(r);
      for (const d of defsOf.get(r) || []) need(d);
    }
  }
  if (process.env.VMDEBUG_GDCE && neededRegs.has(Number(process.env.VMDEBUG_GDCE))) {
    const R=Number(process.env.VMDEBUG_GDCE);
    for (const { st } of all) if (needed.has(st) && statementReads(st).includes(R)) console.error("[gdce] r"+R+" read by", st.kind, "dst r"+st.dst, JSON.stringify(st.expr).slice(0,150));
    console.error("[gdce] ---");
    for (const { st } of all) if (needed.has(st) && statementReads(st).includes(13)) { console.error("[gdce] r13 needed by", st.kind, st.dst, JSON.stringify(st.expr).slice(0,120)); break; }
  }
  let removed = 0;
  for (const [, bb] of bbs) {
    const before = bb.ir.length;
    bb.ir = bb.ir.filter(st => needed.has(st));
    removed += before - bb.ir.length;
  }
  return removed;
}

function computeLiveness(bbs, capturedRegs) {
  const use = new Map(), def = new Map(), liveOut = new Map(), liveIn = new Map();
  for (const [id, bb] of bbs) {
    const u = new Set(), d = new Set();
    for (const s of bb.ir) {
      for (const r of statementReads(s)) if (!d.has(r)) u.add(r);
      if (s.kind === 'assign') d.add(s.dst);
    }
    if (bb.term && bb.term.test) for (const r of irUsesRegisters(bb.term.test)) if (!d.has(r)) u.add(r);
    use.set(id, u); def.set(id, d);
    liveOut.set(id, new Set()); liveIn.set(id, new Set());
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, bb] of bbs) {
      const out = new Set();
      for (const s of bb.succ) if (liveIn.has(s)) for (const r of liveIn.get(s)) out.add(r);
      for (const r of capturedRegs) out.add(r);
      const inn = new Set(out);
      for (const r of def.get(id)) inn.delete(r);
      for (const r of use.get(id)) inn.add(r);
      if (inn.size !== liveIn.get(id).size || [...inn].some(r => !liveIn.get(id).has(r))) { liveIn.set(id, inn); changed = true; }
      liveOut.set(id, out);
    }
  }
  return { liveIn, liveOut };
}

function statementReads(s) {
  const out = [];
  if (s.expr) irUsesRegisters(s.expr, out);
  return out;
}

function deadStoreElimination(bb, liveOut, capturedRegs) {
  let removedAny = false;
  for (let pass = 0; pass < 6; pass++) {
    const live = new Set(liveOut);
    const keep = new Array(bb.ir.length).fill(true);
    if (bb.term && bb.term.test) for (const r of irUsesRegisters(bb.term.test)) live.add(r);
    let changed = false;
    for (let i = bb.ir.length - 1; i >= 0; i--) {
      const s = bb.ir[i];
      if (s.kind === 'assign' && !live.has(s.dst) && !capturedRegs.has(s.dst)) {
        if (irIsPure(s.expr)) { keep[i] = false; changed = true; continue; }
        if (s.expr.t === 'call') { bb.ir[i] = { kind: 'effect', expr: s.expr, pc: s.pc }; changed = true; }
      }
      if (s.kind === 'effect' && irIsPure(s.expr)) { keep[i] = false; changed = true; continue; }
      if (s.kind === 'assign') live.delete(s.dst);
      for (const r of statementReads(s)) live.add(r);
    }
    if (!changed) break;
    bb.ir = bb.ir.filter((_, i) => keep[i]);
    removedAny = true;
  }
  return removedAny;
}

/** re-nest single-use temporaries so expressions look like source again */
function inlineTemporaries(bb, liveOut, capturedRegs) {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const st of bb.ir) if (st.expr) normalizeCalls(st.expr);
    if (bb.term && bb.term.test) normalizeCalls(bb.term.test);
    for (let i = 0; i < bb.ir.length; i++) {
      const s = bb.ir[i];
      if (s.kind !== 'assign' || capturedRegs.has(s.dst)) continue;
      if (liveOut.has(s.dst)) continue;
      let useIdx = -1, uses = 0, redefined = false;
      for (let j = i + 1; j < bb.ir.length; j++) {
        const rs = bb.ir[j];
        const reads = statementReads(rs).filter(r => r === s.dst).length;
        if (reads) { if (useIdx < 0) useIdx = j; uses += reads; }
        if (rs.kind === 'assign' && rs.dst === s.dst) { redefined = true; break; }
      }
      let termUses = 0;
      if (!redefined && bb.term && bb.term.test) termUses = irUsesRegisters(bb.term.test).filter(r => r === s.dst).length;
      // a literal / global / plain register can be duplicated into every use: it has no
      // cost and no side effects, and it is what turns `x = document; x.body` back into
      // `document.body`
      const duplicable = DUPLICABLE.has(s.expr.t);
      if (!duplicable && uses + termUses !== 1) continue;
      if (duplicable && uses + termUses === 0) continue;
      const pure = irIsPure(s.expr);
      const targetIdx = uses ? useIdx : -1;
      if (!duplicable && !pure && targetIdx !== i + 1 && !(uses === 0 && termUses === 1 && i === bb.ir.length - 1)) continue;
      const readsOfExpr = new Set(irUsesRegisters(s.expr));
      // find the last statement the value has to travel to
      let lastUse = -1;
      for (let j = i + 1; j < bb.ir.length; j++) {
        const rs = bb.ir[j];
        if (statementReads(rs).some(r => r === s.dst)) lastUse = j;
        if (rs.kind === 'assign' && rs.dst === s.dst) break;
      }
      let safe = true;
      const stopIdx = duplicable ? (lastUse < 0 ? bb.ir.length : lastUse) : (uses ? useIdx : bb.ir.length);
      for (let j = i + 1; j < stopIdx; j++) {
        const mid = bb.ir[j];
        if (mid.kind === 'assign' && readsOfExpr.has(mid.dst)) { safe = false; break; }
        if (!duplicable && !irIsPure(mid.expr)) { safe = false; break; }
        if (duplicable && s.expr.t === 'global' && !irIsPure(mid.expr) && mid.kind === 'effect' &&
            mid.expr && mid.expr.t === 'setglobal') { safe = false; break; }
      }
      if (!safe) continue;
      if (duplicable) {
        for (let j = i + 1; j < bb.ir.length; j++) {
          const rs = bb.ir[j];
          if (statementReads(rs).some(r => r === s.dst)) bb.ir[j] = substituteStatement(rs, s.dst, s.expr);
          if (rs.kind === 'assign' && rs.dst === s.dst) break;
        }
        if (termUses) bb.term.test = substituteReg(bb.term.test, s.dst, s.expr);
      } else if (uses) bb.ir[useIdx] = substituteStatement(bb.ir[useIdx], s.dst, s.expr);
      else bb.term.test = substituteReg(bb.term.test, s.dst, s.expr);
      bb.ir.splice(i, 1);
      i--;
      changed = true;
    }
    if (!changed) break;
  }
}

function isLastUseSafe() { return true; }

function substituteReg(e, reg, repl) {
  if (!e || typeof e !== 'object') return e;
  if (e.t === 'reg' && e.i === reg) return repl;
  const out = Array.isArray(e) ? [] : {};
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (Array.isArray(v)) out[k] = v.map(x => substituteReg(x, reg, repl));
    else if (v && typeof v === 'object' && v.t) out[k] = substituteReg(v, reg, repl);
    else out[k] = v;
  }
  return out;
}

function substituteStatement(s, reg, repl) {
  const out = { ...s };
  if (s.expr) out.expr = substituteReg(s.expr, reg, repl);
  return out;
}

/* ------------------------------------------------------------------ *
 * Function lifting driver
 * ------------------------------------------------------------------ */

function terminatorOf(env, bb) {
  const last = bb.nodes[bb.nodes.length - 1];
  const ins = last.ins, k = ins.k, o = ins.operands;
  if (ins.kind === 'ret') return { kind: 'return', reg: o[0] };
  if (ins.kind === 'throw') return { kind: 'throw', reg: o[0] };
  if (last.branch && bb.succ.length === 2) {
    const test = last.branch.negate
      ? IR.un('!', IR.reg(last.branch.reg))
      : IR.reg(last.branch.reg);
    return { kind: 'branch', test, trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
  }
  if ((ins.kind === 'jz' || ins.kind === 'jnz') && bb.succ.length === 2) {
    const reg = o[k.cond];
    const test = ins.kind === 'jz' ? IR.un('!', IR.reg(reg)) : IR.reg(reg);
    return { kind: 'branch', test, trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
  }
  if (ins.kind === 'forin_next' && bb.succ.length === 2) {
    return { kind: 'branch', test: IR.un('!', IR.reg(o[k.dst])), trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
  }
  if (bb.succ.length === 1) return { kind: 'goto', target: bb.succ[0] };
  if (bb.succ.length === 0) {
    if (ins.kind === 'jmp_reg') return { kind: 'trap', pc: ins.pc };
    return { kind: 'end' };
  }
  return { kind: 'branch', test: IR.lit(true), trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
}

/** registers of `fn` that a nested function captures (they must survive DCE) */
function capturedRegisters(prog, fn) {
  const out = new Set();
  for (const child of prog.order) {
    if (child.parent !== fn) continue;
    for (const uv of child.upvals || []) if (uv.local) out.add(uv.index);
  }
  return out;
}

function liftFunction(env, prog, fn, helpers) {
  const prevFrame = env.currentFrameSize;
  env.currentFrameSize = env.frameLayout.header + fn.l;
  const merged = duplicateJoins(mergeNodes(fn));
  const { bbs, entry } = buildBasicBlocks(merged);

  for (const [, bb] of bbs) {
    bb.ir = [];
    for (const node of bb.nodes) {
      const stmts = liftInstruction(env, fn, node.ins, node);
      for (const s of stmts) bb.ir.push(s);
    }
    bb.term = terminatorOf(env, bb);
    if (bb.term.kind === 'return') { bb.ir.push({ kind: 'ret', expr: IR.reg(bb.term.reg) }); bb.retStmt = bb.ir[bb.ir.length - 1]; }
    if (bb.term.kind === 'throw') { bb.ir.push({ kind: 'throw', expr: IR.reg(bb.term.reg) }); bb.retStmt = bb.ir[bb.ir.length - 1]; }
    if (bb.term.kind === 'trap') bb.ir.push({ kind: 'trap', pc: bb.term.pc });
  }

  const captured = capturedRegisters(prog, fn);
  // Dead-code elimination has to run to a fixpoint over the whole function: removing the
  // computed-jump machinery of one block makes the block that fed it dead as well, and
  // that is what makes the control-flow flattening disappear.
  globalDeadCode(bbs, captured);
  for (let round = 0; round < 12; round++) {
    const { liveOut } = computeLiveness(bbs, captured);
    let changed = false;
    for (const [id, bb] of bbs) if (deadStoreElimination(bb, new Set(liveOut.get(id)), captured)) changed = true;
    if (!changed) break;
  }
  {
    const { liveOut } = computeLiveness(bbs, captured);
    if (process.env.VMDEBUG_FN == fn.id) for (const [id, bb] of bbs) console.error("[dbg]", id, bb.ir.map(x => x.kind + (x.dst !== undefined ? ":r" + x.dst : "")).join(" | "), "| liveOut:", [...liveOut.get(id)].join(","), "| test:", bb.term.test ? JSON.stringify(bb.term.test).slice(0,40) : "-");
    for (const [id, bb] of bbs) inlineTemporaries(bb, new Set(liveOut.get(id)), captured);
  }
  globalDeadCode(bbs, captured);
  for (let round = 0; round < 4; round++) {
    const { liveOut } = computeLiveness(bbs, captured);
    let changed = false;
    for (const [id, bb] of bbs) if (deadStoreElimination(bb, new Set(liveOut.get(id)), captured)) changed = true;
    if (!changed) break;
  }

  const em = makeEmitter(env, prog, fn, helpers);
  let labelSeq = 0;
  const ctx = {
    blockStatements: bb => bb.ir.filter(s => s.kind !== 'ret' && s.kind !== 'throw' && s.kind !== 'trap').map(em.statement).filter(Boolean),
    terminator: bb => {
      if (bb.term.kind === 'trap') {
        return { kind: 'throw', stmt: em.statement(bb.ir[bb.ir.length - 1]) };
      }
      if (bb.term.kind === 'return' || bb.term.kind === 'throw') {
        const st = bb.ir[bb.ir.length - 1];
        return { kind: bb.term.kind, stmt: em.statement(st) };
      }
      return bb.term;
    },
    makeIf: (test, consequent, alternate) => t.ifStatement(em.expr(test),
      t.blockStatement(consequent), alternate.length ? t.blockStatement(alternate) : null),
    makeLoop: (body, label) => {
      const w = t.whileStatement(t.booleanLiteral(true), t.blockStatement(body));
      return label ? t.labeledStatement(t.identifier(label), w) : w;
    },
    makeBreak: label => t.breakStatement(label ? t.identifier(label) : null),
    makeContinue: label => t.continueStatement(label ? t.identifier(label) : null),
    newLabel: () => 'L' + (++labelSeq) + '_' + fn.id,
  };

  let body;
  try {
    body = structureFunction(ctx, bbs, entry);
  } catch (e) {
    if (e !== RESTRUCTURE) throw e;
    body = emitDispatchLoop(ctx, bbs, entry, em, fn);
  }

  // variable declarations
  const decls = [];
  const params = [];
  for (let i = 0; i < fn.m; i++) {
    const name = em.prefix + i;
    params.push(fn.rest && i === fn.m - 1 ? t.restElement(t.identifier(name)) : t.identifier(name));
  }
  const locals = [...em.used].filter(i => i >= fn.m).sort((a, b) => a - b);
  const argsReg = fn.m < fn.l ? fn.m : -1;
  for (const i of locals) {
    const name = em.prefix + i;
    if (i === argsReg && !fn.rest) {
      decls.push(t.variableDeclarator(t.identifier(name),
        t.callExpression(t.memberExpression(t.memberExpression(t.memberExpression(
          t.identifier('Array'), t.identifier('prototype')), t.identifier('slice')), t.identifier('call')),
        [t.identifier('arguments')])));
    } else {
      decls.push(t.variableDeclarator(t.identifier(name), null));
    }
  }
  const stmts = decls.length ? [t.variableDeclaration('var', decls), ...body] : body;
  env.currentFrameSize = prevFrame;
  return { params, body: stmts };
}

/** last-resort emitter: a program-counter dispatch loop (always correct) */
function emitDispatchLoop(ctx, bbs, entry, em, fn) {
  const ids = [...bbs.keys()];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const pcVar = t.identifier('_pc' + fn.id);
  const cases = [];
  for (const id of ids) {
    const bb = bbs.get(id);
    const body = ctx.blockStatements(bb);
    const term = ctx.terminator(bb);
    if (term.kind === 'return' || term.kind === 'throw') body.push(term.stmt);
    else if (term.kind === 'branch') {
      body.push(t.expressionStatement(t.assignmentExpression('=', pcVar,
        t.conditionalExpression(em.expr(term.test),
          t.numericLiteral(idx.get(term.trueTarget)), t.numericLiteral(idx.get(term.falseTarget))))));
      body.push(t.continueStatement(t.identifier('_vm' + fn.id)));
    } else if (term.kind === 'goto') {
      body.push(t.expressionStatement(t.assignmentExpression('=', pcVar, t.numericLiteral(idx.get(term.target)))));
      body.push(t.continueStatement(t.identifier('_vm' + fn.id)));
    } else body.push(t.returnStatement(null));
    cases.push(t.switchCase(t.numericLiteral(idx.get(id)), body));
  }
  return [
    t.variableDeclaration('var', [t.variableDeclarator(pcVar, t.numericLiteral(idx.get(entry)))]),
    t.labeledStatement(t.identifier('_vm' + fn.id),
      t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.switchStatement(pcVar, cases)]))),
  ];
}

/* ------------------------------------------------------------------ *
 * Whole program
 * ------------------------------------------------------------------ */

const EFFECTFUL_KINDS = new Set(['store_global', 'set_member', 'delete_member', 'define_getter',
  'define_setter', 'store_closure', 'throw', 'push_try', 'pop_try', 'forin_init', 'forin_next',
  'debugger', 'decrypt', 'load_closure', 'call_method', 'new']);

/**
 * Which functions are safe to delete calls to?  The dispatcher helpers introduced by
 * control-flow flattening only shuffle numbers around, so once their result is dead the
 * whole call can go — that is what makes the flattening disappear from the output.
 */
function findEffectFreeFunctions(env, prog) {
  const candidates = new Set();
  for (const fn of prog.order) {
    let ok = true;
    for (const [, node] of fn.nodes) {
      const ins = node.ins;
      if (!ins) continue;
      if (EFFECTFUL_KINDS.has(ins.kind)) {
        // a method call is allowed when it only ever hit a whitelisted builtin
        if ((ins.kind === 'call_method' || ins.kind === 'new') && ins.pureNative && !ins.impureNative) continue;
        ok = false; break;
      }
      if (ins.kind === 'load_global' && !(ins.globalName in env.pureGlobals)) { ok = false; break; }
    }
    if (ok) candidates.add(fn.entry);
  }
  // calls between candidates must stay inside the set
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of prog.order) {
      if (!candidates.has(fn.entry)) continue;
      for (const [, node] of fn.nodes) {
        const ins = node.ins;
        if (!ins || ins.kind !== 'call') continue;
        if (ins.calleeEntry === undefined || ins.calleeEntry < 0 || !candidates.has(ins.calleeEntry)) {
          if (!(ins.pureCall && !ins.impureCall)) { candidates.delete(fn.entry); changed = true; break; }
        }
      }
    }
  }
  return candidates;
}

/**
 * Wrap a VM handler that could not be reduced to a JavaScript operator.  The handler is a
 * pure function of one or two registers, so it is emitted verbatim behind a shim that
 * feeds it the same operands and frame that the VM would have.
 */
function buildOpaqueHelper(env, name, e) {
  const F = env.fields;
  const B = 64;                                   // register base used inside the shim
  const params = e.regSlots.map((_, i) => 'x' + i);
  const setup = e.regSlots.map((r, i) => `  st.${F.stack}[${B} + ${r}] = x${i};`).join('\n');
  const src = Function.prototype.toString.call(env.proto[e.op]);
  const code = `
function ${name}(${params.join(', ')}) {
  var st = {};
  st.${F.stack} = [];
  st.${F.fp} = 0;
  st.${F.stack}[${env.slots.base}] = ${B};
  st.${F.stack}[${env.frameLayout.sizeSlot}] = ${e.frameSize};
${setup}
  var __ops = ${JSON.stringify(e.operands)}, __k = 0;
  st.${F.reader} = function () { return __ops[__k++]; };
  (${src}).call(st);
  return st.${F.stack}[${B} + ${e.dstReg}];
}`;
  const body = parseSource(code).program.body;
  t.addComment(body[0], 'leading',
    ' vm.js: opcode ' + e.op + ' is an MBA expression with no JavaScript equivalent;\n' +
    '   the original VM handler is kept verbatim so that behaviour is preserved ');
  return body;
}

function liftProgram(env, prog) {
  env.fitCache = new Map();
  env.effectFree = findEffectFreeFunctions(env, prog);
  const helperState = { forIn: false, opaque: new Map() };
  const built = new Map();

  const helpers = {
    functionExpression: ref => {
      const child = prog.funcs.get(ref.entry);
      if (!child) return t.identifier('undefined');
      const lifted = built.get(child.entry) || liftFunction(env, prog, child, helpers);
      built.set(child.entry, lifted);
      return t.functionExpression(null, lifted.params, t.blockStatement(lifted.body));
    },
    forInHelper: () => { helperState.forIn = true; return '__vmForIn'; },
    opaqueHelper: e => {
      const name = '__vmMba' + e.op + '_' + e.operands.join('_').slice(0, 40).replace(/[^0-9_]/g, '');
      if (!helperState.opaque.has(name)) helperState.opaque.set(name, buildOpaqueHelper(env, name, e));
      return name;
    },
  };

  const main = liftFunction(env, prog, prog.main, helpers);
  const program = [];
  if (helperState.forIn) {
    program.push(...parseSource(`
function __vmForIn(o) {
  var keys = [], i = 0;
  for (var k in o) keys.push(k);
  return { next: function () { return i < keys.length ? keys[i++] : undefined; } };
}`).program.body);
  }
  let body = main.body;
  // a trailing `return undefined` is how the VM's main function ends; at program level
  // that is not valid JavaScript, so drop it (or wrap the body when a real return remains)
  while (body.length && t.isReturnStatement(body[body.length - 1]) && !body[body.length - 1].argument) {
    body = body.slice(0, -1);
  }
  const hasReturn = body.some(function walk(n) {
    if (!n || typeof n !== 'object') return false;
    if (t.isReturnStatement(n)) return true;
    if (t.isFunction(n)) return false;
    return Object.keys(n).some(k => {
      const v = n[k];
      if (Array.isArray(v)) return v.some(walk);
      return v && typeof v === 'object' && v.type ? walk(v) : false;
    });
  });
  if (hasReturn) {
    body = [t.expressionStatement(t.callExpression(
      t.functionExpression(null, [], t.blockStatement(body)), []))];
  }
  for (const decl of helperState.opaque.values()) program.push(...decl);
  program.push(...body);
  return t.program(program);
}

/* ================================================================== *
 * 13.  Entry points
 * ================================================================== */

/**
 * Deobfuscate one file.  Returns the deobfuscated source.  Input that is not obfuscated
 * with this technique is returned unchanged (re-printed only if it parses), so that
 * ordinary files pass through safely.
 */
function deobfuscate(source, options = {}) {
  const ast = parseSource(source);
  const boot = findBootstrap(ast);
  if (!boot || countHandlerAssignments(ast) < 8) {
    if (options.verbose) console.error('[vm.js] no JS-Confuser VM detected — passing the file through');
    return source;
  }
  const env = buildEnv(source);
  if (!env) return source;
  const prog = analyzeProgram(env);
  if (options.verbose) {
    console.error(`[vm.js] ${env.opcodes.length} opcodes, ${env.code.length} words of bytecode, ` +
      `${prog.order.length} functions`);
    for (const fn of prog.order) {
      if (fn.unresolved.length) {
        console.error(`[vm.js] warning: function #${fn.id} has ${fn.unresolved.length} unresolved computed jump(s)`);
      }
    }
  }
  const program = liftProgram(env, prog);
  const out = generate(program, { comments: true, jsescOption: { minimal: true } }, source);
  return out.code + '\n';
}

function deobfuscateFile(file, outFile, options = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const code = deobfuscate(source, options);
  if (outFile) fs.writeFileSync(outFile, code);
  return code;
}

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a !== '--verbose');
  const verbose = process.argv.includes('--verbose') || true;
  if (!args.length) {
    console.error('usage: node vm.js <input.js> [output.js]');
    process.exit(1);
  }
  const t0 = Date.now();
  const code = deobfuscateFile(args[0], args[1], { verbose });
  if (args[1]) console.error(`[vm.js] wrote ${args[1]} (${code.length} bytes) in ${Date.now() - t0}ms`);
  else process.stdout.write(code);
}

module.exports = deobfuscateFile;
Object.assign(module.exports, {
  deobfuscate, deobfuscateFile,
  parseSource, findBootstrap, countHandlerAssignments, captureVM, discoverFields,
  makeMock, runHandler, probeWith, probeRoles, classifyOpcodes, discoverSlots,
  discoverFunctionMeta, buildEnv, REG_BASE, SLOT_SENT, makeSandbox,
  fitDataOpcode, decodeAt, findDstSlot, analyzeProgram, analyzeFunction, instrAt, UNKNOWN, stepState, evalPure,
  readRegisters, writtenRegisters, controlSlice,
  liftProgram, mergeNodes, buildBasicBlocks, liftFunction,
});
