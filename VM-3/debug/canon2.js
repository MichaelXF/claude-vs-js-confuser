// debug/canon2.js — dump the unified canonical shapes produced by vm.js
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const { detectVM, extractPayload, canonicalize } = require("../vm.js");

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const ast = parser.parse(fs.readFileSync(file, "utf8"), { sourceType: "script" });
const vm = detectVM(ast);
console.log("slots:", JSON.stringify(vm.slots), "regBase:", vm.regBaseOff, "pcOff:", vm.pcOff);

const byCanon = new Map();
for (const [op, fn] of vm.handlers) {
  let r;
  try { r = canonicalize(fn, vm); } catch (e) { r = { canon: "ERROR " + e.message, slots: [] }; }
  if (!byCanon.has(r.canon)) byCanon.set(r.canon, []);
  byCanon.get(r.canon).push({ op, slots: r.slots });
}
const out = [`# unified shapes: ${byCanon.size}\n`];
for (const [canon, list] of [...byCanon.entries()].sort((a, b) => b[1].length - a[1].length)) {
  out.push(`### ${canon}`);
  for (const { op, slots } of list)
    out.push(`    op ${op}  slots=${slots.map((s) => (s.stream ? "s" + s.read : "c" + s.value)).join(" ")}`);
  out.push("");
}
fs.writeFileSync(path.join(__dirname, "canon2.txt"), out.join("\n"));
console.log("shapes:", byCanon.size, "-> debug/canon2.txt");
