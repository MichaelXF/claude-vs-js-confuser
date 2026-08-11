// debug-classify.js - probe every handler and dump what the interpreter learned.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const { locateVM, runHandler, isM, mk, MAGIC, STRIDE } = require("./vm.js");

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });
const vm = locateVM(ast);

// --- find the frame slot that holds the register base
const counts = new Map();
for (const [op, fn] of vm.handlers) {
  const st = runHandler(vm, fn, {
    operand: (n) => 100 + n,
    regValue: (i) => ({ __r: i }),
    frameValue: (slot) => MAGIC + slot * STRIDE,
  });
  for (const e of st.events) if (e.t === "regread") counts.set(e.base, (counts.get(e.base) || 0) + 1);
}
const regBaseSlot = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log("register-base frame slot =", regBaseSlot, "(counts:", [...counts.entries()].join(" "), ")");

// --- structural probe
function show(v, d = 0) {
  if (d > 6) return "…";
  if (isM(v)) {
    const i = mk(v);
    switch (i.kind) {
      case "reg": return "r" + i.i;
      case "frame": return "frame[" + i.slot + "]";
      case "const": return `K(${i.index},${i.key})`;
      case "bin": return `(${show(i.l, d + 1)} ${i.op} ${show(i.r, d + 1)})`;
      case "un": return `${i.op}(${show(i.a, d + 1)})`;
      case "logic": return `(${show(i.l, d + 1)} ${i.op} ${show(i.r, d + 1)})`;
      case "cond": return `(? ${show(i.cons, d + 1)} : ${show(i.alt, d + 1)})`;
      case "member": return `${show(i.obj, d + 1)}[${show(i.prop, d + 1)}]`;
      case "invoke": return `${show(i.obj, d + 1)}.${i.key}(${i.args.map((a) => show(a, d + 1)).join(",")})`;
      case "callres": return `${i.name}(${i.args.map((a) => show(a, d + 1)).join(",")})`;
      case "instance": return `new ${i.name}(${i.args.map((a) => show(a, d + 1)).join(",")})`;
      case "vmfield": return "vm." + i.name;
      case "vmself": return "vm";
      case "native": return `${i.objName}.${i.key}(${i.args.map((a) => show(a, d + 1)).join(",")})`;
      case "delete": return `delete ${show(i.obj, d + 1)}[${show(i.key, d + 1)}]`;
      case "func": return "<fn>";
      case "opaque": return "?";
      case "free": return i.name;
      case "bytecode": return "vm.code";
      case "pool": return "vm.pool";
      case "stackref": return "stack[?]";
      default: return i.kind;
    }
  }
  if (Array.isArray(v)) return "[" + v.map((e) => show(e, d + 1)).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).map((k) => k + ":" + show(v[k], d + 1)).join(",") + "}";
  return String(v);
}
function showEff(e, ind = "  ") {
  switch (e.t) {
    case "setreg": return `${ind}r${e.i} = ${show(e.v)}`;
    case "setpc": return `${ind}PC = ${show(e.v)}`;
    case "setframe": return `${ind}frame[${e.slot}] = ${show(e.v)}`;
    case "setstack": return `${ind}stack[${show(e.idx)}] = ${show(e.v)}`;
    case "setvm": return `${ind}vm.${e.field} = ${show(e.v)}`;
    case "setmember": return `${ind}${show(e.obj)}[${show(e.key)}] = ${show(e.v)}`;
    case "call": return `${ind}${e.name}(${e.args.map((a) => show(a)).join(",")})`;
    case "invoke": return `${ind}${show(e.obj)}.${e.key}(${e.args.map((a) => show(a)).join(",")})`;
    case "new": return `${ind}new ${e.name}(${e.args.map((a) => show(a)).join(",")})`;
    case "throw": return `${ind}throw ${show(e.v)}`;
    case "if":
      return (
        `${ind}if (${e.test ? show(e.test) : "?"}) {\n` +
        e.then.map((x) => showEff(x, ind + "  ")).join("\n") +
        (e.else && e.else.length ? `\n${ind}} else {\n` + e.else.map((x) => showEff(x, ind + "  ")).join("\n") : "") +
        `\n${ind}}`
      );
    default: return ind + JSON.stringify(e.t);
  }
}

const cfg = (operand) => ({
  operand,
  regValue: (i) => require("./vm.js").M("reg", { i }),
  frameValue: (slot) => (slot === regBaseSlot ? MAGIC + slot * STRIDE : require("./vm.js").M("frame", { slot })),
});

const out = [];
const varLen = [];
for (const op of [...vm.handlers.keys()].sort((a, b) => a - b)) {
  const fn = vm.handlers.get(op);
  const a = runHandler(vm, fn, cfg((n) => 100 + n));
  const b = runHandler(vm, fn, cfg((n) => 200 + n));
  const vl = a.nops !== b.nops;
  let countSlot = null;
  let group = 0;
  if (vl) {
    group = (b.nops - a.nops) / 100;
    for (let s = 0; s < Math.min(a.nops, 10); s++) {
      const c = runHandler(vm, fn, cfg((n) => (n === s ? 2 : 100 + n)));
      if (c.nops === a.nops - group * (100 + s) + group * 2) {
        countSlot = s;
        break;
      }
    }
    varLen.push({ op, n1: a.nops, group, countSlot });
  }
  const st = vl ? runHandler(vm, fn, cfg((n) => (n === countSlot ? 2 : 100 + n))) : a;
  out.push(
    `// ===== op ${op}  nops=${vl ? "VAR(" + a.nops + "/" + b.nops + ")" : a.nops}` +
      (st.bail ? `  BAIL:${st.bail}` : "") +
      ` =====\n` +
      st.effects.map((e) => showEff(e)).join("\n")
  );
}
fs.writeFileSync(path.join(__dirname, "debug-classify.txt"), out.join("\n\n"));
console.log("variable-length opcodes:", JSON.stringify(varLen));
console.log("wrote debug-classify.txt");
