/**
 * equiv.js — behavioural equivalence check for input.js vs output.js.
 *
 *   node debug/equiv.js
 *
 * Both files are run in the same fake-DOM sandbox with a deterministic clock and PRNG,
 * and everything observable is compared: the global the program exports, what it logs,
 * and what it returns (called twice, which exercises the run-once latch).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const nodeVm = require('vm');
const ROOT = path.join(__dirname, '..');

function run(file) {
  const logs = [];
  const el = { style: {}, offsetWidth: 140, appendChild() {} };
  const sandbox = {
    Object, Array, String, Number, Boolean, JSON, RegExp, Function, Error,
    Uint8Array, Uint32Array, Buffer, parseInt, parseFloat, isNaN, isFinite,
    console: { log: (...a) => logs.push(a.map(String).join(' ')) },
    document: { createElement: () => el, body: { appendChild() {} } },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
  };
  let seed = 42;
  sandbox.Math = Object.create(Math);
  sandbox.Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  sandbox.Date = Object.create(Date);
  sandbox.Date.now = () => 1723500000000;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = nodeVm.createContext(sandbox);
  nodeVm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { timeout: 20000 });

  const exported = Object.keys(sandbox).filter(k => /^_/.test(k) && typeof sandbox[k] === 'function');
  const returns = [];
  for (const f of exported) { returns.push(sandbox[f]()); returns.push(sandbox[f]()); }
  return { exported, logs, returns };
}

const a = run(path.join(ROOT, 'input.js'));
const b = run(path.join(ROOT, 'output.js'));

const show = (name, r) => {
  console.log(name);
  console.log('  exports:', JSON.stringify(r.exported));
  console.log('  logs   :', JSON.stringify(r.logs));
  console.log('  returns:', JSON.stringify(r.returns));
};
show('input.js', a);
show('output.js', b);

const checks = [
  ['exported global', JSON.stringify(a.exported) === JSON.stringify(b.exported)],
  ['console output', JSON.stringify(a.logs) === JSON.stringify(b.logs)],
  ['return values', JSON.stringify(a.returns) === JSON.stringify(b.returns)],
];
console.log('');
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS  ' : 'FAIL  ') + name); ok = ok && pass; }
process.exit(ok ? 0 : 1);
