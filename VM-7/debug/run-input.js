// Runs input.js with a tiny browser-ish shim so we can observe the sample's behavior.
const fs = require("fs");
const path = require("path");
const vmMod = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");

const log = [];
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    attributes: {},
    textContent: "",
    innerHTML: "",
    className: "",
    setAttribute(k, v) { this.attributes[k] = v; log.push(["setAttribute", this.tagName, k, v]); },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(c) { this.children.push(c); log.push(["appendChild", this.tagName, c && c.tagName]); return c; },
    addEventListener(t, fn) { log.push(["addEventListener", this.tagName, t]); (this._ev || (this._ev = {}))[t] = fn; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add(...a) { log.push(["classList.add", ...a]); }, remove(...a) {}, toggle() {}, contains() { return false; } },
  };
  return el;
}
const document = {
  body: makeEl("body"),
  head: makeEl("head"),
  documentElement: makeEl("html"),
  createElement: (t) => { log.push(["createElement", t]); return makeEl(t); },
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  getElementById: (id) => { log.push(["getElementById", id]); return null; },
  querySelector: (s) => { log.push(["querySelector", s]); return null; },
  querySelectorAll: (s) => { log.push(["querySelectorAll", s]); return []; },
  addEventListener: (t) => { log.push(["document.addEventListener", t]); },
  write: (s) => log.push(["document.write", s]),
};
const windowObj = {
  document,
  location: { href: "https://example.com/", hostname: "example.com", protocol: "https:", search: "" },
  navigator: { userAgent: "node", language: "en-US" },
  alert: (m) => log.push(["alert", m]),
  addEventListener: (t) => log.push(["window.addEventListener", t]),
  setTimeout: (fn, t) => log.push(["setTimeout", t]),
  setInterval: () => log.push(["setInterval"]),
  localStorage: { getItem: (k) => { log.push(["localStorage.getItem", k]); return null; }, setItem: (k, v) => log.push(["localStorage.setItem", k, v]) },
  fetch: (...a) => { log.push(["fetch", ...a]); return Promise.resolve({ json: () => Promise.resolve({}) }); },
  console,
  Math, JSON, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Symbol, Map, Set, WeakMap,
  parseInt, parseFloat, isNaN, isFinite,
};

const sandbox = Object.assign(Object.create(null), windowObj, {
  window: windowObj,
  document,
  Uint8Array, Uint32Array, Buffer,
  atob: (b) => Buffer.from(b, "base64").toString("binary"),
  TypeError, ReferenceError, SyntaxError, RangeError, Function, Proxy, Reflect, Infinity, NaN,
});
sandbox.globalThis = sandbox;
windowObj.globalThis = sandbox;
vmMod.createContext(sandbox);
try {
  vmMod.runInContext(src, sandbox, { filename: "input.js" });
} catch (e) {
  console.log("THREW:", e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e);
}
console.log("--- log ---");
for (const l of log) console.log(l.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" | "));
console.log("--- sandbox new globals ---");
for (const k of Object.keys(sandbox)) if (!(k in windowObj) && !["window", "document", "globalThis", "Uint8Array", "Uint32Array", "Buffer", "atob", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "Function", "Proxy", "Reflect", "Infinity", "NaN"].includes(k)) console.log(k, "=", typeof sandbox[k]);
