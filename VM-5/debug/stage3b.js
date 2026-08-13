// debug/stage3b.js - classification only (no meta discovery), prints kind per opcode
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const src = fs.readFileSync(file, 'utf8');
const ast = V.parseSource(src);
const cap = V.captureVM(ast);
const proto = Object.getPrototypeOf(cap.state);
const { fields, opcodes, PC } = V.discoverFields(cap.state, proto);
const env = {
  ast, cap, proto, fields, opcodes, PC,
  pool: cap.state[fields.pool],
  code: Array.from(cap.state[fields.code]),
  sandbox: cap.sandbox,
  slots: { base: 0, this: 10, template: 12, try: 8 },
};
env.slots = V.discoverSlots(env);
console.log('slots:', env.slots);
env.kinds = V.classifyOpcodes(env);
for (const [, k] of env.kinds) if (k.kind === 'forin_init') env.forin = k;
console.log('forin:', env.forin && { keys: env.forin.keysProp, idx: env.forin.idxProp });

const rows = [];
for (const [op, k] of env.kinds) {
  rows.push([op, k.kind, 'n=' + k.n, 'roles=' + k.roles.join(','), k.src.slice(0, 60).replace(/\n/g, ' ')]);
}
rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0]);
for (const r of rows) console.log(String(r[0]).padStart(5), r[1].padEnd(15), r[2].padEnd(5), r[3].padEnd(28), r[4]);
