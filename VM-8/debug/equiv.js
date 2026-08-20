'use strict';
// Runs the obfuscated sample and the deobfuscated output in identical
// deterministic sandboxes and compares every observable effect.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const makeSandbox = require('./shim.js');

function run(file, seed) {
  const sb = makeSandbox(seed);
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sb, { timeout: 20000, filename: file });
  const exported = sb['_k1crlxlk2w8'];
  if (typeof exported === 'function') {
    for (let i = 0; i < 3; i++) {
      try { sb.__calls.push(['ret', String(exported())]); }
      catch (e) { sb.__calls.push(['threw', e.message]); }
    }
  }
  return sb.__calls.map(c => JSON.stringify(c));
}

let bad = 0;
for (const seed of [1, 7, 12345]) {
  const a = run('input.js', seed);
  const b = run('output.js', seed);
  const n = Math.max(a.length, b.length);
  let ok = true;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      ok = false;
      console.log(`seed ${seed} MISMATCH at ${i}:\n  input : ${a[i]}\n  output: ${b[i]}`);
      break;
    }
  }
  console.log(`seed ${seed}: ${ok ? 'MATCH' : 'DIFFER'} (${a.length} observable effects)`);
  if (ok && a.length) console.log('   e.g. ' + a.slice(0, 6).join('\n        '));
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
