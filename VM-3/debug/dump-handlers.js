// debug/dump-handlers.js
// Enumerate every `C[NNN] = function(){...}` opcode handler from input.js
// and print its normalized source so we can classify semantics by shape.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const code = fs.readFileSync(file, "utf8");
const ast = parser.parse(code, { sourceType: "script" });

const handlers = new Map(); // opcode -> source

traverse(ast, {
  AssignmentExpression(p) {
    const { left, right } = p.node;
    if (left.type !== "MemberExpression" || !left.computed) return;
    if (left.property.type !== "NumericLiteral") return;
    if (right.type !== "FunctionExpression") return;
    handlers.set(left.property.value, generator(right, { compact: false }).code);
  },
});

const out = [];
out.push(`# handler count: ${handlers.size}\n`);
const keys = [...handlers.keys()].sort((a, b) => a - b);
for (const k of keys) {
  out.push(`=== ${k} ===\n${handlers.get(k)}\n`);
}
fs.writeFileSync(path.join(__dirname, "handlers.txt"), out.join("\n"));
console.log("handlers:", handlers.size);

// Group by structural signature (source with numbers replaced) to find families
const fam = new Map();
for (const [k, src] of handlers) {
  const sig = src.replace(/\b\d+\b/g, "#");
  if (!fam.has(sig)) fam.set(sig, []);
  fam.get(sig).push(k);
}
const famOut = [];
famOut.push(`# families: ${fam.size}\n`);
for (const [sig, ks] of [...fam.entries()].sort((a, b) => b[1].length - a[1].length)) {
  famOut.push(`--- opcodes [${ks.join(", ")}] (${ks.length}) ---\n${sig}\n`);
}
fs.writeFileSync(path.join(__dirname, "families.txt"), famOut.join("\n"));
console.log("families:", fam.size);
