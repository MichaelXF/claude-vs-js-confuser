"use strict";
/*
 * test.js - the README's expected test.
 *
 *   var output        = require('./vm.js')('input.js')    // decoded strings present
 *   var regularOutput = require('./vm.js')('regular.js')  // passes through, no errors
 *
 * Additionally executes the deobfuscated output to confirm it runs.
 */
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const vm = require("vm");
const deobfuscate = require("./vm.js");

const here = (f) => path.join(__dirname, f);
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n       " + e.message); }
}

// 1. Obfuscated input -> deobfuscated output with decoded strings.
const output = deobfuscate(here("input.js"));
check("output is a non-empty string", () => {
  assert(typeof output === "string" && output.length > 0);
});
const mustContain = [
  "createElement", "div", "calc(100px + 20px * 2)", "offsetWidth",
  "appendChild", "console", "Date", "Math", "random", "typeof window",
];
for (const s of mustContain) {
  check("decoded string present: " + JSON.stringify(s), () => {
    assert(output.includes(s), "missing: " + s);
  });
}
check("no leftover base64 bytecode blob", () => {
  assert(!/[A-Za-z0-9+/]{600,}/.test(output), "output still contains a large encoded blob");
});
check("no VM interpreter artifacts (Uint32Array bytecode)", () => {
  assert(!output.includes("new Uint32Array"), "output still builds the bytecode array");
});

// 2. The deobfuscated output actually runs and logs an object with the 5 keys.
check("deobfuscated output executes and logs {b,n,bu,dw,k}", () => {
  let logged = null;
  const sandbox = {
    console: { log: (x) => { logged = x; } },
    Date, Math, Buffer, Reflect, Object, Array, process,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { timeout: 5000 });
  assert(logged && typeof logged === "object", "nothing logged");
  for (const k of ["b", "n", "bu", "dw", "k"]) assert(k in logged, "missing key " + k);
  assert(typeof logged.k === "string" && logged.k.split("|").length === 3, "k not the expected format");
});

// 3. A regular, non-obfuscated file passes through without errors.
check("regular.js passes through without throwing", () => {
  const regularOutput = deobfuscate(here("regular.js"));
  assert(typeof regularOutput === "string" && regularOutput.length > 0);
  assert(regularOutput.includes("greet"), "passthrough lost original content");
});
check("regular passthrough still runs", () => {
  const regularOutput = deobfuscate(here("regular.js"));
  const sandbox = { console: { log() {} }, module: { exports: {} }, Error };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(regularOutput, sandbox, { timeout: 5000 });
  assert(typeof sandbox.module.exports.total === "number", "regular file did not execute correctly");
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failures ? 1 : 0;
