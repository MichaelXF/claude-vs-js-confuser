const fs=require('fs');
const parser=require('@babel/parser');
const generator=require('@babel/generator').default;
const code=fs.readFileSync(process.argv[2]||'input.js','utf8');
const ast=parser.parse(code);
const out=generator(ast,{compact:false,retainLines:false,comments:true,concise:false}).code;
fs.writeFileSync(process.argv[3]||'debug/input.pretty.js',out);
console.log('lines',out.split('\n').length);
