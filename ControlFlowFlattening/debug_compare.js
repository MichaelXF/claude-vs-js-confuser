// DEBUG: run original.js, input.js (obfuscated), and output.js (deobfuscated)
// through the same mocked canvas and compare their canvas-op traces. Keep file.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function run(code, frames, clickFrames) {
  const log = [];
  const METHODS = new Set(["fillRect", "clearRect", "strokeRect", "fillText", "strokeText",
    "beginPath", "moveTo", "lineTo", "arc", "stroke", "fill", "closePath", "save", "restore"]);
  const fmt = (v) => typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
  const ctx = new Proxy({}, {
    get(t, p) { return typeof p === "string" && METHODS.has(p) ? (...a) => log.push(p + "(" + a.map(fmt).join(",") + ")") : t[p]; },
    set(t, p, v) { if (typeof v !== "function") log.push("set " + String(p) + "=" + fmt(v)); t[p] = v; return true; },
  });
  const canvas = { width: 400, height: 600, getContext: () => ctx };
  const rafQueue = [];
  const sandbox = {
    document: { getElementById: () => canvas },
    window: { requestAnimationFrame: (fn) => rafQueue.push(fn) },
    Math, String, Number, console: { log() {}, error() {} },
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { timeout: 5000 });
    let n = 0;
    while (rafQueue.length && n < frames) {
      rafQueue.shift()(); n++;
      log.push("--frame " + n + "--");
      if (clickFrames.has(n) && typeof canvas.onpointerdown === "function") { canvas.onpointerdown(); log.push("--click--"); }
    }
  } catch (e) { return { log, error: e }; }
  return { log, error: null };
}

const FR = 200;
const clicks = new Set();
for (let i = 9; i <= FR; i += 9) clicks.add(i);

const files = ["original.js", "input.js", "output.js"];
const runs = files.map((f) => ({ f, r: run(fs.readFileSync(path.join(__dirname, f), "utf8"), FR, clicks) }));

for (const { f, r } of runs) console.log(`${f.padEnd(12)} error=${r.error ? r.error.message : "none"}  ops=${r.log.length}`);

const base = runs[0].r.log;
for (let k = 1; k < runs.length; k++) {
  const other = runs[k].r.log;
  let diff = -1;
  const n = Math.min(base.length, other.length);
  for (let i = 0; i < n; i++) if (base[i] !== other[i]) { diff = i; break; }
  const same = diff === -1 && base.length === other.length;
  console.log(`\noriginal.js  vs  ${files[k]}:  ${same ? "IDENTICAL ✓" : "DIFFER ✗"}`);
  if (!same) {
    console.log(`  lengths: ${base.length} vs ${other.length}; first diff @${diff}`);
    if (diff >= 0) {
      console.log("  original:", JSON.stringify(base.slice(Math.max(0, diff - 2), diff + 3)));
      console.log("  " + files[k] + ":", JSON.stringify(other.slice(Math.max(0, diff - 2), diff + 3)));
    }
  }
}
