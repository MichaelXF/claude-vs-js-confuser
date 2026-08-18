// regular.js — a plain (non-obfuscated) JavaScript program with functions,
// loops, closures, and objects. vm.js must pass it through unchanged.
function fibonacci(n) {
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return a;
}

function makeCounter(start) {
  let count = start;
  return {
    inc() { return ++count; },
    get() { return count; },
  };
}

const words = ["deobfuscation", "control", "flow", "flattening"];
const stats = {};
for (const w of words) {
  stats[w] = w.length + fibonacci(w.length % 8);
}

const counter = makeCounter(10);
while (counter.get() < 15) counter.inc();

if (typeof module !== "undefined") {
  module.exports = { fibonacci, makeCounter, stats, counter };
}
