#!/usr/bin/env node
"use strict";

/*
 * test.js — verification suite for stringConcealing.js
 *
 * Run:  node test.js
 *
 * Covers the README's two contract cases plus an end-to-end runtime-equivalence
 * check on a self-contained basE91 sample we generate (so it can actually run in
 * Node, unlike the browser-only input.js):
 *
 *   1. require('./stringConcealing.js')('input.js')  -> concealed strings decoded
 *   2. require('./stringConcealing.js')('regular.js') -> passes through, same behavior
 *   3. A controlled obfuscated program -> deobfuscated output runs identically
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const parser = require("@babel/parser");

const deobfuscateFile = require("./stringConcealing.js");
const { deobfuscate, base91Decode } = require("./stringConcealing.js");

const DIR = __dirname;
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  PASS  " + name);
  } else {
    failures++;
    console.log("  FAIL  " + name + (detail ? " :: " + detail : ""));
  }
}
function assertParses(code, label) {
  try {
    parser.parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
    return true;
  } catch (e) {
    console.log("    (" + label + " parse error: " + e.message + ")");
    return false;
  }
}

// ---------------------------------------------------------------------------
// basE91 encoder (inverse of the decoder embedded by JS-Confuser) — used only
// to build a controlled, runnable obfuscated sample for the equivalence test.
// ---------------------------------------------------------------------------
function base91Encode(table, bytes) {
  let b = 0, n = 0, out = "";
  for (let i = 0; i < bytes.length; i++) {
    b |= (bytes[i] & 255) << n;
    n += 8;
    if (n > 13) {
      let v = b & 8191;
      if (v > 88) { b >>= 13; n -= 13; }
      else { v = b & 16383; b >>= 14; n -= 14; }
      out += table[v % 91] + table[(v / 91) | 0];
    }
  }
  if (n) {
    out += table[b % 91];
    if (n > 7 || b > 90) out += table[(b / 91) | 0];
  }
  return out;
}

// ===========================================================================
console.log("\n[1] basE91 round-trip (encoder <-> deobfuscator decoder)");
// ===========================================================================
const TABLE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~\"";
check("table is 91 unique chars", TABLE.length === 91 && new Set(TABLE).size === 91, "len=" + TABLE.length);
const samples = ["Hello", "World", "42", "a/b?c=1&d=2", "🚀 unicode ✓", ""];
let roundTripOk = true;
for (const s of samples) {
  const enc = base91Encode(TABLE, Buffer.from(s, "utf8"));
  const dec = base91Decode(TABLE, enc);
  if (dec !== s) { roundTripOk = false; console.log("    mismatch: " + JSON.stringify(s) + " -> " + JSON.stringify(dec)); }
}
check("encode/decode round-trips for ASCII + unicode", roundTripOk);

// ===========================================================================
console.log("\n[2] End-to-end on a controlled, runnable obfuscated program");
// ===========================================================================
const plain = ["Hello", "World", "42"];
const encoded = plain.map((s) => base91Encode(TABLE, Buffer.from(s, "utf8")));
const obfSample = `"use strict";
function __bufToStr(buffer){ return Buffer.from(buffer).toString('utf-8'); }
function __p_smp_decode(str){
  var table=${JSON.stringify(TABLE)};
  var raw=""+(str||"");var len=raw.length;var ret=[];var b=0;var n=0;var v=-1;
  for(var i=0;i<len;i++){var p=table.indexOf(raw[i]);if(p===-1)continue;if(v<0){v=p;}else{v+=p*91;b|=v<<n;n+=(v&8191)>88?13:14;do{ret.push(b&255);b>>=8;n-=8;}while(n>7);v=-1;}}
  if(v>-1){ret.push((b|v<<n)&255);}
  return __bufToStr(ret);
}
var __p_smp_arr=${JSON.stringify(encoded)};
function __p_smp(index){return __p_smp_decode(__p_smp_arr[index]);}
module.exports = __p_smp(0) + " " + __p_smp(1) + " #" + __p_smp(2);
`;
fs.writeFileSync(path.join(DIR, "sample.obf.js"), obfSample);

const sampleDeobf = deobfuscateFile(path.join(DIR, "sample.obf.js"));
fs.writeFileSync(path.join(DIR, "sample.deobf.js"), sampleDeobf);

function runModule(code, filename) {
  const m = { exports: {} };
  vm.runInNewContext(
    "(function(module,exports,Buffer,require){" + code + "\n})",
    { Buffer, console }
  )(m, m.exports, Buffer, require);
  return m.exports;
}
const origVal = runModule(obfSample, "sample.obf.js");
const deobfVal = runModule(sampleDeobf, "sample.deobf.js");
check("obfuscated program output == 'Hello World #42'", origVal === "Hello World #42", origVal);
check("deobfuscated output runs identically", deobfVal === origVal, deobfVal + " vs " + origVal);
check("deobfuscated source contains plain strings", /"Hello"/.test(sampleDeobf) && /"World"/.test(sampleDeobf));
check("deobfuscated source has no getter calls left", !/__p_smp\(/.test(sampleDeobf));
check("deobfuscated source dropped the scaffolding", !/__p_smp_decode|__p_smp_arr|__bufToStr/.test(sampleDeobf));
check("deobfuscated sample parses", assertParses(sampleDeobf, "sample.deobf"));

// ===========================================================================
console.log("\n[3] input.js -> concealed strings are decoded");
// ===========================================================================
const inputOut = deobfuscateFile(path.join(DIR, "input.js"));
fs.writeFileSync(path.join(DIR, "output.js"), inputOut);
check("output.js parses", assertParses(inputOut, "output.js"));
check("no getter calls remain", !/__p_[A-Za-z0-9]+_STR(_\d+)?\(\d+\)/.test(inputOut));
check("no string-array / decode scaffolding remains", !/__p_VTBJ_array|_STR_\d*_decode|bufferToString/.test(inputOut));
// Known plaintext that was concealed in the original (cash/jQuery-like library):
for (const expected of ["createElement", "getElementById", "querySelectorAll", "prototype", "nodeType"]) {
  check("decoded string present: " + expected, inputOut.includes('"' + expected + '"'));
}
check("output is meaningfully smaller than input", inputOut.length < fs.readFileSync(path.join(DIR, "input.js"), "utf8").length / 2);

// ===========================================================================
console.log("\n[4] regular.js -> passes through with identical behavior");
// ===========================================================================
const regularOut = deobfuscate(fs.readFileSync(path.join(DIR, "regular.js"), "utf8"));
fs.writeFileSync(path.join(DIR, "regular.out.js"), regularOut);
check("regular output parses", assertParses(regularOut, "regular.out.js"));

const before = require("./regular.js");
const after = runModule(regularOut, "regular.out.js");
check("greet() behaves the same", after.greet("Ada") === before.greet("Ada"), after.greet("Ada"));
check("numbers array preserved", JSON.stringify(after.numbers) === JSON.stringify(before.numbers));
check("sum preserved", after.sum === before.sum);
check("referenced __ name was NOT stripped", after.marker === "still here");

// ===========================================================================
console.log("");
if (failures === 0) {
  console.log("All tests passed ✔");
  process.exit(0);
} else {
  console.log(failures + " test(s) FAILED");
  process.exit(1);
}
