#!/usr/bin/env node
"use strict";
/**
 * Test suite for vm.js.
 *
 *   node test.js
 *
 * Checks, in order of how much they prove:
 *
 *   1. `input.js` is recognized and deobfuscated without warnings;
 *   2. every trace of the VM (bytecode blob, handler table, dispatcher) is gone
 *      and the concealed strings and constants are back in the source;
 *   3. the deobfuscated program *behaves* exactly like the obfuscated one --
 *      both are run in identical deterministic sandboxes and every observable
 *      event is compared (this is the check that matters);
 *   4. the recovered control-flow graph covers everything the real VM does;
 *   5. a regular, non-obfuscated file passes through untouched;
 *   6. the tool is deterministic: two runs produce identical output.
 */

const fs = require("fs");
const path = require("path");
const nodeVm = require("vm");
const { execFileSync } = require("child_process");

const deobfuscate = require("./vm.js");
const here = (f) => path.join(__dirname, f);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (err) {
    failed++;
    failures.push(name + ": " + err.message);
    console.log("  FAIL " + name + "\n         " + err.message.split("\n").join("\n         "));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- the deterministic sandbox both programs are run in ----------------------

/**
 * A browser-shaped environment that records everything the program does.
 * `Date.now` and `Math.random` are stubbed so two runs are comparable.
 */
function makeSandbox(log) {
  let clock = 0;
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: new Proxy({}, { set(o, k, v) { log.push(["style", tag, String(k), String(v)]); o[k] = v; return true; } }),
    offsetWidth: 140,
    children: [],
    appendChild(c) { log.push(["appendChild", this.tagName, c && c.tagName]); this.children.push(c); return c; },
    setAttribute(k, v) { log.push(["setAttribute", k, String(v)]); },
    addEventListener(type) { log.push(["addEventListener", this.tagName, type]); },
  });
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
    window: windowObj, document,
    console: { log: (...args) => log.push(["console.log", ...args.map(String)]) },
    Math: Object.assign(Object.create(Math), { random: () => { log.push(["Math.random"]); return rand(); } }),
    Date: Object.assign(function Date2() {}, { now: () => { clock += 1000; log.push(["Date.now"]); return 1700000000000 + clock; } }),
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

/** Loads `source`, then exercises whatever it exported onto `window`. */
function observe(source, label) {
  const log = [];
  const sandbox = makeSandbox(log);
  nodeVm.createContext(sandbox);
  try {
    nodeVm.runInContext(source, sandbox, { filename: label, timeout: 20000 });
  } catch (err) {
    log.push(["THREW at load", err.message]);
  }
  const exported = Object.keys(sandbox.window).filter((k) => typeof sandbox.window[k] === "function" && k.startsWith("_"));
  log.push(["exports", exported.join(",")]);
  for (const name of exported) {
    for (const args of [[], ["hello"], [123], [null], ["a longer string to encode"]]) {
      try {
        log.push(["call", name, JSON.stringify(args), "->", String(sandbox.window[name](...args))]);
      } catch (err) {
        log.push(["call", name, JSON.stringify(args), "THREW", err.message]);
      }
    }
  }
  return log;
}

// --- the tests ---------------------------------------------------------------

console.log("vm.js\n");

const inputSource = fs.readFileSync(here("input.js"), "utf8");
let output = "";
const warnings = [];

check("deobfuscates input.js without warnings", () => {
  const stderr = process.stderr.write;
  process.stderr.write = (chunk) => { warnings.push(String(chunk).trim()); return true; };
  try {
    output = deobfuscate(here("input.js"));
  } finally {
    process.stderr.write = stderr;
  }
  assert(output && output.length > 0, "no output was produced");
  assert(warnings.length === 0, "warnings were emitted:\n" + warnings.join("\n"));
});

check("output parses as JavaScript", () => {
  new nodeVm.Script(output, { filename: "output.js" });
});

check("the virtual machine is gone", () => {
  assert(output.length < inputSource.length / 20,
    `output is ${output.length} bytes, expected far less than input's ${inputSource.length}`);
  for (const [what, re] of [
    ["a bytecode array", /Uint32Array/],
    ["base64 decoding", /\batob\b/],
    ["a numeric handler table", /\[\s*\d{4,}\s*\]\s*=\s*function/],
    ["an interpreter dispatch loop", /Math\.imul/],
  ]) assert(!re.test(output), `${what} is still present in the output`);
});

check("concealed strings are decoded", () => {
  for (const text of ["_k1crlxlk2w8", "calc(100px + 20px * 2)", "offsetWidth", "createElement", "fromCharCode", "charCodeAt"]) {
    assert(output.indexOf(text) >= 0, `decoded string ${JSON.stringify(text)} is missing`);
  }
});

check("concealed constants are recovered", () => {
  for (const value of ["1640531527", "65535", "1000000", "% 97", "% 89", "% 83"]) {
    assert(output.indexOf(value) >= 0, `constant ${JSON.stringify(value)} is missing`);
  }
});

check("control flow is structured, not a state machine", () => {
  assert(/\bwhile\s*\(/.test(output), "the decoder loop was not recovered");
  assert(!/switch\s*\(/.test(output), "the output still contains a dispatch switch");
});

check("output behaves identically to input", () => {
  const before = observe(inputSource, "input.js");
  const after = observe(output, "output.js");
  const max = Math.max(before.length, after.length);
  const diffs = [];
  for (let i = 0; i < max; i++) {
    const x = JSON.stringify(before[i]);
    const y = JSON.stringify(after[i]);
    if (x !== y) diffs.push(`  event #${i}\n    input : ${x}\n    output: ${y}`);
  }
  assert(before.length > 5, "the sandbox observed almost nothing; the harness is broken");
  assert(diffs.length === 0, `${diffs.length} of ${max} observable events differ:\n${diffs.slice(0, 5).join("\n")}`);
});

check("recovered CFG covers everything the real VM executes", () => {
  const out = execFileSync(process.execPath, [here("debug/validate2.js")], { encoding: "utf8" });
  assert(/OK: recovered CFG/.test(out), "validate2.js reported a mismatch:\n" + out.trim());
});

check("a regular file passes through unchanged", () => {
  const source = fs.readFileSync(here("regular.js"), "utf8");
  const stderr = process.stderr.write;
  let result;
  process.stderr.write = () => true; // it reports "not a sample" on stderr
  try {
    result = deobfuscate(here("regular.js"));
  } finally {
    process.stderr.write = stderr;
  }
  assert(result === source, "the file was modified instead of passed through");
});

check("a regular file still runs after passing through", () => {
  const result = deobfuscate(here("regular.js"), { quiet: true });
  const sandbox = { module: { exports: {} }, console: { log() {} } };
  sandbox.globalThis = sandbox;
  nodeVm.createContext(sandbox);
  nodeVm.runInContext(result, sandbox, { filename: "regular.js" });
  assert(sandbox.module.exports.report === "2/3 succeeded (always, flaky)",
    "unexpected result: " + JSON.stringify(sandbox.module.exports.report));
});

check("unparseable input passes through unchanged", () => {
  const broken = here("debug/not-javascript.tmp");
  fs.writeFileSync(broken, "this ( is not ] javascript {\n");
  try {
    assert(deobfuscate(broken, { quiet: true }) === fs.readFileSync(broken, "utf8"), "the file was modified");
  } finally {
    fs.unlinkSync(broken);
  }
});

check("the tool is deterministic", () => {
  const again = deobfuscate(here("input.js"), { quiet: true });
  assert(again === output, "two runs produced different output");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
