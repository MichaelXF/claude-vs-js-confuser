// debug/stages.js — time each stage and report specialization statistics
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const V = require("../vm.js");

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const t0 = Date.now();
const ast = parser.parse(fs.readFileSync(file, "utf8"), { sourceType: "script" });
console.log("parse", Date.now() - t0, "ms");

let t = Date.now();
const vm = V.detectVM(ast);
console.log("detect", Date.now() - t, "ms");

t = Date.now();
const payload = V.extractPayload(ast, vm);
console.log("payload", Date.now() - t, "ms");

t = Date.now();
const opmap = V.buildOpcodeMap(vm);
console.log("opcodes", Date.now() - t, "ms");

t = Date.now();
const dis = V.disassemble(payload, opmap);
console.log("disasm", Date.now() - t, "ms", dis.functions.size, "functions");

const decode = V.makeDecoder(payload.pool);
for (const fn of [...dis.functions.values()].sort((a, b) => a.id - b.id)) {
  t = Date.now();
  const live = V.computeInstLiveness(fn);
  const tl = Date.now() - t;
  t = Date.now();
  const spec = V.specializeFunction(fn, decode);
  console.log(`fn#${fn.id} insts=${fn.insts.size} liveness=${tl}ms specialize=${Date.now() - t}ms ` +
    (spec ? `blocks=${spec.blocks.size} steps=${[...spec.blocks.values()].reduce((a, b) => a + b.steps.length, 0)}`
          : "BAILED"));
}
