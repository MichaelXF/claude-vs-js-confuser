// Analyze bytecode: path-sensitive exploration + CFG edges
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const vmMod = require("../vm.js");

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
const ast = parser.parse(src);
const vm = vmMod.extractVM(ast);
const { table, failures } = vmMod.classifyHandlers(vm);
console.error(`classified ${table.size}/${vm.handlers.size} handlers; failures: [${failures.join(", ")}]`);

const dis = vmMod.analyze(vm, table);
console.error(`instructions: ${dis.instrs.size}, functions: ${dis.functions.size}`);
console.error(`unknown regions: ${dis.unknownRegions.length} ${dis.unknownRegions.slice(0, 20).join(",")}`);
console.error(`unresolved jumps: ${JSON.stringify(dis.unresolvedJumps.slice(0, 10))}`);

const lines = [];
for (const [entry, fn] of [...dis.functions.entries()].sort((a, b) => a[0] - b[0])) {
  lines.push(`\n===== FUNCTION entry=${entry} params=${fn.params} regs=${fn.regs} rest=${fn.rest} instrs=${fn.ips.size} =====`);
  const ips = [...fn.ips].sort((a, b) => a - b);
  for (const ip of ips) {
    const instr = dis.instrs.get(ip);
    const edges = fn.edges.get(ip);
    let e = "";
    if (edges && edges.length) e = "   // -> " + edges.map((x) => `${x.to}${x.kind !== "fall" ? "(" + x.kind + ")" : ""}`).join(" ");
    lines.push(`${String(ip).padStart(5)}  ${vmMod.formatInstr(instr, dis.decodeConst)}${e}`);
  }
}
fs.writeFileSync(path.join(__dirname, "disasm.txt"), lines.join("\n"));
console.log("wrote debug/disasm.txt");
