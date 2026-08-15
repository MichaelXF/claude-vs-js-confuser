"use strict";
/**
 * Bytecode analysis.
 *
 * The bytecode is swept into instructions, then every VM function is explored
 * with a constant-propagating abstract interpreter. Because the interpreter
 * executes the real handlers it automatically:
 *
 *   - decodes the concealed constants (they are pure functions of the operand
 *     immediates plus junk register operands),
 *   - evaluates the dispatcher function that computes each jump target,
 *   - folds the opaque predicates of the control-flow-flattening switch, which
 *     unflattens the control flow back into a plain graph.
 *
 * The interpreter is path sensitive: block instances are keyed on the values of
 * the live registers, so the flattening state variable stays precise. Registers
 * that would make the state space explode (loop counters, accumulators) are
 * widened to "unknown" and the pass is restarted.
 */

const { MAGIC_SPREAD, NREG } = require("./machine");

const TOP = Symbol("unknown");

// opcode roles that assign a register
const WRITES_REGISTER = new Set([
  "arith", "loadimm", "loadconst", "void", "this", "getmember", "deletemember",
  "getclosure", "array", "object", "forininit", "forinnext", "getglobal",
  "typeofglobal", "call", "mcall", "new", "func",
]);

class Analyzer {
  constructor(machine) {
    this.m = machine;
    this.instrs = this.sweep();
    this.blockCache = new Map();
    this.destCache = new Map();
    this.functions = new Map();
  }

  // --- disassembly ---------------------------------------------------------

  /** Number of bytecode words an instruction occupies. */
  instrLen(pc) {
    const code = this.m.code;
    const op = code[pc];
    const kind = this.m.KIND[op];
    const struct = this.m.STRUCT[op];
    if (!kind || !struct) throw new Error(`unknown opcode ${op} at ${pc}`);
    const w = (i) => code[pc + i];
    switch (kind.kind) {
      case "array": return 1 + 2 + w(2);
      case "object": return 1 + 2 + 2 * w(2);
      case "func": return 1 + 7 + 2 * w(5);
      case "call": return 1 + 3 + (w(3) === MAGIC_SPREAD ? 1 : w(3));
      case "mcall": return 1 + 4 + (w(4) === MAGIC_SPREAD ? 1 : w(4));
      case "new": return 1 + 3 + (w(3) === MAGIC_SPREAD ? 1 : w(3));
      default: return 1 + struct.len;
    }
  }

  sweep() {
    const map = new Map();
    let pc = 0;
    while (pc < this.m.code.length) {
      const len = this.instrLen(pc);
      map.set(pc, { pc, op: this.m.code[pc], words: this.m.code.slice(pc + 1, pc + len), len, kind: this.m.KIND[this.m.code[pc]] });
      pc += len;
    }
    return map;
  }

  isTerminator(kind) {
    return ["jump", "dynjump", "branch", "return", "throw", "forinnext"].includes(kind.kind);
  }

  block(pc) {
    if (this.blockCache.has(pc)) return this.blockCache.get(pc);
    const list = [];
    let cur = pc;
    for (;;) {
      const ins = this.instrs.get(cur);
      if (!ins) throw new Error("no instruction at " + cur);
      list.push(ins);
      if (this.isTerminator(ins.kind)) break;
      cur += ins.len;
      if (!this.instrs.has(cur)) break;
    }
    this.blockCache.set(pc, list);
    return list;
  }

  /** A dispatcher trampoline: `call hash(state, k1, k2)` followed by `jump reg`. */
  isDispatchBlock(pc) {
    const b = this.block(pc);
    return b.length >= 2 && b[b.length - 1].kind.kind === "dynjump" && b[b.length - 2].kind.kind === "call";
  }

  /** Register operands an instruction reads, in handler order. */
  srcRegs(ins) {
    const w = ins.words;
    switch (ins.kind.kind) {
      case "array": return w.slice(2);
      case "object": return w.slice(2);
      case "call": return [w[1], ...(w[2] === MAGIC_SPREAD ? w.slice(3, 4) : w.slice(3))];
      case "mcall": return [w[1], w[2], ...(w[3] === MAGIC_SPREAD ? w.slice(4, 5) : w.slice(4))];
      case "new": return [w[1], ...(w[2] === MAGIC_SPREAD ? w.slice(3, 4) : w.slice(3))];
      case "func": return [];
      default: return this.m.STRUCT[ins.op].regSlots.map((s) => w[s]);
    }
  }

  /** Registers a nested function captures by reference from this frame. */
  captures(ins) {
    if (ins.kind.kind !== "func") return [];
    const out = [];
    for (let j = 0; j < ins.words[4]; j++) if (ins.words[7 + j * 2]) out.push(ins.words[8 + j * 2]);
    return out;
  }

  /** Destination register of an instruction (MBA handlers scramble it with a key). */
  destOf(ins, key) {
    const kind = ins.kind.kind;
    if (!WRITES_REGISTER.has(kind)) return null;
    // every handler with a readable body writes the register named by word 0
    if (kind !== "arith") return ins.words[0];
    const ck = ins.pc + ":" + key;
    if (this.destCache.has(ck)) return this.destCache.get(ck);
    const res = this.m.runAt(this.m.code, ins.pc, key, new Array(NREG).fill(0), {});
    const d = res.regWrites.length ? res.regWrites[res.regWrites.length - 1][0] : null;
    this.destCache.set(ck, d);
    return d;
  }

  isPure(ins) {
    return ins.kind.kind === "arith" || ins.kind.kind === "loadimm" || ins.kind.kind === "loadconst" ||
      ins.kind.kind === "void" || ins.kind.kind === "func";
  }

  // --- program walk --------------------------------------------------------

  analyzeProgram() {
    const queue = [{
      entry: this.m.topDesc.m, key: this.m.topDesc.x | 0, desc: this.m.topDesc,
      fnObj: this.m.topFnObj, parent: null, defPc: null, closureMap: [],
    }];
    while (queue.length) {
      const job = queue.shift();
      if (this.functions.has(job.entry)) continue;
      const fn = new FuncAnalysis(this, job);
      this.functions.set(job.entry, fn);
      fn.run();
      for (const child of fn.childFunctions()) {
        if (!this.functions.has(child.entry) && !queue.some((q) => q.entry === child.entry)) queue.push(child);
      }
    }
    return this.functions;
  }
}

/** Probe values used to test whether an operand really influences a result. */
function probeSamples() {
  const out = [0, 1, -1, 2, 3, 9, 16, 255, -256, 65535, 2147483647, -2147483648];
  for (let i = 0; i < 14; i++) out.push((Math.random() * 2 ** 32) | 0);
  for (let i = 0; i < 8; i++) out.push((((Math.random() * 2 ** 32) | 0) & ~15) | 9);
  return out;
}

class FuncAnalysis {
  constructor(analyzer, job) {
    this.a = analyzer;
    this.m = analyzer.m;
    this.entry = job.entry;
    this.key = job.key;
    this.desc = job.desc;
    this.fnObj = job.fnObj;
    this.parent = job.parent;
    this.defPc = job.defPc;
    this.closureMap = job.closureMap;
    this.nodes = new Map();
    this.byPc = new Map();
    this.nextId = 0;
    this.captured = new Set();
  }

  initialState() {
    const st = new Array(NREG).fill(undefined);
    const params = this.desc.d | 0;
    for (let j = 0; j < params; j++) st[j] = TOP;
    if (params < this.desc.Q) st[params] = TOP; // the arguments array
    return st;
  }

  // ---- phase 1: context insensitive, gives the static graph and liveness ----

  runMerged() {
    const inStates = new Map([[this.entry, this.initialState()]]);
    const edges = new Map();
    const queue = [this.entry];
    const blocks = new Set();
    let guard = 0;
    while (queue.length) {
      if (++guard > 100000) throw new Error("merged analysis did not converge");
      const pc = queue.shift();
      blocks.add(pc);
      const res = this.execBlock(pc, inStates.get(pc));
      const succs = [];
      for (const o of res.outcomes) for (const target of o.targets) succs.push({ pc: target, state: o.regs });
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
    for (const pc of blocks) for (const ins of this.a.block(pc)) for (const r of this.a.captures(ins)) this.captured.add(r);
  }

  computeLiveness() {
    const uses = new Map();
    const defs = new Map();
    for (const pc of this.staticBlocks) {
      const u = new Set();
      const d = new Set();
      for (const ins of this.a.block(pc)) {
        for (const r of this.a.srcRegs(ins)) if (!d.has(r)) u.add(r);
        const dest = this.a.destOf(ins, this.key);
        if (dest !== null && !this.a.isTerminator(ins.kind)) d.add(dest);
      }
      uses.set(pc, u);
      defs.set(pc, d);
    }
    const liveIn = new Map();
    for (const pc of this.staticBlocks) liveIn.set(pc, new Set(uses.get(pc)));
    for (let round = 0; round < 500; round++) {
      let changed = false;
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
      if (!changed) break;
    }
    for (const li of liveIn.values()) for (const r of this.captured) li.add(r);
    this.liveIn = liveIn;
    this.defs = defs;
  }

  /** Registers written only by MBA opcodes: the flattening state and its helpers. */
  computeDefKinds() {
    const plain = new Set();
    const mba = new Set();
    for (const pc of this.staticBlocks) {
      for (const ins of this.a.block(pc)) {
        if (this.a.isTerminator(ins.kind)) continue;
        const d = this.a.destOf(ins, this.key);
        if (d === null) continue;
        (ins.kind.kind === "arith" ? mba : plain).add(d);
      }
    }
    this.stateRegs = new Set([...mba].filter((r) => !plain.has(r)));
  }

  // ---- phase 2: path sensitive ----

  run() {
    this.runMerged();
    this.computeLiveness();
    this.computeDefKinds();
    this.widened = new Set(this.captured); // aliased through closures, never assume a value
    for (let attempt = 0; attempt < 64; attempt++) {
      this.nodes = new Map();
      this.byPc = new Map();
      this.nextId = 0;
      this.overflow = null;
      this.runPass();
      if (!this.overflow) return;
      const { pc, list } = this.overflow;
      let best = null;
      for (const r of this.liveIn.get(pc) || []) {
        if (this.widened.has(r)) continue;
        const distinct = new Set(list.map((n) => n.state[r])).size;
        const cand = { r, distinct, state: this.stateRegs.has(r) };
        if (!best) { best = cand; continue; }
        if (best.state !== cand.state) { if (best.state) best = cand; continue; }
        if (cand.distinct > best.distinct) best = cand;
      }
      if (!best || best.distinct < 3) return;
      this.widened.add(best.r);
    }
  }

  runPass() {
    this.startNode = this.getNode(this.entry, this.initialState());
    const queue = [this.startNode];
    let guard = 0;
    while (queue.length) {
      if (++guard > 60000) throw new Error("analysis did not converge in function @" + this.entry);
      const node = queue.shift();
      if (node.analyzed) continue;
      node.analyzed = true;
      const res = this.execBlock(node.pc, node.state);
      node.instrs = res.instrs;
      node.values = res.values;
      node.inputs = res.inputs;
      node.dests = res.dests;
      node.term = res.term;
      node.outcomes = res.outcomes;
      node.succ = [];
      for (const o of res.outcomes) {
        o.nodes = o.targets.map((target) => {
          const n = this.getNode(target, o.regs);
          node.succ.push(n);
          return n;
        });
      }
      // a predicate that leads to the same place either way is not a branch
      if (node.outcomes.length === 2 && node.outcomes.every((o) => o.kind === "goto" && o.nodes.length === 1) &&
          node.outcomes[0].nodes[0] === node.outcomes[1].nodes[0]) {
        node.outcomes = [node.outcomes[0]];
        node.outcomes[0].split = null;
      }
      for (const s of node.succ) if (!s.analyzed && !queue.includes(s)) queue.push(s);
    }
  }

  stateKey(pc, state) {
    const live = this.liveIn.get(pc);
    const regs = live ? [...live].sort((a, b) => a - b) : state.map((_, i) => i);
    const parts = [];
    for (const r of regs) {
      const v = state[r];
      parts.push(r + "=" + (v === TOP ? "?" : typeof v === "function" || (v && typeof v === "object") ? "#" + objectId(v) : typeof v + ":" + String(v)));
    }
    return parts.join(",");
  }

  getNode(pc, state) {
    if (this.widened.size) {
      state = state.slice();
      for (const r of this.widened) state[r] = TOP;
    }
    let list = this.byPc.get(pc);
    if (!list) { list = []; this.byPc.set(pc, list); }
    const key = this.stateKey(pc, state);
    for (const n of list) if (n.key === key) return n;
    if (list.length >= 40) {
      if (!this.overflow) this.overflow = { pc, list };
      const n = list[0];
      const merged = mergeStates(n.state, state);
      if (!sameState(n.state, merged)) { n.state = merged; n.analyzed = false; }
      return n;
    }
    const node = { id: this.nextId++, pc, key, state: state.slice(), analyzed: false, succ: [], fn: this };
    list.push(node);
    this.nodes.set(node.id, node);
    return node;
  }

  execBlock(pc, inState) {
    const instrs = this.a.block(pc);
    const values = new Map();
    const dests = new Map();
    const inputs = new Map();
    let paths = [{ regs: inState.slice(), split: null }];

    for (const ins of instrs) {
      const srcs = this.a.srcRegs(ins);
      const dest = this.a.destOf(ins, this.key);
      dests.set(ins.pc, dest);
      if (paths.length) {
        const snapshot = new Map();
        for (const r of new Set(srcs)) snapshot.set(r, paths[0].regs[r]);
        inputs.set(ins.pc, snapshot);
      }
      if (this.a.isTerminator(ins.kind)) continue;

      const next = [];
      for (const p of paths) {
        const known = srcs.every((r) => p.regs[r] !== TOP);
        if (known && this.a.isPure(ins)) {
          const res = this.m.runAt(this.m.code, ins.pc, this.key, p.regs, { fnObj: this.fnObj });
          if (!res.error && res.regWrites.length) {
            const [d, v] = res.regWrites[res.regWrites.length - 1];
            p.regs[d] = v;
            if (paths.length === 1) values.set(ins.pc, v);
            next.push(p);
            continue;
          }
        }
        // MBA opcodes carry junk operands; when the result does not depend on the
        // unknown ones it is really a concealed constant, so fold it.
        if (!known && ins.kind.kind === "arith" && dest !== null) {
          const folded = this.invariantValue(ins, p.regs, srcs.filter((r) => p.regs[r] === TOP));
          if (folded.ok) {
            p.regs[dest] = folded.value;
            if (paths.length === 1) values.set(ins.pc, folded.value);
            next.push(p);
            continue;
          }
        }
        if (dest === null) { next.push(p); continue; }
        if (this.m.RESTYPE[ins.op] === "boolean" && !p.split && paths.length === 1) {
          const whenFalse = { regs: p.regs.slice(), split: { reg: dest, pc: ins.pc, value: false } };
          const whenTrue = { regs: p.regs.slice(), split: { reg: dest, pc: ins.pc, value: true } };
          whenFalse.regs[dest] = false;
          whenTrue.regs[dest] = true;
          next.push(whenFalse, whenTrue);
        } else {
          p.regs[dest] = TOP;
          next.push(p);
        }
      }
      paths = next;
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

  invariantValue(ins, regs, unknown) {
    const samples = probeSamples();
    let first;
    for (let i = 0; i < samples.length; i++) {
      const probe = regs.slice();
      for (const u of unknown) probe[u] = samples[(i + u) % samples.length];
      for (let j = 0; j < NREG; j++) if (probe[j] === TOP) probe[j] = samples[(i + j) % samples.length];
      const res = this.m.runAt(this.m.code, ins.pc, this.key, probe, { fnObj: this.fnObj });
      if (res.error || !res.regWrites.length) return { ok: false };
      const v = res.regWrites[res.regWrites.length - 1][1];
      if (i === 0) first = v;
      else if (!Object.is(first, v)) return { ok: false };
    }
    return { ok: true, value: first };
  }

  resolveTerm(term, path) {
    const w = term.words;
    switch (term.kind.kind) {
      case "return": return { kind: "return", reg: w[0], targets: [] };
      case "throw": return { kind: "throw", reg: w[0], targets: [] };
      case "branch": return { kind: "branch", reg: w[0], whenFalse: term.kind.whenFalse, targets: [w[1], term.pc + term.len] };
      case "forinnext": return { kind: "forinnext", dest: w[0], iter: w[1], targets: [w[2], term.pc + term.len] };
      case "jump": {
        const target = w[0];
        if (this.a.isDispatchBlock(target)) return this.resolveDispatch(target, path);
        return { kind: "goto", targets: [target] };
      }
      case "dynjump": {
        const v = path.regs[w[0]];
        if (typeof v !== "number") return { kind: "dynamic", targets: [] };
        return { kind: "goto", targets: [v] };
      }
      default: return { kind: "goto", targets: [term.pc + term.len] };
    }
  }

  /** Evaluates the dispatcher call that computes the next block address. */
  resolveDispatch(dispPc, path) {
    const b = this.a.block(dispPc);
    const call = b[b.length - 2];
    const callee = path.regs[call.words[1]];
    const args = call.words.slice(3).map((r) => path.regs[r]);
    if (typeof callee !== "function" || args.some((x) => x === TOP)) return { kind: "dynamic", targets: [], dispPc };
    let target;
    try {
      target = callee(...args);
    } catch (e) {
      return { kind: "dynamic", targets: [], dispPc };
    }
    if (typeof target !== "number" || !this.a.instrs.has(target)) return { kind: "dynamic", targets: [], dispPc };
    return { kind: "goto", targets: [target], dispPc };
  }

  /** Nested functions defined by this function, with their closure mapping. */
  childFunctions() {
    const out = [];
    const seen = new Set();
    for (const node of this.nodes.values()) {
      if (!node.instrs) continue;
      for (const ins of node.instrs) {
        if (ins.kind.kind !== "func" || seen.has(ins.words[1])) continue;
        seen.add(ins.words[1]);
        const res = this.m.runAt(this.m.code, ins.pc, this.key, new Array(NREG).fill(undefined), { fnObj: this.fnObj });
        if (res.error || !res.regWrites.length) continue;
        const jsFn = res.regWrites[res.regWrites.length - 1][1];
        const record = this.m.fnRecords ? this.m.fnRecords.get(jsFn) : null;
        if (!record) continue;
        const closureMap = [];
        for (let j = 0; j < ins.words[4]; j++) {
          const isNew = ins.words[7 + j * 2];
          const v = ins.words[8 + j * 2];
          closureMap.push(isNew ? { fn: this.entry, reg: v } : this.closureMap[v]);
        }
        out.push({ entry: ins.words[1], key: record.C.x | 0, desc: record.C, fnObj: record, parent: this.entry, defPc: ins.pc, closureMap });
      }
    }
    return out;
  }
}

let objectIds = new WeakMap();
let objectIdSeq = 0;
function objectId(o) {
  if (!objectIds.has(o)) objectIds.set(o, ++objectIdSeq);
  return objectIds.get(o);
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

module.exports = { Analyzer, FuncAnalysis, TOP };
