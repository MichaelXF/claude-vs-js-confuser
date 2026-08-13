// debug/stage3.js - classify every opcode and print the table
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const src = fs.readFileSync(file, 'utf8');
const env = V.buildEnv(src);
if (!env) { console.log('not VM-obfuscated'); process.exit(0); }

console.log('slots:', env.slots);
console.log('meta layout:', env.meta);
const byKind = new Map();
for (const [op, k] of env.kinds) {
  if (!byKind.has(k.kind)) byKind.set(k.kind, []);
  byKind.get(k.kind).push(op);
}
const lines = [];
for (const [kind, ops] of [...byKind.entries()].sort()) {
  lines.push(kind.padEnd(16) + ' (' + ops.length + '): ' + ops.join(', '));
}
console.log(lines.join('\n'));
