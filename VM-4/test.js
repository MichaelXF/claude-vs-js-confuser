/**
 * test.js — run with `node test.js`
 *
 *   1. vm.js('input.js')    -> deobfuscated source with decoded strings
 *   2. vm.js('regular.js')  -> an ordinary file passes straight through
 *   3. the deobfuscated program behaves *identically* to the obfuscated one
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vmMod = require("vm");
const parser = require("@babel/parser");
const deobfuscate = require("./vm.js");

let failures = 0;
let checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? "\n       " + extra : ""}`);
  }
}
const section = (s) => console.log(`\n== ${s} ==`);

/* ------------------------------------------------------------------ *
 * 1. deobfuscate input.js
 * ------------------------------------------------------------------ */
section("vm.js('input.js')");

const output = deobfuscate(path.join(__dirname, "input.js"));
ok("returns a string", typeof output === "string" && output.length > 0);
ok("parses as valid JavaScript", (() => {
  try { parser.parse(output, { sourceType: "script" }); return true; } catch (e) { return "  " + e.message; }
})() === true);
ok("no VM interpreter left behind", !/\bnew WeakMap\b/.test(output) && !/prototype\[\d+\]/.test(output));
ok("bytecode blob is gone", !/[A-Za-z0-9+/]{400,}={0,2}/.test(output));

// decoded strings — these only exist inside the encrypted constant pool
for (const s of ["_ttwl6apnfd", "createElement", "calc(100px + 20px * 2)", "offsetWidth", "fromCharCode", "charCodeAt"])
  ok(`decoded string ${JSON.stringify(s)}`, output.includes(s));

ok("recovered the control flow (a real loop, not a dispatcher)", /while\s*\(/.test(output) && !/switch\s*\(/.test(output));

/* ------------------------------------------------------------------ *
 * 2. a regular file passes through
 * ------------------------------------------------------------------ */
section("vm.js('regular.js')");

let regularOutput = null;
try {
  regularOutput = deobfuscate(path.join(__dirname, "regular.js"));
  ok("does not throw", true);
} catch (e) {
  ok("does not throw", false, e.message);
}
if (regularOutput) {
  ok("still parses", (() => {
    try { parser.parse(regularOutput, { sourceType: "script" }); return true; } catch (e) { return "  " + e.message; }
  })() === true);
  ok("keeps its identifiers", /function greet/.test(regularOutput) && /class Counter/.test(regularOutput));
  const before = require("./regular.js").run();
  const tmp = path.join(__dirname, ".regular.roundtrip.js");
  fs.writeFileSync(tmp, regularOutput);
  const after = require(tmp).run();
  fs.unlinkSync(tmp);
  ok("behaves the same after a round trip", before === after, `${before} !== ${after}`);
}

/* ------------------------------------------------------------------ *
 * 3. behavioural equivalence of input.js and its deobfuscated form
 * ------------------------------------------------------------------ */
section("input.js vs. deobfuscated output");

/** run a browser-ish payload with fully deterministic Date/Math */
function runPayload(source, name) {
  const logs = [];
  let seed = 0x12345678;
  const sandbox = {
    Object, Reflect, Array, String, Number, Boolean, JSON, RegExp, Error, TypeError,
    ReferenceError, WeakMap, Uint8Array, Uint32Array, Symbol, Promise, Buffer,
    parseInt, parseFloat, isNaN, atob: undefined,
    Math: Object.assign(Object.create(Math), {
      random() {
        seed ^= seed << 13; seed |= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed |= 0;
        return (seed >>> 0) / 4294967296;
      },
    }),
    Date: Object.assign(function Date() {}, { now: () => 1700000000000 }),
    console: { log: (...a) => logs.push(a.map(String).join("")), error() {}, warn() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const nodes = [];
  sandbox.document = {
    createElement(tag) {
      const el = { tag, style: {}, children: [], offsetWidth: 140, appendChild(c) { this.children.push(c); } };
      nodes.push(el);
      return el;
    },
    body: { children: [], appendChild(c) { this.children.push(c); } },
  };
  vmMod.createContext(sandbox);
  vmMod.runInContext(source, sandbox, { filename: name });
  const exported = Object.keys(sandbox).filter((k) => k.startsWith("_") && typeof sandbox[k] === "function");
  const results = exported.map((k) => String(sandbox[k]()));
  return { logs, exported, results, nodes: JSON.stringify(nodes.map((n) => ({ tag: n.tag, style: n.style }))) };
}

const inputSrc = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
let a = null;
let b = null;
try { a = runPayload(inputSrc, "input.js"); } catch (e) { ok("input.js runs", false, e.message); }
try { b = runPayload(output, "output.js"); } catch (e) { ok("output runs", false, e.stack.split("\n").slice(0, 3).join("\n       ")); }

if (a && b) {
  ok("exports the same global", JSON.stringify(a.exported) === JSON.stringify(b.exported),
    `${JSON.stringify(a.exported)} vs ${JSON.stringify(b.exported)}`);
  ok("same DOM side effects", a.nodes === b.nodes, `${a.nodes}\n       ${b.nodes}`);
  ok("same console output", JSON.stringify(a.logs) === JSON.stringify(b.logs),
    `obfuscated:   ${JSON.stringify(a.logs)}\n       deobfuscated: ${JSON.stringify(b.logs)}`);
  ok("same return values", JSON.stringify(a.results) === JSON.stringify(b.results));
  if (a.logs.length) console.log(`  payload output: ${JSON.stringify(a.logs[0]).slice(0, 120)}…`);
}

/* ------------------------------------------------------------------ *
 * 4. writing to a file
 * ------------------------------------------------------------------ */
section("vm.js('input.js', 'output.js')");
const outPath = path.join(__dirname, "output.js");
deobfuscate(path.join(__dirname, "input.js"), outPath);
ok("wrote output.js", fs.existsSync(outPath) && fs.readFileSync(outPath, "utf8") === output);

/* ------------------------------------------------------------------ */
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
