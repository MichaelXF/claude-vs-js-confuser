// Tracer: loads input.js, patches the VM to log every instruction dispatch
// and every operand read (v() call), plus constant decryptions (A() calls).
const fs = require('fs');
const path = require('path');
let src = fs.readFileSync(path.join(__dirname, '/../input.js'), 'utf8');

// Patch v() to log operand reads
src = src.replace(
  'function v(a){return a.k[a.t[a.g+3]++]}',
  'function v(a){var ip=a.t[a.g+3];var val=a.k[a.t[a.g+3]++];global.__reads.push([a.g,ip,val]);return val}'
);

// Patch dispatch loop to log opcode fetches
src = src.replace(
  'e=this.k[e];a[b+6]=(a[b+6]+1)%c.length;try{this[e]()}',
  'e=this.k[e];global.__ops.push([b,a[b+3]-1,e]);a[b+6]=(a[b+6]+1)%c.length;try{this[e]()}'
);

// Replace A() with a logging reimplementation
global.__A = function (a) {
  var startIp = a.t[a.g + 3];
  a.s = [void 0, void 0];
  var b = v(a), c = v(a);
  b = a.v[b];
  var ret;
  if (!c) ret = b;
  else if (typeof b === 'number') ret = b ^ c;
  else if (typeof b !== 'string') ret = b;
  else {
    b = r(b);
    var e = '';
    a.y = void 0;
    for (var i = 0; i < b.length / 2; i++) {
      c = c + 2654435769 | 0;
      e += String.fromCharCode((b[i * 2] | b[i * 2 + 1] << 8) ^ (c ^ c >>> 13) & 65535);
    }
    ret = e;
  }
  global.__strs.push([a.g, startIp, ret]);
  return ret;
};
src = src.replace(/function A\(a\)\{/, 'function A(a){return global.__A(a)}function __Aorig(a){');

global.__reads = [];
global.__ops = [];
global.__strs = [];

globalThis.window = globalThis;
globalThis.document = undefined;

try {
  eval(src);
} catch (e) {
  console.log('RUNTIME ERROR:', e.message);
}

fs.writeFileSync(__dirname + '/trace_ops.json', JSON.stringify(global.__ops));
fs.writeFileSync(__dirname + '/trace_reads.json', JSON.stringify(global.__reads));
fs.writeFileSync(__dirname + '/trace_strs.json', JSON.stringify(global.__strs));
console.log('ops executed:', global.__ops.length);
console.log('operand reads:', global.__reads.length);
console.log('strings decoded:', global.__strs.length);
console.log('unique opcodes:', new Set(global.__ops.map(o => o[2])).size);
console.log('decoded strings:', JSON.stringify(global.__strs.map(s => s[2])));
