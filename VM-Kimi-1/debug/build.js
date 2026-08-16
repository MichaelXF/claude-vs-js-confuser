// Full pipeline driver: explore -> unflatten -> lift -> generate.
const fs = require('fs');
const core = require('./core');
const { explore } = require('./explore');
const { unflatten } = require('./unflatten');
const L = require('./lift');
const { cleanup } = require('./cleanup');
const generate = require('@babel/generator').default;

const words = require('./bytecode.json');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const pool = eval(src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/)[1]);
const ctx = core.makeCtx(words, pool);

const MAIN_CFG = { prefix: 'm', stateReg: 48, accReg: 50, headerIp: 59, entry: 36, trampIp: 2517, argRegs: [144, 143], maskRegs: [147, 148], deltaReg: 142, prop: 0, dispEntry: 3971, nreg: 152, j: 0, paramRegs: [], paramNames: [] };
const INNER_CFG = { prefix: 'i', stateReg: 20, accReg: 22, headerIp: 2555, entry: 2532, trampIp: 3955, argRegs: [77, 76], maskRegs: [80, 81], deltaReg: 75, prop: 'e6pfz', dispEntry: 4135, nreg: 85, j: 2, paramRegs: [0, 1], paramNames: ['a0', 'a1'] };

let innerCache = null;
function decompileInner() {
  if (innerCache) return innerCache;
  const cfg = INNER_CFG;
  const blocks = explore(ctx, cfg);
  const uf = unflatten(ctx, blocks, cfg);
  // inner's closure[0] = main's r9 -> 'm9'
  const out = L.liftFunction(ctx, blocks, uf, cfg, { 0: 'm9' }, (e) => { throw new Error('nested nested ' + e); });
  cleanup(out.body, cfg.prefix);
  innerCache = out;
  return out;
}

function decompileMain() {
  const cfg = MAIN_CFG;
  const blocks = explore(ctx, cfg);
  const uf = unflatten(ctx, blocks, cfg);
  const makeFunc = (nestedEntry) => {
    if (nestedEntry === 2532) {
      const inner = decompileInner();
      return L.funcExpr(INNER_CFG.paramNames, inner.body);
    }
    throw new Error('unknown nested func ' + nestedEntry);
  };
  // main's closure[0] = top-level r2 -> 't2'
  const out = L.liftFunction(ctx, blocks, uf, cfg, { 0: 't2' }, makeFunc);
  cleanup(out.body, cfg.prefix);
  return out;
}

// Top-level (entry 0): straight-line.
const topBody = [];
{
  const env = new Map();
  const R = i => (env.has(i) ? env.get(i) : L.id('t' + i));
  let ip = 0;
  while (true) {
    const ins = ctx.decodeAt(ip);
    const o = ins.operands;
    if (ins.name === 'RETURN') break;
    switch (ins.name) {
      case 'LOAD_THIS': env.set(o[0], { type: 'ThisExpression' }); break;
      case 'LOAD_CONST': env.set(o[0], L.lit(ctx.decodeConst(o[1], o[2]))); break;
      case 'MOVE': env.set(o[0], R(o[1])); break;
      case 'LOAD_GLOBAL': env.set(o[0], L.id(String(ctx.decodeConst(o[1], o[2])))); break;
      case 'MAKE_FUNC': env.set(o[0], L.funcExpr(MAIN_CFG.paramNames, decompileMain().body)); break;
      case 'SET_PROP': topBody.push(L.exprStmt(L.assign(L.memC(R(o[0]), R(o[1])), R(o[2])))); break;
      default: throw new Error('top-level unhandled ' + ins.name);
    }
    ip += ins.size;
  }
}
// top-level r2 (t2) is the captured flag; declare it with its initial value (false).
const v2init = { type: 'VariableDeclaration', kind: 'var', declarations: [{ type: 'VariableDeclarator', id: L.id('t2'), init: L.lit(false) }] };
const program = { type: 'Program', body: [v2init, ...topBody] };
const out = generate(program, { comments: false });
console.log(out.code);
fs.writeFileSync(__dirname + '/out.js', out.code);
