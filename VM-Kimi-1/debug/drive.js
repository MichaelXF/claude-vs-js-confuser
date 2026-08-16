// Driver: verify dispatcher emulation and explore both functions.
const fs = require('fs');
const core = require('./core');
const { explore } = require('./explore');

const words = require('./bytecode.json');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const m = src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/);
const pool = eval(m[1]);
const ctx = core.makeCtx(words, pool);

// Verify dispatcher1 (3971) against earlier probe values
const d1 = (a, b) => core.runDispatcher(ctx, 3971, a, b)[0];
console.log('disp1 entry block (expect 99):', d1(-678747472, -389244826));
console.log('disp1 block 99 true  (expect 139):', d1(363217158, 1951410499));
console.log('disp1 block 99 false (expect 147):', d1(363217158, -1554462678));

// Verify dispatcher2 (4135): need a known pair. We'll trust and cross-check via exploration.

// Explore main function
const mainCfg = { entry: 36, trampIp: 2517, argRegs: [144, 143], prop: 0, dispEntry: 3971, nreg: 152 };
const mainBlocks = explore(ctx, mainCfg);
console.log('main blocks:', mainBlocks.size);

// Explore inner function 2532
const innerCfg = { entry: 2532, trampIp: 3955, argRegs: [77, 76], prop: 'e6pfz', dispEntry: 4135, nreg: 85 };
const innerBlocks = explore(ctx, innerCfg);
console.log('inner blocks:', innerBlocks.size);

// Save both
function save(blocks, file) {
  fs.writeFileSync(__dirname + '/' + file, JSON.stringify([...blocks.entries()].map(([k, v]) => [k, {
    kind: v.kind, instrs: v.instrs, targets: v.targets, targetTrue: v.targetTrue,
    targetFalse: v.targetFalse, target: v.target, fallthrough: v.fallthrough, condReg: v.condReg, reg: v.reg,
    cond: v.cond && v.cond.t === 'x' ? v.cond : undefined,
  }]), null, 0));
}
save(mainBlocks, 'mainblocks.json');
save(innerBlocks, 'innerblocks.json');

// Print inner blocks summary
for (const [ip, b] of [...innerBlocks.entries()].sort((a, b) => a[0] - b[0])) {
  const tag = b.kind === 'dispatch' ? `==> ${b.targets[0]}`
    : b.kind === 'dispatch-cond' ? `==> T:${b.targetTrue} F:${b.targetFalse}`
    : b.kind === 'jump' ? `==> jump ${b.target}`
    : b.kind === 'condjump' ? `==> condjump T:${b.target} F:${b.fallthrough}`
    : `==> ${b.kind}`;
  console.log(`inner block ${ip} ${tag} (${b.instrs.length} instrs)`);
}
