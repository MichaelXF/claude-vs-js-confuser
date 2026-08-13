// debug/patch-dup.js - tail-duplicate small join blocks + trap unresolved computed jumps
const fs = require('fs');
const path = require('path');
const p = path.resolve(__dirname, '..', 'vm.js');
let s = fs.readFileSync(p, 'utf8');

/* 1. duplicate small join blocks so that straight-line code stays in one basic block.
      Control-flow flattening shares tails between many blocks; after the merge those
      shared nodes cut the code into single-instruction blocks, which stops expressions
      from being re-nested.  Cloning them (they are identical by construction) restores
      long straight-line runs. */
const anchor = '/* ---------------- IR ---------------- */';
if (!s.includes(anchor)) throw new Error('anchor not found');
const dupFn = `/**
 * Tail-duplicate small join nodes.  Flattening reuses one node as the tail of many
 * blocks; duplicating those nodes (they are identical by construction) turns the graph
 * back into long straight-line runs, which is what lets expressions re-nest.
 */
function duplicateJoins(merged, limit = 6) {
  const { blocks } = merged;
  const originalSize = blocks.size;
  for (let round = 0; round < 6; round++) {
    const preds = new Map();
    for (const [id, b] of blocks) for (const sc of b.succ) {
      if (!preds.has(sc)) preds.set(sc, []);
      preds.get(sc).push(id);
    }
    // back edges (targets of a cycle) must not be duplicated
    const onStack = new Set(), visited = new Set(), backTargets = new Set();
    const dfs = id => {
      if (onStack.has(id)) { backTargets.add(id); return; }
      if (visited.has(id)) return;
      visited.add(id); onStack.add(id);
      for (const sc of blocks.get(id).succ) if (blocks.has(sc)) dfs(sc);
      onStack.delete(id);
    };
    dfs(merged.entry);
    let changed = false;
    for (const [id, b] of [...blocks]) {
      const ps = preds.get(id) || [];
      if (ps.length < 2 || backTargets.has(id) || id === merged.entry) continue;
      if (blocks.size > originalSize * 4) break;
      // clone for every predecessor but the first
      for (let i = 1; i < ps.length; i++) {
        const copy = { ...b, id: b.id + '#' + blocks.size, succ: b.succ.slice() };
        blocks.set(copy.id, copy);
        const pred = blocks.get(ps[i]);
        pred.succ = pred.succ.map(x => (x === id ? copy.id : x));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return merged;
}

`;
s = s.replace(anchor, dupFn + anchor);

/* 2. call it from liftFunction */
const old = `  const merged = mergeNodes(fn);
  const { bbs, entry } = buildBasicBlocks(merged);`;
if (!s.includes(old)) throw new Error('liftFunction body not found');
s = s.replace(old, `  const merged = duplicateJoins(mergeNodes(fn));
  const { bbs, entry } = buildBasicBlocks(merged);`);

/* 3. an unresolved computed jump becomes a trap: the analysis cannot reproduce the edge,
      and in practice these sit on opaque-predicate paths that never execute. */
const oldTerm = `  if (bb.succ.length === 1) return { kind: 'goto', target: bb.succ[0] };
  if (bb.succ.length === 0) return { kind: 'end' };`;
if (!s.includes(oldTerm)) throw new Error('terminatorOf not found');
s = s.replace(oldTerm, `  if (bb.succ.length === 1) return { kind: 'goto', target: bb.succ[0] };
  if (bb.succ.length === 0) {
    if (ins.kind === 'jmp_reg') return { kind: 'trap', pc: ins.pc };
    return { kind: 'end' };
  }`);

/* 4. emit the trap */
const oldRet = `    if (bb.term.kind === 'return') { bb.ir.push({ kind: 'ret', expr: IR.reg(bb.term.reg) }); bb.retStmt = bb.ir[bb.ir.length - 1]; }
    if (bb.term.kind === 'throw') { bb.ir.push({ kind: 'throw', expr: IR.reg(bb.term.reg) }); bb.retStmt = bb.ir[bb.ir.length - 1]; }`;
if (!s.includes(oldRet)) throw new Error('ret push not found');
s = s.replace(oldRet, oldRet + `
    if (bb.term.kind === 'trap') bb.ir.push({ kind: 'trap', pc: bb.term.pc });`);

const oldCtxTerm = `    terminator: bb => {
      if (bb.term.kind === 'return' || bb.term.kind === 'throw') {`;
if (!s.includes(oldCtxTerm)) throw new Error('ctx.terminator not found');
s = s.replace(oldCtxTerm, `    terminator: bb => {
      if (bb.term.kind === 'trap') {
        return { kind: 'throw', stmt: em.statement(bb.ir[bb.ir.length - 1]) };
      }
      if (bb.term.kind === 'return' || bb.term.kind === 'throw') {`);

const oldStmt = `      case 'debugger': return t.debuggerStatement();`;
if (!s.includes(oldStmt)) throw new Error('statement switch not found');
s = s.replace(oldStmt, `      case 'debugger': return t.debuggerStatement();
      case 'trap': {
        const st = t.throwStatement(t.newExpression(t.identifier('Error'),
          [t.stringLiteral('vm.js: unresolved computed jump at bytecode offset ' + s.pc)]));
        t.addComment(st, 'leading', ' the flattening dispatcher could not be resolved here (dead opaque-predicate path) ');
        return st;
      }`);

/* 5. blockStatements must not emit the trap twice */
const oldBS = `    blockStatements: bb => bb.ir.filter(s => s.kind !== 'ret' && s.kind !== 'throw').map(em.statement).filter(Boolean),`;
if (!s.includes(oldBS)) throw new Error('blockStatements not found');
s = s.replace(oldBS, `    blockStatements: bb => bb.ir.filter(s => s.kind !== 'ret' && s.kind !== 'throw' && s.kind !== 'trap').map(em.statement).filter(Boolean),`);

fs.writeFileSync(p, s);
console.log('patched vm.js (tail duplication + traps)');
