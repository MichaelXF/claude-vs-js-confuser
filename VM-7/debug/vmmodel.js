// Core model of the VM: instruction structure, concolic evaluation, operator fitting.
const path = require("path");
const { load } = require("./harness");

const { exports: ex, entryCall } = load(path.join(__dirname, "..", "input.js"));
const realVM = entryCall[0];
const proto = Object.getPrototypeOf(realVM);
const OPS = Object.getOwnPropertyNames(proto).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
const CODE = Array.from(realVM.i);
const CONSTS = realVM.b;
const GLOBALS = realVM.k;

const H = 4;
const R = 200;
const NREG = 128;

function runInstr(op, words, key, regs, opt = {}) {
  const codeArr = new Array(words.length + 8).fill(0);
  for (let j = 0; j < words.length; j++) codeArr[j] = words[j];
  const codeReads = [];
  const iProxy = new Proxy(codeArr, {
    get(t, p) {
      if (typeof p === "string" && /^\d+$/.test(p)) codeReads.push(+p);
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  const frame = [];
  frame[H + 0] = 0;
  frame[H + 2] = opt.thisVal;
  frame[H + 3] = opt.catchStack;
  frame[H + 4] = 0;
  frame[H + 6] = opt.fnObj || { j: [], prototype: {}, C: {} };
  frame[H + 7] = key | 0;
  frame[H + 8] = opt.args || [];
  frame[H + 9] = 13 + NREG;
  frame[H + 10] = 0;
  frame[H + 11] = R;
  frame[H + 12] = 0;
  for (let j = 0; j < NREG; j++) frame[R + j] = regs ? regs[j] : undefined;

  const regReads = [];
  const regWrites = [];
  const frameWrites = [];
  const gProxy = new Proxy(frame, {
    get(t, p) {
      if (typeof p === "string" && /^\d+$/.test(p)) { const n = +p; if (n >= R) regReads.push(n - R); }
      return t[p];
    },
    set(t, p, v) {
      if (typeof p === "string" && /^\d+$/.test(p)) { const n = +p; if (n >= R) regWrites.push([n - R, v]); else frameWrites.push([n - H, v]); }
      t[p] = v;
      return true;
    },
  });
  const vm = Object.create(proto);
  vm.i = iProxy;
  vm.g = gProxy;
  vm.h = H;
  vm.k = opt.globals || GLOBALS;
  vm.b = opt.consts || CONSTS;
  vm.q = null;
  vm.p = H + 13 + NREG;
  vm.r = 0;
  let error = null;
  try { vm[op](); } catch (e) { error = e; }
  return {
    codeReads, regReads, regWrites, frameWrites,
    pcWrite: frameWrites.filter(([k]) => k === 0).map(([, v]) => v).pop(),
    error,
    len: codeReads.length,
  };
}

// ---- static per-opcode structure (which operand slots index registers) ----
const STRUCT = {};
{
  const probeRegs = [];
  for (let j = 0; j < NREG; j++) probeRegs[j] = 1000 + j;
  const words = [];
  for (let j = 0; j < 48; j++) words.push(j);
  for (const op of OPS) {
    const res = runInstr(op, words, 0, probeRegs);
    const regSlots = [...new Set(res.regReads)].filter((s) => s < 48);
    STRUCT[op] = { len: res.len, regSlots, writes: res.regWrites.length > 0 };
  }
}

// ---- constant pool decoding (mirrors function y) ----
function b64(s) { return Buffer.from(s, "base64"); }
function decodeConst(idx, keyWord) {
  let e = CONSTS[idx];
  if (!keyWord) return e;
  if (typeof e === "number") return e ^ keyWord;
  if (typeof e !== "string") return e;
  const buf = b64(e);
  let h = keyWord >>> 0;
  let out = "";
  for (let i = 0; i < buf.length / 2; i++) {
    h = (h + 2654435769) | 0;
    out += String.fromCharCode((buf[i * 2] | (buf[i * 2 + 1] << 8)) ^ ((h ^ (h >>> 13)) & 65535));
  }
  return out;
}

function funcKey(w, parentKey) {
  return (Math.imul(w[6], 1123873253) ^ Math.imul(w[1] ^ w[3], 601502569) ^ Math.imul(w[2] + w[4] + w[5], 1217387604) ^ parentKey) | 0;
}

// ---- instruction length ----
const MAGIC_SPREAD = 1329987534;
const VARLEN = {
  46215: (w) => 2 + w[1],
  20969: (w) => 2 + 2 * w[1],
  34577: (w) => 7 + 2 * w[4],
  41417: (w) => 3 + (w[2] === MAGIC_SPREAD ? 1 : w[2]),
  42977: (w) => 4 + (w[3] === MAGIC_SPREAD ? 1 : w[3]),
  48258: (w) => 3 + (w[2] === MAGIC_SPREAD ? 1 : w[2]),
};
function instrLen(code, pc) {
  const op = code[pc];
  if (VARLEN[op]) return 1 + VARLEN[op](code.slice(pc + 1, pc + 42));
  if (!STRUCT[op]) throw new Error("unknown opcode " + op + " @" + pc);
  return 1 + STRUCT[op].len;
}

function sweep(code) {
  const list = [];
  let pc = 0;
  while (pc < code.length) {
    const len = instrLen(code, pc);
    list.push({ pc, op: code[pc], words: code.slice(pc + 1, pc + len), len });
    pc += len;
  }
  return list;
}

module.exports = {
  ex, entryCall, realVM, proto, OPS, CODE, CONSTS, GLOBALS, H, R, NREG,
  runInstr, STRUCT, decodeConst, funcKey, instrLen, sweep, MAGIC_SPREAD, VARLEN,
};
