const fs=require('fs'),path=require('path');
const {loadRuntime}=require('../lib-extract.js');
const {prepare}=require('../lib-probe.js');
const {analyze}=require('../lib-analyze.js');
const M=prepare(loadRuntime(fs.readFileSync(path.join(__dirname,'..','input.js'),'utf8')));
console.time('analyze');
const R=analyze(M);
console.timeEnd('analyze');
console.log('functions:', R.functions.map(f=>({id:f.id,entry:f.entry,B:f.B,nregs:f.nregs,nparams:f.nparams,rest:f.rest,sites:f.sites.size,parent:f.parent,upvals:JSON.stringify(f.upvals)})));
let outp='';
for(const f of R.functions){
  outp+=`\n===== function ${f.id} entry=${f.entry} params=${f.nparams} regs=${f.nregs} B=${f.B} upvals=${JSON.stringify(f.upvals)}\n`;
  for(const pc of f.order){ const ir=f.sites.get(pc); outp+= String(pc).padStart(5)+`  op${String(ir.op).padStart(5)}  ${fmt(ir)}\n`; }
}
function show(v){ if(typeof v==='string') return JSON.stringify(v.length>60?v.slice(0,60)+'…':v); if(typeof v==='function')return '<fn>'; if(typeof v==='object'&&v)return '<obj>'; return String(v); }
function key(k){ return k? (k.reg!==undefined?`[v${k.reg}]`:JSON.stringify(k.lit)) : '?'; }
function fmt(ir){
  switch(ir.kind){
    case 'const': return `v${ir.dst} = ${show(ir.value)}`;
    case 'mov': return `v${ir.dst} = v${ir.src}`;
    case 'bin': return `v${ir.dst} = v${ir.a} ${ir.operator} v${ir.b}${ir.wrap?' |0':''}`;
    case 'binimm': return ir.immFirst? `v${ir.dst} = ${ir.imm} ${ir.operator} v${ir.a}` : `v${ir.dst} = v${ir.a} ${ir.operator} ${ir.imm}${ir.wrap?' |0':''}`;
    case 'un': return `v${ir.dst} = ${ir.operator}v${ir.src}`;
    case 'this': return `v${ir.dst} = this`;
    case 'getglobal': return `v${ir.dst} = GLOBAL.${ir.name}`;
    case 'setglobal': return `GLOBAL.${ir.name} = v${ir.src}`;
    case 'typeofglobal': return `v${ir.dst} = typeof GLOBAL.${ir.name}`;
    case 'getprop': return `v${ir.dst} = v${ir.obj}${key(ir.key)}`;
    case 'setprop': return `v${ir.obj}${key(ir.key)} = v${ir.src}`;
    case 'delete': return `v${ir.dst} = delete v${ir.obj}${key(ir.key)}`;
    case 'array': return `v${ir.dst} = [${ir.items.map(i=>'v'+i).join(', ')}]`;
    case 'object': return `v${ir.dst} = {${ir.pairs.map(([k,v])=>k+': v'+v).join(', ')}}`;
    case 'call': return `v${ir.dst} = v${ir.callee}(${ir.args.map(a=>'v'+a).join(', ')})${ir.spread?' /*spread*/':''}`;
    case 'mcall': return `v${ir.dst} = v${ir.callee}.call(v${ir.thisReg}${ir.args.length?', ':''}${ir.args.map(a=>'v'+a).join(', ')})${ir.spread?' /*spread*/':''}`;
    case 'new': return `v${ir.dst} = new v${ir.callee}(${ir.args.map(a=>'v'+a).join(', ')})`;
    case 'closure': return `v${ir.dst} = closure#${ir.target} (entry ${ir.fnInfo&&ir.fnInfo.C}) upvals=${JSON.stringify(ir.upvals)}`;
    case 'getupval': return `v${ir.dst} = upval[${ir.idx}]`;
    case 'setupval': return `upval[${ir.idx}] = v${ir.src}`;
    case 'ret': return `return v${ir.src}`;
    case 'throw': return `throw v${ir.src}`;
    case 'jmp': return `goto ${ir.target}`;
    case 'jt': return `if (v${ir.cond}) goto ${ir.target}`;
    case 'jf': return `if (!v${ir.cond}) goto ${ir.target}`;
    case 'jreg': return `goto v${ir.src}`;
    case 'opaque': return `v${ir.dst} = OPAQUE(op${ir.op}; ${ir.srcs.map(s=>'v'+s).join(', ')}) ops=[${ir.operands}]`;
    default: return ir.kind+' '+JSON.stringify(ir, (k,v)=>['operands','stack','vm'].includes(k)?undefined:v);
  }
}
fs.writeFileSync(path.join(__dirname,'disasm.txt'), outp);
console.log('wrote debug/disasm.txt');
const kinds={}; for(const f of R.functions) for(const ir of f.sites.values()) kinds[ir.kind]=(kinds[ir.kind]||0)+1;
console.log(kinds);
