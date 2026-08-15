// Fits each arithmetic/comparison handler against candidate JS operators by
// running it on random inputs and comparing results.
const { runProbe, seqWords, OPS } = require("./probe");

const BIN = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "&": (a, b) => a & b,
  "|": (a, b) => a | b,
  "^": (a, b) => a ^ b,
  "<<": (a, b) => a << b,
  ">>": (a, b) => a >> b,
  ">>>": (a, b) => a >>> b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "==": (a, b) => a == b,
  "!=": (a, b) => a != b,
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "**": (a, b) => a ** b,
};
const BIN32 = {};
for (const [k, f] of Object.entries(BIN)) BIN32["(" + k + ")|0"] = (a, b) => f(a, b) | 0;
const UN = {
  "-": (a) => -a,
  "~": (a) => ~a,
  "!": (a) => !a,
  "+": (a) => +a,
  "id": (a) => a,
  "|0": (a) => a | 0,
  ">>>0": (a) => a >>> 0,
};

function rndInt(range) {
  return (Math.random() * 2 * range - range) | 0;
}

function trialsFor(op, structure, valueGen, N = 60) {
  const words = seqWords(40);
  const reads = structure.regReads;
  const results = [];
  for (let t = 0; t < N; t++) {
    const regs = [];
    for (let j = 0; j < 64; j++) regs[j] = 0;
    const inputs = {};
    for (const r of reads) {
      const v = valueGen();
      regs[r] = v;
      inputs[r] = v;
    }
    const res = runProbe(op, words, regs);
    if (res.error) return null;
    if (!res.regWrites.length) return null;
    const out = res.regWrites[res.regWrites.length - 1][1];
    results.push({ inputs, out, reads: res.regReads });
  }
  return results;
}

function fit(op, structure) {
  const reads = [...new Set(structure.regReads)];
  const gens = [
    () => rndInt(50),
    () => rndInt(0x7fffffff),
    () => rndInt(1000000),
  ];
  const matches = [];
  for (const gen of gens) {
    const trials = trialsFor(op, structure, gen, 40);
    if (!trials) return { error: true };
    const local = new Set();
    // unary candidates
    for (const a of reads) {
      for (const [name, f] of Object.entries(UN)) {
        if (trials.every((t) => Object.is(f(t.inputs[a]), t.out))) local.add(`u${name}(r${a})`);
      }
    }
    for (const a of reads) {
      for (const b of reads) {
        if (a === b) continue;
        for (const [name, f] of Object.entries(BIN)) {
          if (trials.every((t) => Object.is(f(t.inputs[a], t.inputs[b]), t.out))) local.add(`r${a} ${name} r${b}`);
        }
        for (const [name, f] of Object.entries(BIN32)) {
          if (trials.every((t) => Object.is(f(t.inputs[a], t.inputs[b]), t.out))) local.add(`r${a} ${name} r${b}`);
        }
      }
    }
    matches.push(local);
  }
  // intersect
  let inter = matches[0];
  for (const m of matches.slice(1)) inter = new Set([...inter].filter((x) => m.has(x)));
  return { all: [...inter], perGen: matches.map((m) => [...m]) };
}

if (require.main === module) {
  const words = seqWords(40);
  const regs = [];
  for (let j = 0; j < 64; j++) regs[j] = 1000 + j;
  for (const op of OPS) {
    const st = runProbe(op, words, regs);
    if (st.error || !st.regWrites.length || !st.regReads.length) {
      console.log(`op ${String(op).padStart(5)} len=${st.len} SKIP (${st.error ? "err" : "no read/write"})`);
      continue;
    }
    const f = fit(op, st);
    console.log(`op ${String(op).padStart(5)} len=${st.len} rd=[${st.regReads}] => ${f.error ? "ERR" : f.all.join(" | ") || "NO MATCH  gens:" + JSON.stringify(f.perGen)}`);
  }
}
module.exports = { fit };
