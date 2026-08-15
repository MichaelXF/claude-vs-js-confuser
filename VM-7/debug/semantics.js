// Per-opcode semantics: hand-read for the plain handlers, fitted for the MBA ones.
const M = require("./vmmodel2");
const { CODE, sweep, STRUCT, runAt, NREG, decodeConst } = M;

// ---- opcodes whose handler source is plain enough to read directly ----
// kind describes how to build IR; `w` = operand words, `s(i)` = words[i] as register
const PLAIN = {
  44744: { kind: "debugger" },
  29585: { kind: "trypop" },
  31145: { kind: "jump" },
  31178: { kind: "throw", reg: 0 },
  47933: { kind: "dynjump", reg: 0 },
  47933.1: null,
  14166: { kind: "setglobal", nameConst: [0, 1], val: 2 },
  39896: { kind: "loadimm", dest: 0, imm: 1 },
  3501: { kind: "loadconst", dest: 0, constIdx: 1, constKey: 2 },
  19461: { kind: "move", dest: 0, src: 1 },
  45888: { kind: "unary", op: "+", dest: 0, src: 1 },
  12149: { kind: "unary", op: "!", dest: 0, src: 1 },
  16504: { kind: "unary", op: "~", dest: 0, src: 1 },
  50146: { kind: "unary", op: "-", dest: 0, src: 1 },
  21415: { kind: "unary", op: "typeof", dest: 0, src: 1 },
  63862: { kind: "voidop", dest: 0, src: 1 },
  40602: { kind: "this", dest: 0 },
  6548: { kind: "binary", op: "+", dest: 0, a: 1, b: 2 },
  22273: { kind: "binary", op: "-", dest: 0, a: 1, b: 2 },
  24492: { kind: "binary", op: "*", dest: 0, a: 1, b: 2 },
  26926: { kind: "binary", op: "/", dest: 0, a: 1, b: 2 },
  9164: { kind: "binary", op: "%", dest: 0, a: 1, b: 2 },
  4969: { kind: "binary", op: "**", dest: 0, a: 1, b: 2 },
  39540: { kind: "binary", op: "&", dest: 0, a: 1, b: 2 },
  47762: { kind: "binary", op: "|", dest: 0, a: 1, b: 2 },
  36699: { kind: "binary", op: "^", dest: 0, a: 1, b: 2 },
  56680: { kind: "binary", op: "<<", dest: 0, a: 1, b: 2 },
  28171: { kind: "binary", op: ">>", dest: 0, a: 1, b: 2 },
  49537: { kind: "binary", op: ">>>", dest: 0, a: 1, b: 2 },
  55744: { kind: "binary", op: "<", dest: 0, a: 1, b: 2 },
  14822: { kind: "binary", op: ">", dest: 0, a: 1, b: 2 },
  26487: { kind: "binary", op: "<=", dest: 0, a: 1, b: 2 },
  58658: { kind: "binary", op: ">=", dest: 0, a: 1, b: 2 },
  48837: { kind: "binary", op: "==", dest: 0, a: 1, b: 2 },
  30837: { kind: "binary", op: "!=", dest: 0, a: 1, b: 2 },
  27901: { kind: "binary", op: "===", dest: 0, a: 1, b: 2 },
  12213: { kind: "binary", op: "!==", dest: 0, a: 1, b: 2 },
  23847: { kind: "binary", op: "in", dest: 0, a: 1, b: 2 },
  36092: { kind: "binary", op: "instanceof", dest: 0, a: 1, b: 2 },
  223: { kind: "branch", reg: 0, target: 1, whenFalse: true },
  51943: { kind: "branch", reg: 0, target: 1, whenFalse: false },
  37457: { kind: "getmember", dest: 0, obj: 1, prop: 2 },
  63716: { kind: "setmember", obj: 0, prop: 1, val: 2 },
  17515: { kind: "deletemember", dest: 0, obj: 1, prop: 2 },
  18114: { kind: "trycatch", catchPc: 0, catchReg: 1 },
  32278: { kind: "tryfinally", s: 0, G: 1, z: 2, B: 3 },
  7574: { kind: "getclosure", dest: 0, idx: 1 },
  56439: { kind: "setclosure", idx: 0, val: 1 },
  46215: { kind: "array", dest: 0, count: 1 },
  20969: { kind: "object", dest: 0, count: 1 },
  21434: { kind: "definegetter", obj: 0, prop: 1, fn: 2 },
  25878: { kind: "definesetter", obj: 0, prop: 1, fn: 2 },
  3291: { kind: "forininit", dest: 0, obj: 1 },
  46118: { kind: "forinnext", dest: 0, iter: 1, doneTarget: 2 },
  51395: { kind: "getglobal", dest: 0, constIdx: 1, constKey: 2 },
  64259: { kind: "typeofglobal", dest: 0, constIdx: 1, constKey: 2 },
  41417: { kind: "call", dest: 0, fn: 1, argc: 2 },
  42977: { kind: "mcall", dest: 0, obj: 1, fn: 2, argc: 3 },
  48258: { kind: "new", dest: 0, fn: 1, argc: 2 },
  37176: { kind: "return", reg: 0 },
  34577: { kind: "func", dest: 0 },
  5170: { kind: "decrypt" },
};

// ---- fitting for MBA opcodes ----
const BIN = {
  "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => a / b, "%": (a, b) => a % b,
  "&": (a, b) => a & b, "|": (a, b) => a | b, "^": (a, b) => a ^ b,
  "<<": (a, b) => a << b, ">>": (a, b) => a >> b, ">>>": (a, b) => a >>> b,
  "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b,
  "==": (a, b) => a == b, "!=": (a, b) => a != b, "===": (a, b) => a === b, "!==": (a, b) => a !== b,
};
const UN = { "-": (a) => -a, "~": (a) => ~a, "!": (a) => !a, "+": (a) => +a };
// order matters: prefer the simplest/most likely reading
const BIN_PRIORITY = ["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>", "<", "<=", ">", ">=", "===", "==", "!==", "!=", "instanceof", "in"];

function gen(kind) {
  switch (kind) {
    case 0: return () => ((Math.random() * 200 - 100) | 0);
    case 1: return () => (((Math.random() * 2 ** 32) | 0) & ~15) | 9;
    case 2: return () => [0, 1, -1, 2, 3, 7, 8, 16, 255, -256, 2147483647, -2147483648][(Math.random() * 12) | 0];
    default: return () => ((Math.random() * 2 ** 31) | 0);
  }
}

// Fits the operator implemented by an MBA opcode at one instruction site.
// `state` supplies concrete values for registers that are known there.
function fitSite(ins, key, state, TOP) {
  const srcs = [...new Set(STRUCT[ins.op].regSlots.map((s) => ins.words[s]))];
  const unknown = srcs.filter((r) => !state || state[r] === TOP);
  if (!unknown.length) return { kind: "const" };
  const trials = [];
  for (let t = 0; t < 200; t++) {
    const g = gen(t % 4);
    const regs = new Array(NREG).fill(0);
    for (let j = 0; j < NREG; j++) if (state && state[j] !== TOP && typeof state[j] !== "object" && typeof state[j] !== "function") regs[j] = state[j];
    const inputs = {};
    for (const r of unknown) { const v = g(); regs[r] = v; inputs[r] = v; }
    if (t % 5 === 0 && unknown.length > 1) { const v = g(); for (const r of unknown) { regs[r] = v; inputs[r] = v; } }
    for (const r of srcs) if (!(r in inputs)) inputs[r] = regs[r];
    const res = runAt(CODE, ins.pc, key, regs, {});
    if (res.error || !res.regWrites.length) return { kind: "unknown", reason: "err" };
    trials.push({ inputs, out: res.regWrites[res.regWrites.length - 1][1] });
  }
  const matches = [];
  for (const a of srcs) for (const [name, f] of Object.entries(UN)) {
    if (trials.every((t) => Object.is(f(t.inputs[a]), t.out))) matches.push({ kind: "unary", op: name, a });
  }
  for (const a of srcs) for (const b of srcs) {
    if (a === b) continue;
    for (const [name, f] of Object.entries(BIN)) {
      if (trials.every((t) => Object.is(f(t.inputs[a], t.inputs[b]), t.out))) matches.push({ kind: "binary", op: name, a, b });
    }
  }
  // int32-truncated variants (MBA implementations of numeric ops)
  for (const a of srcs) for (const b of srcs) {
    if (a === b) continue;
    for (const [name, f] of Object.entries(BIN)) {
      if (["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(name)) continue;
      if (trials.every((t) => Object.is(f(t.inputs[a], t.inputs[b]) | 0, t.out))) matches.push({ kind: "binary", op: name, a, b, int32: true });
    }
  }
  for (const a of srcs) for (const [name, f] of Object.entries(UN)) {
    if (name === "!") continue;
    if (trials.every((t) => Object.is(f(t.inputs[a]) | 0, t.out))) matches.push({ kind: "unary", op: name, a, int32: true });
  }
  if (!matches.length) return { kind: "unknown", srcs, unknown };
  matches.sort((x, y) => {
    const px = (x.kind === "unary" ? 0 : 1) * 100 + BIN_PRIORITY.indexOf(x.op) + (x.int32 ? 50 : 0);
    const py = (y.kind === "unary" ? 0 : 1) * 100 + BIN_PRIORITY.indexOf(y.op) + (y.int32 ? 50 : 0);
    return px - py;
  });
  return { ...matches[0], all: matches };
}

module.exports = { PLAIN, fitSite };
