// debug/analyze.js -- full analysis: functions, instructions, fitted semantics
const fs = require('fs');
const path = require('path');
const { loadVM } = require('./load');
const { buildOpTable, fitSite, makeEnv } = require('./ops');

const SPREAD = 2329202881;

const LAYOUT = {
  LOADTHIS: ['dst'],
  LOADCONST: ['dst', 'pool', 'key'],
  LOADCELL: ['dst', 'cell'],
  STORECELL: ['cell', 'src'],
  LOADGLOBAL: ['dst', 'pool', 'key'],
  TYPEOFGLOBAL: ['dst', 'pool', 'key'],
  STOREGLOBAL: ['pool', 'key', 'src'],
  SETMEMBER: ['obj', 'key', 'val'],
  DELETE: ['dst', 'obj', 'key'],
  DEFGET: ['obj', 'key', 'fn'],
  DEFSET: ['obj', 'key', 'fn'],
  RETURN: ['src'],
  THROW: ['src'],
  JMP: ['target'],
  JMPIF: ['cond', 'target'],
  JMPIFNOT: ['cond', 'target'],
  JMPDYN: ['reg'],
  TRYCATCH: ['catchPC', 'catchReg'],
  TRYFIN: ['finPC', 'typeReg', 'valReg', 'marker'],
  POPTRY: [],
  DEBUGGER: [],
  FORIN_INIT: ['dst', 'obj'],
  FORIN_NEXT: ['dst', 'iter', 'doneTarget'],
  DECRYPT: ['dst', 'from', 'to', 'key'],
};

function decode(T, code, pc) {
  const op = code[pc];
  const info = T[op];
  if (!info) return null;
  const kind = info.kind;
  const ins = { pc, op, kind };
  let p = pc + 1;
  const take = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(code[p++]); return a; };
  if (LAYOUT[kind]) {
    const names = LAYOUT[kind];
    const vals = take(names.length);
    names.forEach((nm, i) => { ins[nm] = vals[i]; });
    ins.words = vals;
  } else if (kind === 'ARRAY') {
    const [dst, count] = take(2); ins.dst = dst; ins.count = count; ins.elems = take(count);
  } else if (kind === 'OBJECT') {
    const [dst, count] = take(2); ins.dst = dst; ins.count = count;
    ins.pairs = []; for (let i = 0; i < count; i++) ins.pairs.push(take(2));
  } else if (kind === 'CALL' || kind === 'NEW') {
    const [dst, fn, argc] = take(3); ins.dst = dst; ins.fn = fn;
    if (argc === SPREAD) { ins.spread = true; ins.args = take(1); } else { ins.argc = argc; ins.args = take(argc); }
  } else if (kind === 'CALLMETHOD') {
    const [dst, thisr, fn, argc] = take(4); ins.dst = dst; ins.thisReg = thisr; ins.fn = fn;
    if (argc === SPREAD) { ins.spread = true; ins.args = take(1); } else { ins.argc = argc; ins.args = take(argc); }
  } else if (kind === 'MAKEFUNC') {
    const [dst, entry, nparams, nregs, ncells, hasRest, newC] = take(7);
    ins.dst = dst; ins.entry = entry; ins.nparams = nparams; ins.nregs = nregs;
    ins.hasRest = hasRest; ins.newC = newC; ins.cells = [];
    for (let i = 0; i < ncells; i++) { const [isNew, idx] = take(2); ins.cells.push({ isNew, idx }); }
  } else {
    const n = info.layout.consumed;
    ins.words = take(n);
    ins.dstPos = info.layout.writes[0];
    ins.regPos = info.layout.reads;
    ins.dst = ins.words[ins.dstPos];
    ins.srcRegs = ins.regPos.map(i => ins.words[i]);
  }
  ins.len = p - pc;
  ins.next = p;
  return ins;
}

function readConst(L, poolIdx, key) {
  const env = makeEnv(L, { words: [poolIdx, key], C: 0 });
  return L.V(env.inst);
}

// cache of fitted semantics keyed by opcode + immediates + frame key
function makeFitter(L, T) {
  const cache = new Map();
  return function (ins, C) {
    const info = T[ins.op];
    const groups = new Map();
    for (const p of info.layout.reads) if (!groups.has(ins.words[p])) groups.set(ins.words[p], groups.size);
    const key = ins.op + '|' + C + '|' + ins.words.map((w, i) =>
      info.layout.reads.includes(i) ? 'R' + groups.get(w) : i === info.layout.writes[0] ? 'D' : w).join(',');
    if (cache.has(key)) return cache.get(key);
    const r = fitSite(L, ins.op, ins.words, info.layout, C);
    cache.set(key, r);
    return r;
  };
}

// the distinct source registers of a site, in first-read order -- the fitted
// result indexes into this list (it is per-site, unlike the cached fit)
function inputsOf(T, ins) {
  const info = T[ins.op];
  const seen = [];
  for (const p of info.layout.reads) if (!seen.includes(ins.words[p])) seen.push(ins.words[p]);
  return seen;
}

function analyze(file) {
  const L = loadVM(file);
  const T = buildOpTable(L);
  const code = Array.from(L.vm.i);
  const fit = makeFitter(L, T);
  return {
    L, T, code, fit,
    decode: (pc) => decode(T, code, pc),
    readConst: (p, k) => readConst(L, p, k),
    inputsOf: (ins) => inputsOf(T, ins),
  };
}

module.exports = { analyze, decode, readConst, LAYOUT, SPREAD };

if (require.main === module) {
  const A = analyze(path.join(__dirname, '..', 'input.js'));
  const { L, T, code, fit } = A;
  // discover functions
  const funcs = new Map();
  const root = { entry: L.tmpl.x.F, nparams: L.tmpl.x.o, nregs: L.tmpl.x.m, C: L.tmpl.x.C, cells: [], name: 'root' };
  funcs.set(root.entry, root);
  const work = [root];
  const listing = [];
  while (work.length) {
    const f = work.shift();
    const seen = new Set();
    const stack = [f.entry];
    const inss = [];
    while (stack.length) {
      let pc = stack.pop();
      while (true) {
        if (seen.has(pc) || pc >= code.length) break;
        const ins = A.decode(pc);
        if (!ins) { inss.push({ pc, kind: 'BAD', op: code[pc], len: 1 }); break; }
        seen.add(pc); inss.push(ins);
        if (ins.kind === 'MAKEFUNC' && !funcs.has(ins.entry)) {
          const nf = { entry: ins.entry, nparams: ins.nparams, nregs: ins.nregs, C: ins.newC, cells: ins.cells, name: 'fn' + ins.entry };
          funcs.set(nf.entry, nf); work.push(nf);
        }
        if (ins.kind === 'JMP') { pc = ins.target; continue; }
        if (ins.kind === 'JMPIF' || ins.kind === 'JMPIFNOT') { stack.push(ins.target); pc = ins.next; continue; }
        if (ins.kind === 'FORIN_NEXT') { stack.push(ins.doneTarget); pc = ins.next; continue; }
        if (ins.kind === 'TRYCATCH') { stack.push(ins.catchPC); pc = ins.next; continue; }
        if (ins.kind === 'TRYFIN') { stack.push(ins.finPC); pc = ins.next; continue; }
        if (['RETURN', 'THROW', 'JMPDYN'].includes(ins.kind)) break;
        pc = ins.next;
      }
    }
    inss.sort((a, b) => a.pc - b.pc);
    listing.push(`\n===== function @${f.entry}  params=${f.nparams} regs=${f.nregs} C=${f.C} cells=${JSON.stringify(f.cells)}`);
    for (const ins of inss) {
      let s = `${String(ins.pc).padStart(5)}: ${ins.kind.padEnd(11)}`;
      if (ins.kind === 'DATA') {
        const r = fit(ins, f.C);
        let sem;
        if (r.kind === 'BINARY') sem = `r${ins.dst} = r${ins.srcRegs[r.a]} ${r.op} r${ins.srcRegs[r.b]}`;
        else if (r.kind === 'BINCONST') sem = r.side === 'right'
          ? `r${ins.dst} = r${ins.srcRegs[r.a]} ${r.op} ${r.k}` : `r${ins.dst} = ${r.k} ${r.op} r${ins.srcRegs[r.a]}`;
        else if (r.kind === 'UNARY') sem = `r${ins.dst} = ${r.op} r${ins.srcRegs[r.a]}`;
        else if (r.kind === 'CONST') sem = `r${ins.dst} = ${JSON.stringify(r.value)}`;
        else sem = `?? ${r.kind} op=${ins.op} words=[${ins.words}] regs=[${ins.srcRegs}]`;
        s += ' ' + sem + `      ; op=${ins.op}`;
      } else if (['LOADCONST', 'LOADGLOBAL', 'TYPEOFGLOBAL'].includes(ins.kind)) {
        s += ` r${ins.dst} = ${JSON.stringify(A.readConst(ins.pool, ins.key))}`;
      } else if (ins.kind === 'STOREGLOBAL') {
        s += ` global[${JSON.stringify(A.readConst(ins.pool, ins.key))}] = r${ins.src}`;
      } else if (ins.kind === 'MAKEFUNC') {
        s += ` r${ins.dst} = fn@${ins.entry}(params=${ins.nparams},regs=${ins.nregs},rest=${ins.hasRest}) cells=${JSON.stringify(ins.cells)}`;
      } else {
        s += ' ' + JSON.stringify(Object.fromEntries(Object.entries(ins).filter(([k]) =>
          !['pc', 'op', 'kind', 'words', 'len', 'next'].includes(k))));
      }
      listing.push(s);
    }
  }
  fs.writeFileSync(path.join(__dirname, 'listing.txt'), listing.join('\n'));
  console.log(listing.join('\n').slice(0, 12000));
  console.log('\nfunctions:', funcs.size);
}
