const fs=require('fs'),path=require('path');
const {loadRuntime}=require('../lib-extract.js');
const {prepare,probe}=require('../lib-probe.js');
const {classify}=require('../lib-disasm.js');
const {regTracer,THIS_MARK}=require('../lib-classify.js');
const M=prepare(loadRuntime(fs.readFileSync(path.join(__dirname,'..','input.js'),'utf8')));
const B=M.meta.B|0;
for (const op of [46728, 27414, 57674, 61791]) {
  const Q=new Uint32Array(48); Q[0]=op; for(let i=1;i<Q.length;i++)Q[i]=20+i*3;
  M.bytecode=Q;
  const log=[]; const regs=[]; for(let i=0;i<64;i++)regs.push(regTracer(i,log));
  const p=probe(M,{pc:0,B,nregs:64,regs,thisVal:THIS_MARK});
  const rb=p.regBase, hb=p.hBefore;
  console.log('op',op,'operands',p.operands,'pcAfter',p.pcAfter,'fall',p.fall,
    'hdrW',[...new Set(p.writes.filter(x=>x[0]>=hb&&x[0]<rb).map(x=>x[0]-hb))],
    'threw',p.threw&&p.threw.message);
  const ir=classify(M,{pc:0,op,operands:p.operands.slice(),next:p.fall},{id:0,entry:0,B,nregs:40,nparams:0},{nibbleHint:new Map(),notTyped:new Set()});
  console.log('   ->',JSON.stringify(ir,(k,v)=>['operands','stack','vm','fnInfo'].includes(k)?undefined:v));
}
