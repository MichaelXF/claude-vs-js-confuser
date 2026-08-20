const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const rows=require('./sweep.json');

// function table: main + closures
function fnB(seed, C, l, j, nUp, K, parentB){
  return Math.imul(seed,761908105) ^ Math.imul(C^l,2733279211) ^ Math.imul(j+nUp+K,2830881870) ^ parentB | 0;
}
const fns=[{C:M.meta.C, l:M.meta.l, j:M.meta.j, B:M.meta.B|0, name:'main'}];
// closure at 17 is in main; closure at 751 is in fn@37
const byPc = new Map(rows.map(r=>[r.pc,r]));
function owner(pc){ // crude: last fn whose C <= pc
  let best=fns[0]; for(const f of fns) if(f.C<=pc && f.C>=best.C) best=f; return best;
}
let changed=true;
while(changed){ changed=false;
  for(const r of rows){ if(r.op!==48773) continue;
    const [dst,C,j,l,nUp,K,seed]=r.ops;
    if(fns.some(f=>f.C===C)) continue;
    const par=owner(r.pc);
    fns.push({C,l,j,B:fnB(seed,C,l,j,nUp,K,par.B),name:'f'+C, parent:par.name, nUp, K});
    changed=true;
  }
}
fns.sort((a,b)=>a.C-b.C);
console.log('functions:', JSON.stringify(fns));
for(const r of rows) r.fn = owner(r.pc);

const RND=(i)=> ((i*2654435761)|0);
function probeSite(r, regvals, extra){
  const nregs = Math.max(r.fn.l, 100);
  const regs = Array.from({length:nregs},(_,i)=> regvals? regvals(i) : RND(i+1));
  return probe(M,{pc:r.pc, B:r.fn.B, nregs, regs, ...extra});
}

const perOp=new Map();
for(const r of rows){
  if(perOp.has(r.op)) continue;
  const p=probeSite(r);
  const rb=p.regBase;
  const readRegs=[...new Set(p.reads.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  const writeRegs=[...new Set(p.writes.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  const hdrReads=[...new Set(p.reads.filter(x=>x[0]<rb).map(x=>x[0]-p.hBefore))];
  const hdrWrites=[...new Set(p.writes.filter(x=>x[0]<rb).map(x=>x[0]-p.hBefore))];
  perOp.set(r.op,{op:r.op, n:p.nOperands, operands:p.operands, readRegs, writeRegs, hdrReads, hdrWrites,
    threw: p.threw && String(p.threw.message).slice(0,60), pc:r.pc, count:0});
}
for(const r of rows) perOp.get(r.op).count++;
const arr=[...perOp.values()].sort((a,b)=>b.count-a.count);
for(const e of arr){
  console.log(`op ${e.op} x${e.count} n=${e.n} ops=[${e.operands}] readR=[${e.readRegs}] writeR=[${e.writeRegs}] hdrR=[${e.hdrReads}] hdrW=[${e.hdrWrites}]${e.threw?' THREW '+e.threw:''}`);
}
require('fs').writeFileSync('debug/opsummary.json', JSON.stringify(arr,null,1));
require('fs').writeFileSync('debug/fns.json', JSON.stringify(fns,null,1));
