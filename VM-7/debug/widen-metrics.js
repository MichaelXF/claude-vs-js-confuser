// Compares candidate widenings of one function on several possible scoring
// signals, so the pass score can be chosen from data rather than intuition.
//
//   node debug/widen-metrics.js <functionEntry> <reg> [reg ...]
const fs = require("fs");
const path = require("path");
const { inspect, loadSample, Machine } = require("../lib/machine");
const { Analyzer, FuncAnalysis } = require("../lib/analyze");

const file = path.join(__dirname, "..", "input.js");
const info = inspect(fs.readFileSync(file, "utf8"));
const loaded = loadSample(info.ast, info.entryStmt, file);
const m = new Machine(loaded);
const a = new Analyzer(m);

const entry = Number(process.argv[2]);
const regs = process.argv.slice(3).map(Number);

// analyze the parents so the requested function has its descriptor
const target = { fn: null };
const origRun = FuncAnalysis.prototype.run;
FuncAnalysis.prototype.run = function () {
  if (this.entry === entry) { target.fn = this; this.runMerged(); this.computeLiveness(); return this.pass(new Set(this.captured)) && undefined; }
  return origRun.call(this);
};
a.analyzeProgram();

const fn = target.fn;
if (!fn) throw new Error("function @" + entry + " was not reached");

function metrics(widened) {
  const res = fn.pass(new Set([...fn.captured, ...widened]));
  const pcs = new Set();
  const arithPcs = new Set();
  const foldedPcs = new Set();
  for (const node of res.nodes.values()) {
    pcs.add(node.pc);
    for (const ins of node.instrs || []) {
      if (ins.kind.kind !== "arith") continue;
      arithPcs.add(ins.pc);
      if (node.values.has(ins.pc)) foldedPcs.add(ins.pc);
    }
  }
  const unfolded = [...arithPcs].filter((p) => !foldedPcs.has(p));
  return {
    widened: `[${widened.join(",")}]`,
    nodes: res.nodes.size,
    overflow: res.overflow ? "@" + res.overflow.pc : "-",
    unresolved: res.unresolved,
    splitSites: res.splits,
    blocks: pcs.size,
    arithSites: arithPcs.size,
    unfoldedArith: unfolded.length,
  };
}

const rows = [metrics([])].concat(regs.map((r) => metrics([r])));
const cols = Object.keys(rows[0]);
console.log(cols.map((c) => c.padEnd(14)).join(""));
for (const row of rows) console.log(cols.map((c) => String(row[c]).padEnd(14)).join(""));
