// debug/patch-gdce.js - whole-function dead code elimination (removes dead *cycles*, e.g.
// the flattening state variable that only ever feeds itself)
const fs = require('fs');
const path = require('path');
const p = path.resolve(__dirname, '..', 'vm.js');
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('function globalDeadCode')) {
  const anchor = 'function computeLiveness(bbs, capturedRegs) {';
  s = s.replace(anchor, `/**
 * Whole-function dead code elimination.
 *
 * Liveness alone cannot remove the flattening's state variable: every block updates it
 * from its own previous value, so it keeps itself alive even though nothing ever reads
 * it.  This marks the statements that are actually needed (side effects, returns, branch
 * conditions, captured variables) and works backwards through the def/use graph; whatever
 * is left over is deleted no matter how it is entangled with itself.
 */
function globalDeadCode(bbs, capturedRegs) {
  const defsOf = new Map();          // register -> [statement]
  const all = [];
  for (const [, bb] of bbs) {
    for (const st of bb.ir) {
      all.push({ st, bb });
      if (st.kind === 'assign') {
        if (!defsOf.has(st.dst)) defsOf.set(st.dst, []);
        defsOf.get(st.dst).push(st);
      }
    }
  }
  const needed = new Set();
  const neededRegs = new Set(capturedRegs);
  const work = [];
  const need = st => { if (!needed.has(st)) { needed.add(st); work.push(st); } };
  for (const { st } of all) {
    if (st.kind !== 'assign') need(st);                       // effects, returns, throws…
    else if (!irIsPure(st.expr)) need(st);
    else if (capturedRegs.has(st.dst)) need(st);
  }
  for (const [, bb] of bbs) if (bb.term && bb.term.test) for (const r of irUsesRegisters(bb.term.test)) neededRegs.add(r);
  for (const r of neededRegs) for (const st of defsOf.get(r) || []) need(st);
  while (work.length) {
    const st = work.pop();
    for (const r of statementReads(st)) {
      if (neededRegs.has(r)) continue;
      neededRegs.add(r);
      for (const d of defsOf.get(r) || []) need(d);
    }
  }
  let removed = 0;
  for (const [, bb] of bbs) {
    const before = bb.ir.length;
    bb.ir = bb.ir.filter(st => needed.has(st));
    removed += before - bb.ir.length;
  }
  return removed;
}

` + anchor);
}

const oldPasses = `  for (let round = 0; round < 12; round++) {
    const { liveOut } = computeLiveness(bbs, captured);
    let changed = false;
    for (const [id, bb] of bbs) if (deadStoreElimination(bb, new Set(liveOut.get(id)), captured)) changed = true;
    if (!changed) break;
  }`;
if (!s.includes(oldPasses)) throw new Error('dce rounds not found');
s = s.replace(oldPasses, `  globalDeadCode(bbs, captured);
  for (let round = 0; round < 12; round++) {
    const { liveOut } = computeLiveness(bbs, captured);
    let changed = false;
    for (const [id, bb] of bbs) if (deadStoreElimination(bb, new Set(liveOut.get(id)), captured)) changed = true;
    if (!changed) break;
  }`);

const oldSecond = `  for (let round = 0; round < 4; round++) {
    const { liveOut } = computeLiveness(bbs, captured);
    let changed = false;
    for (const [id, bb] of bbs) if (deadStoreElimination(bb, new Set(liveOut.get(id)), captured)) changed = true;
    if (!changed) break;
  }`;
if (!s.includes(oldSecond)) throw new Error('second dce rounds not found');
s = s.replace(oldSecond, `  globalDeadCode(bbs, captured);
  for (let round = 0; round < 4; round++) {
    const { liveOut } = computeLiveness(bbs, captured);
    let changed = false;
    for (const [id, bb] of bbs) if (deadStoreElimination(bb, new Set(liveOut.get(id)), captured)) changed = true;
    if (!changed) break;
  }`);

fs.writeFileSync(p, s);
console.log('patched vm.js (global dead code elimination)');
