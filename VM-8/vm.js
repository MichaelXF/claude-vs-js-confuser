'use strict';
// ===========================================================================
// vm.js — devirtualizer for "JS-Confuser-VM MBA v6" samples.
//
//   node vm.js input.js output.js
//   require('./vm.js')('input.js')   -> deobfuscated source (string)
//
// Pipeline
//   1. lib-extract   locate the VM runtime by AST shape, load it sandboxed
//   2. lib-probe     execute single bytecode instructions under instrumentation
//   3. lib-disasm    linear sweep + behavioral classification of every site
//   4. lib-analyze   discover functions, walk each CFG, produce IR
//   5. lib-peval     specialize the control-flow-flattening dispatcher away
//   6. lib-emit      merge, dead-code eliminate, restructure the CFG
//   7. lib-codegen   emit JavaScript
//
// Nothing is keyed on opcode numbers, handler order or identifier names: the
// semantics of every handler are recovered by running it.
// ===========================================================================
const fs = require('fs');
const path = require('path');
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const parser = require('@babel/parser');

const { loadRuntime } = require('./lib-extract.js');
const { prepare } = require('./lib-probe.js');
const { analyze } = require('./lib-analyze.js');
const { pevalFunction } = require('./lib-peval.js');
const { buildFunctions } = require('./lib-codegen.js');
const { polish } = require('./lib-polish.js');

function deobfuscateSource(source, opts = {}) {
  const log = opts.verbose ? (...a) => console.error('[vm]', ...a) : () => {};
  let M = null;
  try { M = loadRuntime(source); } catch (e) { M = null; }
  if (!M) {
    log('no JS-Confuser VM bootstrap found - passing the file through');
    // Still make sure it parses so that malformed input is reported.
    parser.parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
    return { code: source, passthrough: true, warnings: [] };
  }
  prepare(M);
  log('bytecode words:', M.bytecode.length, 'constants:', M.pool.length, 'handlers:', M.opKeys.length);

  const R = analyze(M);
  log('functions:', R.functions.length);
  if (R.decrypted && R.decrypted.length) {
    log('decrypted bytecode regions:', R.decrypted.map(d => d.decrypts.join('..')).join(', '));
  }

  const pevals = new Map();
  for (const fn of R.functions) {
    const P = pevalFunction(M, fn);
    pevals.set(fn.id, P);
    log(`  fn${fn.id} entry=${fn.entry} sites=${fn.sites.size} -> ${P.nodes.length} specialized nodes` +
      (P.dispatcher ? ` (dispatcher at ${P.dispatcher.head}, state ${P.dispatcher.state})` : ''));
  }

  const out = buildFunctions(M, R, pevals, opts);

  // The entry function becomes the program body; wrap it only when it really
  // needs to return.
  const preamble = [];
  if (out.helpers && out.helpers.has('forin')) {
    preamble.push(...parser.parse(FORIN_HELPERS).program.body);
  }
  const wrapper = t.functionExpression(null, [], t.blockStatement(out.main.body.slice()));
  const program = t.file(t.program([t.expressionStatement(t.callExpression(wrapper, []))]));
  if (opts.polish !== false) {
    try { polish(program); } catch (e) { (out.warnings || []).push('polish pass failed: ' + e.message); }
  }
  // Unwrap the entry point when it does not actually need to return.
  const inner = wrapper.body.body;
  if (!containsReturn(inner)) program.program.body = inner;
  if (preamble.length) program.program.body.unshift(...preamble);
  const code = generate(program, { comments: true, compact: false, concise: false, jsescOption: { minimal: true } }).code;
  return { code, passthrough: false, warnings: out.warnings, functions: R.functions.length };
}

const FORIN_HELPERS = [
  'var __ITER_DONE = {};',
  'function __forInKeys(o) { var k = []; for (var p in o) k.push(p); return { keys: k, i: 0 }; }',
  'function __iterNext(it) { return it.i < it.keys.length ? it.keys[it.i++] : __ITER_DONE; }',
].join('\n');

function isVoidLike(node) {
  return (t.isUnaryExpression(node) && node.operator === 'void') ||
    (t.isIdentifier(node) && node.name === 'undefined');
}
function containsReturn(stmts) {
  let found = false;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || found) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n.type) return;
    if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' ||
        n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod' || n.type === 'ClassMethod') return;
    if (n.type === 'ReturnStatement') { found = true; return; }
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'start' && k !== 'end') walk(n[k]);
  };
  walk(stmts);
  return found;
}

function deobfuscateFile(inputPath, outputPath, opts = {}) {
  const source = fs.readFileSync(inputPath, 'utf8');
  const res = deobfuscateSource(source, opts);
  if (outputPath) fs.writeFileSync(outputPath, res.code);
  return res.code;
}

module.exports = deobfuscateFile;
module.exports.deobfuscateSource = deobfuscateSource;
module.exports.deobfuscateFile = deobfuscateFile;

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a !== '--verbose' && a !== '-v');
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  if (!args.length) {
    console.error('usage: node vm.js <input.js> [output.js]');
    process.exit(1);
  }
  const input = args[0];
  const output = args[1] || path.join(path.dirname(input), 'output.js');
  const started = Date.now();
  const res = deobfuscateSource(fs.readFileSync(input, 'utf8'), { verbose });
  fs.writeFileSync(output, res.code);
  for (const w of res.warnings || []) console.error('[vm] warning:', w);
  console.error(`[vm] ${res.passthrough ? 'passed through' : 'deobfuscated'} ${input} -> ${output} in ${Date.now() - started}ms`);
}
