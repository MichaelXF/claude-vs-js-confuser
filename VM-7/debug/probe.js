// Probes every handler: runs it against a synthetic frame and records how many
// bytecode words it eats, which registers it reads, and which register it writes.
const path = require("path");
const { load } = require("./harness");

const { exports: ex, entryCall } = load(path.join(__dirname, "..", "input.js"));
const realVM = entryCall[0];
const proto = Object.getPrototypeOf(realVM);
const OPS = Object.getOwnPropertyNames(proto).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);

const H = 4; // frame pointer
const R = 100; // register base
const FNKEY = 2207321894;

function runProbe(op, words, regs, opt = {}) {
  opt = Object.assign({ nRegs: 64 }, opt);
  const codeArr = words.slice();
  const codeReads = [];
  const codeWrites = [];
  const iProxy = new Proxy(codeArr, {
    get(t, p) {
      if (typeof p === "string" && /^\d+$/.test(p)) codeReads.push(+p);
      return t[p];
    },
    set(t, p, v) {
      if (typeof p === "string" && /^\d+$/.test(p)) codeWrites.push([+p, v]);
      t[p] = v;
      return true;
    },
  });

  const frame = [];
  frame[H + 0] = 0; // pc -> index 0 of words
  frame[H + 2] = opt.thisVal !== undefined ? opt.thisVal : "THISVAL";
  frame[H + 3] = opt.catchStack;
  frame[H + 4] = 0;
  frame[H + 6] = opt.fnObj || { j: [], prototype: {}, C: {} };
  frame[H + 7] = opt.fnKey === undefined ? FNKEY : opt.fnKey;
  frame[H + 8] = opt.args || [];
  frame[H + 9] = 13 + 64;
  frame[H + 10] = 0;
  frame[H + 11] = R;
  frame[H + 12] = 0;
  for (let j = 0; j < opt.nRegs; j++) frame[R + j] = regs ? regs[j] : 1;

  const regReads = [];
  const regWrites = [];
  const frameReads = [];
  const frameWrites = [];
  const gProxy = new Proxy(frame, {
    get(t, p) {
      if (typeof p === "string" && /^\d+$/.test(p)) {
        const n = +p;
        if (n >= R) regReads.push(n - R);
        else frameReads.push(n - H);
      }
      return t[p];
    },
    set(t, p, v) {
      if (typeof p === "string" && /^\d+$/.test(p)) {
        const n = +p;
        if (n >= R) regWrites.push([n - R, v]);
        else frameWrites.push([n - H, v]);
      }
      t[p] = v;
      return true;
    },
  });

  const vm = Object.create(proto);
  vm.i = iProxy;
  vm.g = gProxy;
  vm.h = H;
  vm.k = opt.globals || realVM.k;
  vm.b = opt.consts || realVM.b;
  vm.q = null;
  vm.p = H + 13 + 64;
  vm.r = 0;

  let error = null;
  try {
    vm[op]();
  } catch (e) {
    error = e;
  }
  const pcWrites = frameWrites.filter(([k]) => k === 0).map(([, v]) => v);
  return { codeReads, codeWrites, regReads, regWrites, frameReads, frameWrites, pcWrites, error, frame, len: codeReads.length ? Math.max(...codeReads) + 1 : 0 };
}

function seqWords(n) {
  const w = [];
  for (let j = 0; j < n; j++) w.push(j);
  return w;
}

if (require.main === module) {
  const regs = [];
  for (let j = 0; j < 64; j++) regs[j] = 1000 + j;
  const rows = [];
  for (const op of OPS) {
    const r = runProbe(op, seqWords(40), regs);
    rows.push({
      op,
      len: r.len,
      regReads: r.regReads.join(","),
      regWrites: r.regWrites.map(([k, v]) => `${k}=${typeof v === "object" ? "obj" : String(v).slice(0, 20)}`).join(" "),
      frameReads: [...new Set(r.frameReads)].join(","),
      frameWrites: r.frameWrites.map(([k, v]) => `${k}=${String(v).slice(0, 14)}`).join(" "),
      err: r.error ? String(r.error.message).slice(0, 40) : "",
    });
  }
  for (const r of rows) {
    console.log(
      `op ${String(r.op).padStart(5)} len=${String(r.len).padStart(2)} rd=[${r.regReads}] wr=[${r.regWrites}] fr=[${r.frameReads}] fw=[${r.frameWrites}] ${r.err ? "ERR:" + r.err : ""}`
    );
  }
}

module.exports = { runProbe, seqWords, OPS, proto, realVM, ex, entryCall, H, R, FNKEY };
