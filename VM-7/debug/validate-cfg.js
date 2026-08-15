// Validates the recovered CFG: every block transition the real VM performs must
// exist as an edge in the analyzed graph.
const path = require("path");
const { load } = require("./harness");
const { makeShim } = require("./dom-shim");
const A = require("./analyze");
const M = require("./vmmodel2");

const { exports: ex, entryCall } = load(path.join(__dirname, "..", "input.js"));
const vm = entryCall[0];
const shim = makeShim([]);
vm.k.window = shim.window;
vm.k.document = shim.document;

const proto = Object.getPrototypeOf(vm);
let tracing = false;
const trace = [];
for (const op of Object.getOwnPropertyNames(proto).filter((k) => /^\d+$/.test(k))) {
  const orig = proto[op];
  Object.defineProperty(proto, op, {
    value: function () { if (tracing) trace.push([this.g[this.h + 0] - 1, this.h]); return orig.call(this); },
    writable: true, configurable: true,
  });
}
tracing = true;
ex.A(vm, entryCall[1], entryCall[2], entryCall[3], entryCall[4]);
const fn = shim.window["_k1crlxlk2w8"];
for (const a of [["hello world"], [""], ["abc"], [123], [{}], [null]]) { try { fn(...a); } catch (e) {} }
tracing = false;

const funcs = A.analyzeProgram();
const analysisBlocks = new Set();
const edges = new Set();
for (const [, fa] of funcs) {
  for (const n of fa.nodes.values()) {
    if (!n.analyzed) continue;
    analysisBlocks.add(n.pc);
    for (const o of n.outcomes) for (const t of o.nodes || []) edges.add(n.pc + "->" + t.pc);
  }
}

// Replay the trace, recording block-level transitions (dispatch blocks are transparent).
const observed = new Set();
const obsBlocks = new Set();
const state = new Map(); // frame -> {block, lastPc, pendingSrc}
for (const [pc, h] of trace) {
  let st = state.get(h);
  if (!st) { st = { block: pc, lastPc: null, pendingSrc: null }; state.set(h, st); }
  const lastIns = st.lastPc !== null ? A.INSTRS.get(st.lastPc) : null;
  const lastWasTerm = lastIns && A.TERMINATORS.has(lastIns.op);
  if (lastWasTerm) {
    const isDispatch = A.isDispatchBlock(pc) || (st.pendingSrc && !analysisBlocks.has(pc));
    if (A.isDispatchBlock(pc)) {
      st.pendingSrc = st.pendingSrc || st.block;
    } else {
      const src = st.pendingSrc || st.block;
      st.pendingSrc = null;
      if (analysisBlocks.has(pc) || true) observed.add(src + "->" + pc);
      st.block = pc;
    }
  }
  if (!st.pendingSrc) obsBlocks.add(st.block);
  st.lastPc = pc;
}

// A frame slot is reused across calls, so trace-level transitions that cross a
// function boundary are artifacts of the replay, not real edges.
const fnOf = new Map();
for (const [entry, fa] of funcs) for (const pc of fa.staticBlocks) if (!fnOf.has(pc)) fnOf.set(pc, entry);
let missing = 0;
for (const e of [...observed].sort()) {
  const [a, b] = e.split("->").map(Number);
  if (fnOf.get(a) !== fnOf.get(b)) continue;
  if (!edges.has(e)) { missing++; console.log("EDGE MISSING:", e); }
}
let missBlocks = 0;
for (const b of obsBlocks) if (!analysisBlocks.has(b)) { missBlocks++; console.log("BLOCK MISSING:", b); }
console.log(`observed blocks ${obsBlocks.size} / analysis ${analysisBlocks.size}; observed edges ${observed.size} / analysis ${edges.size}`);
console.log(missing === 0 && missBlocks === 0 ? "OK: analysis covers all observed control flow" : `MISMATCH: ${missBlocks} blocks, ${missing} edges`);
