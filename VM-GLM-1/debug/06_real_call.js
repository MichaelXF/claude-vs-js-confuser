// REAL call test: actually execute window._k1crlxlk2w8() (no Proxy interception)
// usage: node debug/06_real_call.js input.js|output.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = process.argv[2] || "output.js";
const log = [];
const divs = [];
const makeDiv = () => {
  const d = {
    style: {},
    children: [],
    appendChild(c) { this.children.push(c); return c; },
  };
  let w = 0;
  Object.defineProperty(d, "offsetWidth", { get() { return 140; } });
  divs.push(d);
  return d;
};
const documentShim = {
  createElement: (tag) => { log.push(`createElement(${tag})`); return makeDiv(); },
  body: { appendChild(c) { log.push(`body.appendChild(${c && c.style ? "div" : c})`); return c; } },
  getElementById: () => null,
  addEventListener: () => {},
};
const sandbox = {
  console: { log: (...a) => log.push("console.log " + a.join(" ")), error: console.error, warn: () => {}, info: () => {} },
  document: documentShim,
  Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise, Symbol, parseInt, parseFloat, isNaN, isFinite,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  setTimeout: (fn) => 0,
  setInterval: () => 0,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.console = sandbox.console;
const ctx = vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
try {
  vm.runInContext(src, ctx, { timeout: 10000 });
  log.push("--- loaded ---");
} catch (e) {
  log.push("LOAD THREW: " + (e && e.message));
}
const t0 = Date.now();
try {
  const r = vm.runInContext("window._k1crlxlk2w8()", ctx, { timeout: 10000 });
  log.push(`first call -> ${String(r)} (${Date.now() - t0}ms)`);
} catch (e) {
  log.push(`first call THREW/TIMEOUT: ${e && e.message} (${Date.now() - t0}ms)`);
}
const t1 = Date.now();
try {
  const r = vm.runInContext("window._k1crlxlk2w8()", ctx, { timeout: 10000 });
  log.push(`second call -> ${String(r)} (${Date.now() - t1}ms)`);
} catch (e) {
  log.push(`second call THREW/TIMEOUT: ${e && e.message} (${Date.now() - t1}ms)`);
}
const bodyChildren = (documentShim.body && documentShim.body.children && documentShim.body.children.length) || 0;
log.push(`divs created: ${divs.length}, div0.style.width=${JSON.stringify(divs[0] && divs[0].style.width)}, body children: ${bodyChildren}`);
console.log(log.join("\n"));
