// debug/canon.js — normalize each opcode handler into a shape signature
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const { analyzeVM } = require("./vmshape.js");

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const code = fs.readFileSync(file, "utf8");
const ast = parser.parse(code, { sourceType: "script" });
const vm = analyzeVM(ast);
console.log("VM shape:", JSON.stringify({ ...vm, handlers: vm.handlers.size }, (k, v) => (k === "handlerNodes" ? undefined : v)));

const out = [];
const byCanon = new Map();
for (const [op, fnNode] of vm.handlers) {
  const { canon, nums } = vm.canonicalize(fnNode);
  if (!byCanon.has(canon)) byCanon.set(canon, []);
  byCanon.get(canon).push({ op, nums });
}
out.push(`# distinct canonical shapes: ${byCanon.size}\n`);
const entries = [...byCanon.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [canon, list] of entries) {
  out.push(`### ${canon}`);
  for (const { op, nums } of list) out.push(`    op ${op}  nums=[${nums.join(",")}]`);
  out.push("");
}
fs.writeFileSync(path.join(__dirname, "canon.txt"), out.join("\n"));
console.log("shapes:", byCanon.size, "-> debug/canon.txt");
