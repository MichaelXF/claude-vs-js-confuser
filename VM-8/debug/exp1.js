const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const fns=require('./fns.json');
function owner(pc){ let best=fns[0]; for(const f of fns) if(f.C<=pc && f.C>=best.C) best=f; return best; }
function run(pc, setreg){
  const fn=owner(pc); const n=Math.max(fn.l,100);
  const regs=new Array(n); for(let i=0;i<n;i++) regs[i]=((i*2654435761)|0);
  setreg(regs);
  return probe(M,{pc,B:fn.B,nregs:n,regs});
}
function F(pc, src, dst){
  return (a)=>{ const p=run(pc,r=>{r[src]=a;}); const w=p.writes.filter(x=>x[0]-p.regBase===dst).pop(); return w?w[1]:undefined; };
}
for (const [pc,src,dst,imm] of [[75,40,40,368974448],[91,40,40,1667756528],[355,38,38,905482874],[153,40,40,2395032704],[106,40,40,2406598704],[59,38,40,262311919]]) {
  const f=F(pc,src,dst);
  const f0=f(0);
  // XOR linearity test
  let xorlin=true;
  for(let k=0;k<12;k++){ const a=((k*2654435761)|0), b=((k*40503+7919)|0);
    if( ((f(a)^f(b)^f(a^b)^f0)|0) !==0 ) { xorlin=false; break; } }
  // additive linearity
  let addlin=true;
  for(let k=0;k<12;k++){ const a=((k*2654435761)|0), b=((k*40503+7919)|0);
    if( (((f(a)-f0)+(f(b)-f0)+f0 - f((a+b)|0))|0) !==0 ) { addlin=false; break; } }
  console.log(`pc ${pc} imm=${imm} f(0)=${f0} f(1)=${f(1)} f(-1)=${f(-1)} f(2)=${f(2)} xorLinear=${xorlin} addLinear=${addlin}`);
  if(addlin){ const k=(f(1)-f0)|0; console.log('   affine: f(a)=imul(a,'+k+')+'+f0, 'check', ((Math.imul(12345,k)+f0)|0)===f(12345)); }
  if(xorlin){ console.log('   xor-linear bits:', [0,1,2,3].map(i=>(f(1<<i)^f0)>>>0)); }
}
