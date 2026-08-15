// Runs the real VM, calls the exported function, and traces the pcs executed.
const path = require("path");
const { load } = require("./harness");
const { makeShim } = require("./dom-shim");

const { exports: ex, entryCall } = load(path.join(__dirname, "..", "input.js"));
const { g, A, r } = ex;
const vm = entryCall[0];
const shim = makeShim([]);
vm.k.window = shim.window;
vm.k.document = shim.document;

const trace = [];
const proto = Object.getPrototypeOf(vm);
let tracing = false;
for (const op of Object.getOwnPropertyNames(proto).filter((k) => /^\d+$/.test(k))) {
  const orig = proto[op];
  Object.defineProperty(proto, op, {
    value: function () { if (tracing) trace.push(this.g[this.h + 0] - 1); return orig.call(this); },
    writable: true, configurable: true,
  });
}

A(vm, entryCall[1], entryCall[2], entryCall[3], entryCall[4]);
const keys = Object.keys(shim.window).filter((k) => k.startsWith("_"));
console.log("exported globals:", keys);
const fn = shim.window[keys[0]];
console.log("typeof:", typeof fn);

tracing = true;
let out;
try {
  out = fn("hello world");
} catch (e) {
  console.log("call threw:", e.message);
}
tracing = false;
console.log("result:", JSON.stringify(out));
console.log("trace length:", trace.length);
// compress into block-entry sequence
const seq = [];
for (const pc of trace) if (!seq.length || seq[seq.length - 1] !== pc) seq.push(pc);
console.log("first 120 pcs:", seq.slice(0, 120).join(" "));

// Also try calling with different arg shapes
for (const arg of [undefined, 0, "abc", [1, 2], { a: 1 }]) {
  try { console.log("fn(", JSON.stringify(arg), ") =", JSON.stringify(fn(arg))); }
  catch (e) { console.log("fn(", JSON.stringify(arg), ") threw", e.message); }
}
