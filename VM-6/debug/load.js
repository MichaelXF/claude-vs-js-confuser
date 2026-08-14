// debug/load.js -- load input.js in a sandbox, capture VM internals WITHOUT running the program
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const vmmod = require('vm');

function loadVM(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parser.parse(src, { sourceType: 'script' });
  const body = ast.program.body;
  const last = body[body.length - 1];
  if (last.type !== 'ExpressionStatement' || last.expression.type !== 'CallExpression')
    throw new Error('no bootstrap call');
  const bootName = last.expression.callee.name;
  last.expression.callee = { type: 'Identifier', name: '__cap' };
  const code = 'var __boot;var __cap=function(){__boot=[].slice.call(arguments)};\n' + generate(ast, { compact: false }).code;

  const sandbox = {
    console, Math, Object, Array, String, Number, Boolean, JSON, Reflect, WeakMap, Uint8Array, Uint32Array,
    Buffer, atob: typeof atob !== 'undefined' ? atob : undefined, Error, TypeError, ReferenceError,
    RangeError, SyntaxError, Function, Symbol, Date, RegExp, Promise, Map, Set, parseInt, parseFloat,
    isNaN, isFinite, encodeURIComponent, decodeURIComponent, Proxy, Infinity, NaN, undefined,
  };
  const ctx = vmmod.createContext(sandbox);
  vmmod.runInContext(code, ctx, { filename: file });
  const boot = ctx.__boot;
  return {
    ctx,
    bootName,
    vm: boot[0],          // instance of g: .i bytecode, .A pool, .h globals
    thisArg: boot[1],
    args: boot[2],
    tmpl: boot[3],        // instance of t: .x = {o,m,F,C,H}
    A: ctx.A,             // opcode table (g.prototype)
    G: ctx.g, T: ctx.t, U: ctx.u, W: ctx.w, V: ctx.v, R: ctx.r, X: ctx.x, Z: ctx.z,
  };
}

module.exports = { loadVM };

if (require.main === module) {
  const L = loadVM(process.argv[2] || path.join(__dirname, '..', 'input.js'));
  console.log('bootstrap fn:', L.bootName);
  console.log('bytecode words:', L.vm.i.length);
  console.log('pool entries:', L.vm.A.length);
  console.log('root template:', JSON.stringify(L.tmpl.x));
  console.log('first 40 words:', Array.from(L.vm.i.slice(0, 40)));
  const ops = Object.keys(L.A).map(Number).filter(n => !isNaN(n));
  console.log('opcodes:', ops.length);
  fs.writeFileSync(path.join(__dirname, 'bytecode.json'), JSON.stringify(Array.from(L.vm.i)));
}
