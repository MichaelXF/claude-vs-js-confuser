// debug/opcodes.js -- print the classified opcode table (the definitive one,
// straight out of vm.js).  Used to write the table in NOTES.md.
//
//   node debug/opcodes.js [input.js]
const path = require('path');
const { loadVM, makeAnalyzer, exploreAll } = require('../vm.js').internals;

const file = process.argv[2] || path.join(__dirname, '..', 'input.js');
const L = loadVM(file);
const A = makeAnalyzer(L);

// which opcodes are actually used, and what each site fits to
const all = exploreAll(A);
const used = new Map();       // op -> Set of fitted descriptions
for (const [, rec] of all) {
  for (const b of rec.blocks.values()) {
    for (const ins of b.stmts) {
      const set = used.get(ins.op) || new Set();
      used.set(ins.op, set);
      if (ins.kind !== 'DATA') { set.add(ins.kind); continue; }
      const f = A.fit(ins, rec.func.C);
      if (f.kind === 'BINARY') set.add('a ' + f.op + ' b');
      else if (f.kind === 'BINARY2') set.add('(a ' + f.op + ' b) ' + f.op2 + ' K');
      else if (f.kind === 'BINARY3') set.add('(a ' + f.op + ' b) ' + f.op2 + ' c');
      else if (f.kind === 'BINCONST') set.add(f.side === 'right' ? 'a ' + f.op + ' K' : 'K ' + f.op + ' a');
      else if (f.kind === 'UNARY') set.add(f.op + ' a');
      else if (f.kind === 'MOV') set.add('a');
      else if (f.kind === 'CONST') set.add('constant');
      else set.add('?? ' + f.kind);
    }
  }
}

const ops = Object.keys(A.T).map(Number).sort((a, b) => a - b);
let structural = 0, data = 0, mba = 0;
const rows = [];
for (const op of ops) {
  const info = A.T[op];
  const l = info.layout;
  const isMBA = info.kind === 'DATA' && info.code.length > 400;
  if (info.kind === 'DATA') { data++; if (isMBA) mba++; } else structural++;
  rows.push({
    op, kind: info.kind, words: l.consumed, regs: l.reads.join(','),
    dst: l.writes.join(','), size: info.code.length, mba: isMBA,
    seen: used.has(op) ? [...used.get(op)].join(' | ') : '',
  });
}
console.log('opcodes: ' + ops.length + '  (structural ' + structural + ', data ' + data +
  ' of which MBA-obfuscated ' + mba + ')');
console.log('used by this sample: ' + used.size);
console.log('');
console.log('  op     kind          words regs      dst  src-len  meaning at the sites we see');
for (const r of rows) {
  console.log('  ' + String(r.op).padEnd(6) + ' ' + r.kind.padEnd(13) + ' ' +
    String(r.words).padEnd(5) + ' ' + ('[' + r.regs + ']').padEnd(9) + ' ' +
    ('[' + r.dst + ']').padEnd(4) + ' ' + String(r.size).padStart(6) + '   ' + r.seen);
}
