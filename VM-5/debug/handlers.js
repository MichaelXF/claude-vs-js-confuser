// debug/handlers.js - print handler sources (truncated) sorted by length
const { load } = require('./load');
const fs = require('fs');
const path = require('path');

const r = load(process.argv[2] || 'input.js', { window: true, noRun: true });
const A = r.ctx.A;
const ops = Object.keys(A).map(Number).filter(n => !isNaN(n));
const out = [];
const rows = ops.map(op => ({ op, src: Function.prototype.toString.call(A[op]) }));
rows.sort((a, b) => a.src.length - b.src.length);
const LIMIT = Number(process.env.LIMIT || 400);
for (const { op, src } of rows) {
  out.push(`### ${op}  [len=${src.length}]\n${src.length > LIMIT ? src.slice(0, LIMIT) + ' …' : src}\n`);
}
fs.writeFileSync(path.join(__dirname, 'handlers.txt'), out.join('\n'));
console.log('wrote', out.length, 'handlers to debug/handlers.txt');
console.log('len histogram:', rows.map(r => r.src.length).join(','));
