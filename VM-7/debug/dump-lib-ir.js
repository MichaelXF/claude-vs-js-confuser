// Dumps the analyzed node graph produced by lib/ (as opposed to the older
// debug/analyze.js), with per-instruction folded values and fitted operators.
//
//   node debug/dump-lib-ir.js [functionEntry]
const fs = require("fs");
const path = require("path");
const { inspect, loadSample, Machine, MAGIC_SPREAD } = require("../lib/machine");
const { Analyzer, TOP } = require("../lib/analyze");
const { fitInstruction } = require("../lib/fit");

const file = path.join(__dirname, "..", "input.js");
const info = inspect(fs.readFileSync(file, "utf8"));
const loaded = loadSample(info.ast, info.entryStmt, file);
const m = new Machine(loaded);
const a = new Analyzer(m);
const funcs = a.analyzeProgram();

const fmt = (v) => {
  if (v === TOP) return "?";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "..." : v);
  if (typeof v === "function") return "<fn>";
  if (typeof v === "object" && v) return "<obj>";
  return String(v);
};

function describe(fn, node, ins) {
  const w = ins.words;
  const R = (n) => "r" + n;
  const dest = a.destOf(ins, fn.key);
  switch (ins.kind.kind) {
    case "jump": return `JMP ${w[0]}`;
    case "dynjump": return `DYNJMP ${R(w[0])}`;
    case "branch": return `if (${ins.kind.whenFalse ? "!" : ""}${R(w[0])}) JMP ${w[1]}`;
    case "return": return `RETURN ${R(w[0])}`;
    case "throw": return `THROW ${R(w[0])}`;
    case "loadimm": return `${R(dest)} = ${w[1]}`;
    case "loadconst": return `${R(dest)} = ${JSON.stringify(m.decodeConst(w[1], w[2]))}`;
    case "this": return `${R(dest)} = this`;
    case "void": return `${R(dest)} = void ${R(w[1])}`;
    case "getmember": return `${R(dest)} = ${R(w[1])}[${R(w[2])}]`;
    case "setmember": return `${R(w[0])}[${R(w[1])}] = ${R(w[2])}`;
    case "getglobal": return `${R(dest)} = global.${m.decodeConst(w[1], w[2])}`;
    case "setglobal": return `global.${m.decodeConst(w[0], w[1])} = ${R(w[2])}`;
    case "typeofglobal": return `${R(dest)} = typeof global.${m.decodeConst(w[1], w[2])}`;
    case "getclosure": return `${R(dest)} = closure[${w[1]}]`;
    case "setclosure": return `closure[${w[0]}] = ${R(w[1])}`;
    case "array": return `${R(dest)} = [${w.slice(2).map(R).join(", ")}]`;
    case "func": return `${R(dest)} = function@${w[1]}(params=${w[2]} regs=${w[3]} cl=${w[4]})`;
    case "call": {
      const args = w[2] === MAGIC_SPREAD ? `...${R(w[3])}` : w.slice(3).map(R).join(", ");
      return `${R(dest)} = ${R(w[1])}(${args})`;
    }
    case "mcall": {
      const args = w[3] === MAGIC_SPREAD ? `...${R(w[4])}` : w.slice(4).map(R).join(", ");
      return `${R(dest)} = ${R(w[2])}.call(${R(w[1])}, ${args})`;
    }
    case "new": {
      const args = w[2] === MAGIC_SPREAD ? `...${R(w[3])}` : w.slice(3).map(R).join(", ");
      return `${R(dest)} = new ${R(w[1])}(${args})`;
    }
    case "arith": {
      const inputs = node.inputs.get(ins.pc) || new Map();
      const srcs = a.srcRegs(ins);
      const fixed = new Map();
      for (const [r, v] of inputs) if (v !== TOP) fixed.set(r, v);
      let fit = fitInstruction(m, m.code, ins.pc, fn.key, srcs, fixed);
      if (fit.kind === "const") fit = fitInstruction(m, m.code, ins.pc, fn.key, srcs, new Map());
      const known = [...fixed.entries()].map(([r, v]) => `r${r}=${fmt(v)}`).join(" ");
      const body = fit.kind === "binary" ? `${R(fit.a)} ${fit.op}${fit.int32 ? "|0" : ""} ${R(fit.b)}`
        : fit.kind === "unary" ? `${fit.op || "="}${R(fit.a)}${fit.int32 ? "|0" : ""}`
        : `???op${ins.op}(${srcs.map(R).join(",")})`;
      return `${R(dest)} = ${body}   [op${ins.op} srcs=${srcs.map(R).join(",")}${known ? " known: " + known : ""}]`;
    }
    default: return `${ins.kind.kind} ${w.join(",")}`;
  }
}

const want = process.argv[2] ? Number(process.argv[2]) : null;
for (const [entry, fn] of funcs) {
  if (want !== null && entry !== want) continue;
  console.log(`\n########## function @${entry} params=${fn.desc.d} regs=${fn.desc.Q} key=${fn.key} widened=[${[...fn.widened].join(",")}]`);
  const nodes = [...fn.nodes.values()].sort((x, y) => x.pc - y.pc || x.id - y.id);
  for (const node of nodes) {
    if (!node.analyzed) continue;
    const outs = node.outcomes.map((o) => `${o.split ? `[r${o.split.reg}=${o.split.value}] ` : ""}${o.kind}${o.nodes && o.nodes.length ? "->#" + o.nodes.map((n) => n.id).join(",") : ""}`);
    console.log(`  --- node#${node.id} @${node.pc}  ==> ${outs.join(" ; ")}`);
    for (const ins of node.instrs) {
      const val = node.values.get(ins.pc);
      console.log(`      ${String(ins.pc).padStart(5)} ${describe(fn, node, ins)}${node.values.has(ins.pc) ? `      // = ${fmt(val)}` : ""}`);
    }
  }
}
