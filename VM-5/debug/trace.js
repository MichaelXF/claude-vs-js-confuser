// debug/trace.js - trace real execution of the VM: (pc, opcode, frame) per step
const { load } = require('./load');
const fs = require('fs');
const path = require('path');

const r = load(process.argv[2] || 'input.js', { window: true, noRun: true });
const ctx = r.ctx;
const A = ctx.A;
const ops = Object.keys(A).map(Number).filter(n => !isNaN(n));

const trace = [];
const MAX = Number(process.env.MAX || 200000);
for (const op of ops) {
  const orig = A[op];
  A[op] = function () {
    if (trace.length < MAX) {
      const pc = this.g[this.h + 2] - 1;
      trace.push({ pc, op, fp: this.h, base: this.g[this.h + 0] });
    }
    return orig.apply(this, arguments);
  };
}

const t0 = Date.now();
let err = null;
try {
  ctx.z.apply(null, ctx.__BOOTARGS__);
} catch (e) { err = e; }
console.log('steps:', trace.length, 'ms:', Date.now() - t0, 'err:', err && err.message);

// operand span per (pc,op): distance to the next pc in the same frame is not reliable;
// instead record for each executed pc the opcode
const pcOp = new Map();
for (const t of trace) {
  if (pcOp.has(t.pc) && pcOp.get(t.pc) !== t.op) console.log('!! pc', t.pc, 'has two opcodes', pcOp.get(t.pc), t.op);
  pcOp.set(t.pc, t.op);
}
console.log('distinct pcs executed:', pcOp.size, 'of', ctx.D.length);
const usedOps = new Set(trace.map(t => t.op));
console.log('distinct opcodes executed:', usedOps.size);
console.log('never executed opcodes:', ops.filter(o => !usedOps.has(o)).join(','));

fs.writeFileSync(path.join(__dirname, 'trace.json'), JSON.stringify({
  pcs: [...pcOp.entries()].sort((a, b) => a[0] - b[0]),
  head: trace.slice(0, 200),
}, null, 1));
console.log('wrote debug/trace.json');
