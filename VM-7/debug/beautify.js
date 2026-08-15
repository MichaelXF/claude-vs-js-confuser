// Pretty-print input.js so the VM structure is readable.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const generator = require("@babel/generator").default;

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });
const out = generator(ast, { compact: false, comments: true, retainLines: false });
fs.writeFileSync(path.join(__dirname, "input.pretty.js"), out.code);
console.log("wrote input.pretty.js", out.code.length, "bytes");
