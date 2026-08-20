const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const N=M.bytecode.length;
let pc=0; const rows=[];
while(pc<N){
  const r=probe(M,{pc, B:M.meta.B, nregs:40, regs:Array.from({length:40},(_,i)=>({__r:i}))});
  if(!r.ran){ console.log('pc',pc,'NO HANDLER for op',M.bytecode[pc]); break; }
  rows.push({pc, op:r.op, n:r.nOperands, ops:r.operands, next:r.next, pcAfter:r.pcAfter, threw:r.threw&&r.threw.message});
  pc=r.next;
}
console.log('swept to', pc, 'of', N, 'instructions:', rows.length);
const freq={}; for(const r of rows) freq[r.op]=(freq[r.op]||0)+1;
const used=Object.keys(freq).length;
console.log('distinct opcodes used:', used, 'of', Object.keys(M.proto).filter(k=>/^\d+$/.test(k)).length);
require('fs').writeFileSync('debug/sweep.json', JSON.stringify(rows,null,1));
console.log(rows.slice(0,40).map(r=>`${r.pc}\t${r.op}\t[${r.ops.join(',')}]`).join('\n'));
