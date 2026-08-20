// Trace real execution of the payload to validate the static model.
const path=require('path');
const fs=require('fs');
const {loadVM}=require('./probe.js');
globalThis.window = globalThis;
globalThis.document = { createElement:()=>({style:{},appendChild(){},setAttribute(){}}), body:{appendChild(){}} };
const M=loadVM(path.join(__dirname,'..','input.js'));
const trace=[];
const vm=new M.VM(M.bytecode, null, M.globalObj, M.pool);
for(const k of Object.keys(M.proto).filter(k=>/^\d+$/.test(k))){
  const real=M.proto[k];
  vm[k]=function(){ const h=this.h; const pc=this.g[h+3]-1; trace.push([pc,+k,h,this.g[h+6]|0,this.g[h+7]]); return real.call(this); };
}
const fnObj=new M.Fn(M.meta);
let out;
try{ out=M.interp(vm, fnObj, [], 'q', null); }catch(e){ console.log('THREW',e.message); }
console.log('trace length', trace.length, 'result', out);
const fnBs=new Map();
for(const [pc,op,h,B,rb] of trace){ if(!fnBs.has(B)) fnBs.set(B,[]); const a=fnBs.get(B); if(a.length<3) a.push(pc); }
console.log('distinct frame B values -> first pcs:', JSON.stringify([...fnBs].map(([b,p])=>[b,p])));
fs.writeFileSync('debug/trace.json', JSON.stringify(trace.slice(0,4000)));
// pcs visited
const pcs=[...new Set(trace.map(t=>t[0]))].sort((a,b)=>a-b);
console.log('distinct pcs visited:', pcs.length);
