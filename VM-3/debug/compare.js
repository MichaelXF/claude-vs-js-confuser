// debug/compare.js — run input.js and a candidate output side by side in an
// identical fake-DOM sandbox and diff what they produce.
const fs = require("fs");
const path = require("path");
const vmMod = require("node:vm");

function makeSandbox(seed) {
  const log = [];
  let now = 1700000000000;
  let rnd = seed;
  const random = () => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff;
  };
  const mkEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    offsetWidth: 140,
    offsetHeight: 32,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    textContent: "",
    innerHTML: "",
  });
  const document = {
    createElement: mkEl,
    createTextNode: (s) => ({ nodeValue: s }),
    body: mkEl("body"),
    head: mkEl("head"),
    documentElement: mkEl("html"),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const win = { document, location: { href: "http://localhost/" },
    navigator: { userAgent: "node" }, addEventListener() {},
    setTimeout: () => 0, clearTimeout: () => {} };
  const MathStub = Object.create(Math);
  MathStub.random = random;
  const DateStub = function (...a) { return new Date(...a); };
  DateStub.now = () => (now += 7);
  DateStub.prototype = Date.prototype;
  const sandbox = {
    console: { log: (...a) => log.push(["log", ...a]), error: (...a) => log.push(["error", ...a]) },
    window: win, document,
    Math: MathStub, Date: DateStub,
    JSON, Object, Array, String, Number, Boolean, Reflect, RegExp, Symbol,
    Error, TypeError, ReferenceError, SyntaxError, RangeError,
    Function, Promise, Map, Set, WeakMap, WeakSet, Buffer, Proxy,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    escape: typeof escape === "function" ? escape : undefined,
    unescape: typeof unescape === "function" ? unescape : undefined,
    __log: log,
  };
  sandbox.globalThis = sandbox;
  win.window = win;
  return sandbox;
}

function run(code, label) {
  const sandbox = makeSandbox(12345);
  vmMod.createContext(sandbox);
  const result = { label, log: sandbox.__log, error: null, calls: [] };
  try {
    vmMod.runInContext(code, sandbox, { timeout: 120000, filename: label });
  } catch (e) {
    result.error = String(e && e.message);
    return result;
  }
  const exported = Object.keys(sandbox.window)
    .filter((k) => typeof sandbox.window[k] === "function" && /^_/.test(k));
  for (const name of exported) {
    for (const args of [[], ["hello world"], ["abc", 5], [""], [12345]]) {
      try {
        const r = vmMod.runInContext(
          `(function(){ return window[${JSON.stringify(name)}].apply(null, ${JSON.stringify(args)}); })()`,
          sandbox, { timeout: 120000 });
        result.calls.push([name, args, safe(r)]);
      } catch (e) {
        result.calls.push([name, args, "THROW: " + String(e && e.message)]);
      }
    }
  }
  result.exported = exported;
  return result;
}

function safe(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

const a = run(fs.readFileSync(process.argv[2], "utf8"), process.argv[2]);
const b = run(fs.readFileSync(process.argv[3], "utf8"), process.argv[3]);

const sa = JSON.stringify({ log: a.log, calls: a.calls, error: a.error, exported: a.exported }, null, 1);
const sb = JSON.stringify({ log: b.log, calls: b.calls, error: b.error, exported: b.exported }, null, 1);

if (sa === sb) {
  console.log("IDENTICAL BEHAVIOUR");
  console.log(sa.slice(0, 1500));
  process.exit(0);
}
console.log("--- A:", process.argv[2]);
console.log(sa.slice(0, 3000));
console.log("--- B:", process.argv[3]);
console.log(sb.slice(0, 3000));
process.exit(1);
