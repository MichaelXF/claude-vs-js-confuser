// Logs every register write the real VM performs, so lifted expressions can be
// checked against ground truth.
const path = require("path");
const { inspect, loadSample } = require("../lib/machine");
const { makeShim } = require("./dom-shim");
const fs = require("fs");

const file = path.join(__dirname, "..", "input.js");
const info = inspect(fs.readFileSync(file, "utf8"));
const loaded = loadSample(info.ast, info.entryStmt, file);
const vm = loaded.entryArgs[0];
const shim = makeShim([]);
vm.k.window = shim.window;
vm.k.document = shim.document;
vm.k.console = { log() {} };

const proto = Object.getPrototypeOf(vm);
const writes = [];
let tracing = false;
for (const op of Object.getOwnPropertyNames(proto).filter((k) => /^\d+$/.test(k))) {
  const orig = proto[op];
  Object.defineProperty(proto, op, {
    value: function () {
      const pc = this.g[this.h + 0] - 1;
      const base = this.g[this.h + 11];
      const before = this.g.slice(base, base + 80);
      const r = orig.call(this);
      if (tracing) {
        const after = this.g.slice(base, base + 80);
        for (let i = 0; i < after.length; i++) {
          if (!Object.is(before[i], after[i])) writes.push([pc, +op, i, after[i], before.slice()]);
        }
      }
      return r;
    },
    writable: true, configurable: true,
  });
}
tracing = true;
loaded.exports[loaded.runnerName](vm, loaded.entryArgs[1], loaded.entryArgs[2], loaded.entryArgs[3], loaded.entryArgs[4]);
shim.window["_k1crlxlk2w8"]();
tracing = false;

const want = process.argv.slice(2).map(Number);
const fmt = (v) => (typeof v === "string" ? JSON.stringify(v.length > 40 ? v.slice(0, 40) + "..." : v) : typeof v === "function" ? "<fn>" : typeof v === "object" && v ? "<obj>" : String(v));
let shown = 0;
for (const [pc, op, reg, value, before] of writes) {
  if (want.length && !want.includes(pc)) continue;
  if (shown++ > 200) break;
  console.log(`pc ${String(pc).padStart(5)} op ${String(op).padStart(5)} r${reg} = ${fmt(value)}`);
}
console.log("total writes:", writes.length);
