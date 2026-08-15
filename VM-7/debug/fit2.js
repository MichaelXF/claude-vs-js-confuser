// Fits each opcode used by the program against candidate operators, using the real
// operand words and each candidate function key.
const { CODE, sweep, STRUCT, runInstr, funcKey, entryCall } = require("./vmmodel");

const list = sweep(CODE);
const byOp = new Map();
for (const ins of list) {
  if (!byOp.has(ins.op)) byOp.set(ins.op, []);
  byOp.get(ins.op).push(ins);
}

// candidate keys: discovered from the function-definition instructions
const topKey = entryCall[1].C.x | 0;
const KEYS = { top: topKey };
{
  const defs = list.filter((i) => i.op === 34577);
  // fn 37 defined at top level; 2830 & 1758 inside 37; 2980 inside 1758
  const k37 = funcKey(defs.find((d) => d.words[1] === 37).words, topKey);
  KEYS.f37 = k37;
  KEYS.f2830 = funcKey(defs.find((d) => d.words[1] === 2830).words, k37);
  const k1758 = funcKey(defs.find((d) => d.words[1] === 1758).words, k37);
  KEYS.f1758 = k1758;
  KEYS.f2980 = funcKey(defs.find((d) => d.words[1] === 2980).words, k1758);
}

const BIN = {
  "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => a / b, "%": (a, b) => a % b,
  "&": (a, b) => a & b, "|": (a, b) => a | b, "^": (a, b) => a ^ b,
  "<<": (a, b) => a << b, ">>": (a, b) => a >> b, ">>>": (a, b) => a >>> b,
  "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b,
  "==": (a, b) => a == b, "!=": (a, b) => a != b, "===": (a, b) => a === b, "!==": (a, b) => a !== b,
  "imul": (a, b) => Math.imul(a, b),
};
const BIN32 = {};
for (const [k, f] of Object.entries(BIN)) if (!"< <= > >= == != === !==".split(" ").includes(k)) BIN32[k + "|0"] = (a, b) => f(a, b) | 0;
const UN = { "-": (a) => -a, "~": (a) => ~a, "!": (a) => !a, "+": (a) => +a, id: (a) => a, "|0": (a) => a | 0, ">>>0": (a) => a >>> 0 };

function valueSets(n) {
  const pools = [
    () => (Math.random() * 9 - 4) | 0,
    () => (Math.random() * 2 ** 32 - 2 ** 31) | 0,
    () => [0, 1, -1, 2, -2, 7, 255, 65535, -65536, 2147483647, -2147483648][(Math.random() * 11) | 0],
  ];
  return pools[n % pools.length];
}

function analyzeOp(op, ins, key) {
  const st = STRUCT[op];
  const slots = st.regSlots;
  const regsOf = slots.map((s) => ins.words[s]); // register indices used
  const uniq = [...new Set(regsOf)];
  const N = 120;
  const trials = [];
  for (let t = 0; t < N; t++) {
    const gen = valueSets(t);
    const regs = [];
    for (let j = 0; j < 128; j++) regs[j] = 0;
    const inputs = {};
    for (const rg of uniq) { const v = gen(); regs[rg] = v; inputs[rg] = v; }
    // occasionally force equal inputs
    if (t % 7 === 0 && uniq.length >= 2) { const v = gen(); for (const rg of uniq) { regs[rg] = v; inputs[rg] = v; } }
    const res = runInstr(op, ins.words, key, regs);
    if (res.error) return { error: res.error.message };
    if (!res.regWrites.length) return { noWrite: true };
    const w = res.regWrites[res.regWrites.length - 1];
    trials.push({ inputs, dest: w[0], out: w[1] });
  }
  const dests = [...new Set(trials.map((t) => t.dest))];
  // sensitivity
  const sensitive = uniq.filter((rg) => {
    const base = trials[0];
    for (const t of trials) if (t.inputs[rg] !== base.inputs[rg] && !Object.is(t.out, base.out)) return true;
    return false;
  });
  const matches = new Set();
  for (const a of uniq) {
    for (const [name, f] of Object.entries(UN)) if (trials.every((t) => Object.is(f(t.inputs[a]), t.out))) matches.add(`${name}(r${a})`);
  }
  for (const a of uniq) for (const b of uniq) {
    if (a === b) continue;
    for (const [name, f] of Object.entries(BIN)) if (trials.every((t) => Object.is(f(t.inputs[a], t.inputs[b]), t.out))) matches.add(`r${a} ${name} r${b}`);
    for (const [name, f] of Object.entries(BIN32)) if (trials.every((t) => Object.is(f(t.inputs[a], t.inputs[b]), t.out))) matches.add(`r${a} ${name} r${b}`);
  }
  const constOut = new Set(trials.map((t) => t.out));
  return { dests, sensitive, uniq, matches: [...matches], constant: constOut.size === 1 ? [...constOut][0] : undefined, outTypes: [...new Set(trials.map((t) => typeof t.out))] };
}

const ops = [...byOp.keys()].sort((a, b) => a - b);
for (const op of ops) {
  const ins = byOp.get(op)[0];
  const results = [];
  for (const [kn, kv] of Object.entries(KEYS)) {
    const r = analyzeOp(op, ins, kv);
    results.push([kn, r]);
  }
  const good = results.filter(([, r]) => r.matches && r.matches.length);
  const line = good.length
    ? good.map(([kn, r]) => `${kn}: ${r.matches.join(" | ")}${r.sensitive.length !== r.uniq.length ? ` (junk regs: ${r.uniq.filter((x) => !r.sensitive.includes(x))})` : ""}`).join("   ///   ")
    : results.map(([kn, r]) => `${kn}: ${r.error ? "ERR " + r.error : r.noWrite ? "nowrite" : r.constant !== undefined ? "const " + r.constant : "sens=" + JSON.stringify(r.sensitive) + " types=" + r.outTypes}`).join(" | ");
  console.log(`op ${String(op).padStart(5)} x${String(byOp.get(op).length).padStart(3)} slots=${JSON.stringify(STRUCT[op].regSlots)} words=[${ins.words.join(",")}] => ${line}`);
}
