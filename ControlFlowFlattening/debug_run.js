// DEBUG: run the engine on input.js and print result + info. Keep this file.
const fs = require("fs");
const path = require("path");
const { deobfuscate } = require("./cff");

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const res = deobfuscate(src);
console.log("changed:", res.changed);
console.log("info:", JSON.stringify(res.info, null, 2));
fs.writeFileSync(path.join(__dirname, "debug_output.js"), res.code);
console.log("\n--- first 120 lines of output ---");
console.log(res.code.split("\n").slice(0, 120).join("\n"));
