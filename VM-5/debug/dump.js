// debug/dump.js - dump bytecode, pool, and trace execution of input.js
const { load } = require('./load');

const r = load(process.argv[2] || 'input.js', { window: true, noRun: true });
const ctx = r.ctx;
const args = ctx.__BOOT__ ? null : null;
console.log('has BOOT?', typeof ctx.__BOOT__);

// re-run: the replaced call stored nothing; instead call it now
// The bootstrap statement was replaced, so we captured nothing. Rebuild manually:
console.log('C len', ctx.C && ctx.C.length);
console.log('D len', ctx.D && ctx.D.length);
const A = ctx.A;
const ops = Object.keys(A).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
console.log('num handlers', ops.length);
console.log('opcodes', ops.join(','));

// histogram of opcode words in the bytecode
const D = ctx.D;
const seen = new Map();
for (let i = 0; i < D.length; i++) {
  if (A[D[i]]) seen.set(D[i], (seen.get(D[i]) || 0) + 1);
}
console.log('opcode-valued words:', [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + 'x' + v).join(' '));
