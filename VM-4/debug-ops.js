// debug-ops.js - run the real classifier over every opcode and print the table.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const V = require("./vm.js");

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });
const vm = V.locateVM(ast);
vm.regBaseSlot = V.findRegBaseSlot(vm);

const rows = [];
const kinds = new Map();
for (const op of [...vm.handlers.keys()].sort((a, b) => a - b)) {
  let d;
  try {
    d = V.classify(vm, V.probeStructure(vm, op));
  } catch (e) {
    d = { op, kind: "ERROR:" + e.message };
  }
  kinds.set(d.kind, (kinds.get(d.kind) || 0) + 1);
  const { op: _o, ...rest } = d;
  rows.push(`${String(op).padStart(5)}  ${JSON.stringify(rest)}`);
}
fs.writeFileSync(path.join(__dirname, "debug-ops.txt"), rows.join("\n"));
console.log([...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}: ${c}`).join("\n"));
