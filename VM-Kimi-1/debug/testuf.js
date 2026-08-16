// Test the unflattener on both functions.
const fs = require('fs');
const core = require('./core');
const { unflatten } = require('./unflatten');

const words = require('./bytecode.json');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const pool = eval(src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/)[1]);
const ctx = core.makeCtx(words, pool);

function test(name, blocksFile, cfg) {
  const blocks = new Map(require('./' + blocksFile));
  const uf = unflatten(ctx, blocks, cfg);
  console.log(`\n===== ${name} =====`);
  console.log('specialValue:', uf.specialValue, 'specialBlock:', uf.specialBlock, 'entryState:', uf.entryState, 'entryReal:', uf.entryReal);
  console.log('cases:', uf.cases.length);
  const nodes = [...uf.realNodes.values()].sort((a, b) => a.ip - b.ip);
  for (const n of nodes) {
    const succStr = n.succs.map(s => (s.cond === null ? '' : s.cond ? 'T:' : 'F:') + s.ip).join(', ');
    console.log(`  node ${n.ip} (state=${n.entryState}, kind=${n.block.kind}) -> ${succStr || '(none)'}`);
  }
}

test('main', 'mainblocks.json', { stateReg: 48, accReg: 50, headerIp: 59, entry: 36, trampIp: 2517, argRegs: [144, 143] });
test('inner', 'innerblocks.json', { stateReg: 20, accReg: 22, headerIp: 2555, entry: 2532, trampIp: 3955, argRegs: [77, 76] });
