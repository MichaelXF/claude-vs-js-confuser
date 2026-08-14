// debug/assemble.js -- a tiny assembler for JS-Confuser-VM.
//
// The provided input.js only exercises a slice of the instruction set, so this
// builds *synthetic* payloads (re-using the real runtime out of input.js) that
// do use the rest: try/catch, for-in, new, object/array literals, getters and
// setters, spread, rest parameters, typeof-global, delete, ...
//
// The result is a file byte-compatible with what the obfuscator emits, so it
// can be fed straight to vm.js.
const fs = require('fs');
const path = require('path');
const { loadVM, makeAnalyzer } = require('../vm.js').internals;

const SPREAD = 2329202881;

// discover the opcode number for each behavior from the real sample
function opcodeMap(file) {
  const L = loadVM(file);
  const A = makeAnalyzer(L);
  const byKind = {};
  for (const key of Object.keys(A.T)) {
    const info = A.T[key];
    if (info.kind !== 'DATA') { byKind[info.kind] = byKind[info.kind] || Number(key); continue; }
  }
  // plain (non-MBA) binary/unary handlers, identified by an exact operator fit
  const bin = {}, un = {};
  for (const key of Object.keys(A.T)) {
    const info = A.T[key];
    if (info.kind !== 'DATA') continue;
    const layout = info.layout;
    if (layout.consumed === 3 && layout.reads.length === 2 && layout.writes.length === 1) {
      const words = [0, 1, 2];
      const f = A.fit({ op: Number(key), words, srcRegs: [1, 2], dst: 0 }, 0);
      if (f.exact && f.kind === 'BINARY' && bin[f.op] === undefined) bin[f.op] = Number(key);
    } else if (layout.consumed === 2 && layout.reads.length === 1 && layout.writes.length === 1) {
      const f = A.fit({ op: Number(key), words: [0, 1], srcRegs: [1], dst: 0 }, 0);
      if (f.exact && f.kind === 'UNARY' && un[f.op] === undefined) un[f.op] = Number(key);
      if (f.exact && f.kind === 'MOV' && un.mov === undefined) un.mov = Number(key);
    }
  }
  // load-immediate: two words, no register reads, result == the second word
  for (const key of Object.keys(A.T)) {
    const info = A.T[key];
    if (info.kind !== 'DATA') continue;
    const l = info.layout;
    if (l.consumed === 2 && l.reads.length === 0 && l.writes.length === 1) {
      const f = A.fit({ op: Number(key), words: [0, 4242], srcRegs: [], dst: 0 }, 0);
      if (f.kind === 'CONST' && f.value === 4242) { byKind.DATA_IMM = Number(key); break; }
    }
  }
  return { L, A, byKind, bin, un };
}

class Asm {
  constructor(maps) {
    this.maps = maps;
    this.code = [];
    this.pool = [];
    this.labels = new Map();
    this.fixups = [];
  }
  poolIndex(v) {
    for (let i = 0; i < this.pool.length; i++) if (Object.is(this.pool[i], v)) return i;
    this.pool.push(v);
    return this.pool.length - 1;
  }
  emit(...words) { for (const w of words) this.code.push(w); return this; }
  label(name) { this.labels.set(name, this.code.length); return this; }
  ref(name) { this.fixups.push({ at: this.code.length, name }); this.code.push(0); return this; }
  here() { return this.code.length; }

  op(kind) {
    const o = this.maps.byKind[kind];
    if (o === undefined) throw new Error('no opcode for ' + kind);
    return o;
  }
  // --- instructions --------------------------------------------------------
  loadConst(dst, value) { return this.emit(this.op('LOADCONST'), dst, this.poolIndex(value), 0); }
  loadImm(dst, n) { return this.emit(this.maps.byKind.DATA_IMM, dst, n >>> 0); }
  mov(dst, src) { return this.emit(this.maps.un.mov, dst, src); }
  loadThis(dst) { return this.emit(this.op('LOADTHIS'), dst); }
  loadGlobal(dst, name) { return this.emit(this.op('LOADGLOBAL'), dst, this.poolIndex(name), 0); }
  typeofGlobal(dst, name) { return this.emit(this.op('TYPEOFGLOBAL'), dst, this.poolIndex(name), 0); }
  storeGlobal(name, src) { return this.emit(this.op('STOREGLOBAL'), this.poolIndex(name), 0, src); }
  member(dst, obj, key) { return this.emit(this.maps.bin['[]'], dst, obj, key); }
  setMember(obj, key, val) { return this.emit(this.op('SETMEMBER'), obj, key, val); }
  del(dst, obj, key) { return this.emit(this.op('DELETE'), dst, obj, key); }
  bin(op, dst, a, b) {
    const o = this.maps.bin[op];
    if (o === undefined) throw new Error('no binary opcode for ' + op);
    return this.emit(o, dst, a, b);
  }
  un(op, dst, a) {
    const o = this.maps.un[op];
    if (o === undefined) throw new Error('no unary opcode for ' + op);
    return this.emit(o, dst, a);
  }
  call(dst, fn, args) { return this.emit(this.op('CALL'), dst, fn, args.length, ...args); }
  callSpread(dst, fn, arrReg) { return this.emit(this.op('CALL'), dst, fn, SPREAD, arrReg); }
  method(dst, thisReg, fn, args) { return this.emit(this.op('CALLMETHOD'), dst, thisReg, fn, args.length, ...args); }
  construct(dst, fn, args) { return this.emit(this.op('NEW'), dst, fn, args.length, ...args); }
  array(dst, elems) { return this.emit(this.op('ARRAY'), dst, elems.length, ...elems); }
  object(dst, pairs) { return this.emit(this.op('OBJECT'), dst, pairs.length, ...[].concat(...pairs)); }
  defineGet(obj, key, fn) { return this.emit(this.op('DEFGET'), obj, key, fn); }
  defineSet(obj, key, fn) { return this.emit(this.op('DEFSET'), obj, key, fn); }
  forInInit(dst, obj) { return this.emit(this.op('FORIN_INIT'), dst, obj); }
  forInNext(dst, iter, doneLabel) { this.emit(this.op('FORIN_NEXT'), dst, iter); return this.ref(doneLabel); }
  jmp(label) { this.emit(this.op('JMP')); return this.ref(label); }
  jmpIf(cond, label) { this.emit(this.op('JMPIF'), cond); return this.ref(label); }
  jmpIfNot(cond, label) { this.emit(this.op('JMPIFNOT'), cond); return this.ref(label); }
  ret(src) { return this.emit(this.op('RETURN'), src); }
  throwErr(src) { return this.emit(this.op('THROW'), src); }
  pushTryCatch(catchLabel, catchReg) { this.emit(this.op('TRYCATCH')); this.ref(catchLabel); return this.emit(catchReg); }
  popTry() { return this.emit(this.op('POPTRY')); }
  makeFunc(dst, entryLabel, nparams, nregs, cells, hasRest, C) {
    this.emit(this.op('MAKEFUNC'), dst);
    this.ref(entryLabel);
    this.emit(nparams, nregs, cells.length, hasRest ? 1 : 0, C >>> 0);
    for (const c of cells) this.emit(c.isNew ? 1 : 0, c.idx);
    return this;
  }
  loadCell(dst, idx) { return this.emit(this.op('LOADCELL'), dst, idx); }
  storeCell(idx, src) { return this.emit(this.op('STORECELL'), idx, src); }

  finish() {
    for (const f of this.fixups) {
      if (!this.labels.has(f.name)) throw new Error('undefined label ' + f.name);
      this.code[f.at] = this.labels.get(f.name);
    }
    return this;
  }
}

function serializePool(pool) {
  return '[' + pool.map(v => {
    if (v === undefined) return 'void 0';
    if (v === null) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (v > 0 ? 'Infinity' : (v < 0 ? '-Infinity' : 'NaN'));
    if (typeof v === 'boolean') return v ? '!0' : '!1';
    return JSON.stringify(v);
  }).join(',') + ']';
}

function toBase64(words) {
  const buf = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => buf.writeUInt32LE(w >>> 0, i * 4));
  return buf.toString('base64');
}

// splice a synthetic program into the real runtime taken from input.js
function buildSample(templateFile, asm, root) {
  const src = fs.readFileSync(templateFile, 'utf8');
  asm.finish();
  const b64 = toBase64(asm.code);
  let out = src.replace(/l\("[A-Za-z0-9+/=]*"\)/, 'l(' + JSON.stringify(b64) + ')');
  if (out === src) throw new Error('bytecode blob not found in template');

  // the bootstrap call is the very last statement; rewrite it wholesale
  const at = out.lastIndexOf('new g(D,');
  if (at < 0) throw new Error('bootstrap call not found in template');
  out = out.slice(0, at) + 'new g(D,' + serializePool(asm.pool) + ',B),void 0,null,' +
    'new t({o:' + root.o + ',m:' + root.m + ',F:' + root.F + ',C:' + (root.C >>> 0) + '}));\n';
  return out;
}

module.exports = { Asm, opcodeMap, buildSample, SPREAD };
