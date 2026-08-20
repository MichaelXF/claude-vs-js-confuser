// Improved black-box fitter with better sampling + diagnostics.
const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const rows=require('./sweep.json');
const fns=require('./fns.json');
function owner(pc){ let best=fns[0]; for(const f of fns) if(f.C<=pc && f.C>=best.C) best=f; return best; }

let SEED=12345;
function rnd(){ SEED^=SEED<<13; SEED^=SEED>>>17; SEED^=SEED<<5; return SEED|0; }
const POOL=[-3,-2,-1,0,1,2,3,4,5,7,10,-10,100,-100,1000,-1000,65535,65536,-65536,
  1073741824,-1073741824,2147483647,-2147483648,123456789,-987654321,255,-256,16,32,64];

function run(site, regvals){
  const fn=owner(site.pc);
  const nregs=Math.max(fn.l,100);
  const regs=new Array(nregs);
  for(let i=0;i<nregs;i++) regs[i]=regvals(i);
  const p=probe(M,{pc:site.pc,B:fn.B,nregs,regs});
  return p;
}
function outOf(p,dst){ const w=p.writes.filter(x=>x[0]-p.regBase===dst).pop(); return w?w[1]:undefined; }

function structure(site){
  const base=run(site,i=>((i*2654435761)|0));
  const rb=base.regBase;
  const wr=[...new Set(base.writes.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  const rd=[...new Set(base.reads.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  return {rb,wr,rd,base};
}

function liveness(site,dst,rd){
  const baseVals=i=>((i*2654435761)|0);
  const live=[];
  for(const r of rd){
    const outs=new Set();
    for(const v of POOL) outs.add(String(outOf(run(site,i=> i===r? v : baseVals(i)),dst)));
    // also try setting r equal to each other read register's base value
    for(const o of rd) if(o!==r) outs.add(String(outOf(run(site,i=> i===r? baseVals(o) : baseVals(i)),dst)));
    if(outs.size>1) live.push(r);
  }
  return live;
}

const BINS={
  '+':(a,b)=>a+b,'-':(a,b)=>a-b,'*':(a,b)=>a*b,'/':(a,b)=>a/b,'%':(a,b)=>a%b,
  '&':(a,b)=>a&b,'|':(a,b)=>a|b,'^':(a,b)=>a^b,'<<':(a,b)=>a<<b,'>>':(a,b)=>a>>b,'>>>':(a,b)=>a>>>b,
  '<':(a,b)=>a<b,'<=':(a,b)=>a<=b,'>':(a,b)=>a>b,'>=':(a,b)=>a>=b,
  '==':(a,b)=>a==b,'!=':(a,b)=>a!=b,'===':(a,b)=>a===b,'!==':(a,b)=>a!==b,'**':(a,b)=>a**b,
};
const UNS={'id':a=>a,'~':a=>~a,'-':a=>-a,'!':a=>!a,'+':a=>+a,'|0':a=>a|0,'!!':a=>!!a,'void':a=>void 0};

function fit(site){
  const {rb,wr,rd}=structure(site);
  if(wr.length!==1) return {op:site.op,pc:site.pc,kind:'multi-write',wr,rd};
  const dst=wr[0];
  const live=liveness(site,dst,rd);
  const imms=site.ops.filter(o=>!rd.includes(o)&&o!==dst);
  const immv=[]; for(const v of imms){ immv.push(v); if(v>0x7fffffff) immv.push(v|0); }
  const res={op:site.op,pc:site.pc,dst,rd,live,imms,matches:[],samples:[]};
  const T=[];
  const NT=48;
  for(let k=0;k<NT;k++){
    const vals={};
    for(const r of live) vals[r]= (k<POOL.length&&live.length===1)? POOL[k] : (k%3===0? POOL[(k*7+r)%POOL.length] : rnd());
    if(live.length===2 && k%5===0){ const [x,y]=live; vals[y]=vals[x]; }
    const p=run(site,i=> (i in vals)? vals[i] : ((i*2654435761)|0));
    T.push({vals,out:outOf(p,dst)});
  }
  res.samples=T.slice(0,8).map(t=>[live.map(r=>t.vals[r]),t.out]);
  if(live.length===0){ res.constant=T[0].out; res.kind='const'; if(!T.every(t=>Object.is(t.out,T[0].out))) res.kind='const?varies'; return res; }
  const cands=[];
  if(live.length===1){
    const r=live[0];
    for(const [n,f] of Object.entries(UNS)) cands.push([n+'(a)',t=>f(t.vals[r])]);
    for(const iv of immv) for(const [n,f] of Object.entries(BINS)){
      cands.push([`a ${n} ${iv}`,t=>f(t.vals[r],iv)]);
      cands.push([`${iv} ${n} a`,t=>f(iv,t.vals[r])]);
      cands.push([`(a ${n} ${iv})|0`,t=>f(t.vals[r],iv)|0]);
      cands.push([`imul(a,${iv})`,t=>Math.imul(t.vals[r],iv)]);
    }
  } else if(live.length===2){
    const [x,y]=live;
    for(const [n,f] of Object.entries(BINS)){
      cands.push([`a ${n} b`,t=>f(t.vals[x],t.vals[y])]);
      cands.push([`b ${n} a`,t=>f(t.vals[y],t.vals[x])]);
      cands.push([`(a ${n} b)|0`,t=>f(t.vals[x],t.vals[y])|0]);
      cands.push([`(b ${n} a)|0`,t=>f(t.vals[y],t.vals[x])|0]);
    }
    cands.push(['imul(a,b)',t=>Math.imul(t.vals[x],t.vals[y])]);
  }
  for(const [n,f] of cands){ let ok=true; for(const t of T) if(!Object.is(f(t),t.out)){ok=false;break;} if(ok) res.matches.push(n); }
  res.kind=res.matches.length?'fit':'unknown';
  return res;
}

const seen=new Set(); const out=[];
for(const r of rows){
  if(seen.has(r.op)) continue; seen.add(r.op);
  let f; try{ f=fit(r);}catch(e){ f={op:r.op,pc:r.pc,kind:'ERR',err:String(e.message)}; }
  out.push(f);
  console.log(`op ${f.op} pc ${f.pc} dst=${f.dst} live=[${f.live}] imm=[${f.imms}] ${f.kind}`+
    (f.kind==='const'?` = ${String(f.constant)}`:'')+(f.matches&&f.matches.length?` => ${f.matches.slice(0,4).join(' | ')}`:'')+
    (f.kind==='unknown'?` samples=${JSON.stringify(f.samples)}`:''));
}
require('fs').writeFileSync('debug/fit2.json',JSON.stringify(out,null,1));
