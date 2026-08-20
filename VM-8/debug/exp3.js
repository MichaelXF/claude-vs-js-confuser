const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const fns=require('./fns.json');
function owner(pc){ let best=fns[0]; for(const f of fns) if(f.C<=pc&&f.C>=best.C) best=f; return best; }
function run(pc,set){ const fn=owner(pc),n=Math.max(fn.l,100);const regs=new Array(n);
  for(let i=0;i<n;i++)regs[i]=((i*2654435761)|0)|15; set(regs);
  return probe(M,{pc,B:fn.B,nregs:n,regs}); }
function get(p,d){const w=p.writes.filter(x=>x[0]-p.regBase===d).pop();return w?w[1]:undefined;}
let S=99;const rn=()=>{S^=S<<13;S^=S>>>17;S^=S<<5;return S|0;};
// 24746 @75: dst40 src40 imm 368974448
console.log('--- 24746 @75, a&15==15 ---');
for(let k=0;k<6;k++){ const a=(rn()&~15)|15; const o=get(run(75,r=>{r[40]=a;}),40);
  console.log(a, '->', o, ' a^imm=', (a^368974448), ' a+imm=',(a+368974448)|0, ' imul=',Math.imul(a,368974448)); }
console.log('--- 47454 @65, a,b &15==15 ---');
for(const [a,b] of [[15,15],[31,15],[15,31],[262311919,262311919],[262311919,1509521695],[-1,15],[1023,255]]){
  console.log(a,b,'->',get(run(65,r=>{r[38]=a;r[40]=b;}),42));
}
console.log('--- 43949 @59: dst40 <- f(r38), imm 262311919 ---');
for(let k=0;k<5;k++){ const a=(rn()&~15)|15; console.log(a,'->',get(run(59,r=>{r[38]=a;}),40)); }
