// Tests the "junk register" theory: MBA junk operands cancel when their value has
// low nibble 9 (the shape the obfuscator guarantees for concealed constants).
const M = require("./vmmodel2");
const { CODE, sweep, runAt, NREG, STRUCT } = M;
const list = [...sweep(CODE).values()];

function evalAt(ins, key, regs) {
  const res = runAt(CODE, ins.pc, key, regs, {});
  if (res.error) return "ERR:" + res.error.message;
  if (!res.regWrites.length) return "NOWRITE";
  return res.regWrites[res.regWrites.length - 1][1];
}

const KEY37 = -616178882;
function test(op, key, label) {
  const ins = list.find((i) => i.op === op);
  if (!ins) return console.log(op, "not used");
  const srcs = [...new Set(STRUCT[op].regSlots.map((s) => ins.words[s]))];
  console.log(`\nop ${op} @${ins.pc} words=[${ins.words}] srcs=[${srcs}] (${label})`);
  for (const r of srcs) {
    const outs = new Set();
    for (let t = 0; t < 8; t++) {
      const regs = new Array(NREG).fill(0);
      for (const s of srcs) regs[s] = ((Math.random() * 2 ** 32) | 0 & ~15) | 9;
      regs[r] = (((Math.random() * 2 ** 32) | 0) & ~15) | 9;
      outs.add(String(evalAt(ins, key, regs)));
    }
    // same but only varying r, others fixed
    const fixed = new Array(NREG).fill(0);
    for (const s of srcs) fixed[s] = (((Math.random() * 2 ** 32) | 0) & ~15) | 9;
    const outs2 = new Set();
    for (let t = 0; t < 8; t++) {
      const regs = fixed.slice();
      regs[r] = (((Math.random() * 2 ** 32) | 0) & ~15) | 9;
      outs2.add(String(evalAt(fixed && ins, key, regs)));
    }
    console.log(`   r${r}: varying alone -> ${outs2.size} distinct  ${outs2.size === 1 ? "(JUNK)" : "(REAL)"} sample=${[...outs2][0]}`);
  }
}

test(15604, KEY37, "suspected concealed-constant load in fn37");
test(8972, KEY37, "suspected concealed-constant load");
test(13544, KEY37, "chain helper");
test(454, KEY37, "chain compare");
test(9115, KEY37, "chain compare");
test(6548, KEY37, "plain add (control)");
