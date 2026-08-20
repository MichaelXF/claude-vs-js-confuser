'use strict';
// ---------------------------------------------------------------------------
// A tiny assembler for this VM.
//
// The sample exercises only part of the handler table, so language features it
// happens not to use (try/catch, for-in, array and object literals, `new`, …)
// are tested by building fresh bytecode out of the sample's own handlers and
// running the result through vm.js end to end.
//
// Operand slots are discovered the same way everything else is: emit an
// instruction with distinct operand values, classify it, and see which slot
// each role came from.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const { loadRuntime, locateBootstrap } = require('../lib-extract.js');
const { prepare, probe } = require('../lib-probe.js');
const { classify } = require('../lib-disasm.js');
const { regTracer, THIS_MARK } = require('../lib-classify.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'input.js'), 'utf8');

// --- shape discovery -------------------------------------------------------
function shapes(M, B, rampFn) {
  const real = M.bytecode;
  const ctx = { nibbleHint: new Map(), notTyped: new Set() };
  const fn = { id: 0, entry: 0, B, nregs: 40, nparams: 0, rest: false };
  const out = new Map();
  const RAMP = rampFn || ((i) => 20 + i * 3); // distinct, never equal to a small count
  for (const key of M.opKeys) {
    const op = +key;
    const Q = new Uint32Array(48);
    Q[0] = op;
    for (let i = 1; i < Q.length; i++) Q[i] = RAMP(i);
    M.bytecode = Q;
    let ir = null;
    try {
      const log = [];
      const regs = [];
      for (let i = 0; i < 64; i++) regs.push(regTracer(i, log));
      const p = probe(M, { pc: 0, B, nregs: 64, regs, thisVal: THIS_MARK });
      const site = { pc: 0, op, operands: p.operands.slice(), next: p.fall };
      ir = classify(M, site, fn, ctx);
      ir.operands = p.operands.slice();
    } catch (e) { ir = null; }
    if (ir) out.set(op, ir);
  }
  M.bytecode = real;
  return out;
}

function slotOf(operands, value) { return operands.indexOf(value); }

// Build an emitter for one IR kind out of the classification of a candidate op.
function makeEmitter(op, ir) {
  const ops = ir.operands;
  const k = ir.kind;
  const slot = (v) => slotOf(ops, v);
  const fixed = (roles) => {
    const map = roles.map(([name, v]) => [name, slot(v)]);
    if (map.some(([, s]) => s < 0)) return null;
    return (args) => {
      const words = new Array(ops.length).fill(0);
      for (const [name, s] of map) words[s] = args[name] >>> 0;
      return [op, ...words];
    };
  };
  switch (k) {
    case 'const': return null; // constants are pool driven; handled separately
    case 'mov': return fixed([['dst', ir.dst], ['src', ir.src]]);
    case 'this': return fixed([['dst', ir.dst]]);
    case 'bin': return ir.wrap ? null : fixed([['dst', ir.dst], ['a', ir.a], ['b', ir.b]]);
    case 'un': return fixed([['dst', ir.dst], ['src', ir.src]]);
    case 'getprop': return ir.key.reg === undefined ? null : fixed([['dst', ir.dst], ['obj', ir.obj], ['key', ir.key.reg]]);
    case 'setprop': return ir.key.reg === undefined ? null : fixed([['obj', ir.obj], ['key', ir.key.reg], ['src', ir.src]]);
    case 'delete': return ir.key.reg === undefined ? null : fixed([['dst', ir.dst], ['obj', ir.obj], ['key', ir.key.reg]]);
    case 'ret': return fixed([['src', ir.src]]);
    case 'throw': return fixed([['src', ir.src]]);
    case 'jmp': return fixed([['target', ir.target]]);
    case 'jf': case 'jt': return fixed([['cond', ir.cond], ['target', ir.target]]);
    case 'forin': return fixed([['dst', ir.dst], ['obj', ir.obj]]);
    case 'forinnext': {
      const obj = slot(ir.obj), tgt = slot(ir.target);
      let dst = slot(ir.dst);
      if (dst < 0) { for (let i = 0; i < ops.length; i++) if (i !== obj && i !== tgt) { dst = i; break; } }
      if (obj < 0 || tgt < 0 || dst < 0) return null;
      return (args) => {
        const words = new Array(ops.length).fill(0);
        words[dst] = args.dst >>> 0; words[obj] = args.obj >>> 0; words[tgt] = args.target >>> 0;
        return [op, ...words];
      };
    }
    case 'getglobal': case 'typeofglobal': {
      const d = slot(ir.dst);
      const rest = [];
      for (let i = 0; i < ops.length; i++) if (i !== d) rest.push(i);
      if (d < 0 || rest.length !== 2) return null;
      return (args) => {
        const words = new Array(ops.length).fill(0);
        words[d] = args.dst >>> 0; words[rest[0]] = args.pool >>> 0; words[rest[1]] = 0;
        return [op, ...words];
      };
    }
    case 'setglobal': {
      const sSlot = slot(ir.src);
      const rest = [];
      for (let i = 0; i < ops.length; i++) if (i !== sSlot) rest.push(i);
      if (sSlot < 0 || rest.length !== 2) return null;
      return (args) => {
        const words = new Array(ops.length).fill(0);
        words[sSlot] = args.src >>> 0; words[rest[0]] = args.pool >>> 0; words[rest[1]] = 0;
        return [op, ...words];
      };
    }
    case 'trypop': return () => [op];
    case 'trypush':
      if (ir.catchPc === undefined) return null;
      if (ir.flagReg !== undefined) {
        return fixed([['catchPc', ir.catchPc], ['flagReg', ir.flagReg], ['excReg', ir.excReg], ['flagValue', ir.flagValue]]);
      }
      return fixed([['catchPc', ir.catchPc], ['excReg', ir.excReg]]);
    case 'array': case 'object': case 'call': case 'mcall': case 'new': {
      // one leftover slot holds the element/argument count
      const known = new Set();
      const roleSlots = [];
      const push = (name, v) => { const s = slot(v); if (s >= 0) { known.add(s); roleSlots.push([name, s]); } };
      if (ir.dst !== undefined) push('dst', ir.dst);
      if (ir.callee !== undefined && ir.callee !== null) push('callee', ir.callee);
      if (ir.thisReg !== undefined && ir.thisReg !== null) push('thisReg', ir.thisReg);
      if (ir.obj !== undefined) push('obj', ir.obj);
      const items = k === 'array' ? ir.items
        : k === 'object' ? [].concat(...ir.pairs.map(p => [p[0] && p[0].reg, p[1]]))
          : ir.args;
      const itemSlots = [];
      for (const it of items) { const s = it == null ? -1 : slot(it); if (s >= 0) { known.add(s); itemSlots.push(s); } }
      let countSlot = -1;
      for (let i = 0; i < ops.length; i++) if (!known.has(i)) { countSlot = i; break; }
      if (countSlot < 0) return null;
      const firstItem = Math.min(...(itemSlots.length ? itemSlots : [ops.length]));
      return (args) => {
        const n = k === 'object' ? args.pairs.length : args.items.length;
        const words = [];
        for (const [name, s] of roleSlots) words[s] = args[name] >>> 0;
        words[countSlot] = n >>> 0;
        let w = firstItem;
        if (k === 'object') for (const [kk, vv] of args.pairs) { words[w++] = kk >>> 0; words[w++] = vv >>> 0; }
        else for (const it of args.items) words[w++] = it >>> 0;
        for (let i = 0; i < w; i++) if (words[i] === undefined) words[i] = 0;
        return [op, ...words.slice(0, w)];
      };
    }
    default: return null;
  }
}

function buildToolkit() {
  const M = prepare(loadRuntime(SOURCE));
  const B = M.meta.B | 0;
  const sh = shapes(M, B);
  const small = shapes(M, B, (i) => i); // small counts for the counted forms
  const COUNTED = new Set(['array', 'object', 'call', 'mcall', 'new']);
  const emitters = new Map();
  for (const [op, irSmall] of small) {
    if (!COUNTED.has(irSmall.kind)) continue;
    if (emitters.has(irSmall.kind)) continue;
    const e = makeEmitter(op, irSmall);
    if (e) emitters.set(irSmall.kind, e);
  }
  for (const [op, ir] of sh) {
    if (emitters.has(ir.kind)) continue;
    const key = ir.kind + (ir.kind === 'trypush' && ir.flagReg !== undefined ? ':finally' : '') +
      (ir.kind === 'bin' ? ':' + ir.operator : '') + (ir.kind === 'un' ? ':' + ir.operator : '');
    if (emitters.has(key)) continue;
    const e = makeEmitter(op, ir);
    if (e) emitters.set(key, e);
  }
  // constants: find the plain "load from pool" handler (2 operands, dst + index)
  let constEmit = null;
  for (const [op, ir] of sh) {
    if (ir.kind !== 'const' || ir.operands.length !== 3) continue;
    const dstSlot = slotOf(ir.operands, ir.dst);
    if (dstSlot !== 0) continue;
    constEmit = (dst, poolIndex) => [op, dst >>> 0, poolIndex >>> 0, 0];
    break;
  }
  return { M, B, shapes: sh, emitters, constEmit };
}

// --- program builder -------------------------------------------------------
function assemble(kit, program, offset) {
  const base = offset || 0;
  const words = [];
  const labels = new Map();
  const fixups = [];
  for (const ins of program) {
    if (typeof ins === 'string') { labels.set(ins, base + words.length); continue; }
    const at = words.length;
    let emitted;
    if (ins.op === 'const') emitted = kit.constEmit(ins.dst, ins.pool);
    else {
      const e = kit.emitters.get(ins.op);
      if (!e) throw new Error('no emitter for ' + ins.op);
      emitted = e(ins);
    }
    words.push(...emitted);
    if (ins.label !== undefined) fixups.push({ at, ins, emitted });
  }
  // patch label references
  for (const f of fixups) {
    const target = labels.get(f.ins.label);
    if (target === undefined) throw new Error('unknown label ' + f.ins.label);
    const e = kit.emitters.get(f.ins.op);
    const rebuilt = f.ins.op === 'const' ? null
      : e(Object.assign({}, f.ins, { target, catchPc: target }));
    for (let i = 0; i < rebuilt.length; i++) words[f.at + i] = rebuilt[i];
  }
  return { words: Uint32Array.from(words.map(w => w >>> 0)), labels };
}

// Locate the `encodeBytecode` decryption handler and work out its operand
// layout by watching which words of the bytecode array it rewrites.
function findDecryptor(kit) {
  const { M } = kit;
  const real = M.bytecode;
  const OPS = [40, 16, 20, 7];
  let found = null;
  for (const key of M.opKeys) {
    const op = +key;
    const Q = new Uint32Array(64);
    Q[0] = op;
    for (let i = 0; i < OPS.length; i++) Q[1 + i] = OPS[i];
    for (let i = 5; i < 64; i++) Q[i] = 0x11111111;
    const before = Uint32Array.from(Q);
    M.bytecode = Q;
    try {
      probe(M, { pc: 0, B: kit.B, nregs: 8, regs: [], thisVal: null, bytecode: Q, mutate: true });
    } catch (e) { M.bytecode = real; continue; }
    const changed = [];
    for (let i = 0; i < 64; i++) if (Q[i] !== before[i]) changed.push(i);
    M.bytecode = real;
    if (!changed.length) continue;
    const dest = changed[0];
    const count = changed.length;
    const destSlot = OPS.indexOf(dest);
    let startSlot = -1, endSlot = -1;
    for (let a = 0; a < OPS.length; a++) {
      for (let b = 0; b < OPS.length; b++) {
        if (a === b || a === destSlot || b === destSlot) continue;
        if (OPS[b] - OPS[a] === count) { startSlot = a; endSlot = b; }
      }
    }
    if (destSlot < 0 || startSlot < 0) continue;
    const keySlot = [0, 1, 2, 3].find(i => i !== destSlot && i !== startSlot && i !== endSlot);
    found = { op, destSlot, startSlot, endSlot, keySlot };
    break;
  }
  return found;
}

// Run the decryptor over a zeroed source region: what it writes is the key
// stream, so XOR-ing the plaintext with it produces the encrypted region.
function keystream(kit, dec, dest, start, len, key) {
  const { M } = kit;
  const real = M.bytecode;
  const size = Math.max(dest, start) + len + 8;
  const Q = new Uint32Array(size);
  Q[0] = dec.op;
  const slots = new Array(4);
  slots[dec.destSlot] = dest;
  slots[dec.startSlot] = start;
  slots[dec.endSlot] = start + len;
  slots[dec.keySlot] = key;
  for (let i = 0; i < 4; i++) Q[1 + i] = slots[i] >>> 0;
  M.bytecode = Q;
  probe(M, { pc: 0, B: kit.B, nregs: 8, regs: [], thisVal: null, bytecode: Q, mutate: true });
  M.bytecode = real;
  const out = new Uint32Array(len);
  for (let i = 0; i < len; i++) out[i] = Q[dest + i] >>> 0;
  return out;
}

function decryptInstruction(dec, dest, start, len, key) {
  const words = [dec.op];
  const slots = new Array(4);
  slots[dec.destSlot] = dest;
  slots[dec.startSlot] = start;
  slots[dec.endSlot] = start + len;
  slots[dec.keySlot] = key;
  for (let i = 0; i < 4; i++) words.push(slots[i] >>> 0);
  return words;
}

function buildFile(kit, bytecode, pool, meta) {
  const ast = parser.parse(SOURCE, { sourceType: 'script' });
  const boot = locateBootstrap(ast);
  const buf = Buffer.alloc(bytecode.length * 4);
  for (let i = 0; i < bytecode.length; i++) buf.writeUInt32LE(bytecode[i], i * 4);
  let longest = null;
  traverse(ast, { StringLiteral(p) { if (!longest || p.node.value.length > longest.node.value.length) longest = p; } });
  longest.node.value = buf.toString('base64');

  const call = boot.statement.expression;
  const vmArgs = call.arguments[0].arguments;
  vmArgs[boot.poolIndex] = t.arrayExpression(pool.map(v =>
    typeof v === 'string' ? t.stringLiteral(v)
      : typeof v === 'number' ? (v < 0 ? t.unaryExpression('-', t.numericLiteral(-v)) : t.numericLiteral(v))
        : typeof v === 'boolean' ? t.booleanLiteral(v)
          : v === null ? t.nullLiteral() : t.unaryExpression('void', t.numericLiteral(0))));
  const metaObj = call.arguments[1].arguments[0];
  for (const p of metaObj.properties) {
    const name = p.key.name !== undefined ? p.key.name : p.key.value;
    // j = params, l = registers, C = entry pc, B = key
    if (meta[name] !== undefined) {
      p.value = meta[name] < 0 ? t.unaryExpression('-', t.numericLiteral(-meta[name])) : t.numericLiteral(meta[name]);
    }
  }
  return generate(ast, { compact: true }).code;
}

module.exports = { buildToolkit, assemble, buildFile, findDecryptor, keystream, decryptInstruction };

if (require.main === module) {
  const kit = buildToolkit();
  console.log('emitters:', [...kit.emitters.keys()].sort().join(', '));
  console.log('const emitter:', kit.constEmit ? 'yes' : 'no');
}
