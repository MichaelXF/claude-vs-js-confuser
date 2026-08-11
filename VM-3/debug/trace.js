// debug/trace.js — run the original VM under a fake DOM and log the executed pcs
const fs = require("fs");
const path = require("path");
const vmMod = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");

// patch the dispatch loop so every executed opcode address is recorded
const marker = "e=a.i[c];try{a[e]()}";
if (!src.includes(marker)) throw new Error("dispatch loop shape changed");
const patched = src.replace(marker, "e=a.i[c];__trace(c,a);try{a[e]()}");

const trace = [];
const frames = [];
const sandbox = makeSandbox();
const states = new Map();   // pc -> Set of "r31|r33"
const WATCH = [302];
sandbox.__trace = (pc, vm) => {
  if (trace.length < 4000000) trace.push(pc);
  if (WATCH.includes(pc)) {
    const base = vm.g[vm.w + 3];
    const key = vm.g[base + 31] + "|" + vm.g[base + 33];
    if (!states.has(pc)) states.set(pc, new Set());
    states.get(pc).add(key);
  }
};
vmMod.createContext(sandbox);
try {
  vmMod.runInContext(patched, sandbox, { timeout: 60000 });
} catch (e) {
  console.log("run error:", e.message);
}

// the top level only exports a function onto `window`; call it to see real work
const exported = Object.keys(sandbox.window).filter((k) => typeof sandbox.window[k] === "function" && k.startsWith("_"));
console.log("exported globals:", exported);
let result;
for (const name of exported) {
  try {
    result = vmMod.runInContext(`window[${JSON.stringify(name)}]()`, sandbox, { timeout: 60000 });
    console.log("called", name, "->", typeof result, JSON.stringify(result)?.slice(0, 400));
  } catch (e) { console.log("call error:", e.message); }
}
console.log("executed instructions:", trace.length);
const counts = new Map();
for (const pc of trace) counts.set(pc, (counts.get(pc) || 0) + 1);
console.log("distinct pcs:", counts.size);
const hot = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log("hottest:", JSON.stringify(hot));
console.log("first 40 pcs:", trace.slice(0, 40).join(" "));
// how many times does the dispatcher entry (pc 302) run?
console.log("visits to 302:", counts.get(302) || 0);
for (const [pc, set] of states) console.log("distinct (r31,r33) at", pc, "=", set.size);
fs.writeFileSync(path.join(__dirname, "trace-pcs.json"), JSON.stringify(trace));
console.log("logged output:", JSON.stringify(sandbox.__log.slice(0, 20), null, 1));

function makeSandbox() {
  const log = [];
  const mkEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {},
      children: [],
      offsetWidth: 140,
      appendChild(c) { this.children.push(c); return c; },
      setAttribute() {},
      addEventListener() {},
      textContent: "",
      innerHTML: "",
    };
    return el;
  };
  const document = {
    createElement: mkEl,
    createTextNode: (s) => ({ nodeValue: s }),
    body: mkEl("body"),
    documentElement: mkEl("html"),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
  };
  const win = {
    document,
    location: { href: "http://localhost/" },
    navigator: { userAgent: "node" },
    setTimeout: (f) => f && 0,
    addEventListener() {},
    console: { log: (...a) => log.push(a) },
  };
  const sandbox = {
    console: { log: (...a) => log.push(a), error: (...a) => log.push(a) },
    window: win,
    document,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Reflect,
    RegExp, Error, TypeError, ReferenceError, Function, Symbol, Promise, Map, Set,
    WeakMap, WeakSet, Buffer, parseInt, parseFloat, isNaN, isFinite,
    __log: log,
  };
  sandbox.globalThis = sandbox;
  win.window = win;
  return sandbox;
}
