// Fitter v3: scans low-nibble invariant classes required by JS-Confuser MBA.
const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const rows=require('./sweep.json');
const fns=require('./fns.json');
function owner(pc){ let best=fns[0]; for(const f of fns) if(f.C<=pc&&f.C>=best.C) best=f; return best; }
let S=987654321; const rn=()=>{S^=S<<13;S^=S>>>17;S^=S<<5;return S|0;};
function mk(v,nib){ return nib==null? v : ((v & ~15)|nib); }

function run(site, regs){
  const fn=owner(site.pc); const n=Math.max(fn.l,110);
  const full=new Array(n); for(let i=0;i<n;i++) full[i]= regs[i]!==undefined? regs[i] : 0;
  return probe(M,{pc:site.pc,B:fn.B,nregs:n,regs:full});
}
function baseRegs(n,nib){ const r=new Array(n); for(let i=0;i<n;i++) r[i]=mk((i*2654435761)|0,nib); return r; }
function out(p,dst){ const w=p.writes.filter(x=>x[0]-p.regBase===dst).pop(); return w?w[1]:undefined; }

const BINS={'+':(a,b)=>a+b,'-':(a,b)=>a-b,'*':(a,b)=>a*b,'/':(a,b)=>a/b,'%':(a,b)=>a%b,
 '&':(a,b)=>a&b,'|':(a,b)=>a|b,'^':(a,b)=>a^b,'<<':(a,b)=>a<<b,'>>':(a,b)=>a>>b,'>>>':(a,b)=>a>>>b,
 '<':(a,b)=>a<b,'<=':(a,b)=>a<=b,'>':(a,b)=>a>b,'>=':(a,b)=>a>=b,
 '==':(a,b)=>a==b,'!=':(a,b)=>a!=b,'===':(a,b)=>a===b,'!==':(a,b)=>a!==b};
const UNS={'a':a=>a,'~a':a=>~a,'-a':a=>-a,'!a':a=>!a,'+a':a=>+a,'(a|0)':a=>a|0,'!!a':a=>!!a};
const eq=(x,y)=>Object.is(x,y)||(x===0&&y===0);

function tryClass(site, nib, rd, dst){
  const fn=owner(site.pc); const n=Math.max(fn.l,110);
  const base=baseRegs(n,nib);
  // liveness within this class
  const live=[];
  for(const r of rd){
    const s=new Set();
    for(let k=0;k<10;k++){ const regs=base.slice(); regs[r]=mk(rn(),nib); s.add(String(out(run(site,regs),dst))); }
    for(const o of rd) if(o!==r){ const regs=base.slice(); regs[r]=base[o]; s.add(String(out(run(site,regs),dst))); }
    if(s.size>1) live.push(r);
  }
  const imms=site.ops.filter(o=>!rd.includes(o)&&o!==site.ops[0]);
  const immv=[]; for(const v of new Set([...imms, site.ops[0]])){ immv.push(v); if(v>0x7fffffff) immv.push(v|0); }
  const T=[];
  for(let k=0;k<28;k++){
    const regs=base.slice();
    const vals={};
    for(const r of live){ let v;
      if(k<6) v=mk([0,1,2,15,-1,-16][k],nib); else v=mk(rn(),nib);
      regs[r]=v; vals[r]=v; }
    if(live.length===2&&k%4===1){ regs[live[1]]=regs[live[0]]; vals[live[1]]=vals[live[0]]; }
    T.push({vals,out:out(run(site,regs),dst)});
  }
  const cands=[];
  if(live.length===0){
    const c=T[0].out;
    if(T.every(t=>eq(t.out,c))) return {nib,live,matches:['const '+String(c)],constant:c,T};
    return {nib,live,matches:[],T};
  }
  if(live.length===1){
    const r=live[0];
    for(const [nm,f] of Object.entries(UNS)) cands.push([nm,t=>f(t.vals[r])]);
    for(const iv of immv) for(const [nm,f] of Object.entries(BINS)){
      cands.push([`a ${nm} ${iv}`,t=>f(t.vals[r],iv)]);
      cands.push([`${iv} ${nm} a`,t=>f(iv,t.vals[r])]);
    }
    cands.push(['imul',t=>Math.imul(t.vals[r],1)]);
  } else if(live.length===2){
    const [x,y]=live;
    for(const [nm,f] of Object.entries(BINS)){
      cands.push([`a ${nm} b`,t=>f(t.vals[x],t.vals[y])]);
      cands.push([`b ${nm} a`,t=>f(t.vals[y],t.vals[x])]);
    }
  } else return {nib,live,matches:[],T};
  const m=[]; for(const [nm,f] of cands){ let ok=true; for(const t of T) if(!eq(f(t),t.out)){ok=false;break;} if(ok) m.push(nm); }
  return {nib,live,matches:m,T};
}

const results={};
const seen=new Set();
for(const site of rows){
  if(seen.has(site.op)) continue; seen.add(site.op);
  const p0=run(site,baseRegs(120,null));
  const rb=p0.regBase;
  const wr=[...new Set(p0.writes.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  const rd=[...new Set(p0.reads.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  if(wr.length!==1){ console.log(`op ${site.op} pc ${site.pc} -> multi-write/ctrl (rd=${rd})`); continue; }
  const dst=wr[0];
  let best=null;
  for(const nib of [null,15,6,0,1,2,3,4,5,7,8,9,10,11,12,13,14]){
    const r=tryClass(site,nib,rd,dst);
    if(r.matches.length){ best=r; break; }
  }
  results[site.op]={pc:site.pc,dst,rd,best};
  if(best) console.log(`op ${site.op} pc ${site.pc} dst=${dst} nib=${best.nib} live=[${best.live}] => ${best.matches.slice(0,5).join(' | ')}`);
  else console.log(`op ${site.op} pc ${site.pc} dst=${dst} rd=[${rd}] => UNRESOLVED`);
}
require('fs').writeFileSync('debug/fit3.json',JSON.stringify(results,(k,v)=>k==='T'?undefined:v,1));
