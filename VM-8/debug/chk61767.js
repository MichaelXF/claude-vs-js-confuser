const fs=require('fs'),path=require('path');
const {loadRuntime}=require('../lib-extract.js');
const {prepare}=require('../lib-probe.js');
const {numRun,writeAt,THIS_MARK}=require('../lib-classify.js');
const M=prepare(loadRuntime(fs.readFileSync(path.join(__dirname,'..','input.js'),'utf8')));
const site={pc:590,operands:[59,38,38,61]};
const fn={B:-1175385224,nregs:88};
const vals=[0,1,-1,0.5,-0.5,NaN,Infinity,1e20,1.5,123.456,2147483647,-2147483648,15,6,'a',true,null,undefined,{}];
const outs=new Set();
for(const v of vals){ const regs=new Array(96).fill(3); regs[38]=v; regs[61]=7;
  outs.add(String(writeAt(numRun(M,site,fn,regs),59))); }
console.log('distinct outputs for f(x,x):',[...outs]);
