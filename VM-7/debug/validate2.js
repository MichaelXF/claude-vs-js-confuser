// Validates lib/analyze.js against the real VM: every block transition the VM
// actually performs must exist in the recovered graph.
const fs = require("fs");
const path = require("path");
const { inspect, loadSample, Machine } = require("../lib/machine");
const { Analyzer } = require("../lib/analyze");
const { makeShim } = require("./dom-shim");

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const src = fs.readFileSync(file, "utf8");
const info = inspect(src);
const loaded = loadSample(info.ast, info.entryStmt, file);
const m = new Machine(loaded);
const a = new Analyzer(m);
const funcs = a.analyzeProgram();

// run the untouched sample separately so tracing sees a pristine machine
const info2 = inspect(fs.readFileSync(file, "utf8"));
const loaded2 = loadSample(info2.ast, info2.entryStmt, file);
const vm = loaded2.entryArgs[0];
const shim = makeShim([]);
vm.k.window = shim.window;
vm.k.document = shim.document;
const proto = Object.getPrototypeOf(vm);
const trace = [];
let tracing = false;
for (const op of Object.getOwnPropertyNames(proto).filter((k) => /^\d+$/.test(k))) {
  const orig = proto[op];
  Object.defineProperty(proto, op, {
    value: function () { if (tracing) trace.push([this.g[this.h + 0] - 1, this.h]); return orig.call(this); },
    writable: true, configurable: true,
  });
}
tracing = true;
const runner = loaded2.exports[loaded2.runnerName];
runner(vm, loaded2.entryArgs[1], loaded2.entryArgs[2], loaded2.entryArgs[3], loaded2.entryArgs[4]);
for (const key of Object.keys(shim.window)) {
  if (typeof shim.window[key] === "function" && key.startsWith("_")) {
    for (const arg of [["hello world"], [""], ["abc"], [123], [{}], [null], ["a longer string to decode"]]) {
      try { shim.window[key](...arg); } catch (e) {}
    }
  }
}
tracing = false;

const analysisBlocks = new Set();
const edges = new Set();
const fnOf = new Map();
for (const [entry, fn] of funcs) {
  for (const pc of fn.staticBlocks) if (!fnOf.has(pc)) fnOf.set(pc, entry);
  for (const n of fn.nodes.values()) {
    if (!n.analyzed) continue;
    analysisBlocks.add(n.pc);
    for (const o of n.outcomes) for (const s of o.nodes || []) edges.add(n.pc + "->" + s.pc);
  }
}

const observed = new Set();
const obsBlocks = new Set();
const state = new Map();
for (const [pc, h] of trace) {
  let st = state.get(h);
  if (!st) { st = { block: pc, lastPc: null, pending: null }; state.set(h, st); }
  const last = st.lastPc !== null ? a.instrs.get(st.lastPc) : null;
  if (last && a.isTerminator(last.kind)) {
    if (a.isDispatchBlock(pc)) st.pending = st.pending || st.block;
    else {
      observed.add((st.pending || st.block) + "->" + pc);
      st.pending = null;
      st.block = pc;
    }
  }
  if (!st.pending) obsBlocks.add(st.block);
  st.lastPc = pc;
}

let missingEdges = 0;
for (const e of [...observed].sort()) {
  const [from, to] = e.split("->").map(Number);
  if (fnOf.get(from) !== fnOf.get(to)) continue; // frame reuse across calls
  if (!edges.has(e)) { missingEdges++; console.log("EDGE MISSING:", e); }
}
let missingBlocks = 0;
for (const b of obsBlocks) if (!analysisBlocks.has(b)) { missingBlocks++; console.log("BLOCK MISSING:", b); }
console.log(`traced ${trace.length} instructions; observed ${obsBlocks.size} blocks / ${observed.size} transitions`);
console.log(`analysis: ${analysisBlocks.size} blocks / ${edges.size} edges`);
console.log(missingEdges === 0 && missingBlocks === 0 ? "OK: recovered CFG covers all observed control flow" : `MISMATCH: ${missingBlocks} blocks, ${missingEdges} edges`);
