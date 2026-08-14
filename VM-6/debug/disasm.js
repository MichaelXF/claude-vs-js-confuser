// debug/disasm.js -- walk the bytecode, decode instructions, print a listing
const fs = require('fs');
const path = require('path');
const { loadVM } = require('./load');
const { buildOpTable, fitSite, makeEnv } = require('./ops');

const SPREAD = 2329202881;

// fixed operand layouts for the structural opcodes
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

function decode(L, T, code, pc) {
  const op = code[pc];
  const info = T[op];
  if (!info) return null;
  const kind = info.kind;
  const ins = { pc, op, kind, words: [] };
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
    ins.pairs = []; for (let i = 0; i < count; i++) { const kv = take(2); ins.pairs.push(kv); }
  } else if (kind === 'CALL' || kind === 'NEW') {
    const [dst, fn, argc] = take(3); ins.dst = dst; ins.fn = fn;
    if (argc === SPREAD) { ins.spread = true; ins.args = take(1); } else { ins.argc = argc; ins.args = take(argc); }
  } else if (kind === 'CALLMETHOD') {
    const [dst, thisr, fn, argc] = take(4); ins.dst = dst; ins.thisReg = thisr; ins.fn = fn;
    if (argc === SPREAD) { ins.spread = true; ins.args = take(1); } else { ins.argc = argc; ins.args = take(argc); }
  } else if (kind === 'MAKEFUNC') {
    const [dst, entry, nparams, nregs, ncells, hasRest, C] = take(7);
    ins.dst = dst; ins.entry = entry; ins.nparams = nparams; ins.nregs = nregs;
    ins.hasRest = hasRest; ins.C = C; ins.cells = [];
    for (let i = 0; i < ncells; i++) { const [isNew, idx] = take(2); ins.cells.push({ isNew, idx }); }
  } else {
    // DATA opcode: use probed layout
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

function walk(L, T, code, entries) {
  const seen = new Map();
  const work = entries.slice();
  const funcs = [];
  while (work.length) {
    const { pc: start, C } = work.shift();
    let pc = start;
    while (true) {
      if (seen.has(pc)) break;
      if (pc >= code.length) break;
      const ins = decode(L, T, code, pc);
      if (!ins) { seen.set(pc, { pc, kind: 'BAD', op: code[pc], len: 1, next: pc + 1 }); break; }
      ins.C = C;
      seen.set(pc, ins);
      if (ins.kind === 'MAKEFUNC') { work.push({ pc: ins.entry, C: ins.C_new = ins.C }); funcs.push(ins); }
      if (ins.kind === 'JMP') { pc = ins.target; continue; }
      if (ins.kind === 'JMPIF' || ins.kind === 'JMPIFNOT') { work.push({ pc: ins.target, C }); pc = ins.next; continue; }
      if (ins.kind === 'FORIN_NEXT') { work.push({ pc: ins.doneTarget, C }); pc = ins.next; continue; }
      if (ins.kind === 'TRYCATCH') { work.push({ pc: ins.catchPC, C }); pc = ins.next; continue; }
      if (ins.kind === 'TRYFIN') { work.push({ pc: ins.finPC, C }); pc = ins.next; continue; }
      if (ins.kind === 'RETURN' || ins.kind === 'THROW' || ins.kind === 'JMPDYN') break;
      pc = ins.next;
    }
  }
  return { seen, funcs };
}

if (require.main === module) {
  const L = loadVM(path.join(__dirname, '..', 'input.js'));
  const T = buildOpTable(L);
  const code = Array.from(L.vm.i);
  const rootC = L.tmpl.x.C;
  // makefunc gives each function its own C key; fix that up during the walk
  const { seen } = walk(L, T, code, [{ pc: L.tmpl.x.F, C: rootC }]);
  const pcs = [...seen.keys()].sort((a, b) => a - b);
  const out = [];
  let prev = null;
  for (const pc of pcs) {
    if (prev !== null && pc !== prev) out.push(`      ---- gap ${prev}..${pc - 1} ----`);
    const ins = seen.get(pc);
    let s = `${String(pc).padStart(5)}: ${ins.kind.padEnd(12)}`;
    if (ins.kind === 'LOADCONST' || ins.kind === 'LOADGLOBAL' || ins.kind === 'TYPEOFGLOBAL') {
      s += ` r${ins.dst} = ${JSON.stringify(readConst(L, ins.pool, ins.key))}`;
    } else if (ins.kind === 'STOREGLOBAL') {
      s += ` ${JSON.stringify(readConst(L, ins.pool, ins.key))} = r${ins.src}`;
    } else if (ins.kind === 'MAKEFUNC') {
      s += ` r${ins.dst} = fn@${ins.entry} params=${ins.nparams} regs=${ins.nregs} rest=${ins.hasRest} C=${ins.C} cells=${JSON.stringify(ins.cells)}`;
    } else if (ins.kind === 'DATA') {
      s += ` [${ins.words.join(',')}] dst=r${ins.dst} regs=[${ins.srcRegs.map(r => 'r' + r).join(',')}]`;
    } else {
      s += ' ' + JSON.stringify(Object.fromEntries(Object.entries(ins).filter(([k]) =>
        !['pc', 'op', 'kind', 'words', 'len', 'next', 'C'].includes(k))));
    }
    out.push(s);
    prev = ins.next;
  }
  fs.writeFileSync(path.join(__dirname, 'disasm.txt'), out.join('\n'));
  console.log(out.slice(0, 120).join('\n'));
  console.log('...\ntotal instructions:', pcs.length, 'coverage', prev, '/', code.length);
}
