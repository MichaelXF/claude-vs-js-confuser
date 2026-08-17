"use strict";

const assert = require("assert");
const path = require("path");
const deobfuscate = require("./vm.js");
const { compare } = require("./debug/compare.js");

const root = __dirname;
const outputPath = path.join(root, "output.js");
const regularOutputPath = path.join(root, "debug", "regular-output.js");

const output = deobfuscate(path.join(root, "input.js"), outputPath);
assert(output.includes(".createElement"), "concealed strings were not decoded");
assert(output.includes(".appendChild"), "DOM property strings were not decoded");
assert(!output.includes("Uint32Array"), "encoded bytecode remains in the output");
assert(!output.includes('"base64"'), "the Base64 decoder remains in the output");
assert(!/\bA\[\d+\]\s*=\s*function/.test(output), "the randomized opcode table remains in the output");
assert(!output.includes("WeakMap"), "a virtual-function runtime remains in the output");
assert(!output.includes("__operands"), "operand-reader state remains in the output");
assert(!/\b(?:class|switch)\b|\bcase\s+\d+\s*:/.test(output), "VM dispatch code remains in the output");
assert(!/\bregisters_\d+\b/.test(output), "virtual register arrays remain in the output");
assert(!output.includes("first_iteration_"), "a flattened loop-entry sentinel remains in the output");
assert(!/\b(?:let|const)\b/.test(output), "the lift emitted block-scoped declarations unsupported by the VM");
assert(/while \([^)]*\.length\)/.test(output), "the source-level loop condition was not reconstructed");
assert(output.includes("fromCharCode") && output.includes("charCodeAt"), "the lifted string transform is missing");
assert(!output.includes("invoked_"), "a synthetic call-once guard was added by the lifter");
assert(Buffer.byteLength(output) < 10000, "dead VM/CFF code was not eliminated");

const regularOutput = deobfuscate(path.join(root, "regular.js"), regularOutputPath);
assert(regularOutput.includes("function add"), "regular JavaScript did not pass through");
assert.strictEqual(require(regularOutputPath)(20, 22), 42);

function universal() {
  const target = function placeholder() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => 0;
      if (property === "length") return 0;
      return universal();
    },
    set() { return true; },
    apply() { return universal(); },
    construct() { return universal(); },
  });
}

const savedGlobals = {
  window: global.window,
  document: global.document,
  requestAnimationFrame: global.requestAnimationFrame,
  cancelAnimationFrame: global.cancelAnimationFrame,
};
const savedLog = console.log;
try {
  global.window = {};
  global.document = universal();
  global.requestAnimationFrame = universal();
  global.cancelAnimationFrame = universal();
  delete require.cache[require.resolve(outputPath)];
  require(outputPath);
  const entry = Object.values(window).find((value) => typeof value === "function");
  assert(entry, "browser entry point was not restored");
  console.log = () => {};
  entry();
} finally {
  console.log = savedLog;
  Object.assign(global, savedGlobals);
}

for (const [seed, clock] of [[123456789, 1700000000000], [1, 1], [0xdeadbeef, 2000000000000]]) {
  for (const callCount of [1, 2, 3, 5]) {
    const comparison = compare(path.join(root, "input.js"), outputPath, { seed, clock, callCount });
    assert(comparison.identical, `deterministic effects differ for seed ${seed} after ${callCount} calls`);
  }
}

console.log("All deobfuscation and pass-through tests passed.");
