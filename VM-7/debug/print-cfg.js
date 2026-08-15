// Prints each function's blocks with resolved successors.
const { analyzeAll, OP, TOP } = require("./cfg");
const M = require("./vmmodel2");

const an = analyzeAll();
for (const [entry, fn] of an.functions) {
  console.log(`\n########## function @${entry}  params=${fn.desc.d} regs=${fn.desc.Q} key=${fn.key}`);
  for (const bpc of [...fn.blocks.keys()].sort((a, b) => a - b)) {
    const blk = fn.blocks.get(bpc);
    const outs = blk.outcomes.map((o) => {
      const cond = o.split ? `[r${o.split.reg}=${o.split.value}]` : "";
      return `${cond}${o.kind}${o.targets.length ? "->" + o.targets.join(",") : ""}`;
    });
    console.log(`  --- block ${bpc}  succ: ${outs.join(" ; ")}`);
    for (const rec of blk.records) {
      const st = M.STRUCT[rec.ins.op];
      console.log(`      ${String(rec.ins.pc).padStart(5)} op${String(rec.ins.op).padStart(6)} words=[${rec.ins.words.join(",")}] dest=${rec.dest} srcs=[${rec.srcs}] type=${M.RESTYPE[rec.ins.op]}`);
    }
  }
}
