"use strict";

const deobfuscate = require("./vm-core.js");

module.exports = deobfuscate;
module.exports.transform = deobfuscate.transform;
module.exports._internals = deobfuscate._internals;

if (require.main === module) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error("Usage: node vm.js <input.js> <output.js>");
    process.exitCode = 1;
  } else {
    deobfuscate(inputPath, outputPath);
  }
}
