// Report which frame-header slots each handler reads.
const fs=require('fs'), parser=require('@babel/parser'), traverse=require('@babel/traverse').default;
const {locate}=require('./loader.js');
const code=fs.readFileSync('input.js','utf8');
const info=locate(code);
const ast=parser.parse(code);
const perOp={};
traverse(ast,{AssignmentExpression(p){
  const {left,right}=p.node;
  if(left.type!=='MemberExpression')return;
  if(left.object.type!=='Identifier'||left.object.name!==info.protoVar)return;
  if(!left.computed||left.property.type!=='NumericLiteral')return;
  const op=left.property.value;
  const set=new Set();
  p.get('right').traverse({BinaryExpression(q){
    if(q.node.operator!=='+')return;
    if(q.node.right.type==='NumericLiteral' && q.node.left.type!=='NumericLiteral'){
      // heuristic: `<x> + N` inside a computed member -> frame/reg offset
      if(q.parent.type==='MemberExpression'&&q.parent.computed&&q.parent.property===q.node) set.add(q.node.right.value);
    }
  }});
  perOp[op]=Array.from(set).sort((a,b)=>a-b);
}});
const counts={};
for(const [op,s] of Object.entries(perOp)) for(const n of s) counts[n]=(counts[n]||0)+1;
console.log('offset usage counts:',counts);
// which ops use unusual offsets
for(const [op,s] of Object.entries(perOp)){
  const odd=s.filter(n=>![7,3].includes(n));
  if(odd.length) console.log(op, JSON.stringify(s));
}
