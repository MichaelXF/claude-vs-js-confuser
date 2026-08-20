const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const fns=require('./fns.json');
function owner(pc){ let best=fns[0]; for(const f of fns) if(f.C<=pc && f.C>=best.C) best=f; return best; }
function run(pc, setreg){
  const fn=owner(pc); const n=Math.max(fn.l,100);
  const regs=new Array(n); for(let i=0;i<n;i++) regs[i]=((i*2654435761)|0);
  setreg(regs);
  const p=probe(M,{pc,B:fn.B,nregs:n,regs});
  return p;
}
function get(p,dst){ const w=p.writes.filter(x=>x[0]-p.regBase===dst).pop(); return w?w[1]:undefined; }
// 47454 at pc 65: dst 42, srcs 38 & 40
const vals=[-2147483648,-1073741824,-1000,-5,-1,0,1,2,5,1000,1073741824,2147483647,7,8,9];
let trues=0, tot=0, sample=[];
for(const a of vals) for(const b of vals){
  const p=run(65,r=>{r[38]=a;r[40]=b;});
  const o=get(p,42); tot++;
  if(o===true){trues++; if(sample.length<12) sample.push([a,b]);}
}
console.log('47454 @65 true count', trues,'/',tot, JSON.stringify(sample));
// also check what write indices occur
const p=run(65,r=>{r[38]=5;r[40]=5;});
console.log('writes', JSON.stringify(p.writes.map(w=>[w[0]-p.regBase,w[1]])), 'reads', JSON.stringify(p.reads.filter(x=>x[0]>=p.regBase).map(x=>[x[0]-p.regBase,x[1]])));
