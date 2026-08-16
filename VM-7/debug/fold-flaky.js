// Runs the invariance fold many times per instruction site and reports the
// sites whose answer is not stable, which is what makes the widening heuristic
// (and therefore the whole unflattening) jump between runs.
//
//   node debug/fold-flaky.js [repeats]
const fs = require("fs");
const path = require("path");
const { inspect, loadSample, Machine } = require("../lib/machine");
const { Analyzer, FuncAnalysis } = require("../lib/analyze");

const repeats = Number(process.argv[2] || 8);
const file = path.join(__dirname, "..", "input.js");
const info = inspect(fs.readFileSync(file, "utf8"));
const loaded = loadSample(info.ast, info.entryStmt, file);
const m = new Machine(loaded);

const stats = new Map(); // "fn@pc" -> { ok: n, no: n, values: Set }
const original = FuncAnalysis.prototype.invariantValue;
FuncAnalysis.prototype.invariantValue = function (ins, regs, unknown) {
  const out = original.call(this, ins, regs, unknown);
  const context = this.a.srcRegs(ins).map((r) => `r${r}=${unknown.includes(r) ? "?" : String(regs[r])}`).join(" ");
  const key = `@${this.entry} pc ${ins.pc} op ${ins.op} { ${context} }`;
  if (!stats.has(key)) stats.set(key, { ok: 0, no: 0, values: new Set() });
  const s = stats.get(key);
  if (out.ok) { s.ok++; s.values.add(String(out.value)); } else s.no++;
  return out;
};

for (let i = 0; i < repeats; i++) {
  const a = new Analyzer(m);
  a.analyzeProgram();
  const shape = [...a.functions.values()].map((f) => `@${f.entry}:${f.nodes.size}n widened[${[...f.widened].join(",")}]`).join("  ");
  console.log(`run ${i}: ${shape}`);
}

console.log("\nunstable fold sites:");
let unstable = 0;
for (const [key, s] of stats) {
  if (s.ok && s.no) { unstable++; console.log(`  ${key}: folded ${s.ok}x -> {${[...s.values].join("|")}}, refused ${s.no}x`); }
  else if (s.values.size > 1) { unstable++; console.log(`  ${key}: folded to DIFFERENT values {${[...s.values].join("|")}}`); }
}
if (!unstable) console.log("  (none)");
