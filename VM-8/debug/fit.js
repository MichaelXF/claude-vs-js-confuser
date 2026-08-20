// Fit arithmetic/comparison semantics per instruction site by black-box probing.
const path=require('path');
const {loadVM, probe}=require('./probe.js');
const M=loadVM(path.join(__dirname,'..','input.js'));
const rows=require('./sweep.json');
const fns=require('./fns.json');
function owner(pc){ let best=fns[0]; for(const f of fns) if(f.C<=pc && f.C>=best.C) best=f; return best; }

const VALS=[0,1,2,-1,3,7,-2,255,256,-256,65535,65536,123456789,-123456789,2147483647,-2147483648,5,-5,1000000,-999,42,17,-17,99,100,-100,0x7fffffff-1,12,13];
function rnd(seed){ let x=seed|0; x^=x<<13; x^=x>>>17; x^=x<<5; return x|0; }

function run(site, regvals){
  const fn=owner(site.pc);
  const nregs=Math.max(fn.l,100);
  const regs=new Array(nregs);
  for(let i=0;i<nregs;i++) regs[i]=regvals(i);
  return probe(M,{pc:site.pc,B:fn.B,nregs,regs});
}

function analyzeSite(site){
  const base=run(site,i=>rnd(i*7+11));
  const rb=base.regBase;
  const wr=[...new Set(base.writes.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  const rd=[...new Set(base.reads.filter(x=>x[0]>=rb).map(x=>x[0]-rb))];
  if(wr.length!==1) return null;
  const dst=wr[0];
  // find live inputs: vary each read register
  const live=[];
  for(const r of rd){
    let differs=false;
    for(let k=0;k<6 && !differs;k++){
      const a=run(site,i=> i===r? rnd(k*31+5) : rnd(i*7+11));
      const b=run(site,i=> i===r? rnd(k*31+997) : rnd(i*7+11));
      const va=a.writes.filter(x=>x[0]-rb===dst).pop(), vb=b.writes.filter(x=>x[0]-rb===dst).pop();
      if(!va||!vb) { differs=true; break; }
      if(!Object.is(va[1],vb[1])) differs=true;
    }
    if(differs) live.push(r);
  }
  // immediates = operands not matching any read/written register index
  const imm=site.ops.filter(o=> !rd.includes(o));
  return {dst, rd, live, imm, base};
}

const OPS1={
  'a':a=>a,'~a':a=>~a,'-a':a=>-a,'!a':a=>!a,'+a':a=>+a,'a|0':a=>a|0,'~~a':a=>~~a,'!!a':a=>!!a,
};
function bin(){
  const t={};
  const src={
    'a+b':(a,b)=>a+b,'a-b':(a,b)=>a-b,'a*b':(a,b)=>a*b,'a/b':(a,b)=>a/b,'a%b':(a,b)=>a%b,
    'a&b':(a,b)=>a&b,'a|b':(a,b)=>a|b,'a^b':(a,b)=>a^b,'a<<b':(a,b)=>a<<b,'a>>b':(a,b)=>a>>b,'a>>>b':(a,b)=>a>>>b,
    'a<b':(a,b)=>a<b,'a<=b':(a,b)=>a<=b,'a>b':(a,b)=>a>b,'a>=b':(a,b)=>a>=b,
    'a==b':(a,b)=>a==b,'a!=b':(a,b)=>a!=b,'a===b':(a,b)=>a===b,'a!==b':(a,b)=>a!==b,
    'imul(a,b)':(a,b)=>Math.imul(a,b),'a**b':(a,b)=>a**b,
  };
  for(const k in src){ t[k]=src[k]; t['('+k+')|0']=(a,b)=>src[k](a,b)|0; }
  return t;
}
const BIN=bin();

function fitSite(site){
  const info=analyzeSite(site);
  if(!info) return null;
  const fn=owner(site.pc);
  const {dst,live,imm}=info;
  const nregs=Math.max(fn.l,100);
  const trials=[];
  const N=40;
  for(let k=0;k<N;k++){
    const vals={};
    for(const r of live) vals[r]= VALS[(k*7+r*3)%VALS.length];
    const p=run(site,i=> (i in vals)? vals[i] : rnd(i*7+11));
    const w=p.writes.filter(x=>x[0]-p.regBase===dst).pop();
    trials.push({vals,out:w?w[1]:undefined});
  }
  const res={op:site.op,pc:site.pc,dst,live,imm,matches:[]};
  if(live.length===0){
    const all=trials.every(t=>Object.is(t.out,trials[0].out));
    res.constant = all? trials[0].out : '<varies>';
    return res;
  }
  if(live.length===1){
    const r=live[0];
    for(const [name,f] of Object.entries(OPS1)) if(trials.every(t=>Object.is(f(t.vals[r]),t.out))) res.matches.push(name);
    // unary with each immediate as second operand
    for(const iv of imm){
      for(const sg of [iv, iv|0]){
        for(const [name,f] of Object.entries(BIN)){
          if(trials.every(t=>Object.is(f(t.vals[r],sg),t.out))) res.matches.push(name.replace('b',String(sg)));
          if(trials.every(t=>Object.is(f(sg,t.vals[r]),t.out))) res.matches.push(name.replace('a',String(sg)).replace('b','a'));
        }
      }
    }
    return res;
  }
  if(live.length===2){
    const [x,yy]=live;
    for(const [name,f] of Object.entries(BIN)){
      if(trials.every(t=>Object.is(f(t.vals[x],t.vals[yy]),t.out))) res.matches.push(name);
      if(trials.every(t=>Object.is(f(t.vals[yy],t.vals[x]),t.out))) res.matches.push('rev:'+name);
    }
    return res;
  }
  return res;
}

const seen=new Set();
const out=[];
for(const r of rows){
  const key=r.op;
  if(seen.has(key)) continue;
  const f=fitSite(r);
  if(!f) continue;
  seen.add(key);
  out.push(f);
  console.log(`op ${r.op} pc ${r.pc} dst=${f.dst} live=[${f.live}] imm=[${f.imm}] ${f.constant!==undefined?('const='+f.constant):('=> '+(f.matches.join(' | ')||'??'))}`);
}
require('fs').writeFileSync('debug/fit.json',JSON.stringify(out,null,1));
