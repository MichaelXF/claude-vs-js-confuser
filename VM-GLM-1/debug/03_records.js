// Dump symbolic records of all handlers for archetype classification
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const vmMod = require("../vm.js");

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
const ast = parser.parse(src);
const vm = vmMod.extractVM(ast);
if (!vm) { console.error("no VM found"); process.exit(1); }
console.error("VM extracted:", {
  vmCtorName: vm.vmCtorName, handlerVar: vm.handlerVar,
  handlers: vm.handlers.size, weakMapVar: vm.weakMapVar,
  cellReadFn: vm.cellReadFn, framePushFn: vm.framePushFn, metaCtor: vm.metaCtor,
  entryMeta: vm.entryMeta, bytecode: vm.bytecode.length, constants: vm.constants.length,
});

const lines = [];
for (const [opcode, fn] of vm.handlers) {
  let rec;
  try {
    rec = vmMod.interpretHandler(fn, vm);
  } catch (e) {
    lines.push(`/* ${opcode} INTERPRET-ERROR ${e.message} */`);
    continue;
  }
  lines.push(`/* opcode ${opcode} — reads ${rec.opsRead} */`);
  lines.push(vmMod.serRecord(rec).replace(/^/gm, "  "));
  lines.push("");
}
fs.writeFileSync(path.join(__dirname, "handler_records.txt"), lines.join("\n"));
console.log("wrote debug/handler_records.txt");
