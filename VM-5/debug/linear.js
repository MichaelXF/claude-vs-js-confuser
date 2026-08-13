// debug/linear.js - linear sweep disassembly of the whole bytecode (finds blocks that the
// CFG walk cannot reach because their jumps are computed by the dispatcher)
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));
const out = [];
let pc = Number(process.argv[3] || 0);
const end = Number(process.argv[4] || env.code.length);
const fmtVal = v => typeof v === 'string' ? JSON.stringify(v) : String(v);
while (pc < end) {
  const ins = V.decodeAt(env, pc);
  let extra = '';
  const w = ins.rec && ins.rec.regWrites[ins.rec.regWrites.length - 1];
  if (w && (ins.kind === 'expr')) extra = ' -> r' + w[0] + '=' + fmtVal(w[1]);
  if (ins.rec && ins.rec.globalReads.length) extra += ' glob=' + ins.rec.globalReads.join(',');
  if (ins.rec && ins.rec.globalWrites.length) extra += ' globset=' + ins.rec.globalWrites.map(x => x[0]).join(',');
  out.push(String(pc).padStart(5) + ': ' + String(ins.op).padStart(5) + ' ' + ins.kind.padEnd(14) + ' [' + ins.operands.join(', ') + ']' + extra);
  if (ins.kind === 'invalid') { out.push('  !! invalid opcode, stopping'); break; }
  pc = ins.next;
}
fs.writeFileSync(path.join(__dirname, 'linear.txt'), out.join('\n'));
console.log(out.length + ' instructions -> debug/linear.txt');
console.log(out.slice(0, Number(process.env.SHOW || 60)).join('\n'));
