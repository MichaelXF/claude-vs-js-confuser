// Dumps a readable IR of every block, using the merged analysis (one node per block).
const M = require("./vmmodel2");
const A = require("./analyze");
const { PLAIN, fitSite } = require("./semantics");
const { CODE, decodeConst, STRUCT } = M;
const { TOP, OP, block, destOf, instrSrcs } = A;

function fmtVal(v) {
  if (v === TOP) return "?";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function") return "<fn>";
  if (typeof v === "object" && v) return "<obj>";
  return String(v);
}

function describe(ins, key, state, fa) {
  const w = ins.words;
  const p = PLAIN[ins.op];
  const dest = destOf(ins, key);
  const R = (n) => `r${n}`;
  if (p) {
    switch (p.kind) {
      case "debugger": return "debugger";
      case "trypop": return "TRY_POP";
      case "jump": return `JMP ${w[0]}`;
      case "throw": return `THROW ${R(w[0])}`;
      case "dynjump": return `DYNJMP ${R(w[0])}`;
      case "setglobal": return `global[${JSON.stringify(decodeConst(w[0], w[1]))}] = ${R(w[2])}`;
      case "loadimm": return `${R(dest)} = ${w[1]}`;
      case "loadconst": return `${R(dest)} = ${JSON.stringify(decodeConst(w[1], w[2]))}`;
      case "move": return `${R(dest)} = ${R(w[1])}`;
      case "unary": return `${R(dest)} = ${p.op}${p.op === "typeof" ? " " : ""}${R(w[1])}`;
      case "voidop": return `${R(dest)} = void ${R(w[1])}`;
      case "this": return `${R(dest)} = this`;
      case "binary": return `${R(dest)} = ${R(w[1])} ${p.op} ${R(w[2])}`;
      case "branch": return `if (${p.whenFalse ? "!" : ""}${R(w[0])}) JMP ${w[1]}`;
      case "getmember": return `${R(dest)} = ${R(w[1])}[${R(w[2])}]`;
      case "setmember": return `${R(w[0])}[${R(w[1])}] = ${R(w[2])}`;
      case "deletemember": return `${R(dest)} = delete ${R(w[1])}[${R(w[2])}]`;
      case "trycatch": return `TRY catch->${w[0]} reg=${w[1]}`;
      case "tryfinally": return `TRY finally->${w[0]} (${w[1]},${w[2]},${w[3]})`;
      case "getclosure": return `${R(dest)} = closure[${w[1]}]`;
      case "setclosure": return `closure[${w[0]}] = ${R(w[1])}`;
      case "array": return `${R(dest)} = [${w.slice(2).map(R).join(", ")}]`;
      case "object": {
        const pairs = [];
        for (let i = 2; i < w.length; i += 2) pairs.push(`${R(w[i])}: ${R(w[i + 1])}`);
        return `${R(dest)} = {${pairs.join(", ")}}`;
      }
      case "definegetter": return `defineGetter(${R(w[0])}, ${R(w[1])}, ${R(w[2])})`;
      case "definesetter": return `defineSetter(${R(w[0])}, ${R(w[1])}, ${R(w[2])})`;
      case "forininit": return `${R(dest)} = forIn(${R(w[1])})`;
      case "forinnext": return `${R(w[0])} = next(${R(w[1])}) else JMP ${w[2]}`;
      case "getglobal": return `${R(dest)} = global.${decodeConst(w[1], w[2])}`;
      case "typeofglobal": return `${R(dest)} = typeof global.${decodeConst(w[1], w[2])}`;
      case "call": {
        const args = w[2] === M.MAGIC_SPREAD ? `...${R(w[3])}` : w.slice(3).map(R).join(", ");
        return `${R(dest)} = ${R(w[1])}(${args})`;
      }
      case "mcall": {
        const args = w[3] === M.MAGIC_SPREAD ? `...${R(w[4])}` : w.slice(4).map(R).join(", ");
        return `${R(dest)} = ${R(w[2])}.call(${R(w[1])}, ${args})`;
      }
      case "new": {
        const args = w[2] === M.MAGIC_SPREAD ? `...${R(w[3])}` : w.slice(3).map(R).join(", ");
        return `${R(dest)} = new ${R(w[1])}(${args})`;
      }
      case "return": return `RETURN ${R(w[0])}`;
      case "func": return `${R(dest)} = function@${w[1]} (params=${w[2]} regs=${w[3]} closures=${w[4]} rest=${w[5]})`;
      case "decrypt": return `DECRYPT dst=${w[0]} src=${w[1]}..${w[2]}`;
      default: return `?${p.kind}`;
    }
  }
  // MBA op: fit it
  const fit = fitSite(ins, key, state, TOP);
  if (fit.kind === "const") return `${R(dest)} = <const>`;
  if (fit.kind === "binary") return `${R(dest)} = ${R(fit.a)} ${fit.op}${fit.int32 ? "|0" : ""} ${R(fit.b)}   [mba ${ins.op}]`;
  if (fit.kind === "unary") return `${R(dest)} = ${fit.op}${R(fit.a)}${fit.int32 ? "|0" : ""}   [mba ${ins.op}]`;
  return `${R(dest)} = ???op${ins.op}(${instrSrcs(ins).map(R).join(",")})`;
}

const funcs = A.analyzeProgram();
for (const [entry, fa] of funcs) {
  console.log(`\n########## function @${entry} params=${fa.desc.d} regs=${fa.desc.Q}`);
  const pcs = [...fa.staticBlocks].sort((a, b) => a - b);
  // recompute merged states for printing
  for (const pc of pcs) {
    const nodes = fa.byPc.get(pc) || [];
    const node = nodes[0];
    console.log(`  --- block ${pc}${nodes.length > 1 ? ` (x${nodes.length})` : ""} -> ${node ? node.outcomes.map((o) => `${o.split ? `[r${o.split.reg}=${o.split.value}]` : ""}${o.kind}:${o.targets.join(",")}`).join(" ; ") : "unreached"}`);
    if (!node) continue;
    for (const ins of node.instrs) {
      const val = node.values.get(ins.pc);
      const txt = describe(ins, fa.key, node.state, fa);
      console.log(`      ${String(ins.pc).padStart(5)} ${txt}${val !== undefined ? `      // = ${fmtVal(val)}` : ""}`);
    }
  }
}
