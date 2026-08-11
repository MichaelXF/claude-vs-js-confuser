// debug/disasm.js — disassemble the payload and dump per-function listings
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const V = require("../vm.js");

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const ast = parser.parse(fs.readFileSync(file, "utf8"), { sourceType: "script" });
const vm = V.detectVM(ast);
const payload = V.extractPayload(ast, vm);
const opmap = V.buildOpcodeMap(vm);
const decode = V.makeDecoder(payload.pool);

const dis = V.disassemble(payload, opmap);
console.log("functions:", dis.functions.size);
let total = 0, kinds = new Map();
for (const fn of dis.functions.values()) {
  total += fn.insts.size;
  for (const i of fn.insts.values()) kinds.set(i.kind, (kinds.get(i.kind) || 0) + 1);
}
console.log("instructions:", total, "of", payload.words.length, "words");
console.log("kinds:", [...kinds.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}:${v}`).join(" "));

function fmt(i) {
  const f = [];
  for (const k of ["dst", "src", "a", "b", "obj", "key", "val", "cond", "target",
    "reg", "cell", "iter", "index", "callee", "entry", "params", "regs", "value",
    "from", "to", "dest", "keyRaw", "regKind", "regVal", "kindThrow", "fnReg"])
    if (i[k] !== undefined) f.push(`${k}=${i[k]}`);
  if (i.op) f.unshift(`'${i.op}'`);
  if (i.args) f.push(`args=[${i.args}]${i.spread ? "*" : ""}`);
  if (i.elems) f.push(`elems=[${i.elems}]`);
  if (i.pairs) f.push(`pairs=${JSON.stringify(i.pairs)}`);
  if (i.captures) f.push(`caps=${JSON.stringify(i.captures)}`);
  if (i.kind === "loadConst") {
    let v;
    try { v = JSON.stringify(decode(i.index, i.key)); } catch { v = "?"; }
    f.push(`=> ${v}`);
  }
  if (i.kind === "loadGlobal" || i.kind === "storeGlobal" || i.kind === "typeofGlobal")
    f.push(`name=${JSON.stringify(decode(i.index, i.key))}`);
  return `${String(i.pc).padStart(6)}: ${i.kind.padEnd(13)} ${f.join(" ")}`;
}

const out = [];
const fns = [...dis.functions.values()].sort((a, b) => a.entry - b.entry);
for (const fn of fns) {
  out.push(`\n===== fn#${fn.id} entry=${fn.entry} params=${fn.params} regs=${fn.regs}` +
    `${fn.hasRest ? " rest" : ""}${fn.top ? " TOP" : ""} instructions=${fn.insts.size} =====`);
  for (const pc of [...fn.insts.keys()].sort((a, b) => a - b)) out.push(fmt(fn.insts.get(pc)));
}
fs.writeFileSync(path.join(__dirname, "disasm.txt"), out.join("\n"));
console.log("-> debug/disasm.txt");
