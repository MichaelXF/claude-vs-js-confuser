// Build the switch-case table from the chain blocks and simulate the state machine.
const fs = require('fs');
const blocks = new Map(require('./blocks.json'));

// Chain blocks in order: start at 99, follow F links.
// Each chain block: r50 = r50 +/- const (or set at 99); cond r48 === r50; T -> stub; F -> next.
// Stub blocks contain only r143/r144/JUMP and dispatch to the real payload.

// Walk chain
const cases = []; // {caseValue, chainIp, stubIp, payloadIp}
let order = [];
let ip = 99;
// r50 simulation: block 99 sets r50 = const; others add/sub.
let r50 = 0;
const seen = new Set();
while (true) {
  const b = blocks.get(ip);
  if (!b) { console.log('chain end at', ip); break; }
  if (seen.has(ip)) { console.log('chain loop at', ip); break; }
  seen.add(ip);
  order.push(ip);
  // find the r50 update and constant: look at instructions
  // pattern: rX = CONST ; r50? = r50 +/- rX ; r50 = rYX  (or for 99: r50 = rX directly)
  // We'll just parse instructions.
  let constVal = null, op = null, setDirect = false;
  for (const ins of b.instrs) {
    const o = ins.operands;
    if (ins.name === 'LOAD_CONST' || ins.name === 'LOAD_LITERAL') {
      // candidate constant (dest varies); the one used in the r50 arithmetic
    }
  }
  // Simpler: find ADD/SUB with one operand being r50 (reg 50)
  for (let i = 0; i < b.instrs.length; i++) {
    const ins = b.instrs[i];
    const o = ins.operands;
    if ((ins.name === 'ADD' || ins.name === 'SUB') && (o[1] === 50 || o[2] === 50)) {
      // the other operand reg holds the constant; find its LOAD
      const otherReg = o[1] === 50 ? o[2] : o[1];
      // find LOAD of otherReg in this block
      for (const ins2 of b.instrs) {
        if ((ins2.name === 'LOAD_CONST' || ins2.name === 'LOAD_LITERAL') && ins2.operands[0] === otherReg) {
          constVal = ins2.name === 'LOAD_LITERAL' ? (ins2.operands[1] >> 0) : null;
          if (ins2.name === 'LOAD_CONST') {
            // decode
            const [d, idx, key] = ins2.operands;
            let v = poolConst(idx, key);
            constVal = v;
          }
        }
      }
      op = ins.name;
    }
    if (ins.name === 'MOVE' && o[0] === 50) {
      // r50 = rX ; check if rX was set directly from a constant (block 99)
      const srcReg = o[1];
      for (const ins2 of b.instrs) {
        if ((ins2.name === 'LOAD_CONST' || ins2.name === 'LOAD_LITERAL') && ins2.operands[0] === srcReg) {
          if (op === null) { setDirect = true; constVal = ins2.name === 'LOAD_LITERAL' ? (ins2.operands[1] >> 0) : poolConst(ins2.operands[1], ins2.operands[2]); }
        }
      }
    }
  }
  if (setDirect) r50 = constVal;
  else if (op === 'ADD') r50 = r50 + constVal;
  else if (op === 'SUB') r50 = r50 - constVal;
  else { console.log('block', ip, ': no r50 update found'); break; }

  // T target is the stub
  const stub = b.targetTrue;
  const stubBlock = blocks.get(stub);
  const payload = stubBlock.targets ? stubBlock.targets[0] : null;
  cases.push({ caseValue: r50, chainIp: ip, stubIp: stub, payloadIp: payload });
  ip = b.targetFalse;
}

function poolConst(idx, key) {
  const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
  const m = src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/);
  const pool = eval(m[1]);
  let b = pool[idx];
  if (!key) return b;
  if (typeof b === 'number') return b ^ key;
  if (typeof b !== 'string') return b;
  const buf = Buffer.from(b, 'base64');
  let e = '', c = key;
  for (let a = 0; a < buf.length / 2; a++) {
    c = c + 2654435769 | 0;
    e += String.fromCharCode((buf[a * 2] | buf[a * 2 + 1] << 8) ^ (c ^ c >>> 13) & 65535);
  }
  return e;
}

console.log('chain order:', order.join(' -> '));
console.log('\ncase table:');
for (const c of cases) console.log(`  case ${c.caseValue}: chain@${c.chainIp} stub@${c.stubIp} -> payload@${c.payloadIp}`);

// Now simulate the state machine: r48 starts 28763.
// block 59: if r48 === 48702 -> 1717 (which does work, r48 -= 20217, -> 59)
// else chain: find matching case; payload updates r48 by const; -> 59.
// payload blocks: find r48 update.
function r48Update(b) {
  for (let i = 0; i < b.instrs.length; i++) {
    const ins = b.instrs[i];
    const o = ins.operands;
    if ((ins.name === 'ADD' || ins.name === 'SUB') && (o[1] === 48 || o[2] === 48) && o[0] === 48) {
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

const caseMap = new Map(cases.map(c => [c.caseValue, c]));
let r48 = 28763;
let steps = 0;
console.log('\nstate machine trace:');
while (steps++ < 100) {
  if (r48 === 48702) {
    console.log(`  r48=${r48} -> block 1717 (closure0=true, document), r48 -= 20217`);
    r48 -= 20217;
    continue;
  }
  const c = caseMap.get(r48);
  if (!c) { console.log(`  r48=${r48} -> NO CASE (fall through chain -> 59) -- INFINITE?`); break; }
  const pb = blocks.get(c.payloadIp);
  const kind = pb.kind;
  console.log(`  r48=${r48} -> case -> payload@${c.payloadIp} (${kind})`);
  if (kind === 'return') { console.log('  RETURN'); break; }
  const delta = r48Update(pb);
  r48 += delta;
}
