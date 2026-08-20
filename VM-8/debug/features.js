'use strict';
// ---------------------------------------------------------------------------
// End-to-end tests for language features the shipped sample never uses.
//
// Each program is assembled from the sample's own handler table into a fresh
// obfuscated file, then run twice: once as-is, and once after vm.js has
// deobfuscated it.  Both runs must produce identical observable effects.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const vmMod = require('vm');
const { buildToolkit, assemble, buildFile, findDecryptor, keystream, decryptInstruction } = require('./assemble.js');
const makeSandbox = require('./shim.js');
const deobfuscate = require('../vm.js');

const kit = buildToolkit();
const TMP = path.join(__dirname, 'gen');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

function run(code, name) {
  const sb = makeSandbox(1);
  vmMod.createContext(sb);
  try {
    vmMod.runInContext(code, sb, { timeout: 20000, filename: name });
  } catch (e) {
    sb.__calls.push(['threw', e.message]);
  }
  return sb.__calls.map((c) => JSON.stringify(c));
}

let failures = 0;
function feature(name, pool, program, nregs) {
  const { words } = assemble(kit, program);
  const src = buildFile(kit, words, pool, { j: 0, l: nregs || 24, C: 0 });
  const srcPath = path.join(TMP, name + '.js');
  fs.writeFileSync(srcPath, src);
  let out, err = null;
  try { out = deobfuscate(srcPath, path.join(TMP, name + '.out.js')); }
  catch (e) { err = e; }
  if (err) {
    console.log(`FAIL  ${name}  -- deobfuscation threw: ${err.message}`);
    failures++;
    return;
  }
  const a = run(src, name + '.js');
  const b = run(out, name + '.out.js');
  const ok = JSON.stringify(a) === JSON.stringify(b) && a.length > 0 && !/unstructured|unresolved/.test(out);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -- ${a.join(' ')}`);
  if (!ok) {
    console.log('   obfuscated  :', a.join(' | '));
    console.log('   deobfuscated:', b.join(' | '));
    console.log('   output:\n' + out.split('\n').map((l) => '     ' + l).join('\n'));
    failures++;
  }
}

const LOG = (objReg, fnReg, tmpReg, args) => ([
  { op: 'getprop', dst: tmpReg, obj: objReg, key: fnReg },
  { op: 'mcall', dst: tmpReg, thisReg: objReg, callee: tmpReg, items: args },
]);

// --- 1. try / catch --------------------------------------------------------
feature('try_catch', ['console', 'log', 'boom', 'caught:', 'done'], [
  { op: 'getglobal', dst: 0, pool: 0 },
  { op: 'const', dst: 1, pool: 1 },
  { op: 'trypush', catchPc: 0, excReg: 5, label: 'Lc' },
  { op: 'const', dst: 2, pool: 2 },
  { op: 'throw', src: 2 },
  'Lc',
  { op: 'const', dst: 3, pool: 3 },
  { op: 'bin:+', dst: 4, a: 3, b: 5 },
  ...LOG(0, 1, 6, [4]),
  { op: 'const', dst: 7, pool: 4 },
  { op: 'ret', src: 7 },
]);

// --- 2. try / catch that does not throw, with a join -----------------------
feature('try_join', ['console', 'log', 'A', 'B'], [
  { op: 'getglobal', dst: 0, pool: 0 },
  { op: 'const', dst: 1, pool: 1 },
  { op: 'trypush', catchPc: 0, excReg: 5, label: 'Lc' },
  { op: 'const', dst: 2, pool: 2 },
  { op: 'trypop' },
  { op: 'jmp', target: 0, label: 'Lend' },
  'Lc',
  { op: 'const', dst: 2, pool: 3 },
  'Lend',
  ...LOG(0, 1, 6, [2]),
  { op: 'ret', src: 2 },
]);

// --- 3. for-in over an object literal --------------------------------------
feature('for_in', ['console', 'log', 'x', 'y', '', 'k:'], [
  { op: 'const', dst: 1, pool: 2 },
  { op: 'const', dst: 2, pool: 2 },
  { op: 'const', dst: 3, pool: 3 },
  { op: 'const', dst: 4, pool: 3 },
  { op: 'object', dst: 0, pairs: [[1, 2], [3, 4]] },
  { op: 'forin', dst: 5, obj: 0 },
  { op: 'const', dst: 6, pool: 4 },
  'Lloop',
  { op: 'forinnext', dst: 7, obj: 5, target: 0, label: 'Ldone' },
  { op: 'bin:+', dst: 6, a: 6, b: 7 },
  { op: 'jmp', target: 0, label: 'Lloop' },
  'Ldone',
  { op: 'getglobal', dst: 8, pool: 0 },
  { op: 'const', dst: 9, pool: 1 },
  ...LOG(8, 9, 10, [6]),
  { op: 'ret', src: 6 },
]);

// --- 4. arrays, new, typeof, instanceof, in, delete ------------------------
feature('objects', ['console', 'log', 'Error', 'nope', 'message', 'length', 'a'], [
  { op: 'getglobal', dst: 0, pool: 0 },
  { op: 'const', dst: 1, pool: 1 },
  { op: 'getglobal', dst: 2, pool: 2 },        // Error
  { op: 'const', dst: 3, pool: 3 },            // "nope"
  { op: 'new', dst: 4, callee: 2, items: [3] },
  { op: 'const', dst: 5, pool: 4 },            // "message"
  { op: 'getprop', dst: 6, obj: 4, key: 5 },   // err.message
  { op: 'array', dst: 7, items: [3, 6] },
  { op: 'const', dst: 8, pool: 5 },            // "length"
  { op: 'getprop', dst: 9, obj: 7, key: 8 },   // arr.length
  { op: 'un:typeof', dst: 10, src: 4 },
  { op: 'bin:instanceof', dst: 11, a: 4, b: 2 },
  { op: 'bin:in', dst: 12, a: 8, b: 7 },
  { op: 'const', dst: 13, pool: 6 },
  { op: 'setprop', obj: 7, key: 13, src: 6 },
  { op: 'delete', dst: 14, obj: 7, key: 13 },
  ...LOG(0, 1, 15, [6, 9, 10, 11, 12, 14]),
  { op: 'ret', src: 9 },
], 28);

// --- 5. an encrypted bytecode region (the `encodeBytecode` option) ---------
(function encrypted() {
  const dec = findDecryptor(kit);
  if (!dec) { console.log('SKIP  encoded_bytecode -- no decryption handler in this build'); return; }
  const pool = ['console', 'log', 'hidden payload'];
  const body = [
    { op: 'getglobal', dst: 0, pool: 0 },
    { op: 'const', dst: 1, pool: 1 },
    { op: 'const', dst: 2, pool: 2 },
    ...LOG(0, 1, 3, [2]),
    { op: 'ret', src: 2 },
  ];
  const DEST = 5;
  const plain = assemble(kit, body, DEST).words;
  const len = plain.length;
  const SRC = DEST + len;
  const KEY = 0x5bd1e995;
  const ks = keystream(kit, dec, DEST, SRC, len, KEY);
  const words = new Uint32Array(SRC + len);
  const head = decryptInstruction(dec, DEST, SRC, len, KEY);
  for (let i = 0; i < head.length; i++) words[i] = head[i] >>> 0;
  for (let i = 0; i < len; i++) words[SRC + i] = (plain[i] ^ ks[i]) >>> 0;
  const src = buildFile(kit, words, pool, { j: 0, l: 24, C: 0 });
  const p = path.join(TMP, 'encoded_bytecode.js');
  fs.writeFileSync(p, src);
  let out, err = null;
  try { out = deobfuscate(p, path.join(TMP, 'encoded_bytecode.out.js')); } catch (e) { err = e; }
  if (err) { console.log('FAIL  encoded_bytecode -- ' + err.message); failures++; return; }
  const a = run(src, 'encoded_bytecode.js');
  const b = run(out, 'encoded_bytecode.out.js');
  const ok = JSON.stringify(a) === JSON.stringify(b) && a.length > 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  encoded_bytecode  -- ${a.join(' ')}`);
  if (!ok) {
    console.log('   obfuscated  :', a.join(' | '));
    console.log('   deobfuscated:', b.join(' | '));
    console.log(out);
    failures++;
  }
})();

console.log(failures ? `\n${failures} feature test(s) failed` : '\nall feature tests passed');
process.exit(failures ? 1 : 0);
