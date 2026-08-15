// Prints the disassembly grouped by function.
const { disassemble } = require("./disasm");
const { code, instrs, funcs } = disassemble();
const byPc = [...instrs.values()].sort((a, b) => a.pc - b.pc);
for (const [entry, f] of funcs) {
  console.log(`\n=== function @${entry} key=${f.key} Q=${f.desc.Q} d=${f.desc.d} F=${f.desc.F} ===`);
  const list = byPc.filter((r) => r.fn === entry);
  for (const r of list) console.log(`  ${String(r.pc).padStart(5)}: op ${String(r.op).padStart(5)} [${r.words.join(", ")}]`);
}
