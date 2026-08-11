const fs = require("fs");
const path = require("path");
const V = require("../vm.js");
const t0 = Date.now();
const res = V.deobfuscateSource(
  fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8"),
  { specialize: false, skipCleanup: process.env.SKIP_CLEANUP === "1" });
console.log("total", Date.now() - t0, "ms; bytes:", res.code.length);
fs.writeFileSync(path.join(__dirname, "plain-output.js"), res.code);
