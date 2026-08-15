// Executes the VM with instrumentation: logs every dispatched (pc, opcode) and
// every global-object property access made by the program.
const path = require("path");
const { load } = require("./harness");

const { exports: ex, entryCall } = load(path.join(__dirname, "..", "input.js"));
const { g, A, B, r } = ex;
const vm = entryCall[0];

const { makeShim } = require("./dom-shim");
const domLog = [];
const shim = makeShim(domLog);
vm.k.window = shim.window;
vm.k.document = shim.document;
for (const k of ["alert", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch", "localStorage", "navigator", "location", "XMLHttpRequest", "screen"]) vm.k[k] = shim.window[k];

const globalReads = [];
const realGlobal = vm.k;
const proxyGlobal = new Proxy(realGlobal, {
  has(t, p) { globalReads.push(["has", String(p)]); return Reflect.has(t, p); },
  get(t, p) { globalReads.push(["get", String(p)]); return Reflect.get(t, p); },
  set(t, p, v) { globalReads.push(["set", String(p)]); return Reflect.set(t, p, v); },
});
vm.k = proxyGlobal;

const trace = [];
const proto = Object.getPrototypeOf(vm);
const opcodes = Object.getOwnPropertyNames(proto).filter((k) => /^\d+$/.test(k));
for (const op of opcodes) {
  const orig = proto[op];
  Object.defineProperty(proto, op, {
    value: function () {
      trace.push([this.g[this.h + 0] - 1, +op, this.h]);
      return orig.call(this);
    },
    writable: true, configurable: true,
  });
}

let result, err;
try {
  result = A(vm, entryCall[1], entryCall[2], entryCall[3], entryCall[4]);
} catch (e) {
  err = e;
}
console.log("steps:", trace.length, "result:", result, "err:", err && err.message);
console.log("first 80 steps (pc, op, frame):");
for (const t of trace.slice(0, 80)) console.log(" ", t.join("\t"));
console.log("global accesses:", globalReads.length);
const seen = new Set();
for (const gr of globalReads) {
  const k = gr.join(" ");
  if (!seen.has(k)) { seen.add(k); console.log("  ", k); }
}
const counts = new Map();
for (const t of trace) counts.set(t[1], (counts.get(t[1]) || 0) + 1);
console.log("opcode use counts:", [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([o, c]) => o + ":" + c).join(" "));
console.log("distinct opcodes executed:", counts.size, "of", opcodes.length);
