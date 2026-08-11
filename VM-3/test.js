/**
 * test.js — checks for the JS-Confuser-VM deobfuscator.
 *
 *   node test.js
 *
 * 1. `vm.js` turns input.js into VM-free JavaScript with the constant pool
 *    decoded.
 * 2. The result behaves *identically* to the original: both are executed in
 *    the same deterministic fake-DOM sandbox and every console call, return
 *    value and thrown error is compared.
 * 3. A normal, non-obfuscated file passes straight through untouched.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const nodeVm = require("node:vm");

const deobfuscate = require("./vm.js");

const HERE = __dirname;
let failures = 0;
let checks = 0;

function ok(name, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * a deterministic browser-ish sandbox so both programs see the same world
 * ------------------------------------------------------------------ */

function makeSandbox() {
  const log = [];
  let clock = 1700000000000;
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const element = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    offsetWidth: 140,
    offsetHeight: 32,
    textContent: "",
    innerHTML: "",
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
  });
  const document = {
    createElement: element,
    createTextNode: (s) => ({ nodeValue: s }),
    body: element("body"),
    head: element("head"),
    documentElement: element("html"),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = {
    document,
    location: { href: "http://localhost/" },
    navigator: { userAgent: "node" },
    addEventListener() {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  window.window = window;

  const MathStub = Object.create(Math);
  MathStub.random = random;
  const DateStub = function (...a) { return new Date(...a); };
  DateStub.now = () => (clock += 7);
  DateStub.prototype = Date.prototype;

  const sandbox = {
    console: {
      log: (...a) => log.push(["log", ...a]),
      error: (...a) => log.push(["error", ...a]),
      warn: (...a) => log.push(["warn", ...a]),
    },
    window, document,
    Math: MathStub, Date: DateStub,
    JSON, Object, Array, String, Number, Boolean, Reflect, RegExp, Symbol, Proxy,
    Error, TypeError, ReferenceError, SyntaxError, RangeError,
    Function, Promise, Map, Set, WeakMap, WeakSet, Buffer,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    __log: log,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

const PROBE_ARGS = [[], ["hello world"], ["abc", 5], [""], [12345], ["é中文"]];

/** Run a program, then poke every function it exported onto `window`. */
function observe(code, label) {
  const sandbox = makeSandbox();
  nodeVm.createContext(sandbox);
  const seen = { log: sandbox.__log, error: null, exports: [], calls: [] };
  try {
    nodeVm.runInContext(code, sandbox, { timeout: 120000, filename: label });
  } catch (e) {
    seen.error = String(e && e.message);
    return seen;
  }
  seen.exports = Object.keys(sandbox.window)
    .filter((k) => typeof sandbox.window[k] === "function" && /^_/.test(k))
    .sort();
  for (const name of seen.exports) {
    for (const args of PROBE_ARGS) {
      try {
        const value = nodeVm.runInContext(
          `(function () { return window[${JSON.stringify(name)}]` +
          `.apply(null, ${JSON.stringify(args)}); })()`,
          sandbox, { timeout: 120000 });
        seen.calls.push([name, args, stringify(value)]);
      } catch (e) {
        seen.calls.push([name, args, "throw: " + String(e && e.message)]);
      }
    }
  }
  return seen;
}

function stringify(v) {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/* ------------------------------------------------------------------ *
 * 1. input.js -> output.js
 * ------------------------------------------------------------------ */

section("deobfuscating input.js");

const inputPath = path.join(HERE, "input.js");
const outputPath = path.join(HERE, "output.js");
const originalSource = fs.readFileSync(inputPath, "utf8");

const started = Date.now();
const output = deobfuscate(inputPath, outputPath);
console.log(`  (${Date.now() - started} ms, ${originalSource.length} -> ${output.length} bytes)`);

ok("output is not the input verbatim", output !== originalSource);
ok("the VM interpreter loop is gone", !/\.prototype\s*;?\s*\w+\[\d{3,5}\]\s*=\s*function/.test(output));
ok("no base64 bytecode blob remains", !/[A-Za-z0-9+/]{500,}={0,2}/.test(output));
ok("no Uint32Array bytecode remains", !/Uint32Array/.test(output));

ok("output parses as JavaScript", (() => {
  try { new Function(output); return true; } catch { return false; }
})());

section("decoded constants show up as plain strings");
for (const expected of ["createElement", "appendChild", "offsetWidth",
  "fromCharCode", "charCodeAt", "calc(100px + 20px * 2)", "div"]) {
  ok(`contains ${JSON.stringify(expected)}`, output.includes(expected));
}
ok("the encrypted pool entries are gone",
  !output.includes("1ZTR/KhtPdW3tChPrsM3dw=="));

/* ------------------------------------------------------------------ *
 * 2. behaviour is preserved
 * ------------------------------------------------------------------ */

section("original and deobfuscated behave identically");

const before = observe(originalSource, "input.js");
const after = observe(output, "output.js");

ok("original ran without error", before.error === null, before.error || "");
ok("deobfuscated ran without error", after.error === null, after.error || "");
ok("same globals exported", JSON.stringify(before.exports) === JSON.stringify(after.exports),
  `${JSON.stringify(before.exports)} vs ${JSON.stringify(after.exports)}`);
ok("same console output", JSON.stringify(before.log) === JSON.stringify(after.log),
  diff(JSON.stringify(before.log, null, 1), JSON.stringify(after.log, null, 1)));
ok("same results for every probed call",
  JSON.stringify(before.calls) === JSON.stringify(after.calls),
  diff(JSON.stringify(before.calls, null, 1), JSON.stringify(after.calls, null, 1)));
ok("the program actually did something", before.log.length > 0);

section("deobfuscation is deterministic");
const again = deobfuscate(inputPath);
ok("running twice gives the same source", again === output);

/* ------------------------------------------------------------------ *
 * 3. a regular file passes straight through
 * ------------------------------------------------------------------ */

section("non-obfuscated input passes through");

const regularPath = path.join(HERE, "regular.js");
const regularSource = fs.readFileSync(regularPath, "utf8");
let regularOutput;
let threw = null;
try {
  regularOutput = deobfuscate(regularPath);
} catch (e) {
  threw = e;
}
ok("no exception", threw === null, threw && threw.stack);
ok("returned unchanged", regularOutput === regularSource);
ok("still runs", (() => {
  try { require(regularPath); return true; } catch { return false; }
})());

const modern = "const f = async (a = 1, ...rest) => { for (const x of rest) await x; };\n" +
  "class K { static #p = 1; get v() { return K.#p; } }\n" +
  "label: for (;;) { break label; }\n";
ok("modern syntax passes through", deobfuscate.deobfuscateSource(modern).code === modern);

const notJs = "this is (not javascript at all ]]";
ok("unparseable input passes through", deobfuscate.deobfuscateSource(notJs).code === notJs);

const emptyFile = "";
ok("empty input passes through", deobfuscate.deobfuscateSource(emptyFile).code === emptyFile);

ok("already-deobfuscated output passes through",
  deobfuscate.deobfuscateSource(output).code === output);

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}

function diff(a, b) {
  if (a === b) return "";
  const la = a.split("\n"), lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `first difference at line ${i + 1}:\n         A: ${la[i]}\n         B: ${lb[i]}`;
    }
  }
  return "";
}
