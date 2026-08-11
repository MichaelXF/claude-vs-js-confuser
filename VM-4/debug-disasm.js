// debug-disasm.js - dump a human-readable disassembly of the recovered bytecode.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const V = require("./vm.js");

const file = process.argv[2] || "input.js";
const src = fs.readFileSync(path.join(__dirname, file), "utf8");
const ast = parser.parse(src, { sourceType: "script" });
const vm = V.locateVM(ast);
vm.regBaseSlot = V.findRegBaseSlot(vm);
const pool = vm.pool.map(V.poolValue);

const descs = new Map();
for (const op of vm.handlers.keys()) descs.set(op, V.classify(vm, V.probeStructure(vm, op)));

const funcs = V.disassemble(vm, descs);
console.log("functions:", funcs.size);

const K = (v) => {
  const c = V.decodeConst(pool, v.index, v.key);
  return JSON.stringify(c.v);
};
const S = (v) => {
  if (!v) return "?";
  if (v.k === "reg") return "r" + v.i;
  if (v.k === "imm") return String(v.v | 0 === v.v ? v.v : v.v);
  if (v.k === "const") return K(v);
  if (v.k === "this") return "this";
  return "?";
};

const out = [];
for (const f of [...funcs.values()].sort((a, b) => a.entry - b.entry)) {
  out.push(`\n===== fn#${f.id} @${f.entry}  params=${f.params} regs=${f.regs} rest=${f.rest} =====`);
  for (const pc of f.order) {
    const i = f.instrs.get(pc);
    const d = i.desc;
    const o = i.ops;
    const dst = d.dst ? "r" + V.regIdx(d.dst, o) + " = " : "";
    let text;
    switch (d.kind) {
      case "BIN": text = `${dst}${S(V.value(d.srcs[0], o))} ${d.operator} ${S(V.value(d.srcs[1], o))}`; break;
      case "UN": text = `${dst}${d.operator} ${S(V.value(d.srcs[0], o))}`; break;
      case "MOV": text = `${dst}${S(V.value(d.src, o))}`; break;
      case "LOAD_IMM": text = `${dst}${S(V.value(d.src, o))}`; break;
      case "LOAD_CONST": text = `${dst}${S(V.value(d.src, o))}`; break;
      case "LOAD_THIS": text = `${dst}this`; break;
      case "GET_GLOBAL": text = `${dst}global[${S(V.value(d.name, o))}]`; break;
      case "SET_GLOBAL": text = `global[${S(V.value(d.name, o))}] = ${S(V.value(d.value, o))}`; break;
      case "TYPEOF_GLOBAL": text = `${dst}typeof global[${S(V.value(d.name, o))}]`; break;
      case "GET_PROP": text = `${dst}${S(V.value(d.obj, o))}[${S(V.value(d.key, o))}]`; break;
      case "SET_PROP": text = `${S(V.value(d.obj, o))}[${S(V.value(d.key, o))}] = ${S(V.value(d.value, o))}`; break;
      case "DEL_PROP": text = `${dst}delete ${S(V.value(d.obj, o))}[${S(V.value(d.key, o))}]`; break;
      case "JMP": text = `jmp ${S(V.value(d.target, o))}`; break;
      case "JMP_TRUE": text = `if ${S(V.value(d.src, o))} jmp ${S(V.value(d.target, o))}`; break;
      case "JMP_FALSE": text = `ifnot ${S(V.value(d.src, o))} jmp ${S(V.value(d.target, o))}`; break;
      case "JMP_REG": text = `jmp *r${V.regIdx(d.target, o)}  -> [${(i.targets || []).join(",")}]`; break;
      case "RET": text = `return ${S(V.value(d.src, o))}`; break;
      case "THROW": text = `throw ${S(V.value(d.src, o))}`; break;
      case "CALL": {
        const args = argList(d, o);
        text = `${dst}${S(V.value(d.callee, o))}(${args})`;
        break;
      }
      case "METHOD_CALL": {
        const args = argList(d, o);
        text = `${dst}${S(V.value(d.thisArg, o))}.${S(V.value(d.callee, o))}(${args})`;
        break;
      }
      case "NEW": {
        const args = argList(d, o);
        text = `${dst}new ${S(V.value(d.callee, o))}(${args})`;
        break;
      }
      case "ARRAY": text = `${dst}[${varRegs(d, o, 1).join(", ")}]`; break;
      case "OBJECT": {
        const rs = varRegs(d, o, 2);
        const ps = [];
        for (let j = 0; j < rs.length; j += 2) ps.push(`${rs[j]}: ${rs[j + 1]}`);
        text = `${dst}{${ps.join(", ")}}`;
        break;
      }
      case "MAKE_FN": {
        const s = d.spec;
        const ep = Object.keys(s).find((k) => k !== vm.specProps.regs && k !== vm.specProps.params && k !== vm.specProps.rest);
        const n = o[s[vm.specProps.regs === undefined ? "o" : vm.specProps.regs]];
        const ups = [];
        for (let j = d.fixed; j < o.length; j += 2) ups.push((o[j] ? "local r" : "up ") + o[j + 1]);
        text = `${dst}function@${o[s[ep]]} (params=${o[s[vm.specProps.params]]} regs=${n} rest=${o[s[vm.specProps.rest]]}) [${ups.join(", ")}]`;
        break;
      }
      case "GET_UPVAL": text = `${dst}upval[${d.index.slot === undefined ? d.index.fixed : o[d.index.slot]}]`; break;
      case "SET_UPVAL": text = `upval[${d.index.slot === undefined ? d.index.fixed : o[d.index.slot]}] = ${S(V.value(d.value, o))}`; break;
      case "FORIN_INIT": text = `${dst}forin_init ${S(V.value(d.src, o))}`; break;
      case "FORIN_NEXT": text = `${dst}forin_next ${S(V.value(d.src, o))} else jmp ${S(V.value(d.target, o))}`; break;
      case "TRY_CATCH": text = `try_catch -> ${S(V.value(d.target, o))} exc r${V.value(d.reg, o).v}`; break;
      case "TRY_FINALLY": text = `try_finally -> ${S(V.value(d.target, o))} flag r${V.value(d.flagReg, o).v}=${V.value(d.flagVal, o).v} exc r${V.value(d.excReg, o).v}`; break;
      case "TRY_POP": text = `try_pop`; break;
      case "DEF_GETTER": text = `defineGetter ${S(V.value(d.obj, o))}[${S(V.value(d.key, o))}] = ${S(V.value(d.value, o))}`; break;
      case "DEF_SETTER": text = `defineSetter ${S(V.value(d.obj, o))}[${S(V.value(d.key, o))}] = ${S(V.value(d.value, o))}`; break;
      case "ARITH": {
        const fit = V.fitInstr(vm, d, f.regs, o);
        let body;
        if (!fit) body = null;
        else if (fit.arity === 3)
          body = fit.shape === "left"
            ? `(${S(fit.a)} ${fit.operator} ${S(fit.b)}) ${fit.operator2} ${S(fit.c)}`
            : `${S(fit.a)} ${fit.operator} (${S(fit.b)} ${fit.operator2} ${S(fit.c)})`;
        else if (fit.arity === 2) body = `${S(fit.a)} ${fit.operator} ${S(fit.b)}`;
        else if (fit.arity === 1) body = `${fit.operator || ""}${S(fit.a)}`;
        else body = String(fit.constant);
        text = body === null ? `${dst}ARITH?? ops=[${o.join(",")}]` : `${dst}${body}${fit.int32 ? " |0" : ""}`;
        break;
      }
      default: text = `${d.kind} ops=[${o.join(",")}]`;
    }
    out.push(`${String(pc).padStart(5)}: ${text}`);
  }
}

function varRegs(d, o, group) {
  const res = [];
  for (let j = d.fixed; j < o.length; j++) res.push("r" + o[j]);
  return res;
}
function argList(d, o) {
  const count = o[d.countSlot];
  if (d.spread != null && count === d.spread) return "..." + "r" + o[d.fixed];
  return varRegs(d, o).join(", ");
}

fs.writeFileSync(path.join(__dirname, "debug-disasm.txt"), out.join("\n"));
console.log("wrote debug-disasm.txt");
