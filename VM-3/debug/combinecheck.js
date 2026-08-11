const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const V = require("../vm.js");
const src = `
v0_1 = v0_9 | v0_8;
v0_2 = v0_1 * (v0_7 & 65535 & 1);
v0_3 = v0_9 | 0;
v0_4 = v0_2 + v0_3 * (v0_7 & 65535 & 1 ^ 1);
v0_5 = v0_4 | ~v0_7;
`;
const stmts = parser.parse(src).program.body;
const isReg = (n) => n.startsWith("v0_");
const out = V.combineExpressions(stmts, new Set(["v0_5"]), isReg, new Set());
console.log(out.map((s) => generate(s).code).join("\n"));
