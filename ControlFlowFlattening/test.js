"use strict";
// ============================================================================
//  test.js  —  verification suite for controlFlowFlattening.js
//
//   1. README module test:   output = require('controlFlowFlattening.js')('input.js')
//                             -> deobfuscated, strings decoded, dispatcher gone.
//   2. Regular file:         a non-obfuscated file passes through fine.
//   3. Behavioral equivalence: run the ORIGINAL input.js and the DEOBFUSCATED
//      output against an identical mocked <canvas>/window, driving N animation
//      frames, and assert the two produce an identical sequence of canvas ops.
//   4. Bare run:             running the output with no DOM throws the expected
//      `document is not defined` (browser-game) error — i.e. it executes.
//
//  Run:  node test.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const parser = require("@babel/parser");

const cff = require("./controlFlowFlattening.js");
const HERE = __dirname;

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("  ✓ " + name);
  else { console.log("  ✗ " + name + (detail ? "  -- " + detail : "")); failures++; }
}

// ---------------------------------------------------------------------------
//  Mocked browser environment that records every canvas operation.
// ---------------------------------------------------------------------------
function makeSandbox(log) {
  const METHODS = new Set([
    "fillRect", "clearRect", "strokeRect", "fillText", "strokeText",
    "beginPath", "moveTo", "lineTo", "arc", "stroke", "fill", "closePath",
    "save", "restore", "translate", "rotate", "scale", "drawImage",
  ]);
  const ctx = new Proxy(
    {},
    {
      get(target, prop) {
        if (typeof prop === "string" && METHODS.has(prop))
          return (...args) => log.push(prop + "(" + args.map(fmt).join(",") + ")");
        return target[prop];
      },
      set(target, prop, val) {
        if (typeof val !== "function") log.push("set " + String(prop) + "=" + fmt(val));
        target[prop] = val;
        return true;
      },
    }
  );
  const canvas = {
    width: 400,
    height: 600,
    getContext: () => ctx,
    _handlers: {},
  };
  // capture event-handler assignments (onpointerdown / onclick) without firing
  const canvasProxy = new Proxy(canvas, {
    set(target, prop, val) { target[prop] = val; return true; },
  });
  const rafQueue = [];
  const sandbox = {
    document: { getElementById: () => canvasProxy },
    window: { requestAnimationFrame: (fn) => { rafQueue.push(fn); } },
    Math: Math,
    String: String,
    Number: Number,
    console: { log() {}, error() {} },
    __rafQueue: rafQueue,
  };
  return { sandbox, rafQueue, canvas };
}
function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return String(v);
}

function runGame(code, frames, clickFrames) {
  const log = [];
  const { sandbox, rafQueue, canvas } = makeSandbox(log);
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { timeout: 5000 });
    // first frame already ran during initialization (main returns o.c());
    // drain queued frames; fire deterministic "clicks" at scheduled frames to
    // exercise the fall / game-over / restart paths (f_3, f_5-reset, f_1).
    let n = 0;
    while (rafQueue.length && n < frames) {
      const fn = rafQueue.shift();
      fn();
      n++;
      log.push("--frame " + n + "--");
      if (clickFrames && clickFrames.has(n) && typeof canvas.onpointerdown === "function") {
        canvas.onpointerdown();
        log.push("--click--");
      }
    }
  } catch (e) {
    return { log, error: e };
  }
  return { log, error: null };
}

// ===========================================================================
console.log("\n[1] README module usage: deobfuscate input.js");
const output = cff(path.join(HERE, "input.js")); // == require('controlFlowFlattening.js')('input.js')
fs.writeFileSync(path.join(HERE, "output.js"), output);

check("output parses as valid JS", (() => { try { parser.parse(output); return true; } catch { return false; } })());
check("decoded string 'myCanvas' present", output.includes("myCanvas"));
check("decoded string 'getContext' present", output.includes("getContext"));
check("decoded string 'bounce' present", output.includes('"bounce"'));
check("decoded string 'gameOver' present", output.includes('"gameOver"'));
check("decoded string 'Score: ' present", output.includes("Score: "));
check("decoded string 'lightblue' present", output.includes("lightblue"));
check("decoded string 'requestAnimationFrame' present", output.includes("requestAnimationFrame"));
check("no leftover encoded call I(\"...\", S[..]) on the state vector", !/\bI\(\s*"[^"]*"\s*,\s*S\[/.test(output));
check("no array-sum dispatcher 'while (J(S)' remains", !/while\s*\(\s*J\(\s*S\s*\)/.test(output));
check("no raw K([...]) re-entry remains", !/\bK\(\s*\[/.test(output));
// structured control-flow recovery: dispatch switch + state variable removed
check("CFG reconstructed: no 'switch' dispatch remains", !/\bswitch\s*\(/.test(output));
check("CFG reconstructed: no 'let state' dispatch variable remains", !/\blet\s+state\b/.test(output));
check("structured if/else present", /\bif\s*\(/.test(output) && /\belse\b/.test(output));
// shared scope promotion: T["o"]["i"] -> top-level variable o_i
check("shared scope promoted: 'o_i' variable present", /\bo_i\b/.test(output));
check("shared scope promoted: no 'T[\"o\"][...]' accesses remain", !/T\["o"\]\["/.test(output));
check("promoted scope variables declared", /\bvar o_[a-z]/.test(output));
// full scope-object removal + closure hoisting
check("scope object fully removed: no 'T[' accesses", !/\bT\[/.test(output));
check("scope object fully removed: no bare 'T' identifier", !/\bT\b/.test(output));
check("threading param 'U' fully removed", !/\bU\b/.test(output));
check("closures reconstructed & called directly (no closure values)", !/=\s*function\s*\(\.\.\.[A-Za-z]/.test(output));
check("indirect '(N, fn)()' calls simplified to bare calls", !/\(\s*\d+\s*,\s*[A-Za-z_$][\w$]*\s*\)\s*\(/.test(output));
check("dead obfuscation scaffolding removed (no E_b/E_c/F_*/o_o)", !/\b(E_[bc]|F_[abc]|o_o)\b/.test(output));
// dot-notation recovery (vs obfuscator's string-keyed member access)
check("dot notation recovered (context.fillStyle etc.)", /\.fillStyle\b/.test(output) && !/\["fillStyle"\]/.test(output));

// ===========================================================================
console.log("\n[2] Regular (non-obfuscated) file passes through unchanged");
const regularSrc = fs.readFileSync(path.join(HERE, "regular.js"), "utf8");
let regularOut, regularErr = null;
try { regularOut = cff(path.join(HERE, "regular.js")); } catch (e) { regularErr = e; }
check("no error thrown on regular file", regularErr === null, regularErr && regularErr.message);
check("regular file returned unchanged", regularOut === regularSrc);
if (regularOut !== undefined)
  check("regular output still parses", (() => { try { parser.parse(regularOut); return true; } catch { return false; } })());

// ===========================================================================
console.log("\n[3] Behavioral equivalence (original vs deobfuscated, mocked canvas)");
const FRAMES = 200;
// click every 9th frame -> drives bounce->fall->land/miss->gameOver->restart,
// exercising every recovered function (f_1..f_5, f_main) on both versions.
const clickFrames = new Set();
for (let i = 9; i <= FRAMES; i += 9) clickFrames.add(i);
const obfSrc = fs.readFileSync(path.join(HERE, "input.js"), "utf8");
const a = runGame(obfSrc, FRAMES, clickFrames);
const b = runGame(output, FRAMES, clickFrames);

check("obfuscated input ran under mock without error", a.error === null, a.error && a.error.stack);
check("deobfuscated ran under mock without error", b.error === null, b.error && b.error.stack);

// Ground-truth check: compare against the hand-written original.js if present.
const origPath = path.join(HERE, "original.js");
if (fs.existsSync(origPath)) {
  const g = runGame(fs.readFileSync(origPath, "utf8"), FRAMES, clickFrames);
  check("original.js ran under mock without error", g.error === null, g.error && g.error.stack);
  let od = -1;
  const on = Math.min(g.log.length, b.log.length);
  for (let i = 0; i < on; i++) if (g.log[i] !== b.log[i]) { od = i; break; }
  check("deobfuscated matches hand-written original.js exactly", od === -1 && g.log.length === b.log.length,
    od === -1 ? "" : `first diff @${od}: orig=[${g.log[od]}] deob=[${b.log[od]}]`);
}
check("both produced a non-trivial canvas-op log", a.log.length > 50 && b.log.length > 50,
  `orig=${a.log.length} deob=${b.log.length}`);
const sameLen = a.log.length === b.log.length;
check("canvas-op log lengths match", sameLen, `orig=${a.log.length} deob=${b.log.length}`);
let firstDiff = -1;
const n = Math.min(a.log.length, b.log.length);
for (let i = 0; i < n; i++) if (a.log[i] !== b.log[i]) { firstDiff = i; break; }
check("canvas-op logs are identical", firstDiff === -1 && sameLen,
  firstDiff === -1 ? "" : `first diff @${firstDiff}: orig=[${a.log[firstDiff]}] deob=[${b.log[firstDiff]}]`);
console.log(`      (compared ${a.log.length} canvas operations over ${FRAMES} frames)`);
const reachedGameOver = b.log.some((x) => x.indexOf("Game over") !== -1);
check("test coverage reached game-over path (f_3) and restart", reachedGameOver);
console.log("      sample ops:", JSON.stringify(b.log.slice(0, 6)));

// ===========================================================================
console.log("\n[4] Bare run with no DOM throws the expected browser-game error");
let bareErr = null;
try { vm.runInNewContext(output, { Math, String, console: { log() {}, error() {} } }, { timeout: 5000 }); }
catch (e) { bareErr = e; }
check("throws ReferenceError about 'document'", !!bareErr && /document is not defined/.test(String(bareErr)),
  bareErr ? String(bareErr) : "no error thrown");

// ===========================================================================
console.log("\n" + (failures === 0 ? "ALL TESTS PASSED ✔" : failures + " TEST(S) FAILED ✗"));
process.exit(failures === 0 ? 0 : 1);
