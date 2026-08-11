// debug-passthrough.js - make sure non-VM files survive vm.js untouched.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const deobfuscate = require("./vm.js");

const samples = {
  "empty.js": "",
  "comment-only.js": "// nothing here\n/* block */\n",
  "directive.js": '"use strict";\nvar a = 1;\nmodule.exports = a;\n',
  "modern.js":
    "const f = async (x = 1, ...rest) => { for await (const v of x) yield_(v); };\n" +
    "class A { #p = 1; static s = 2; get v() { return this.#p; } }\n" +
    "const { a, b: [c] = [] } = obj ?? {};\n" +
    "label: for (const k in obj) { if (k) continue label; }\n" +
    "const tpl = `a${1 + 2}b`;\n" +
    "let big = 10n; let re = /ab+c/gi;\n",
  "minified.js":
    "!function(a,b){var c=function(d){return d*2};for(var e=0;e<10;e++)a[e]=c(e);b&&b(a)}([],null);",
  "many-numeric-props.js":
    "var C = {};\n" + Array.from({ length: 40 }, (_, i) => `C[${i}] = function () { return ${i}; };`).join("\n"),
  "with-getter.js": "var o = { get x() { return 1; }, set x(v) {} }; try { o.x = 2 } catch (e) { } finally { }",
  "labels-and-switch.js":
    "function f(n){ outer: while(n--){ switch(n%3){ case 0: continue outer; case 1: break; default: return n; } } return -1 }\n" +
    "module.exports = f;",
};

let bad = 0;
const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "vm4-"));
for (const [name, src] of Object.entries(samples)) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, src);
  try {
    const out = deobfuscate(p);
    parser.parse(out, { sourceType: "unambiguous", plugins: ["bigInt"], errorRecovery: false });
    const changed = out.replace(/\s+/g, "") !== src.replace(/\s+/g, "");
    console.log(`  ok   ${name.padEnd(24)} ${out.length} bytes${changed ? " (reformatted)" : ""}`);
  } catch (e) {
    bad++;
    console.log(`  FAIL ${name.padEnd(24)} ${e.message}`);
  }
}

// the deobfuscator's own sources should also survive
for (const name of ["vm.js", "test.js", "regular.js", "debug-disasm.js"]) {
  try {
    const out = deobfuscate(path.join(__dirname, name));
    parser.parse(out, { sourceType: "script", errorRecovery: false });
    console.log(`  ok   ${name.padEnd(24)} ${out.length} bytes`);
  } catch (e) {
    bad++;
    console.log(`  FAIL ${name.padEnd(24)} ${e.message}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} failures` : "all pass-through samples ok");
process.exit(bad ? 1 : 0);
