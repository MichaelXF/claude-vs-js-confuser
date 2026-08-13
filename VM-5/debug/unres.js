// debug/unres.js - show the path that leads to an unresolved computed jump
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));
const prog = V.analyzeProgram(env);
const UNKNOWN = V.UNKNOWN;

for (const fn of prog.order) {
  if (!fn.unresolved.length) continue;
  console.log('function #' + fn.id + ' entry=' + fn.entry + ' unresolved at pcs: ' + fn.unresolved.join(','));
  // find the nodes with that pc
  for (const upc of new Set(fn.unresolved)) {
    for (const node of fn.perPc.get(upc) || []) {
      if (node.resolvedTo !== undefined) continue;
      console.log('--- node ' + node.id.slice(0, 120));
      const known = [...node.state.entries()].filter(([, v]) => v !== UNKNOWN && v !== undefined)
        .map(([r, v]) => 'r' + r + '=' + (v && v.__fn ? 'fn@' + v.entry : JSON.stringify(v)));
      console.log('    known regs: ' + known.join(' '));
      const unk = [...node.state.entries()].filter(([, v]) => v === UNKNOWN).map(([r]) => 'r' + r);
      console.log('    unknown regs: ' + unk.join(' '));
    }
  }
}

// find predecessors of the dispatcher block for function #1 and dump one full block
const fn1 = prog.order.find(f => f.unresolved.length);
if (fn1) {
  const preds = new Map();
  for (const [, n] of fn1.nodes) for (const s of n.succ || []) {
    if (!preds.has(s)) preds.set(s, []);
    preds.get(s).push(n);
  }
  for (const upc of new Set(fn1.unresolved)) {
    for (const node of fn1.perPc.get(upc) || []) {
      if (node.resolvedTo !== undefined) continue;
      // walk back up to 30 instructions
      const chain = [];
      let cur = node;
      const seen = new Set();
      while (cur && chain.length < 40 && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.unshift(cur);
        const p = preds.get(cur.id);
        cur = p && p[0];
      }
      console.log('\npath into the unresolved jump:');
      for (const n of chain) {
        const ins = n.ins;
        if (!ins) continue;
        const w = [];
        console.log('  ' + String(ins.pc).padStart(5) + ': ' + ins.kind.padEnd(12) + ' [' + ins.operands.join(',') + ']');
      }
      break;
    }
  }
}
