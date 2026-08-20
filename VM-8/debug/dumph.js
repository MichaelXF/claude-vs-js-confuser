const fs=require('fs'),parser=require('@babel/parser'),traverse=require('@babel/traverse').default,gen=require('@babel/generator').default;
const {locate}=require('./loader.js');
const code=fs.readFileSync('input.js','utf8');
const info=locate(code);
const ast=parser.parse(code);
const out=[];
traverse(ast,{AssignmentExpression(p){
  const {left,right}=p.node;
  if(left.type!=='MemberExpression'||left.object.type!=='Identifier'||left.object.name!==info.protoVar)return;
  if(!left.computed||left.property.type!=='NumericLiteral')return;
  out.push([left.property.value, gen(right,{compact:false}).code]);
}});
out.sort((a,b)=>a[1].length-b[1].length);
fs.writeFileSync('debug/handlers.txt', out.map(([op,c])=>`===== ${op}  (len ${c.length})\n${c}\n`).join('\n'));
console.log(out.map(([op,c])=>`${op}\t${c.length}`).join('\n'));
