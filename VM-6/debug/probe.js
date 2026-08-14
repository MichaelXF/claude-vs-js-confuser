// debug/probe.js -- black-box probe of every opcode handler to learn its operand layout
const path = require('path');
const fs = require('fs');
const { loadVM } = require('./load');

const REGBASE = 500;
const FRAMESZ = 1400;

// build an isolated execution environment for one handler invocation
function makeEnv(L, opts = {}) {
  const words = opts.words || [];
  const bc = new Array(64).fill(0);
  for (let i = 0; i < words.length; i++) bc[i] = words[i];
  const raw = new Array(FRAMESZ).fill(undefined);
  const log = { reads: [], writes: [], calls: 0 };
  raw[0] = 0;                       // parent fp
  raw[1] = REGBASE;                 // register base
  raw[2] = 0;                       // pc
  raw[4] = opts.C === undefined ? 0 : opts.C;
  raw[6] = opts.thisVal;            // this
  raw[9] = opts.tmpl || { x: {}, l: [], prototype: {} };
  raw[10] = 0;
  raw[13] = 400;
  const regs = opts.regs || {};
  for (const k of Object.keys(regs)) raw[REGBASE + Number(k)] = regs[k];
  const frames = new Proxy(raw, {
    get(t, p) {
      if (typeof p === 'string' && /^\d+$/.test(p)) {
        const i = Number(p);
        if (i >= REGBASE) log.reads.push(i - REGBASE);
      }
      return t[p];
    },
    set(t, p, v) {
      if (typeof p === 'string' && /^\d+$/.test(p)) {
        const i = Number(p);
        if (i >= REGBASE) log.writes.push({ reg: i - REGBASE, val: v });
      }
      t[p] = v;
      return true;
    },
  });
  const inst = new L.G(bc, opts.pool || L.vm.A, opts.globals || {});
  inst.g = frames;
  inst.d = 0;
  inst.j = 400;
  inst._raw = raw;
  return { inst, raw, log, bc };
}

function probeOp(L, op, opts = {}) {
  const N = 20;
  const words = [];
  for (let i = 0; i < N; i++) words.push(opts.wordFn ? opts.wordFn(i) : 3 + i * 5);
  const regs = {};
  for (let i = 0; i < 200; i++) regs[i] = opts.regVal === undefined ? 0 : opts.regVal;
  const env = makeEnv(L, Object.assign({ words, regs }, opts));
  let err = null;
  try { L.A[op].call(env.inst); } catch (e) { err = e; }
  const consumed = env.raw[2];
  const readWords = [], writeWords = [];
  for (const r of env.log.reads) {
    const j = words.indexOf(r);
    if (j >= 0 && j < consumed) readWords.push(j);
  }
  for (const wr of env.log.writes) {
    const j = words.indexOf(wr.reg);
    if (j >= 0 && j < consumed) writeWords.push(j);
  }
  return {
    op, consumed, err: err && (err.constructor.name + ': ' + err.message),
    readWords: [...new Set(readWords)], writeWords: [...new Set(writeWords)],
    writes: env.log.writes, env,
  };
}

if (require.main === module) {
  const L = loadVM(path.join(__dirname, '..', 'input.js'));
  const ops = Object.keys(L.A).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  const out = [];
  for (const op of ops) {
    const r = probeOp(L, op, { C: 893140373 });
    out.push({ op, consumed: r.consumed, reads: r.readWords, writes: r.writeWords, err: r.err });
    console.log(`A[${op}] words=${r.consumed} regReads=[${r.readWords}] regWrites=[${r.writeWords}]` +
      (r.err ? '  ERR ' + r.err : ''));
  }
  fs.writeFileSync(path.join(__dirname, 'layout.json'), JSON.stringify(out, null, 1));
}
