'use strict';
// Classify every handler in the table (including the ones this sample never
// executes) by synthesizing an instruction for it.
const fs = require('fs'), path = require('path');
const { loadRuntime } = require('../lib-extract.js');
const { prepare, probe } = require('../lib-probe.js');
const { classify } = require('../lib-disasm.js');
const { regTracer, THIS_MARK } = require('../lib-classify.js');

const M = prepare(loadRuntime(fs.readFileSync(path.join(__dirname, '..', 'input.js'), 'utf8')));
const real = M.bytecode;
const ctx = { nibbleHint: new Map() };
const fn = { id: 0, entry: 0, B: 1885479456, nregs: 32, nparams: 0, rest: false };
const rows = [];
for (const key of M.opKeys) {
  const op = +key;
  const Q = new Uint32Array(40);
  Q[0] = op;
  for (let i = 1; i < Q.length; i++) Q[i] = (i % 9) + 1;
  M.bytecode = Q;
  let ir;
  try {
    const log = [];
    const regs = []; for (let i = 0; i < 40; i++) regs.push(regTracer(i, log));
    const p = probe(M, { pc: 0, B: fn.B, nregs: 40, regs, thisVal: THIS_MARK });
    const site = { pc: 0, op, operands: p.operands.slice(), next: p.fall };
    ir = classify(M, site, fn, ctx);
  } catch (e) { ir = { kind: 'ERROR', err: e.message }; }
  rows.push([op, ir.kind, JSON.stringify(ir, (k, v) => ['operands', 'stack', 'vm', 'fnInfo'].includes(k) ? undefined : v).slice(0, 150)]);
}
M.bytecode = real;
rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0]);
const byKind = {};
for (const [op, kind] of rows) byKind[kind] = (byKind[kind] || 0) + 1;
console.log('kind histogram:', byKind);
console.log(rows.map(r => `${String(r[0]).padStart(6)}  ${r[1].padEnd(14)} ${r[2]}`).join('\n'));
