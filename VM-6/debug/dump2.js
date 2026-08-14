// debug/dump2.js -- print the recovered CFG (uses vm.js internals)
const path = require('path');
const fs = require('fs');
const { loadVM, makeAnalyzer, exploreAll } = require('../vm.js').internals;

function insText(A, ins, C) {
  const k = ins.kind;
  if (k === 'DATA') {
    const r = A.fit(ins, C);
    const inputs = A.inputsOf(ins);
    const S = (i) => 'r' + inputs[i];
    if (r.kind === 'BINARY') return `r${ins.dst} = ${r.op === '[]' ? `${S(r.a)}[${S(r.b)}]` : `${S(r.a)} ${r.op} ${S(r.b)}`}`;
    if (r.kind === 'BINCONST') return r.side === 'right'
      ? `r${ins.dst} = ${S(r.a)} ${r.op} ${JSON.stringify(r.k)}` : `r${ins.dst} = ${JSON.stringify(r.k)} ${r.op} ${S(r.a)}`;
    if (r.kind === 'UNARY') return `r${ins.dst} = ${r.op}${r.op.length > 1 ? ' ' : ''}${S(r.a)}`;
    if (r.kind === 'MOV') return `r${ins.dst} = ${S(r.a)}`;
    if (r.kind === 'CONST') return `r${ins.dst} = ${JSON.stringify(r.value)}`;
    return `r${ins.dst} = ??${r.kind} op=${ins.op} words=[${ins.words}] regs=[${ins.srcRegs}]`;
  }
  if (k === 'LOADCONST') return `r${ins.dst} = ${JSON.stringify(A.readConst(ins.pool, ins.key))}`;
  if (k === 'LOADGLOBAL') return `r${ins.dst} = GLOBAL[${JSON.stringify(A.readConst(ins.pool, ins.key))}]`;
  if (k === 'TYPEOFGLOBAL') return `r${ins.dst} = typeof GLOBAL[${JSON.stringify(A.readConst(ins.pool, ins.key))}]`;
  if (k === 'STOREGLOBAL') return `GLOBAL[${JSON.stringify(A.readConst(ins.pool, ins.key))}] = r${ins.src}`;
  if (k === 'LOADTHIS') return `r${ins.dst} = this`;
  if (k === 'LOADCELL') return `r${ins.dst} = cell[${ins.cell}]`;
  if (k === 'STORECELL') return `cell[${ins.cell}] = r${ins.src}`;
  if (k === 'SETMEMBER') return `r${ins.obj}[r${ins.key}] = r${ins.val}`;
  if (k === 'DELETE') return `r${ins.dst} = delete r${ins.obj}[r${ins.key}]`;
  if (k === 'ARRAY') return `r${ins.dst} = [${ins.elems.map(e => 'r' + e).join(', ')}]`;
  if (k === 'OBJECT') return `r${ins.dst} = {${ins.pairs.map(([a, b]) => `r${a}: r${b}`).join(', ')}}`;
  if (k === 'CALL') return `r${ins.dst} = r${ins.fn}(${(ins.args || []).map(a => 'r' + a).join(', ')})${ins.spread ? '[spread]' : ''}`;
  if (k === 'CALLMETHOD') return `r${ins.dst} = r${ins.thisReg}::r${ins.fn}(${(ins.args || []).map(a => 'r' + a).join(', ')})${ins.spread ? '[spread]' : ''}`;
  if (k === 'NEW') return `r${ins.dst} = new r${ins.fn}(${(ins.args || []).map(a => 'r' + a).join(', ')})`;
  if (k === 'MAKEFUNC') return `r${ins.dst} = function@${ins.entry}(${ins.nparams}p${ins.hasRest ? ',rest' : ''}) cells=${JSON.stringify(ins.cells)}`;
  if (k === 'FORIN_INIT') return `r${ins.dst} = keys(r${ins.obj})`;
  if (k === 'FORIN_NEXT') return `r${ins.dst} = next(r${ins.iter}) else -> ${ins.doneTarget}`;
  if (k === 'DEFGET') return `defineGetter(r${ins.obj}, r${ins.key}, r${ins.fn})`;
  if (k === 'DEFSET') return `defineSetter(r${ins.obj}, r${ins.key}, r${ins.fn})`;
  if (k === 'TRYCATCH') return `pushTry(catch -> ${ins.catchPC}, r${ins.catchReg})`;
  if (k === 'TRYFIN') return `pushTry(finally -> ${ins.finPC}, r${ins.typeReg}, r${ins.valReg}, ${ins.marker})`;
  if (k === 'POPTRY') return 'popTry()';
  return k;
}

const L = loadVM(path.join(__dirname, '..', 'input.js'));
const A = makeAnalyzer(L);
const all = exploreAll(A);
const only = process.argv[2] ? Number(process.argv[2]) : null;
const out = [];
for (const [entry, r] of all) {
  if (only !== null && entry !== only) continue;
  out.push(`\n===== fn@${entry} params=${r.func.nparams} regs=${r.func.nregs} cells=${JSON.stringify(r.func.cells)} blocks=${r.blocks.size}`);
  for (const bk of [...r.blocks.keys()]) {
    const b = r.blocks.get(bk);
    out.push(`  --- [${bk}]`);
    for (const ins of b.stmts) out.push(`   ${String(ins.pc).padStart(5)}  ${insText(A, ins, r.func.C)}`);
    const t = b.term || {};
    out.push(`   => ${t.kind}` +
      (t.kind === 'goto' ? ' [' + t.targetKey + ']' : '') +
      (t.kind === 'branch' ? ` cond=${t.condIns ? 'r' + t.condIns.dst + '@' + t.condIns.pc : 'r' + t.condReg} true->[${t.trueKey}] false->[${t.falseKey}]` : '') +
      (t.kind === 'return' ? ' r' + t.reg : '') + (t.kind === 'throw' ? ' r' + t.reg : ''));
  }
}
fs.writeFileSync(path.join(__dirname, 'cfg2.txt'), out.join('\n'));
console.log(out.join('\n'));
