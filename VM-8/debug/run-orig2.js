const path=require('path');
globalThis.window = globalThis;
globalThis.document = { createElement:(t)=>({style:{},appendChild(){},setAttribute(){}}), body:{appendChild(){}} };
const before = new Set(Object.getOwnPropertyNames(globalThis));
const m = require(path.resolve(__dirname,'..','input.js'));
console.log('module.exports =', m);
const after = Object.getOwnPropertyNames(globalThis).filter(k=>!before.has(k));
console.log('new globals:', after);
for (const k of after) { try { console.log(' ', k, '=', globalThis[k]); } catch(e){ console.log(' ',k,'<err>'); } }
