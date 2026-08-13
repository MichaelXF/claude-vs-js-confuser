// debug/stage4.js - whole-program analysis: functions, nodes, coverage, unresolved jumps
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));
const t0 = Date.now();
const prog = V.analyzeProgram(env);
console.log('analysis took', Date.now() - t0, 'ms');
console.log('spread magic:', env.spreadMagic, 'meta:', JSON.stringify(env.meta));

const covered = new Set();
const out = [];
for (const fn of prog.order) {
  for (const [, node] of fn.nodes) {
    const ins = node.ins;
    if (ins) for (let i = ins.pc; i < ins.next; i++) covered.add(i);
  }
  const kinds = new Map();
  for (const [, node] of fn.nodes) if (node.ins) kinds.set(node.ins.kind, (kinds.get(node.ins.kind) || 0) + 1);
  out.push(`#${fn.id} entry=${fn.entry} params=${fn.m} locals=${fn.l} rest=${fn.rest} upvals=${JSON.stringify(fn.upvals)} parent=${fn.parent ? fn.parent.id : '-'} nodes=${fn.nodes.size} pcs=${fn.perPc.size} unresolved=${fn.unresolved.length}`);
  out.push('   kinds: ' + [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join(' '));
}
console.log(out.join('\n'));
console.log('bytecode words covered:', covered.size, '/', env.code.length);
const holes = [];
let run = null;
for (let i = 0; i < env.code.length; i++) {
  if (!covered.has(i)) { if (!run) { run = [i, i]; holes.push(run); } else run[1] = i; }
  else run = null;
}
console.log('uncovered ranges:', holes.map(h => h[0] + '-' + h[1]).join(' ') || 'none');
