// Exploration / debug script. Not the deliverable. Safe to keep.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const ast = parser.parse(src);

// String decoder reimplementation (from function I in input.js)
function decode(str, J) {
  let L = "";
  const M = (((J % 95) + 95) % 95);
  for (let N = 0; N < str.length; N++) {
    const O = str.charCodeAt(N);
    const P = O - 32;
    const Q = (P - M + 95) % 95;
    L += String.fromCharCode(Q + 32);
  }
  return L;
}

// Find top-level function declarations
const funcs = {};
for (const node of ast.program.body) {
  if (node.type === "FunctionDeclaration") {
    funcs[node.id.name] = node;
  }
}
console.log("Top-level functions:", Object.keys(funcs));

// Inspect K: params and the while/switch
const K = funcs["K"];
console.log("\nK params:", K.params.map(p => generate(p).code));

// find the while statement
let whileStmt = null;
for (const stmt of K.body.body) {
  if (stmt.type === "WhileStatement") whileStmt = stmt;
}
console.log("\nK while test:", generate(whileStmt.test).code);
const sw = whileStmt.body.body.find(s => s.type === "SwitchStatement");
console.log("K switch discriminant:", generate(sw.discriminant).code);
console.log("Number of case clauses:", sw.cases.length);

console.log("\n--- Case labels (tests) ---");
sw.cases.forEach((c, i) => {
  const test = c.test ? generate(c.test).code : "default";
  console.log(`[${i}] case ${test}:  (consequent stmts: ${c.consequent.length})`);
});

// Try decoding a few sample strings with guessed shifts to sanity-check decoder
console.log("\n--- decoder sanity (need real S values, just structure) ---");
console.log("decode('c]iaKran', 0) =", JSON.stringify(decode("c]iaKran", 0)));
