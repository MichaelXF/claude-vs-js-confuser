"use strict";
/*
 * verify.js - rigorous equivalence harness.
 *
 * Runs input.js (original obfuscated VM) and output.js (devirtualized) inside
 * fresh `vm` contexts under several DISTINGUISHABLE, DETERMINISTIC environments,
 * capturing the console.log output of each and comparing for deep equality.
 *
 * This proves the devirtualization is faithful (not just coincidentally equal in
 * a plain Node environment where several fields happen to share the value false).
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeSandbox(scenario) {
  const logged = [];
  const fakeConsole = { log: (...a) => logged.push(a.length === 1 ? a[0] : a) };

  const fixedMath = Object.create(Math);
  fixedMath.random = () => 0.123456789; // deterministic

  const fakeDate = { now: () => 1700000000000 };

  const sandbox = {
    console: fakeConsole,
    Math: fixedMath,
    Date: fakeDate,
    Buffer: Buffer,
    Reflect: Reflect,
    Object: Object,
    Array: Array,
    String: String,
    Uint8Array: Uint8Array,
    Uint32Array: Uint32Array,
    WeakMap: WeakMap,
    Error: Error,
    ReferenceError: ReferenceError,
    Math_floor: Math.floor,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    __logged: logged,
  };

  if (scenario.window) {
    sandbox.window = {};
  }
  if (scenario.document) {
    sandbox.document = {
      createElement: () => ({
        style: {},
        get offsetWidth() { return 142; },
      }),
      body: { appendChild: () => {} },
    };
  }
  if (scenario.process) sandbox.process = { v: "node" };
  if (scenario.Bun) sandbox.Bun = {};

  // globalThis inside the context should be the context's global object.
  sandbox.globalThis = sandbox;
  return { sandbox, logged };
}

function run(src, scenario) {
  const { sandbox, logged } = makeSandbox(scenario);
  const context = vm.createContext(sandbox);
  vm.runInContext(src, context, { timeout: 5000 });
  return logged.length === 1 ? logged[0] : logged;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const scenarios = [
  { name: "node-like", process: true },
  { name: "browser", window: true, document: true },
  { name: "browser+bun", window: true, document: true, Bun: true },
  { name: "doc-no-window", document: true },          // tests && short-circuit
  { name: "bun-only", Bun: true },
  { name: "all", window: true, document: true, process: true, Bun: true },
  { name: "empty", },
];

function main(outFile, refFile) {
  const dir = __dirname;
  const ref = refFile || "input.js";
  const inputSrc = fs.readFileSync(path.join(dir, ref), "utf8");
  const outputSrc = fs.readFileSync(path.join(dir, outFile || "output.js"), "utf8");

  let pass = 0, fail = 0;
  for (const sc of scenarios) {
    let a, b, err = null;
    try { a = run(inputSrc, sc); } catch (e) { err = ref + " threw: " + e.message; }
    try { b = run(outputSrc, sc); } catch (e) { err = (err ? err + " | " : "") + "output threw: " + e.message; }
    const ok = !err && deepEqual(a, b);
    if (ok) { pass++; console.log(`  PASS  ${sc.name.padEnd(16)} ${JSON.stringify(a)}`); }
    else {
      fail++;
      console.log(`  FAIL  ${sc.name.padEnd(16)}`);
      console.log("        input : " + JSON.stringify(a));
      console.log("        output: " + JSON.stringify(b));
      if (err) console.log("        err   : " + err);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed (comparing ${ref} vs ${outFile || "output.js"})`);
  if (fail) process.exitCode = 1;
}

if (require.main === module) main(process.argv[2], process.argv[3]);
module.exports = main;
