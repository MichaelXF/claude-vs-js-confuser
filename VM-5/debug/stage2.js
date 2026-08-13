// debug/stage2.js - probe every opcode handler and print its operand roles
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const src = fs.readFileSync(file, 'utf8');
const ast = V.parseSource(src);
const cap = V.captureVM(ast, src);
const proto = Object.getPrototypeOf(cap.state);
const info = V.discoverFields(cap.state, proto);
const env = {
  fields: info.fields, PC: info.PC, proto,
  pool: cap.state[info.fields.pool],
  code: cap.state[info.fields.code],
};

const lines = [];
for (const op of info.opcodes.slice().sort((a, b) => a - b)) {
  const r = V.probeRoles(env, op);
  const parts = [
    String(op).padStart(5),
    'n=' + r.nOperands,
    'roles=[' + r.roles.join(',') + ']',
    'rd=' + JSON.stringify(r.regReads),
    'wr=' + JSON.stringify(r.regWrites.map(x => [x[0], typeof x[1] === 'function' ? 'fn' : (typeof x[1] === 'object' ? JSON.stringify(x[1]) : x[1])])),
  ];
  if (r.jump !== null) parts.push('JUMP=' + r.jump);
  if (r.slotReads.length) parts.push('slotRd=' + JSON.stringify(r.slotReads));
  if (r.slotWrites.length) parts.push('slotWr=' + JSON.stringify(r.slotWrites.map(x => x[0])));
  if (r.globalReads.length) parts.push('gRd=' + JSON.stringify(r.globalReads));
  if (r.globalWrites.length) parts.push('gWr=' + JSON.stringify(r.globalWrites.map(x => x[0])));
  if (r.globalHas.length) parts.push('gHas=' + JSON.stringify(r.globalHas));
  if (r.error) parts.push('ERR=' + r.error.slice(0, 60));
  lines.push(parts.join(' '));
}
fs.writeFileSync(path.join(__dirname, 'roles.txt'), lines.join('\n'));
console.log(lines.join('\n'));
