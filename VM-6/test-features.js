// test-features.js -- exercises the parts of the VM instruction set that
// input.js never uses, by assembling synthetic payloads on top of the real
// runtime (see debug/assemble.js) and checking that vm.js reproduces them.
//
//   node test-features.js
const fs = require('fs');
const path = require('path');
const vmMod = require('vm');
const deobfuscate = require('./vm.js');
const { Asm, opcodeMap, buildSample } = require('./debug/assemble.js');

const TEMPLATE = path.join(__dirname, 'input.js');
const TMPDIR = path.join(__dirname, 'debug');
const maps = opcodeMap(TEMPLATE);
const K = 0x51ee71 >>> 0;      // any frame key: the plain opcodes ignore it

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '\n          ' + detail : ''));
  if (!ok) failures++;
}

function sandboxRun(code, name) {
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.map(v => (typeof v === 'string' ? v : JSON.stringify(v) || String(v))).join(' ')) },
    Object, Array, String, Number, Boolean, JSON, Math, Reflect, WeakMap, Map, Set, Symbol,
    Error, TypeError, RangeError, ReferenceError, Function, Date, RegExp, Promise, Proxy,
    Uint8Array, Uint32Array, Buffer, parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, undefined,
  };
  sandbox.globalThis = sandbox;
  const ctx = vmMod.createContext(sandbox);
  try { vmMod.runInContext(code, ctx, { filename: name, timeout: 10000 }); }
  catch (e) { logs.push('THREW ' + e.constructor.name + ': ' + e.message); }
  return logs;
}

function runCase(name, build, root, opts) {
  opts = opts || {};
  const a = new Asm(maps);
  build(a);
  let sample;
  try { sample = buildSample(TEMPLATE, a, root); }
  catch (e) { check(name, false, 'assembler: ' + e.message); return; }
  const file = path.join(TMPDIR, '_feat_' + name.replace(/\W+/g, '_') + '.js');
  fs.writeFileSync(file, sample);

  const before = sandboxRun(sample, name + '.obf');
  if (opts.expect && JSON.stringify(before) !== JSON.stringify(opts.expect)) {
    check(name, false, 'synthetic payload itself misbehaved: ' + JSON.stringify(before) +
      ' expected ' + JSON.stringify(opts.expect));
    return;
  }
  let out = null, err = null;
  try { out = deobfuscate.deobfuscate(file, sample); }
  catch (e) { err = e; }
  if (err) {
    if (opts.allowRefusal && /cannot fully devirtualize/.test(err.message)) {
      check(name + ' (refused, guard works)', true, err.message);
      fs.unlinkSync(file);
      return;
    }
    check(name, false, 'deobfuscate threw: ' + err.message);
    fs.writeFileSync(file + '.err', String(err.stack));
    return;
  }
  const after = sandboxRun(out, name + '.deobf');
  const ok = JSON.stringify(before) === JSON.stringify(after);
  check(name, ok, ok ? '' : JSON.stringify(before) + '\n          ' + JSON.stringify(after) + '\n---\n' + out);
  if (ok) fs.unlinkSync(file); else fs.writeFileSync(file + '.out', out);
}

/* ------------------------------------------------------------------------- */
console.log('synthetic VM payloads');

// 1. globals, member access, method calls, if/else, while
runCase('basic-control-flow', (a) => {
  // var t = 0, i = 0; while (i < 5) { if (i % 2) t = t + i; else t = t - i; i = i + 1; }
  // console.log("sum", t);
  a.loadImm(1, 0);              // t
  a.loadImm(2, 0);              // i
  a.label('loop');
  a.loadImm(3, 5);
  a.bin('<', 4, 2, 3);
  a.jmpIfNot(4, 'done');
  a.loadImm(3, 2);
  a.bin('%', 4, 2, 3);
  a.jmpIfNot(4, 'else');
  a.bin('+', 1, 1, 2);
  a.jmp('cont');
  a.label('else');
  a.bin('-', 1, 1, 2);
  a.label('cont');
  a.loadImm(3, 1);
  a.bin('+', 2, 2, 3);
  a.jmp('loop');
  a.label('done');
  a.loadGlobal(3, 'console');
  a.loadConst(4, 'log');
  a.member(5, 3, 4);
  a.loadConst(6, 'sum');
  a.method(7, 3, 5, [6, 1]);
  a.loadConst(0, undefined);
  a.ret(0);
}, { o: 0, m: 10, F: 0, C: K }, { expect: ['sum -2'] });

// 2. object + array literals, for-in, delete, typeof
runCase('objects-arrays-forin', (a) => {
  a.loadConst(1, 'a'); a.loadImm(2, 1);
  a.loadConst(3, 'b'); a.loadImm(4, 2);
  a.loadConst(5, 'c'); a.loadImm(6, 3);
  a.object(7, [[1, 2], [3, 4], [5, 6]]);      // { a: 1, b: 2, c: 3 }
  a.del(8, 7, 3);                              // delete o.b
  a.array(9, [2, 4, 6]);                       // [1, 2, 3]
  a.forInInit(10, 7);
  a.loadConst(11, '');
  a.label('next');
  a.forInNext(12, 10, 'endloop');
  a.bin('+', 11, 11, 12);
  a.jmp('next');
  a.label('endloop');
  a.loadGlobal(13, 'console');
  a.loadConst(14, 'log');
  a.member(15, 13, 14);
  a.typeofGlobal(16, 'Math');
  a.loadConst(17, 'length');
  a.member(18, 9, 17);
  a.method(19, 13, 15, [11, 8, 16, 18]);
  a.loadConst(0, undefined);
  a.ret(0);
}, { o: 0, m: 24, F: 0, C: K }, { expect: ['ac true object 3'] });

// 3. constructors, prototypes, instanceof, in, getters
runCase('new-instanceof-accessors', (a) => {
  a.makeFunc(1, 'ctor', 1, 6, [], false, K);
  a.jmp('after');
  a.label('ctor');
  a.loadThis(2);
  a.loadConst(3, 'v');
  a.setMember(2, 3, 0);
  a.loadConst(4, undefined);
  a.ret(4);
  a.label('after');
  a.loadImm(2, 7);
  a.construct(3, 1, [2]);                     // new C(7)
  a.bin('instanceof', 4, 3, 1);
  a.loadConst(5, 'v');
  a.bin('in', 6, 5, 3);
  a.member(7, 3, 5);
  a.makeFunc(8, 'getter', 0, 4, [], false, K);
  a.jmp('after2');
  a.label('getter');
  a.loadImm(1, 99);
  a.ret(1);
  a.label('after2');
  a.loadConst(9, 'g');
  a.defineGet(3, 9, 8);
  a.member(10, 3, 9);
  a.loadGlobal(11, 'console');
  a.loadConst(12, 'log');
  a.member(13, 11, 12);
  a.method(14, 11, 13, [7, 4, 6, 10]);
  a.loadConst(0, undefined);
  a.ret(0);
}, { o: 0, m: 18, F: 0, C: K }, { expect: ['7 true true 99'] });

// 4. closures over cells, rest params, arguments, spread call
runCase('closures-rest-spread', (a) => {
  a.loadImm(1, 10);                                  // captured counter
  a.makeFunc(2, 'bump', 0, 6, [{ isNew: 1, idx: 1 }], false, K);
  a.jmp('after');
  a.label('bump');
  a.loadCell(1, 0);
  a.loadImm(2, 1);
  a.bin('+', 3, 1, 2);
  a.storeCell(0, 3);
  a.ret(3);
  a.label('after');
  a.call(3, 2, []);
  a.call(4, 2, []);
  a.makeFunc(5, 'restfn', 2, 8, [], true, K);        // function (x, ...rest)
  a.jmp('after2');
  a.label('restfn');
  a.loadConst(3, 'length');
  a.member(4, 1, 3);                                  // rest.length
  a.bin('+', 5, 0, 4);
  a.loadConst(6, ':');
  a.bin('+', 5, 5, 6);
  a.loadConst(7, 'length');
  a.member(6, 2, 7);                                  // arguments.length
  a.bin('+', 5, 5, 6);
  a.ret(5);
  a.label('after2');
  a.loadImm(6, 1); a.loadImm(7, 2); a.loadImm(8, 3);
  a.array(9, [6, 7, 8]);
  a.callSpread(10, 5, 9);                             // restfn(...[1,2,3])
  a.loadGlobal(11, 'console');
  a.loadConst(12, 'log');
  a.member(13, 11, 12);
  a.method(14, 11, 13, [3, 4, 10]);
  a.loadConst(0, undefined);
  a.ret(0);
}, { o: 0, m: 18, F: 0, C: K }, { expect: ['11 12 3:3'] });

// 5. try / catch / throw  (guarded: vm.js refuses rather than emit wrong code)
runCase('try-catch', (a) => {
  a.pushTryCatch('handler', 3);
  a.loadGlobal(1, 'Error');
  a.loadConst(2, 'boom');
  a.construct(4, 1, [2]);
  a.throwErr(4);
  a.label('handler');
  a.loadConst(5, 'message');
  a.member(6, 3, 5);
  a.jmp('report');
  a.label('report');
  a.loadGlobal(7, 'console');
  a.loadConst(8, 'log');
  a.member(9, 7, 8);
  a.method(10, 7, 9, [6]);
  a.loadConst(0, undefined);
  a.ret(0);
}, { o: 0, m: 14, F: 0, C: K }, { expect: ['boom'] });

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all feature checks passed'));
process.exit(failures ? 1 : 0);
