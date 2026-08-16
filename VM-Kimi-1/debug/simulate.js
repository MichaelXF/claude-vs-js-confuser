// Simulate the flattened state machine to recover the original control-flow path.
const fs = require('fs');
const blocks = new Map(require('./blocks.json'));

// Case table from previous analysis (chain blocks): caseValue -> payloadIp
const CASES = {
  22385: 2026, 29455: 2333, 8492: 1769, 55929: 1824, 61427: 2058, 3056: 2306,
  64592: 2032, 40600: 2360, 50116: 2479, 24844: 1973, 28763: 2141, 60817: 1717,
  4895: 2387, 18575: 1958, 36187: 1851, 63163: 2170, 7139: 2000, 23956: 2085,
  57600: 1931, 57313: 2197, 28815: 2485, 15970: 1743, 36919: 1904, 41038: 2452,
  44155: 2252, 50817: 1797, 53711: 1878, 15210: 2112, 52878: 2280, 7759: 2225,
};

const pool = (() => {
  const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
  const m = src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/);
  return eval(m[1]);
})();
function poolConst(idx, key) {
  let b = pool[idx];
  if (!key) return b;
  if (typeof b === 'number') return b ^ key;
  return b;
}
// find r48 delta in a payload block
function r48Delta(b) {
  for (const ins of b.instrs) {
    const o = ins.operands;
    if ((ins.name === 'ADD' || ins.name === 'SUB') && o[0] === 48 && (o[1] === 48 || o[2] === 48)) {
      const otherReg = o[1] === 48 ? o[2] : o[1];
      for (const ins2 of b.instrs) {
        if ((ins2.name === 'LOAD_CONST' || ins2.name === 'LOAD_LITERAL') && ins2.operands[0] === otherReg) {
          const cv = ins2.name === 'LOAD_LITERAL' ? (ins2.operands[1] >> 0) : poolConst(ins2.operands[1], ins2.operands[2]);
          return ins.name === 'ADD' ? cv : -cv;
        }
      }
    }
  }
  return 0;
}

let r48 = 28763, closure0 = false;
let steps = 0;
const trace = [];
while (steps++ < 60) {
  let node;
  if (r48 === 48702) node = 1717;
  else if (CASES[r48] !== undefined) node = CASES[r48];
  else { console.log(`r48=${r48}: NO CASE -> fallthrough (loop)`); break; }

  const b = blocks.get(node);
  trace.push({ r48, node, kind: b.kind, closure0 });
  if (b.kind === 'return') { console.log(`step ${steps}: r48=${r48} -> block ${node} RETURN`); break; }
  if (node === 2387) {
    // conditional on closure0
    if (closure0) { console.log(`step ${steps}: r48=${r48} -> 2387 (closure0=true) r48+=17490`); r48 += 17490; }
    else { console.log(`step ${steps}: r48=${r48} -> 2387 (closure0=false) r48+=55922`); r48 += 55922; }
    continue;
  }
  const delta = r48Delta(b);
  console.log(`step ${steps}: r48=${r48} -> block ${node} (${b.kind}) r48 ${delta >= 0 ? '+' : ''}${delta}${node === 1717 ? ' [sets closure0=true]' : ''}`);
  if (node === 1717) closure0 = true;
  r48 += delta;
}
fs.writeFileSync(__dirname + '/simtrace.json', JSON.stringify(trace, null, 1));
