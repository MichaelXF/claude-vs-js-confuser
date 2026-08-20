const fs=require('fs'),path=require('path');
const {loadRuntime}=require('../lib-extract.js');
const {prepare}=require('../lib-probe.js');
const {analyze}=require('../lib-analyze.js');
const {pevalFunction,findDispatcher}=require('../lib-peval.js');
const M=prepare(loadRuntime(fs.readFileSync(path.join(__dirname,'..','input.js'),'utf8')));
console.time('analyze'); const R=analyze(M); console.timeEnd('analyze');
for(const fn of R.functions){
  const d=findDispatcher(fn);
  console.log(`fn${fn.id} entry=${fn.entry} sites=${fn.sites.size} dispatcher=${d? 'head '+d.head+' chain '+d.chain.size+' state '+JSON.stringify(d.state):'none'}`);
}
console.time('peval');
const out=[];
for(const fn of R.functions){
  const P=pevalFunction(M,fn);
  out.push(P);
  console.log(`fn${fn.id}: ${P.nodes.length} nodes`);
}
console.timeEnd('peval');
let txt='';
function show(v){ if(typeof v==='string') return JSON.stringify(v.length>70?v.slice(0,70)+'…':v); if(typeof v==='function')return '<fn>'; if(typeof v==='object'&&v)return '<obj>'; return String(v); }
function key(k){ return k? (k.reg!==undefined?`[v${k.reg}]`:JSON.stringify(k.lit)) : '?'; }
function fmt(ir){
  switch(ir.kind){
    case 'const': return `v${ir.dst} = ${show(ir.value)}`;
    case 'select': return `v${ir.dst} = ${ir.cond.neg?'!':''}v${ir.cond.reg} ? ${show(ir.t)} : ${show(ir.f)}`;
    case 'mov': return `v${ir.dst} = v${ir.src}`;
    case 'bin': return `v${ir.dst} = v${ir.a} ${ir.operator} v${ir.b}${ir.wrap?'|0':''}`;
    case 'binimm': return ir.immFirst? `v${ir.dst} = ${ir.imm} ${ir.operator} v${ir.a}` : `v${ir.dst} = v${ir.a} ${ir.operator} ${ir.imm}${ir.wrap?'|0':''}`;
    case 'un': return `v${ir.dst} = ${ir.operator}v${ir.src}`;
    case 'this': return `v${ir.dst} = this`;
    case 'getglobal': return `v${ir.dst} = ${ir.name}`;
    case 'setglobal': return `${ir.name} = v${ir.src}`;
    case 'typeofglobal': return `v${ir.dst} = typeof ${ir.name}`;
    case 'getprop': return `v${ir.dst} = v${ir.obj}${key(ir.key)}`;
    case 'setprop': return `v${ir.obj}${key(ir.key)} = v${ir.src}`;
    case 'array': return `v${ir.dst} = [${ir.items.map(i=>'v'+i)}]`;
    case 'call': return `v${ir.dst} = v${ir.callee}(${ir.args.map(a=>'v'+a)})`;
    case 'mcall': return `v${ir.dst} = v${ir.callee}.call(v${ir.thisReg}${ir.args.length?', ':''}${ir.args.map(a=>'v'+a)})`;
    case 'new': return `v${ir.dst} = new v${ir.callee}(${ir.args.map(a=>'v'+a)})`;
    case 'closure': return `v${ir.dst} = fn#${ir.target}`;
    case 'getupval': return `v${ir.dst} = up[${ir.idx}]`;
    case 'setupval': return `up[${ir.idx}] = v${ir.src}`;
    case 'opaque': return `v${ir.dst} = UNRESOLVED_OPAQUE(op${ir.op})`;
    default: return ir.kind;
  }
}
for(let i=0;i<out.length;i++){
  const P=out[i];
  txt+=`\n===== fn${i} nodes=${P.nodes.length}\n`;
  for(const n of P.nodes){
    txt+=`  N${n.id} (pc ${n.pc}, preds ${n.preds})\n`;
    for(const s of n.stmts) txt+='      '+fmt(s)+'\n';
    const t=n.term;
    if(!t) txt+='      <no term>\n';
    else if(t.type==='goto') txt+=`      -> N${t.target.id}\n`;
    else if(t.type==='if') txt+=`      if (${t.cond.neg?'!':''}v${t.cond.reg}) -> N${t.then.id} else N${t.else.id}\n`;
    else if(t.type==='ret') txt+=`      return v${t.value}\n`;
    else txt+=`      ${t.type}\n`;
  }
}
fs.writeFileSync(path.join(__dirname,'peval.txt'),txt);
console.log('wrote debug/peval.txt');
