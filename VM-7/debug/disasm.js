// Linear disassembler: walks the bytecode from the entry point, following control
// flow, emulating the self-decrypting opcode, and discovering nested functions.
const path = require("path");
const { runProbe, seqWords, OPS, proto, realVM, ex, entryCall, H, R } = require("./probe");

// ---- fixed instruction lengths, measured by probing ----
const LEN = {};
{
  const regs = [];
  for (let j = 0; j < 64; j++) regs[j] = 1000 + j;
  for (const op of OPS) LEN[op] = runProbe(op, seqWords(40), regs).len;
}

const MAGIC_SPREAD = 1329987534;

// variable-length opcodes
const VARLEN = {
  46215: (w) => 2 + w[1], // array literal: dest, count, elems...
  20969: (w) => 2 + 2 * w[1], // object literal: dest, count, (k,v)...
  34577: (w) => 7 + 2 * w[4], // function def
  41417: (w) => 3 + (w[2] === MAGIC_SPREAD ? 1 : w[2]), // call
  42977: (w) => 4 + (w[3] === MAGIC_SPREAD ? 1 : w[3]), // method call
  48258: (w) => 3 + (w[2] === MAGIC_SPREAD ? 1 : w[2]), // new
};

function instrLen(code, pc) {
  const op = code[pc];
  const w = [];
  for (let j = 1; j <= 40; j++) w.push(code[pc + j]);
  if (VARLEN[op]) return 1 + VARLEN[op](w);
  if (LEN[op] === undefined) throw new Error("unknown opcode " + op + " @" + pc);
  return 1 + LEN[op];
}

// ---- control-flow classification ----
const OP_JMP = 31145; // pc = imm
const OP_JMP_IF_FALSE = 223; // if (!reg) pc = imm
const OP_JMP_IF_TRUE = 51943; // if (reg) pc = imm
const OP_JMP_REG = 47933; // pc = reg  (dispatcher)
const OP_RET = 37176;
const OP_THROW = 31178;
const OP_DECRYPT = 5170;
const OP_FUNC = 34577;
const OP_TRY_CATCH = 18114; // push {D: catchPc, u: catchReg}
const OP_TRY_FIN = 32278; // push {s,G,z,B}
const OP_POP_TRY = 29585;
const OP_FORIN_NEXT = 46118; // dest, iterReg, doneTarget

function decrypt(code, pc) {
  const a = code[pc + 1], e = code[pc + 2], h = code[pc + 3];
  let c = (code[pc + 4] ^ a) | 0;
  const out = [];
  for (let b = e; b < h; b++) {
    c = (c + 2654435769) | 0;
    out.push(((code[b] ^ c ^ (c >>> 13)) >>> 0));
  }
  for (let j = 0; j < out.length; j++) code[a + j] = out[j];
  return { dst: a, from: e, to: h, count: out.length };
}

function funcKey(w, parentKey) {
  // op 34577: n = imul(w6,1123873253) ^ imul(w1^w3,601502569) ^ imul(w2+w4+w5,1217387604) ^ parentKey
  const b = w[1], d = w[2], f = w[3], k = w[4], l = w[5], seed = w[6];
  return (Math.imul(seed, 1123873253) ^ Math.imul(b ^ f, 601502569) ^ Math.imul(d + k + l, 1217387604) ^ parentKey) | 0;
}

function disassemble() {
  const vm = entryCall[0];
  const code = Array.from(vm.i);
  const entryFn = entryCall[1].C; // {d, Q, m, x}
  const funcs = new Map(); // entryPc -> {key, desc, blocks}
  const instrs = new Map(); // pc -> {op, words, len, fnEntry}
  const decrypts = [];

  const queue = [{ pc: entryFn.m, key: entryFn.x | 0, fn: entryFn.m }];
  funcs.set(entryFn.m, { key: entryFn.x | 0, desc: entryFn, pcs: [] });
  const seen = new Set();

  while (queue.length) {
    const { pc, key, fn } = queue.shift();
    if (pc >= code.length) continue;
    const tag = fn + ":" + pc;
    if (seen.has(tag)) continue;
    seen.add(tag);

    const op = code[pc];
    let len;
    try {
      len = instrLen(code, pc);
    } catch (e) {
      console.error("STOP", e.message, "fn", fn);
      continue;
    }
    const words = code.slice(pc + 1, pc + len);
    const rec = { pc, op, words, len, fn };
    if (instrs.has(pc) && instrs.get(pc).op !== op) console.error("!! conflicting decode at", pc);
    instrs.set(pc, rec);
    funcs.get(fn).pcs.push(pc);

    const next = pc + len;
    switch (op) {
      case OP_JMP:
        queue.push({ pc: words[0], key, fn });
        break;
      case OP_JMP_IF_FALSE:
      case OP_JMP_IF_TRUE:
        queue.push({ pc: words[1], key, fn });
        queue.push({ pc: next, key, fn });
        break;
      case OP_RET:
      case OP_THROW:
        break;
      case OP_JMP_REG:
        rec.dynamic = true;
        break;
      case OP_FORIN_NEXT:
        queue.push({ pc: words[2], key, fn });
        queue.push({ pc: next, key, fn });
        break;
      case OP_TRY_CATCH:
        queue.push({ pc: words[0], key, fn });
        queue.push({ pc: next, key, fn });
        break;
      case OP_TRY_FIN:
        queue.push({ pc: words[0], key, fn });
        queue.push({ pc: next, key, fn });
        break;
      case OP_DECRYPT: {
        const info = decrypt(code, pc);
        decrypts.push({ pc, ...info, fn });
        queue.push({ pc: next, key, fn });
        break;
      }
      case OP_FUNC: {
        const child = words[1];
        const ck = funcKey(words, key);
        if (!funcs.has(child)) {
          funcs.set(child, { key: ck, desc: { m: child, d: words[2], Q: words[3], F: words[5], x: ck }, pcs: [], parent: fn });
          queue.push({ pc: child, key: ck, fn: child });
        }
        queue.push({ pc: next, key, fn });
        break;
      }
      default:
        queue.push({ pc: next, key, fn });
    }
  }
  return { code, instrs, funcs, decrypts };
}

module.exports = { disassemble, LEN, VARLEN, instrLen, funcKey, MAGIC_SPREAD, OP_JMP, OP_JMP_IF_FALSE, OP_JMP_IF_TRUE, OP_JMP_REG, OP_RET, OP_THROW, OP_DECRYPT, OP_FUNC, OP_TRY_CATCH, OP_TRY_FIN, OP_POP_TRY, OP_FORIN_NEXT };

if (require.main === module) {
  const { code, instrs, funcs, decrypts } = disassemble();
  console.log("code len", code.length, "decoded instrs", instrs.size, "funcs", funcs.size);
  console.log("decrypt ops:", decrypts.length);
  for (const d of decrypts) console.log("  decrypt @" + d.pc, "dst", d.dst, "src", d.from + ".." + d.to, "n", d.count, "fn", d.fn);
  console.log("functions:", [...funcs.entries()].map(([k, v]) => `${k}(key=${v.key},Q=${v.desc.Q},d=${v.desc.d},n=${v.pcs.length})`).join(" "));
  const covered = new Set();
  for (const [pc, r] of instrs) for (let j = 0; j < r.len; j++) covered.add(pc + j);
  console.log("coverage", covered.size, "/", code.length);
  const gaps = [];
  let start = null;
  for (let j = 0; j < code.length; j++) {
    if (!covered.has(j)) { if (start === null) start = j; }
    else if (start !== null) { gaps.push([start, j - 1]); start = null; }
  }
  if (start !== null) gaps.push([start, code.length - 1]);
  console.log("gaps:", gaps.map((g) => g[0] + ".." + g[1]).join(" "));
  const dyn = [...instrs.values()].filter((r) => r.dynamic);
  console.log("dynamic jumps:", dyn.map((r) => r.pc).join(" "));
}
