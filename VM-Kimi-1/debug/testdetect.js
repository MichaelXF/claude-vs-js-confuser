// Verify auto-detected configs (detect.js) produce the same lifted output as the
// hand-tuned configs used in build.js.
const fs = require('fs');
const core = require('./core');
const { explore } = require('./explore');
const { unflatten } = require('./unflatten');
const { decodeAll, findTrampoline, detectFlow } = require('./detect');
const L = require('./lift');
const { cleanup } = require('./cleanup');
const generate = require('@babel/generator').default;

const words = require('./bytecode.json');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const pool = eval(src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/)[1]);
const ctx = core.makeCtx(words, pool);
const instrs = decodeAll(ctx);

function decompile(entry, prefix, closureMap, makeFunc) {
  const t = findTrampoline(ctx, instrs, entry);
  const cfg = { entry, prefix, trampIp: t.trampIp, argRegs: t.argRegs, prop: t.prop, dispEntry: t.dispEntry, nreg: 200 };
  const blocks = explore(ctx, cfg);
  const flow = detectFlow(ctx, blocks, t.argRegs);
  Object.assign(cfg, flow);
  cfg.j = entry === 2532 ? 2 : 0;
  cfg.paramRegs = entry === 2532 ? [0, 1] : [];
  cfg.paramNames = entry === 2532 ? ['a0', 'a1'] : [];
  const uf = unflatten(ctx, blocks, cfg);
  const out = L.liftFunction(ctx, blocks, uf, cfg, closureMap, makeFunc);
  cleanup(out.body, prefix);
  return out;
}

const inner = decompile(2532, 'i', { 0: 'm9' }, () => { throw new Error('n2'); });
const main = decompile(36, 'm', { 0: 't2' }, (e) => L.funcExpr(['a0', 'a1'], inner.body));
const code = generate({ type: 'Program', body: main.body }, {}).code;
console.log(code.split('\n').filter(l => /t2|m9 =/.test(l)).join('\n'));
console.log('--- inner guard/loop ---');
console.log(generate({ type: 'Program', body: inner.body }, {}).code.split('\n').slice(0, 8).join('\n'));
