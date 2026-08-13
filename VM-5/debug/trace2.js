// debug/trace2.js - run the program for real, call whatever it exports, and record the
// set of executed program counters (ground truth for the static analysis)
const { load } = require('./load');
const fs = require('fs');
const path = require('path');

const r = load(process.argv[2] || 'input.js', { window: true, noRun: true });
const ctx = r.ctx;
const A = ctx.A;
const ops = Object.keys(A).map(Number).filter(n => !isNaN(n));
const pcs = new Set();
for (const op of ops) {
  const orig = A[op];
  A[op] = function () { pcs.add(this.g[this.h + 2] - 1); return orig.apply(this, arguments); };
}
ctx.z.apply(null, ctx.__BOOTARGS__);

const exported = Object.keys(ctx).filter(k => k.length > 3 && typeof ctx[k] === 'function');
console.log('globals defined by the program:', exported.join(', '));
const fn = ctx[exported[0]];
const args = JSON.parse(process.env.ARGS || '["hello world"]');
let res;
try { res = fn.apply(null, args); } catch (e) { console.log('call threw:', e.message); }
console.log('call result:', JSON.stringify(res));
console.log('executed pcs:', pcs.size);
fs.writeFileSync(path.join(__dirname, 'exec-pcs.json'), JSON.stringify([...pcs].sort((a, b) => a - b)));
