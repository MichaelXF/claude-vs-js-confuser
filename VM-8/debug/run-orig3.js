const path=require('path');
globalThis.window = globalThis;
globalThis.document = { createElement:(t)=>({style:{},appendChild(){},setAttribute(){}}), body:{appendChild(){}} };
require(path.resolve(__dirname,'..','input.js'));
const f = globalThis['_k1crlxlk2w8'];
console.log('fn.length =', f.length);
for (const args of [[],[1],[1,2],['a'],['abc',3],[[1,2,3]],[{a:1}]]) {
  try { console.log(JSON.stringify(args), '->', JSON.stringify(f.apply(null,args))); }
  catch(e){ console.log(JSON.stringify(args), 'THREW', e.message); }
}
