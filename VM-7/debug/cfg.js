// Recovers the control-flow graph: constant propagation through each function's
// blocks, resolving the dispatcher-computed jump targets.
const M = require("./vmmodel2");
const { CODE, sweep, STRUCT, RESTYPE, runAt, funcKey, decodeConst, TOPKEY, NREG } = M;

const INSTRS = sweep(CODE);
const TOP = Symbol("TOP");

const OP = {
  JMP: 31145, JMP_FALSE: 223, JMP_TRUE: 51943, DYNJMP: 47933, RET: 37176, THROW: 31178,
  FORIN_NEXT: 46118, FUNC: 34577, CALL: 41417, MCALL: 42977, NEW: 48258,
  TRY_CATCH: 18114, TRY_FIN: 32278, POP_TRY: 29585, DECRYPT: 5170,
};
const TERMINATORS = new Set([OP.JMP, OP.JMP_FALSE, OP.JMP_TRUE, OP.DYNJMP, OP.RET, OP.THROW, OP.FORIN_NEXT]);
// ops we must never execute concretely (side effects / environment)
const IMPURE = new Set([OP.CALL, OP.MCALL, OP.NEW, 63716, 14166, 21434, 25878, 17515, 51395, 64259, 37457, 3291, 46118, 56439, 7574, 40602, 44744]);

function blockOf(startPc) {
  const list = [];
  let pc = startPc;
  while (true) {
    const ins = INSTRS.get(pc);
    if (!ins) throw new Error("no instruction at " + pc);
    list.push(ins);
    if (TERMINATORS.has(ins.op)) break;
    pc += ins.len;
    if (!INSTRS.has(pc)) break;
  }
  return list;
}

// Is this block a dispatcher trampoline (call + dynamic jump)?
function isDispatchBlock(startPc) {
  const b = blockOf(startPc);
  return b.length >= 2 && b[b.length - 1].op === OP.DYNJMP && b[b.length - 2].op === OP.CALL;
}

class Analyzer {
  constructor() {
    this.functions = new Map(); // entryPc -> {key, desc, blocks:Map, parent}
    this.dispatchers = new Map(); // entryPc of dispatcher fn -> callable
  }

  makeCallable(defPc, parentKey, closureCells) {
    // Executes op 34577 for real to obtain a live JS function for the defined VM function.
    const ins = INSTRS.get(defPc);
    const regs = new Array(NREG).fill(undefined);
    const fnObj = { j: closureCells || [], prototype: {}, C: {} };
    const res = runAt(CODE, defPc, parentKey, regs, { fnObj });
    if (res.error) throw res.error;
    return res.regWrites[res.regWrites.length - 1][1];
  }

  analyzeFunction(entryPc, key, desc, parentInfo, fnObj) {
    const fn = { entry: entryPc, key, desc, blocks: new Map(), order: [], parent: parentInfo, childDefs: [], fnObj };
    this.functions.set(entryPc, fn);

    const initial = new Array(NREG).fill(undefined);
    const nParams = desc.d | 0;
    for (let j = 0; j < nParams; j++) initial[j] = TOP; // parameters
    if (desc.d < desc.Q) initial[desc.d] = TOP; // arguments array
    const inputStates = new Map([[entryPc, initial]]);
    const queue = [entryPc];
    const done = new Set();

    while (queue.length) {
      const bpc = queue.shift();
      const state = inputStates.get(bpc);
      const result = this.execBlock(fn, bpc, state);
      fn.blocks.set(bpc, result);
      if (!fn.order.includes(bpc)) fn.order.push(bpc);
      for (const succ of result.succs) {
        const cur = inputStates.get(succ.pc);
        const merged = cur ? mergeStates(cur, succ.state) : succ.state.slice();
        const changed = !cur || !sameState(cur, merged);
        inputStates.set(succ.pc, merged);
        if (changed || !done.has(succ.pc)) {
          done.add(succ.pc);
          if (!queue.includes(succ.pc)) queue.push(succ.pc);
        }
      }
    }
    return fn;
  }

  execBlock(fn, startPc, inState) {
    const instrs = blockOf(startPc);
    // paths: {regs, cond} - cond records the split (register index + value)
    let paths = [{ regs: inState.slice(), split: null }];
    const records = [];

    for (const ins of instrs) {
      const st = STRUCT[ins.op];
      const rec = { ins, dest: null, srcs: [], kind: null };
      records.push(rec);
      if (ins.op === OP.DYNJMP || ins.op === OP.JMP || ins.op === OP.RET || ins.op === OP.THROW || ins.op === OP.JMP_FALSE || ins.op === OP.JMP_TRUE || ins.op === OP.FORIN_NEXT) {
        rec.srcs = st.regSlots.map((s) => ins.words[s]);
        continue;
      }
      const srcRegs = st.regSlots.map((s) => ins.words[s]);
      rec.srcs = srcRegs;
      const newPaths = [];
      for (const p of paths) {
        const allKnown = srcRegs.every((r) => p.regs[r] !== TOP) && !IMPURE.has(ins.op);
        if (allKnown) {
          const res = runAt(CODE, ins.pc, fn.key, p.regs, { fnObj: fn.fnObj });
          if (res.error || !res.regWrites.length) {
            // treat as unknown write to dest
            const d = this.destOf(fn, ins);
            if (d !== null) p.regs[d] = TOP;
            rec.dest = d;
            newPaths.push(p);
            continue;
          }
          const [d, v] = res.regWrites[res.regWrites.length - 1];
          rec.dest = d;
          p.regs[d] = v;
          newPaths.push(p);
        } else {
          const d = this.destOf(fn, ins);
          rec.dest = d;
          if (d === null) { newPaths.push(p); continue; }
          if (RESTYPE[ins.op] === "boolean" && paths.length < 8) {
            const pf = { regs: p.regs.slice(), split: p.split || { reg: d, srcs: srcRegs, pc: ins.pc, value: false } };
            const pt = { regs: p.regs.slice(), split: p.split || { reg: d, srcs: srcRegs, pc: ins.pc, value: true } };
            if (p.split) { pf.regs[d] = TOP; newPaths.push(pf); }
            else { pf.regs[d] = false; pt.regs[d] = true; newPaths.push(pf, pt); }
          } else {
            p.regs[d] = TOP;
            newPaths.push(p);
          }
        }
      }
      paths = newPaths;
    }

    const term = instrs[instrs.length - 1];
    const succs = [];
    const outcomes = [];
    for (const p of paths) {
      const t = this.resolveTerm(fn, term, p);
      outcomes.push({ split: p.split, ...t });
      for (const s of t.targets) succs.push({ pc: s, state: p.regs });
    }
    return { startPc, instrs, records, outcomes, succs, term };
  }

  destOf(fn, ins) {
    const st = STRUCT[ins.op];
    if (!st.writes) return null;
    const regs = new Array(NREG).fill(0);
    const res = runAt(CODE, ins.pc, fn.key, regs, {});
    if (!res.regWrites.length) return null;
    return res.regWrites[res.regWrites.length - 1][0];
  }

  resolveTerm(fn, term, path) {
    const w = term.words;
    switch (term.op) {
      case OP.RET: return { kind: "return", reg: w[0], targets: [] };
      case OP.THROW: return { kind: "throw", reg: w[0], targets: [] };
      case OP.JMP: {
        const t = w[0];
        if (isDispatchBlock(t)) return this.resolveDispatch(fn, t, path);
        return { kind: "goto", targets: [t] };
      }
      case OP.JMP_FALSE: return { kind: "branch-false", reg: w[0], targets: [w[1], term.pc + term.len] };
      case OP.JMP_TRUE: return { kind: "branch-true", reg: w[0], targets: [w[1], term.pc + term.len] };
      case OP.FORIN_NEXT: return { kind: "forin", dest: w[0], iter: w[1], targets: [w[2], term.pc + term.len] };
      case OP.DYNJMP: {
        const v = path.regs[w[0]];
        if (v === TOP) return { kind: "dynamic", targets: [] };
        return { kind: "goto", targets: [v] };
      }
      default: return { kind: "fallthrough", targets: [term.pc + term.len] };
    }
  }

  resolveDispatch(fn, dispPc, path) {
    const b = blockOf(dispPc);
    const call = b[b.length - 2];
    const dyn = b[b.length - 1];
    // call: [dest, fnReg, argc, ...argRegs]
    const fnReg = call.words[1];
    const argRegs = call.words.slice(3);
    const callee = path.regs[fnReg];
    const args = argRegs.map((r) => path.regs[r]);
    if (typeof callee !== "function" || args.some((a) => a === TOP)) {
      return { kind: "dynamic", targets: [], dispPc };
    }
    const target = callee(...args);
    return { kind: "goto", targets: [target], dispPc, dispatchArgs: args };
  }
}

function mergeStates(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Object.is(a[i], b[i]) ? a[i] : TOP;
  return out;
}
function sameState(a, b) {
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

module.exports = { Analyzer, INSTRS, blockOf, isDispatchBlock, TOP, OP, TERMINATORS };

// Walks every function reachable from the entry point.
function analyzeAll() {
  const an = new Analyzer();
  const topDesc = M.entryCall[1].C;
  const queue = [{ entry: topDesc.m, key: TOPKEY, desc: topDesc, parent: null, fnObj: M.entryCall[1] }];
  while (queue.length) {
    const job = queue.shift();
    if (an.functions.has(job.entry)) continue;
    const fn = an.analyzeFunction(job.entry, job.key, job.desc, job.parent, job.fnObj);
    for (const [, blk] of fn.blocks) {
      for (const rec of blk.records) {
        if (rec.ins.op !== OP.FUNC) continue;
        const w = rec.ins.words;
        const childEntry = w[1];
        if (an.functions.has(childEntry)) continue;
        const res = runAt(CODE, rec.ins.pc, fn.key, new Array(NREG).fill(undefined), { fnObj: fn.fnObj });
        const jsFn = res.regWrites[res.regWrites.length - 1][1];
        const rObj = M.ex.m.get(jsFn);
        queue.push({ entry: childEntry, key: rObj.C.x | 0, desc: rObj.C, parent: fn.entry, fnObj: rObj });
      }
    }
  }
  return an;
}

module.exports.analyzeAll = analyzeAll;

if (require.main === module) {
  const an = analyzeAll();
  for (const [entry, fn] of an.functions) {
    let dyn = 0;
    for (const [, blk] of fn.blocks) for (const o of blk.outcomes) if (o.kind === "dynamic") dyn++;
    console.log(`fn@${entry} key=${fn.key} d=${fn.desc.d} Q=${fn.desc.Q} blocks=${fn.blocks.size} unresolvedDynamic=${dyn} parent=${fn.parent}`);
    console.log("   blocks:", [...fn.blocks.keys()].sort((a, b) => a - b).join(" "));
  }
}
