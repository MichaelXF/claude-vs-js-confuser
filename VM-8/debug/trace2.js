const path=require('path');
const fs=require('fs');
const {loadVM}=require('./probe.js');
globalThis.window = globalThis;
globalThis.document = { createElement:()=>({style:{},appendChild(){},setAttribute(){}}), body:{appendChild(){}} };
globalThis.navigator = { userAgent:'node' };
const M=loadVM(path.join(__dirname,'..','input.js'));
const trace=[];
let on=false;
for(const k of Object.keys(M.proto).filter(k=>/^\d+$/.test(k))){
  const real=M.proto[k];
  M.proto[k]=function(){ if(on){const h=this.h; const pc=this.g[h+3]-1; trace.push([pc,+k,h,this.g[h+6]|0,this.g[h+7]]);} return real.call(this); };
}
const vm=new M.VM(M.bytecode, null, M.globalObj, M.pool);
on=true;
try{ M.interp(vm, new M.Fn(M.meta), [], 'q', null); }catch(e){ console.log('boot THREW',e.message); }
const orig=console.log;
try{ globalThis['_k1crlxlk2w8'](); }catch(e){ orig('call THREW',e.message, e.stack.split('\n').slice(0,3).join('|')); }
on=false;
orig('trace length', trace.length);
const fnBs=new Map();
for(const [pc,op,h,B,rb] of trace){ if(!fnBs.has(B)) fnBs.set(B,[]); const a=fnBs.get(B); if(a.length<3) a.push(pc); }
orig('distinct frame B -> first pcs:', JSON.stringify([...fnBs].map(([b,p])=>[b,p])));
const pcs=[...new Set(trace.map(t=>t[0]))].sort((a,b)=>a-b);
orig('distinct pcs visited:', pcs.length);
fs.writeFileSync('debug/trace.json', JSON.stringify(trace));
