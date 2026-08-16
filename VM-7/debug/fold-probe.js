// Probes one instruction's sensitivity to each of its unknown operands, to see
// which junk operands really cancel and which only appear to.
//
//   node debug/fold-probe.js <pc> <key> [reg=value ...]
const fs = require("fs");
const path = require("path");
const { inspect, loadSample, Machine, NREG } = require("../lib/machine");
const { Analyzer } = require("../lib/analyze");

const file = path.join(__dirname, "..", "input.js");
const info = inspect(fs.readFileSync(file, "utf8"));
const loaded = loadSample(info.ast, info.entryStmt, file);
const m = new Machine(loaded);
const a = new Analyzer(m);

const pc = Number(process.argv[2]);
const key = Number(process.argv[3]);
const known = new Map();
for (const arg of process.argv.slice(4)) {
  const [r, v] = arg.split("=");
  known.set(Number(r.replace(/^r/, "")), Number(v));
}

const ins = a.instrs.get(pc);
const srcs = a.srcRegs(ins);
console.log(`pc ${pc} op ${ins.op} kind ${ins.kind.kind} srcs [${srcs.join(",")}] known {${[...known].map(([r, v]) => `r${r}=${v}`).join(",")}}`);

const POOL = [0, 1, -1, 2, 3, 9, 16, 255, -256, 65535, 2147483647, -2147483648,
  0x12345678, -0x12345678, 0x7ffffff9, 0x40000009, 25, 41, 57, 73, 89, 105, 121, 137];

function runWith(assign) {
  const regs = new Array(NREG).fill(0);
  for (const [r, v] of known) regs[r] = v;
  for (const [r, v] of Object.entries(assign)) regs[r] = v;
  const res = m.runAt(m.code, pc, key, regs, {});
  if (res.error || !res.regWrites.length) return "<error>";
  return res.regWrites[res.regWrites.length - 1][1];
}

const unknown = srcs.filter((r) => !known.has(r));
for (const u of [...new Set(unknown)]) {
  const seen = new Map();
  for (const v of POOL) {
    const out = runWith({ [u]: v });
    if (!seen.has(out)) seen.set(out, []);
    seen.get(out).push(v);
  }
  console.log(`  varying r${u} alone -> ${seen.size} distinct result(s)`);
  for (const [out, vals] of seen) {
    console.log(`      ${String(out).padEnd(14)} for ${vals.length} value(s): ${vals.slice(0, 6).join(", ")}${vals.length > 6 ? ", ..." : ""}`);
  }
  const nibble9 = POOL.filter((v) => (v & 15) === 9);
  const outs9 = new Set(nibble9.map((v) => runWith({ [u]: v })));
  console.log(`      restricted to (v & 15) === 9 (${nibble9.length} values) -> ${outs9.size} distinct: ${[...outs9].join(", ")}`);
}
