// Logs every widening trial: which register was tried and what the resulting
// pass scored (unresolved jumps / unfolded predicates / node count).
//
//   node debug/widen-trace.js
const fs = require("fs");
const path = require("path");
const { inspect, loadSample, Machine } = require("../lib/machine");
const { Analyzer, FuncAnalysis } = require("../lib/analyze");

const file = path.join(__dirname, "..", "input.js");
const info = inspect(fs.readFileSync(file, "utf8"));
const loaded = loadSample(info.ast, info.entryStmt, file);
const m = new Machine(loaded);
const a = new Analyzer(m);

const pass = FuncAnalysis.prototype.pass;
FuncAnalysis.prototype.pass = function (widened) {
  const out = pass.call(this, widened);
  console.log(`  @${this.entry} widened[${[...widened].join(",")}] -> ${out.nodes.size} nodes, ` +
    `overflow=${out.overflow ? "@" + out.overflow.pc : "no"}, unresolved=${out.unresolved}, blocks=${out.blocks}, unfolded=${out.unfolded}`);
  return out;
};

const choose = FuncAnalysis.prototype.chooseWidening;
FuncAnalysis.prototype.chooseWidening = function (current, widened, budget) {
  const { pc, list } = current.overflow;
  const rows = [];
  for (const r of this.liveIn.get(pc) || []) {
    if (widened.has(r)) continue;
    rows.push({ r, distinct: new Set(list.map((n) => n.state[r])).size });
  }
  rows.sort((x, y) => y.distinct - x.distinct);
  console.log(`  @${this.entry}: overflow at @${pc} (${list.length} instances); candidates ` +
    rows.filter((x) => x.distinct >= 2).map((x) => `r${x.r}(${x.distinct})`).join(" "));
  const out = choose.call(this, current, widened, budget);
  console.log(`  @${this.entry}: chose ${out.best ? "r" + out.best.reg : "(nothing)"} after ${out.tried} trial(s)`);
  return out;
};

a.analyzeProgram();
