// Run input.js with browser-ish globals stubbed, capture console output + interesting activity
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const logs = [];
const stubConsole = {
  log: (...a) => logs.push(["log", a.map(String)]),
  warn: (...a) => logs.push(["warn", a.map(String)]),
  error: (...a) => logs.push(["error", a.map(String)]),
  info: (...a) => logs.push(["info", a.map(String)]),
  debug: (...a) => logs.push(["debug", a.map(String)]),
};

const windowStub = {};
const documentStub = {
  write: (...a) => logs.push(["document.write", a.map(String)]),
  getElementById: () => ({ innerHTML: "", appendChild() {}, style: {} }),
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  body: { appendChild() {} },
};

const ctx = vm.createContext({
  console: stubConsole,
  window: windowStub,
  document: documentStub,
  setTimeout: (fn) => fn(),
  setInterval: () => 0,
  clearTimeout: () => {},
  clearInterval: () => {},
  alert: (x) => logs.push(["alert", [String(x)]]),
  prompt: () => "",
  confirm: () => true,
  navigator: { userAgent: "debug" },
  location: { href: "about:blank" },
  Math,
  JSON,
  Date,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Reflect,
  Proxy,
  Symbol,
  Map,
  Set,
  WeakMap,
  Promise,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  Uint8Array,
  Uint32Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  TextDecoder,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
});
ctx.globalThis = ctx;
windowStub.console = stubConsole;
windowStub.document = documentStub;

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
try {
  vm.runInContext(src, ctx, { timeout: 10000 });
} catch (e) {
  logs.push(["THREW", [e && e.stack ? e.stack : String(e)]]);
}

for (const [kind, args] of logs) {
  console.log(`[${kind}] ${args.join(" ")}`);
}
if (!logs.length) console.log("(no output captured)");
