// test.js — README-spec test:
//   1. require('./vm.js')('input.js')   -> deobfuscated output with decoded strings
//   2. require('./vm.js')('regular.js') -> plain JS passes through unchanged
const fs = require("fs");
const vm = require("vm");
const deobfuscate = require("./vm.js");

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + " - " + name);
  if (!cond) failures++;
};

// 1. VM sample -> devirtualized output
const output = deobfuscate("input.js", "output.js");
fs.writeFileSync("output.js", output, "utf8");
check("output is a non-empty string", typeof output === "string" && output.length > 100);
for (const s of ["_k1crlxlk2w8", "createElement", "calc(100px + 20px * 2)", "appendChild", "console"]) {
  check("output contains decoded string " + JSON.stringify(s), output.includes(s));
}
for (const bad of ["WeakMap", "Uint8Array", "atob(", "JMPR", "MKFUNC"]) {
  check("output has no VM machinery token " + JSON.stringify(bad), !output.includes(bad));
}
check("output parses as valid JS", (() => { try { new vm.Script(output); return true; } catch (e) { return false; } })());

// 2. plain JS -> passthrough unchanged
const regularSource = fs.readFileSync("regular.js", "utf8");
const regularOutput = deobfuscate("regular.js");
check("regular.js passes through unchanged", regularOutput === regularSource);

// 3. behavior: the lifted program must run and exhibit payload side effects
(function () {
  const logs = [];
  const makeDiv = () => {
    const d = { style: {}, children: [] };
    Object.defineProperty(d, "offsetWidth", { get() { return 140; } });
    d.appendChild = (c) => { d.children.push(c); return c; };
    return d;
  };
  const sandbox = {
    console: { log: (...a) => logs.push(a.map(String).join(" ")) },
    document: {
      createElement: () => makeDiv(),
      body: { appendChild: (c) => c },
    },
    Math, Date, JSON,
    setTimeout: () => 0,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  try {
    vm.runInContext(output, vm.createContext(sandbox), { timeout: 10000 });
    vm.runInContext("window._k1crlxlk2w8()", vm.createContext(sandbox), { timeout: 10000 });
    const line = logs.find((l) => /\d+\|\d+\|\d+\|\d+\|\d+/.test(l));
    check("payload call prints ts|rand|h1|h2|h3 line", !!line);
    check("payload line includes decoder output", !!line && line.length > 30);
  } catch (e) {
    check("payload call runs without error (" + e.message + ")", false);
  }
})();

console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
