#!/usr/bin/env node
"use strict";
/**
 * Deobfuscator for "JS-Confuser-VM MBA v5" samples.
 *
 * The sample is a register based virtual machine. Its program lives in a
 * Uint32Array of bytecode; the opcode handlers sit on a prototype table under
 * randomized numeric opcodes; the handler bodies are rewritten with mixed
 * boolean-arithmetic identities keyed on a per-function constant; the bytecode
 * itself is control-flow flattened and every jump target is produced by a
 * hashing "dispatcher" function; constants are concealed behind arithmetic and
 * strings are stored base64-encoded under a xorshift keystream.
 *
 * Rather than trying to read the MBA-obfuscated handlers, this tool lifts the
 * bytecode back to JavaScript and uses the live handlers as an oracle:
 *
 *   1. the sample is executed in a sandbox with its entry call intercepted,
 *      which yields the handler table, bytecode, constant pool and globals;
 *   2. every handler is probed to learn its instruction length, operand layout
 *      and effect (lib/machine.js), and its operator is recovered by fitting
 *      observed results against candidate JS operators (lib/fit.js);
 *   3. the bytecode is disassembled and run through a constant-propagating
 *      abstract interpreter which resolves the dispatcher, folds the concealed
 *      constants and unflattens the control flow (lib/analyze.js);
 *   4. the resulting blocks are lifted to an AST, cleaned up and structured
 *      back into if/else and loops (lib/lift.js, lib/structure.js).
 *
 * Usage
 *   node vm.js input.js output.js
 *   require("./vm.js")("input.js")   -> deobfuscated source
 *
 * Files that are not VM samples are passed through untouched.
 */

const fs = require("fs");
const path = require("path");
const generate = require("@babel/generator").default;

const { inspect, loadSample, Machine } = require("./lib/machine");
const { Analyzer } = require("./lib/analyze");
const { Lifter } = require("./lib/lift");
const { polish } = require("./lib/polish");

/**
 * Deobfuscates one file.
 * @param {string} file path to the JavaScript file
 * @param {object} [options] `{ quiet: boolean }`
 * @returns {string} deobfuscated source (or the original source if it is not a sample)
 */
function deobfuscate(file, options) {
  options = options || {};
  const source = fs.readFileSync(file, "utf8");
  const info = inspect(source);
  if (!info.isVM) {
    if (!options.quiet) {
      const why = info.parseError ? "could not be parsed" : "is not a JS-Confuser VM sample";
      process.stderr.write(`${path.basename(file)} ${why}; passing it through unchanged\n`);
    }
    return source;
  }

  const loaded = loadSample(info.ast, info.entryStmt, file);
  const machine = new Machine(loaded);
  const analyzer = new Analyzer(machine);
  const functions = analyzer.analyzeProgram();
  const lifter = new Lifter(machine, analyzer, functions);
  const program = polish(lifter.liftProgram());

  const { code } = generate(program, { comments: false, jsescOption: { minimal: true } });
  if (lifter.warnings.length && !options.quiet) {
    for (const warning of [...new Set(lifter.warnings)]) process.stderr.write("warning: " + warning + "\n");
  }
  return code + "\n";
}

module.exports = deobfuscate;
module.exports.deobfuscate = deobfuscate;

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    process.stderr.write("usage: node vm.js <input.js> [output.js]\n");
    process.exit(1);
  }
  const code = deobfuscate(input);
  if (output) {
    fs.writeFileSync(output, code);
    process.stderr.write(`wrote ${output} (${code.length} bytes)\n`);
  } else {
    process.stdout.write(code);
  }
}
