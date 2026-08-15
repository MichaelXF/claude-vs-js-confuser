// Runs input.js and output.js side by side in identical deterministic sandboxes
// and compares everything they observably do.
const fs = require("fs");
const path = require("path");
const nodeVm = require("vm");

function makeSandbox(log) {
  let counter = 0;
  const rand = (() => { let seed = 12345; return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; })();
  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: new Proxy({}, { set(o, k, v) { log.push(["style", tag, String(k), String(v)]); o[k] = v; return true; } }),
      offsetWidth: 140,
      children: [],
      appendChild(c) { log.push(["appendChild", this.tagName, c && c.tagName]); this.children.push(c); return c; },
      setAttribute(k, v) { log.push(["setAttribute", k, String(v)]); },
      addEventListener(type) { log.push(["addEventListener", this.tagName, type]); },
    };
    return el;
  };
  const document = {
    body: makeEl("body"),
    head: makeEl("head"),
    createElement: (tag) => { log.push(["createElement", tag]); return makeEl(tag); },
    getElementById: (id) => { log.push(["getElementById", id]); return null; },
    querySelector: (s) => { log.push(["querySelector", s]); return null; },
    addEventListener: (type) => log.push(["document.addEventListener", type]),
  };
  const windowObj = {
    document,
    location: { href: "https://example.com/", hostname: "example.com" },
    navigator: { userAgent: "test" },
    setTimeout: (fn, ms) => { log.push(["setTimeout", ms]); return 0; },
    alert: (m) => log.push(["alert", String(m)]),
    addEventListener: (type) => log.push(["window.addEventListener", type]),
  };
  const sandbox = {
    window: windowObj,
    document,
    console: { log: (...args) => log.push(["console.log", ...args.map((a) => (typeof a === "string" ? a : String(a)))]) },
    Math: Object.assign(Object.create(Math), { random: () => { log.push(["Math.random"]); return rand(); } }),
    Date: Object.assign(function Date2() {}, { now: () => { counter += 1000; log.push(["Date.now"]); return 1700000000000 + counter; } }),
    JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Promise, Symbol, Map, Set, WeakMap,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Uint8Array, Uint32Array, Buffer, Infinity, NaN, undefined: undefined,
    Reflect, Proxy, Function,
    atob: (b) => Buffer.from(String(b), "base64").toString("binary"),
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
  };
  sandbox.globalThis = sandbox;
  windowObj.window = windowObj;
  windowObj.console = sandbox.console;
  windowObj.Math = sandbox.Math;
  windowObj.Date = sandbox.Date;
  return sandbox;
}

function run(file) {
  const log = [];
  const sandbox = makeSandbox(log);
  nodeVm.createContext(sandbox);
  try {
    nodeVm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file, timeout: 20000 });
  } catch (e) {
    log.push(["THREW at load", e.message]);
  }
  const exported = Object.keys(sandbox.window).filter((k) => typeof sandbox.window[k] === "function" && k.startsWith("_"));
  log.push(["exports", exported.join(",")]);
  for (const name of exported) {
    for (const args of [[], ["hello"], [123], [null]]) {
      try {
        const result = sandbox.window[name](...args);
        log.push(["call", name, JSON.stringify(args), "->", String(result)]);
      } catch (e) {
        log.push(["call", name, JSON.stringify(args), "THREW", e.message]);
      }
    }
  }
  return log;
}

const a = run(path.join(__dirname, "..", "input.js"));
const b = run(path.join(__dirname, "..", "output.js"));

let diff = 0;
const max = Math.max(a.length, b.length);
for (let i = 0; i < max; i++) {
  const x = JSON.stringify(a[i]);
  const y = JSON.stringify(b[i]);
  if (x !== y) { diff++; console.log(`#${i}\n  input : ${x}\n  output: ${y}`); }
}
console.log(`\ninput.js produced ${a.length} events, output.js produced ${b.length}`);
console.log(diff === 0 ? "IDENTICAL BEHAVIOR" : `${diff} DIFFERENCES`);
process.exit(diff === 0 ? 0 : 1);
