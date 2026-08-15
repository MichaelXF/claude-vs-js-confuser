// Two-phase analysis of a VM function:
//   phase 1: context-insensitive constant propagation -> static block graph -> liveness
//   phase 2: path-sensitive propagation (deduped on live registers) -> unflattened graph
const M = require("./vmmodel2");
const { CODE, sweep, STRUCT, RESTYPE, runAt, NREG } = M;

const { PLAIN } = require("./semantics");
const PLAIN_OPS = new Set(Object.keys(PLAIN).map(Number));

const INSTRS = sweep(CODE);
const TOP = Symbol("TOP");

const OP = {
  JMP: 31145, JMP_FALSE: 223, JMP_TRUE: 51943, DYNJMP: 47933, RET: 37176, THROW: 31178,
  FORIN_NEXT: 46118, FUNC: 34577, CALL: 41417, MCALL: 42977, NEW: 48258,
  TRY_CATCH: 18114, TRY_FIN: 32278, POP_TRY: 29585, DECRYPT: 5170, DEBUGGER: 44744,
  ARRAY: 46215, OBJECT: 20969, GETCLOSURE: 7574, SETCLOSURE: 56439,
};
const TERMINATORS = new Set([OP.JMP, OP.JMP_FALSE, OP.JMP_TRUE, OP.DYNJMP, OP.RET, OP.THROW, OP.FORIN_NEXT]);
const IMPURE = new Set([
  OP.CALL, OP.MCALL, OP.NEW, 63716, 14166, 21434, 25878, 17515, 51395, 64259, 37457,
  3291, 46118, 56439, 7574, 40602, 44744, 31178, 46215, 20969,
]);

function blockAt(startPc) {
  const list = [];
  let pc = startPc;
  for (;;) {
    const ins = INSTRS.get(pc);
    if (!ins) throw new Error("no instruction at " + pc);
    list.push(ins);
    if (TERMINATORS.has(ins.op)) break;
    pc += ins.len;
    if (!INSTRS.has(pc)) break;
  }
  return list;
}
const blockCache = new Map();
function block(pc) {
  if (!blockCache.has(pc)) blockCache.set(pc, blockAt(pc));
  return blockCache.get(pc);
}
function isDispatchBlock(pc) {
  const b = block(pc);
  return b.length >= 2 && b[b.length - 1].op === OP.DYNJMP && b[b.length - 2].op === OP.CALL;
}

// Source registers read by an instruction (handles variable-length opcodes).
function instrSrcs(ins) {
  const w = ins.words;
  switch (ins.op) {
    case OP.ARRAY: return w.slice(2);
    case OP.OBJECT: return w.slice(2);
    case OP.CALL: return [w[1], ...(w[2] === M.MAGIC_SPREAD ? w.slice(3, 4) : w.slice(3))];
    case OP.MCALL: return [w[1], w[2], ...(w[3] === M.MAGIC_SPREAD ? w.slice(4, 5) : w.slice(4))];
    case OP.NEW: return [w[1], ...(w[2] === M.MAGIC_SPREAD ? w.slice(3, 4) : w.slice(3))];
    case OP.FUNC: return [];
    default: return STRUCT[ins.op].regSlots.map((s) => w[s]);
  }
}
// Registers captured by a nested function definition (aliased for its lifetime).
function instrCaptures(ins) {
  if (ins.op !== OP.FUNC) return [];
  const out = [];
  const k = ins.words[4];
  for (let j = 0; j < k; j++) {
    const isNew = ins.words[7 + j * 2];
    const v = ins.words[8 + j * 2];
    if (isNew) out.push(v);
  }
  return out;
}

// Values worth probing when testing whether an operand actually matters.
const CONST_POOL = new Set([0, 1, -1, 2, 3, 9, 16, 255, -256, 65535, 2147483647, -2147483648]);
function probeValues(n) {
  const out = [...CONST_POOL];
  for (let i = 0; i < n; i++) out.push(((Math.random() * 2 ** 32) | 0));
  for (let i = 0; i < 8; i++) out.push((((Math.random() * 2 ** 32) | 0) & ~15) | 9);
  return out;
}
// If an instruction's result does not depend on its unknown operands, fold it.
function invariantValue(ins, key, regs, unknownSrcs, fnObj) {
  const samples = probeValues(14);
  let first;
  for (let i = 0; i < samples.length; i++) {
    const r = regs.slice();
    for (const u of unknownSrcs) r[u] = samples[(i + u) % samples.length];
    for (let j = 0; j < NREG; j++) if (r[j] === TOP) r[j] = samples[(i + j) % samples.length];
    const res = runAt(CODE, ins.pc, key, r, { fnObj });
    if (res.error || !res.regWrites.length) return { ok: false };
    const v = res.regWrites[res.regWrites.length - 1][1];
    if (i === 0) first = v;
    else if (!Object.is(first, v)) return { ok: false };
  }
  return { ok: true, value: first };
}

// Opcodes whose handler writes words[0] as the destination register (all the
// plainly-readable ones); MBA opcodes scramble the destination with their key.
const PLAIN_DEST = new Set([
  39896, 3501, 19461, 45888, 12149, 16504, 50146, 21415, 63862, 40602,
  6548, 22273, 24492, 26926, 9164, 4969, 39540, 47762, 36699, 56680, 28171, 49537,
  55744, 14822, 26487, 58658, 48837, 30837, 27901, 12213, 23847, 36092,
  37457, 17515, 7574, 46215, 20969, 3291, 46118, 51395, 64259, 41417, 42977, 48258, 34577,
]);
const destCache = new Map();
function destOf(ins, key) {
  const ck = ins.pc + ":" + key;
  if (destCache.has(ck)) return destCache.get(ck);
  let d = null;
  if (PLAIN_DEST.has(ins.op)) d = ins.words[0];
  else if (STRUCT[ins.op].writes) {
    const res = runAt(CODE, ins.pc, key, new Array(NREG).fill(0), {});
    if (res.regWrites.length) d = res.regWrites[res.regWrites.length - 1][0];
  }
  destCache.set(ck, d);
  return d;
}

class FuncAnalysis {
  constructor(entry, key, desc, fnObj, parent) {
    this.entry = entry;
    this.key = key;
    this.desc = desc;
    this.fnObj = fnObj;
    this.parent = parent;
    this.nodes = new Map();
    this.byPc = new Map();
    this.nextId = 0;
    this.captured = new Set();
  }

  initialState() {
    const st = new Array(NREG).fill(undefined);
    const nParams = this.desc.d | 0;
    for (let j = 0; j < nParams; j++) st[j] = TOP;
    if (this.desc.d < this.desc.Q) st[this.desc.d] = TOP;
    return st;
  }

  // ---------- phase 1: merged propagation, collecting the static block graph ----------
  runMerged() {
    const inStates = new Map([[this.entry, this.initialState()]]);
    const edges = new Map();
    const queue = [this.entry];
    const blocks = new Set();
    let guard = 0;
    while (queue.length) {
      if (++guard > 50000) throw new Error("merged analysis budget");
      const pc = queue.shift();
      blocks.add(pc);
      const state = inStates.get(pc);
      const res = this.execBlock(pc, state, { merged: true });
      const succs = [];
      for (const o of res.outcomes) for (let i = 0; i < o.targets.length; i++) succs.push({ pc: o.targets[i], state: o.regs });
      edges.set(pc, succs.map((s) => s.pc));
      for (const s of succs) {
        const cur = inStates.get(s.pc);
        const merged = cur ? mergeStates(cur, s.state) : s.state.slice();
        if (!cur || !sameState(cur, merged)) {
          inStates.set(s.pc, merged);
          if (!queue.includes(s.pc)) queue.push(s.pc);
        }
      }
    }
    this.staticBlocks = blocks;
    this.staticEdges = edges;
    // captured registers
    for (const pc of blocks) for (const ins of block(pc)) for (const r of instrCaptures(ins)) this.captured.add(r);
    return { blocks, edges };
  }

  computeLiveness() {
    const uses = new Map();
    const defs = new Map();
    for (const pc of this.staticBlocks) {
      const u = new Set();
      const d = new Set();
      for (const ins of block(pc)) {
        for (const r of instrSrcs(ins)) if (!d.has(r)) u.add(r);
        const dest = destOf(ins, this.key);
        if (dest !== null && !TERMINATORS.has(ins.op)) d.add(dest);
      }
      uses.set(pc, u);
      defs.set(pc, d);
    }
    const liveIn = new Map();
    for (const pc of this.staticBlocks) liveIn.set(pc, new Set(uses.get(pc)));
    let changed = true;
    let guard = 0;
    while (changed) {
      changed = false;
      if (++guard > 1000) break;
      for (const pc of this.staticBlocks) {
        const li = liveIn.get(pc);
        const before = li.size;
        for (const s of this.staticEdges.get(pc) || []) {
          const sl = liveIn.get(s);
          if (!sl) continue;
          for (const r of sl) if (!defs.get(pc).has(r)) li.add(r);
        }
        if (li.size !== before) changed = true;
      }
    }
    for (const [pc, li] of liveIn) for (const r of this.captured) li.add(r);
    this.liveIn = liveIn;
    return liveIn;
  }

  // Registers written only by MBA opcodes (the flattening state / concealed constants).
  computeDefKinds() {
    const plainDef = new Set();
    const mbaDef = new Set();
    for (const pc of this.staticBlocks) {
      for (const ins of block(pc)) {
        if (TERMINATORS.has(ins.op)) continue;
        const d = destOf(ins, this.key);
        if (d === null) continue;
        (PLAIN_OPS.has(ins.op) ? plainDef : mbaDef).add(d);
      }
    }
    this.mbaOnlyRegs = new Set([...mbaDef].filter((r) => !plainDef.has(r)));
  }

  // ---------- phase 2: path-sensitive ----------
  // Registers that explode the state space (loop counters, accumulators) are
  // widened to unknown and the analysis restarted; the flattening state
  // registers only take a handful of values and survive.
  run() {
    this.runMerged();
    this.computeLiveness();
    this.computeDefKinds();
    this.widened = new Set();
    for (let attempt = 0; attempt < 40; attempt++) {
      this.nodes = new Map();
      this.byPc = new Map();
      this.nextId = 0;
      this.overflow = null;
      this.runPass();
      if (!this.overflow) return;
      const { pc, list } = this.overflow;
      // Prefer widening ordinary program registers; the flattening state register
      // is the one written exclusively by the obfuscator's concealed-constant
      // (MBA) opcodes, so keep it precise for as long as possible.
      let best = null;
      for (const r of this.liveIn.get(pc) || []) {
        if (this.widened.has(r)) continue;
        const n = new Set(list.map((x) => x.state[r])).size;
        const cand = { r, n, mba: this.mbaOnlyRegs.has(r) };
        if (!best) { best = cand; continue; }
        if (best.mba !== cand.mba) { if (best.mba) best = cand; continue; }
        if (cand.n > best.n) best = cand;
      }
      if (!best || best.n < 3) return;
      this.widened.add(best.r);
    }
  }

  runPass() {
    const start = this.getNode(this.entry, this.initialState());
    this.startNode = start;
    const queue = [start];
    let guard = 0;
    while (queue.length) {
      if (++guard > 40000) throw new Error("analysis budget exceeded in fn@" + this.entry);
      const node = queue.shift();
      if (node.analyzed) continue;
      node.analyzed = true;
      const res = this.execBlock(node.pc, node.state, { merged: false });
      node.instrs = res.instrs;
      node.values = res.values;
      node.dests = res.dests;
      node.inputs = res.inputs;
      node.term = res.term;
      node.outcomes = res.outcomes;
      node.succNodes = [];
      for (const o of res.outcomes) {
        o.nodes = o.targets.map((t) => {
          const n = this.getNode(t, o.regs);
          node.succNodes.push(n);
          return n;
        });
      }
      if (node.outcomes.length === 2 && node.outcomes.every((o) => o.kind === "goto" && o.nodes.length === 1) &&
          node.outcomes[0].nodes[0] === node.outcomes[1].nodes[0]) {
        node.outcomes = [node.outcomes[0]];
        node.outcomes[0].split = null;
      }
      for (const s of node.succNodes) if (!s.analyzed && !queue.includes(s)) queue.push(s);
    }
  }

  stateKey(pc, state) {
    const live = this.liveIn.get(pc);
    if (!live) return state.map((v, i) => (v === TOP ? "T" : typeof v === "function" ? "f" : typeof v === "object" && v ? "o" : JSON.stringify(v))).join("|");
    const parts = [];
    for (const r of [...live].sort((a, b) => a - b)) {
      const v = state[r];
      parts.push(r + "=" + (v === TOP ? "T" : typeof v === "function" ? "f" + (v.__vmid || "") : typeof v === "object" && v ? "o" : JSON.stringify(v)));
    }
    return parts.join(",");
  }

  getNode(pc, state) {
    if (this.widened && this.widened.size) {
      state = state.slice();
      for (const r of this.widened) state[r] = TOP;
    }
    let list = this.byPc.get(pc);
    if (!list) { list = []; this.byPc.set(pc, list); }
    const key = this.stateKey(pc, state);
    for (const n of list) if (n.key === key) return n;
    if (list.length >= 48) {
      if (!this.overflow) this.overflow = { pc, list };
      const n = list[0];
      const merged = mergeStates(n.state, state);
      if (!sameState(n.state, merged)) { n.state = merged; n.analyzed = false; }
      return n;
    }
    const node = { id: this.nextId++, pc, key, state: state.slice(), analyzed: false, succNodes: [] };
    list.push(node);
    this.nodes.set(node.id, node);
    return node;
  }

  execBlock(pc, inState, opt) {
    const instrs = block(pc);
    const values = new Map();
    const dests = new Map();
    const inputs = new Map();
    let paths = [{ regs: inState.slice(), split: null }];
    for (const ins of instrs) {
      const srcRegs = instrSrcs(ins);
      const dest = destOf(ins, this.key);
      dests.set(ins.pc, dest);
      if (paths.length) {
        const snap = {};
        for (const r of new Set(srcRegs)) snap[r] = paths[0].regs[r];
        inputs.set(ins.pc, snap);
      }
      if (TERMINATORS.has(ins.op)) continue;
      const newPaths = [];
      for (const p of paths) {
        const known = srcRegs.every((r) => p.regs[r] !== TOP);
        if (known && !IMPURE.has(ins.op)) {
          const res = runAt(CODE, ins.pc, this.key, p.regs, { fnObj: this.fnObj });
          if (!res.error && res.regWrites.length) {
            const [d, v] = res.regWrites[res.regWrites.length - 1];
            p.regs[d] = v;
            if (paths.length === 1) values.set(ins.pc, v);
            newPaths.push(p);
            continue;
          }
        }
        // MBA opcodes carry junk operands; if the result is invariant over the
        // unknown ones it is really a concealed constant / folded comparison.
        if (!known && !IMPURE.has(ins.op) && !PLAIN_OPS.has(ins.op) && dest !== null) {
          const unknown = srcRegs.filter((r) => p.regs[r] === TOP);
          const inv = invariantValue(ins, this.key, p.regs, unknown, this.fnObj);
          if (inv.ok) {
            p.regs[dest] = inv.value;
            if (paths.length === 1) values.set(ins.pc, inv.value);
            newPaths.push(p);
            continue;
          }
        }
        if (dest !== null) {
          if (RESTYPE[ins.op] === "boolean" && !p.split && paths.length === 1) {
            const pf = { regs: p.regs.slice(), split: { reg: dest, pc: ins.pc, value: false } };
            const pt = { regs: p.regs.slice(), split: { reg: dest, pc: ins.pc, value: true } };
            pf.regs[dest] = false;
            pt.regs[dest] = true;
            newPaths.push(pf, pt);
          } else {
            p.regs[dest] = TOP;
            newPaths.push(p);
          }
        } else newPaths.push(p);
      }
      paths = newPaths;
    }
    const term = instrs[instrs.length - 1];
    const outcomes = [];
    for (const p of paths) {
      const out = this.resolveTerm(term, p);
      out.split = p.split;
      out.regs = p.regs;
      outcomes.push(out);
    }
    return { instrs, values, dests, inputs, term, outcomes };
  }

  resolveTerm(term, path) {
    const w = term.words;
    switch (term.op) {
      case OP.RET: return { kind: "return", reg: w[0], targets: [] };
      case OP.THROW: return { kind: "throw", reg: w[0], targets: [] };
      case OP.JMP: {
        const t = w[0];
        if (isDispatchBlock(t)) return this.resolveDispatch(t, path);
        return { kind: "goto", targets: [t] };
      }
      case OP.JMP_FALSE: return { kind: "branch", reg: w[0], invert: true, targets: [w[1], term.pc + term.len] };
      case OP.JMP_TRUE: return { kind: "branch", reg: w[0], invert: false, targets: [w[1], term.pc + term.len] };
      case OP.FORIN_NEXT: return { kind: "forin", dest: w[0], iter: w[1], targets: [w[2], term.pc + term.len] };
      case OP.DYNJMP: {
        const v = path.regs[w[0]];
        if (v === TOP || typeof v !== "number") return { kind: "dynamic", targets: [] };
        return { kind: "goto", targets: [v] };
      }
      default: return { kind: "goto", targets: [term.pc + term.len] };
    }
  }

  resolveDispatch(dispPc, path) {
    const b = block(dispPc);
    const call = b[b.length - 2];
    const fnReg = call.words[1];
    const argRegs = call.words.slice(3);
    const callee = path.regs[fnReg];
    const args = argRegs.map((r) => path.regs[r]);
    if (typeof callee !== "function" || args.some((a) => a === TOP)) return { kind: "dynamic", targets: [], dispPc };
    return { kind: "goto", targets: [callee(...args)], dispPc };
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

function analyzeProgram() {
  const funcs = new Map();
  const topDesc = M.entryCall[1].C;
  const queue = [{ entry: topDesc.m, key: M.TOPKEY, desc: topDesc, fnObj: M.entryCall[1], parent: null, defPc: null }];
  while (queue.length) {
    const job = queue.shift();
    if (funcs.has(job.entry)) continue;
    const fa = new FuncAnalysis(job.entry, job.key, job.desc, job.fnObj, job.parent);
    fa.defPc = job.defPc;
    funcs.set(job.entry, fa);
    fa.run();
    for (const node of fa.nodes.values()) {
      for (const ins of node.instrs) {
        if (ins.op !== OP.FUNC) continue;
        const childEntry = ins.words[1];
        if (funcs.has(childEntry) || queue.some((q) => q.entry === childEntry)) continue;
        const res = runAt(CODE, ins.pc, fa.key, new Array(NREG).fill(undefined), { fnObj: fa.fnObj });
        const jsFn = res.regWrites[res.regWrites.length - 1][1];
        const rObj = M.ex.m.get(jsFn);
        queue.push({ entry: childEntry, key: rObj.C.x | 0, desc: rObj.C, fnObj: rObj, parent: fa.entry, defPc: ins.pc });
      }
    }
  }
  return funcs;
}

module.exports = { analyzeProgram, FuncAnalysis, INSTRS, block, isDispatchBlock, TOP, OP, TERMINATORS, destOf, instrSrcs, instrCaptures };

if (require.main === module) {
  const funcs = analyzeProgram();
  for (const [entry, fa] of funcs) {
    console.log(`\nfn@${entry} params=${fa.desc.d} regs=${fa.desc.Q} nodes=${fa.nodes.size} distinctPcs=${fa.byPc.size} staticBlocks=${fa.staticBlocks.size}`);
    const dup = [...fa.byPc.entries()].filter(([, l]) => l.length > 1);
    if (dup.length) console.log("   duplicated:", dup.map(([pc, l]) => `${pc}x${l.length}`).join(" "));
    let dyn = 0;
    for (const n of fa.nodes.values()) for (const o of n.outcomes) if (o.kind === "dynamic") dyn++;
    console.log("   unresolved:", dyn, " captured:", [...fa.captured].join(","));
  }
}
