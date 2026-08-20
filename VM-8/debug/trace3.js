const path=require('path');
const fs=require('fs');
const {loadVM}=require('./probe.js');
globalThis.window = globalThis;
globalThis.document = { createElement:()=>({style:{},appendChild(){},setAttribute(){}}), body:{appendChild(){}} };
globalThis.navigator = { userAgent:'node' };
const M=loadVM(path.join(__dirname,'..','input.js'));
const trace=[];
let on=false;
function show(v){ if(typeof v==='function') return '<fn>'; if(typeof v==='object'&&v) return '<obj>'; if(typeof v==='string') return JSON.stringify(v.length>40?v.slice(0,40)+'...':v); return v; }
for(const k of Object.keys(M.proto).filter(k=>/^\d+$/.test(k))){
  const real=M.proto[k];
  M.proto[k]=function(){
    if(!on) return real.call(this);
    const h=this.h, g=this.g, rb=g[h+7], pc=g[h+3]-1, nreg=g[h+10]-15;
    const before=g.slice(rb, rb+nreg);
    const r=real.call(this);
    const ch=[];
    if(this.h===h){ const after=this.g.slice(rb,rb+nreg); for(let i=0;i<nreg;i++) if(!Object.is(before[i],after[i])) ch.push([i,show(after[i])]); }
    trace.push({pc,op:+k,B:g[h+6]|0,in:before.map(show),ch,next:this.h===h?this.g[h+3]:'<frame>'});
    return r;
  };
}
const vm=new M.VM(M.bytecode, null, M.globalObj, M.pool);
on=true;
try{ M.interp(vm, new M.Fn(M.meta), [], 'q', null); }catch(e){}
const orig=console.log;
try{ globalThis['_k1crlxlk2w8'](); }catch(e){ orig('call THREW',e.message); }
on=false;
orig('steps',trace.length);
fs.writeFileSync('debug/trace3.json', JSON.stringify(trace));
// look at pc 65 events
const at=trace.filter(t=>t.pc===65).slice(0,5);
for(const t of at) orig('pc65 op',t.op,'r38=',t.in[38],'r40=',t.in[40],'r37=',t.in[37],'ch',JSON.stringify(t.ch),'next',t.next);
const at2=trace.filter(t=>t.pc===59).slice(0,3);
for(const t of at2) orig('pc59 op',t.op,'r38=',t.in[38],'ch',JSON.stringify(t.ch));
const at3=trace.filter(t=>t.pc===75).slice(0,3);
for(const t of at3) orig('pc75 op',t.op,'r40=',t.in[40],'ch',JSON.stringify(t.ch));
