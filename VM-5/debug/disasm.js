// debug/disasm.js - decode all functions in the bytecode and print a disassembly listing
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));

const K = env.templateKeys;
const mainMeta = env.mainTemplate[K.metaProp];
const funcs = new Map();
const queue = [{ entry: mainMeta[K.entry], m: mainMeta[K.m], l: mainMeta[K.l], rest: !!mainMeta[K.rest], upvals: [], id: 0, main: true }];
const seenFn = new Set([mainMeta[K.entry]]);
let nextId = 1;

const kindsUsed = new Map();

while (queue.length) {
  const fn = queue.shift();
  fn.instrs = new Map();
  const work = [fn.entry];
  const seen = new Set();
  while (work.length) {
    const pc = work.pop();
    if (seen.has(pc) || pc >= env.code.length) continue;
    seen.add(pc);
    const ins = V.decodeAt(env, pc);
    fn.instrs.set(pc, ins);
    kindsUsed.set(ins.kind, (kindsUsed.get(ins.kind) || 0) + 1);
    const k = ins.k;
    const o = ins.operands;
    let succ = [ins.next];
    switch (ins.kind) {
      case 'jmp': succ = [o[k.target]]; break;
      case 'jz': case 'jnz': succ = [o[k.target], ins.next]; break;
      case 'forin_next': succ = [o[k.targetSlot], ins.next]; break;
      case 'ret': case 'throw': succ = []; break;
      case 'jmp_reg': succ = []; break;
      case 'push_try': succ = [ins.next, o[0]]; break;
      case 'invalid': succ = []; break;
      case 'make_function': {
        const M = env.meta;
        const entry = o[M.entry];
        if (!seenFn.has(entry)) {
          seenFn.add(entry);
          queue.push({ entry, m: o[M.m], l: o[M.l], rest: !!o[M.rest], upvalCount: o[M.countSlot], id: nextId++, parent: fn.id });
        }
        break;
      }
    }
    for (const s of succ) if (typeof s === 'number' && s >= 0) work.push(s);
  }
  funcs.set(fn.entry, fn);
}

// ---- print
const out = [];
const fmtVal = v => typeof v === 'string' ? JSON.stringify(v) : String(v);
for (const fn of [...funcs.values()].sort((a, b) => a.id - b.id)) {
  out.push(`\n=== function #${fn.id} entry=${fn.entry} params=${fn.m} locals=${fn.l} rest=${fn.rest} upvals=${fn.upvalCount || 0} ${fn.main ? '(MAIN)' : ''} instrs=${fn.instrs.size}`);
  for (const pc of [...fn.instrs.keys()].sort((a, b) => a - b)) {
    const ins = fn.instrs.get(pc);
    let extra = '';
    if (ins.kind === 'expr' || ins.kind === 'const') {
      const w = ins.rec.regWrites[ins.rec.regWrites.length - 1];
      if (w) extra = ' -> r' + w[0] + '=' + fmtVal(w[1]);
    }
    if (ins.rec.globalReads.length) extra += ' glob=' + ins.rec.globalReads.join(',');
    if (ins.rec.globalWrites.length) extra += ' globset=' + ins.rec.globalWrites.map(x => x[0]).join(',');
    out.push(String(pc).padStart(5) + ': ' + String(ins.op).padStart(5) + ' ' + ins.kind.padEnd(14) + ' [' + ins.operands.join(', ') + ']' + extra);
  }
}
out.push('\nkinds used: ' + [...kindsUsed.entries()].map(([k, v]) => k + ':' + v).join(' '));
fs.writeFileSync(path.join(__dirname, 'disasm.txt'), out.join('\n'));
console.log(out.slice(0, 120).join('\n'));
console.log('...\nwrote debug/disasm.txt  (' + funcs.size + ' functions)');
console.log('kinds used: ' + [...kindsUsed.entries()].map(([k, v]) => k + ':' + v).join(' '));
