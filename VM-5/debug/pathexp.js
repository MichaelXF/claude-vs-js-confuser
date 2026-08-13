// debug/pathexp.js - experiment: path-sensitive exploration (node = pc + register state)
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));
const UNKNOWN = V.UNKNOWN;
const entry = Number(process.argv[3] || 40);

function stateKey(st) {
  const parts = [];
  for (const [k, v] of [...st.entries()].sort((a, b) => a[0] - b[0])) {
    if (v === UNKNOWN || v === undefined) continue;
    parts.push(k + '=' + (v && v.__fn ? 'fn' + v.entry : (typeof v === 'object' ? 'obj' : String(v))));
  }
  return parts.join(',');
}

const seen = new Set();
const pcSeen = new Map();
const work = [{ pc: entry, st: new Map() }];
let nodes = 0, unresolved = 0, iterations = 0;
const CAP = Number(process.env.CAP || 100000);
while (work.length) {
  if (++iterations > CAP) { console.log('CAP hit'); break; }
  const { pc, st } = work.pop();
  const key = pc + '|' + stateKey(st);
  if (seen.has(key)) continue;
  seen.add(key);
  nodes++;
  pcSeen.set(pc, (pcSeen.get(pc) || 0) + 1);
  const r = V.stepState(env, pc, st);
  for (const s of r.succ) work.push({ pc: s.pc, st: s.st });
  if (r.unresolved) unresolved++;
}
console.log('nodes:', nodes, 'distinct pcs:', pcSeen.size, 'unresolved computed jumps:', unresolved);
const top = [...pcSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('most-visited pcs:', top.map(([p, c]) => p + 'x' + c).join(' '));
console.log('pc coverage span:', Math.min(...pcSeen.keys()), '-', Math.max(...pcSeen.keys()));
