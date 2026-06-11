#!/usr/bin/env node
"use strict";
// ============================================================================
//  controlFlowFlattening.js
//
//  AST deobfuscator for the JS-Confuser "Control Flow Flattening" technique
//  (state-vector + sum-dispatch variant) and its companion string encoder.
//
//  Usage:
//    CLI:     node controlFlowFlattening.js <input.js> <output.js>
//    module:  const cff = require('./controlFlowFlattening.js');
//             const code = cff('input.js');        // returns deobfuscated source
//             const code = cff.deobfuscateCode(src) // operate on a source string
//
//  The deobfuscator is a safe no-op for files that do not contain the pattern,
//  so ordinary (non-obfuscated) source passes through untouched.
//
//  Built on @babel/parser, @babel/traverse (scope/bindings via @babel/types),
//  and @babel/generator. The heavy lifting lives in ./cff.js (the engine).
// ============================================================================

const fs = require("fs");
const path = require("path");
const { deobfuscate } = require("./cff.js");

/**
 * Read a JS file and return its deobfuscated source.
 * @param {string} inputFile path to the obfuscated file
 * @returns {string} deobfuscated source code
 */
function deobfuscateFile(inputFile) {
  const src = fs.readFileSync(inputFile, "utf8");
  return deobfuscate(src).code;
}

// Primary module export: function(filename) -> deobfuscated code string.
module.exports = deobfuscateFile;
// Extra handles for programmatic use / tests.
module.exports.deobfuscateFile = deobfuscateFile;
module.exports.deobfuscateCode = (src) => deobfuscate(src);

// ---- CLI -------------------------------------------------------------------
if (require.main === module) {
  const [, , inFile, outFile] = process.argv;
  if (!inFile) {
    console.error("Usage: node controlFlowFlattening.js <input.js> [output.js]");
    process.exit(1);
  }
  const src = fs.readFileSync(inFile, "utf8");
  const result = deobfuscate(src);
  if (outFile) {
    fs.writeFileSync(outFile, result.code);
    if (result.changed)
      console.error(
        `Deobfuscated ${path.basename(inFile)} -> ${path.basename(outFile)} ` +
          `(${result.info.functions ? result.info.functions.length : 0} functions recovered)`
      );
    else
      console.error(
        `No control-flow-flattening pattern found in ${path.basename(inFile)}; ` +
          `wrote source unchanged to ${path.basename(outFile)}.`
      );
  } else {
    process.stdout.write(result.code);
  }
}
