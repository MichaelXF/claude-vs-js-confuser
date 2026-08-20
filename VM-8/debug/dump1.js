globalThis.window = globalThis;
globalThis.document = {};
const M = require('./loaded.js');
console.log('bytecode length', M.bytecode.length);
console.log('pool length', M.pool.length);
console.log('meta', JSON.stringify(M.meta));
const ops = Object.keys(M.proto).filter(k=>/^\d+$/.test(k)).map(Number).sort((a,b)=>a-b);
console.log('numeric handlers:', ops.length);
console.log(ops.join(','));
console.log('non-numeric proto keys:', Object.keys(M.proto).filter(k=>!/^\d+$/.test(k)));
// opcode frequency in stream (naive)
const freq = new Map();
for (const v of M.bytecode) if (M.proto[v]) freq.set(v,(freq.get(v)||0)+1);
console.log('first 60 bytecode words:', Array.from(M.bytecode.slice(0,60)).join(' '));
