// debug/fit.js - fit every data opcode that the program actually uses and print the result
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));
const prog = V.analyzeProgram(env);

const rows = [];
const seen = new Set();
for (const fn of prog.order) {
  env.currentFrameSize = env.frameLayout.header + fn.l;
  for (const [, node] of fn.nodes) {
    const ins = node.ins;
    if (!ins || ins.kind !== 'expr') continue;
    const key = ins.op + '@' + env.currentFrameSize;
    if (seen.has(key)) continue;
    seen.add(key);
    const t0 = Date.now();
    const fit = V.fitDataOpcode(env, ins.k, ins.operands);
    rows.push([ins.op, fn.id, ins.k.roles.join(','), fit.form, fit.operator || '', fit.reason || '',
      fit.ambiguous ? '(' + fit.ambiguous.join('/') + ')' : '', Date.now() - t0 + 'ms']);
  }
}
rows.sort((a, b) => a[0] - b[0]);
for (const r of rows) console.log(String(r[0]).padStart(5), 'fn#' + r[1], r[2].padEnd(20), r[3].padEnd(8), r[4].padEnd(12), r[6], r[5], r[7]);
console.log('total fitted:', rows.length, 'unknown:', rows.filter(r => r[3] === 'unknown').length);
