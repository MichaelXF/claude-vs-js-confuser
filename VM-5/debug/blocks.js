// debug/blocks.js - dump the final basic blocks + IR of one function (post-optimisation)
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');
const generate = require('@babel/generator').default;

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const src = fs.readFileSync(file, 'utf8');
const env = V.buildEnv(src);
const prog = V.analyzeProgram(env);
const want = Number(process.argv[3] || 3);

// re-run liftProgram but hook liftFunction to dump the blocks of the wanted function
const origLift = V.liftFunction;
env.fitCache = new Map();
const fn = prog.order.find(f => f.id === want);
env.effectFree = env.effectFree || new Set();
const helpers = { functionExpression: () => ({ type: 'Identifier', name: '<fn>' }), forInHelper: () => '__vmForIn', opaqueHelper: () => '__mba' };
V.liftProgram(env, prog);   // populates effectFree etc.

const merged = V.mergeNodes(fn);
console.log('merged blocks:', merged.blocks.size);
const { bbs, entry } = V.buildBasicBlocks(merged);
console.log('basic blocks:', bbs.size, 'entry', entry);
const preds = new Map();
for (const [id, bb] of bbs) for (const s of bb.succ) { if (!preds.has(s)) preds.set(s, []); preds.get(s).push(id); }
for (const [id, bb] of bbs) {
  console.log(`${id}${id === entry ? ' (ENTRY)' : ''} preds=${(preds.get(id) || []).length} nodes=${bb.nodes.length} succ=${bb.succ.join(',') || 'END'} last=${bb.nodes[bb.nodes.length - 1].ins.kind}`);
}
