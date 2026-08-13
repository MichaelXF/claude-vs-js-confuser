// debug/load.js - load input.js inside a node vm context and expose internals
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(file, opts = {}) {
  const srcPath = path.resolve(__dirname, '..', file || 'input.js');
  let src = fs.readFileSync(srcPath, 'utf8');

  // Optionally strip the trailing bootstrap call so the program doesn't run
  if (opts.noRun) {
    // last statement is `z(new p(D,B,[...]),void 0,new t({...}),NN,null,{});`
    const idx = src.lastIndexOf('\nz(new p(');
    if (idx === -1) throw new Error('bootstrap call not found');
    src = src.slice(0, idx) + '\nglobalThis.__BOOT__ = function(){ globalThis.__BOOTARGS__ = [].slice.call(arguments); };\n' +
      src.slice(idx + 1).replace(/^z\(/, '__BOOT__(');
  }

  const logs = [];
  const sandbox = {
    console: {
      log: (...a) => { logs.push(a); if (!opts.quiet) console.log(...a); },
      error: (...a) => { logs.push(a); if (!opts.quiet) console.error(...a); },
      warn: (...a) => { logs.push(a); if (!opts.quiet) console.warn(...a); },
    },
    Buffer, atob: global.atob, Math, JSON, Object, Array, String, Number, Boolean,
    Uint8Array, Uint32Array, WeakMap, Map, Set, Symbol, Date, RegExp, Error,
    TypeError, ReferenceError, RangeError, SyntaxError, Promise, parseInt, parseFloat,
    isNaN, isFinite, setTimeout, clearTimeout, process,
  };
  sandbox.globalThis = sandbox;
  if (opts.window) { sandbox.window = sandbox; sandbox.document = { title: 'doc' }; }
  const ctx = vm.createContext(sandbox);
  let err = null;
  try {
    vm.runInContext(src, ctx, { filename: srcPath });
  } catch (e) {
    err = e;
    if (!opts.quiet) console.error('[run error]', e.message);
  }
  return { ctx, logs, err, src };
}

module.exports = { load };

if (require.main === module) {
  const r = load(process.argv[2] || 'input.js', { window: true });
  console.log('--- keys ---');
  console.log(Object.keys(r.ctx).filter(k => k.length <= 2).join(' '));
}
