// debug/cfg.js - dump the merged CFG of a function (blocks, edges, terminators)
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));
const prog = V.analyzeProgram(env);
const want = Number(process.argv[3] || 1);
const fn = prog.order.find(f => f.id === want);
env.currentFrameSize = env.frameLayout.header + fn.l;
const merged = V.mergeNodes(fn);
const { bbs, entry } = V.buildBasicBlocks(merged);
console.log('function #' + fn.id, 'entry bb:', entry, 'blocks:', bbs.size, 'merged nodes:', merged.blocks.size);

const preds = new Map();
for (const [id, bb] of bbs) for (const s of bb.succ) { if (!preds.has(s)) preds.set(s, []); preds.get(s).push(id); }
const lines = [];
for (const [id, bb] of bbs) {
  const pcs = bb.nodes.map(n => n.pc);
  const last = bb.nodes[bb.nodes.length - 1];
  lines.push(`${id}${id === entry ? ' (ENTRY)' : ''}: pcs ${pcs[0]}..${pcs[pcs.length - 1]} (${pcs.length}) -> ${bb.succ.join(',') || 'END'} ${last.branch ? 'BRANCH on r' + last.branch.reg + (last.branch.negate ? ' (neg)' : '') : last.ins.kind} preds=${(preds.get(id) || []).length}`);
}
console.log(lines.slice(0, Number(process.env.SHOW || 40)).join('\n'));
console.log('...');
// reachability check for terminators
let rets = 0, ends = 0;
for (const [, bb] of bbs) {
  const last = bb.nodes[bb.nodes.length - 1];
  if (last.ins.kind === 'ret') rets++;
  if (!bb.succ.length) ends++;
}
console.log('blocks ending in ret:', rets, ' blocks with no successor:', ends);
fs.writeFileSync(path.join(__dirname, 'cfg' + want + '.txt'), lines.join('\n'));
