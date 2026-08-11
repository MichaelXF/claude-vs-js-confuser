// debug-explore.js - scratch analysis of the VM in input.js
// Dumps handler bodies, the bytecode array and the constant table so the
// opcode semantics can be worked out by hand.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });

const handlers = [];
let b64 = null;
let constTable = null;

traverse(ast, {
  AssignmentExpression(p) {
    const { left, right } = p.node;
    // C[12345] = function(){...}
    if (
      left.type === "MemberExpression" &&
      left.computed &&
      left.property.type === "NumericLiteral" &&
      (right.type === "FunctionExpression" || right.type === "ArrowFunctionExpression")
    ) {
      handlers.push({ op: left.property.value, code: generate(right, { compact: false }).code });
    }
  },
  "CallExpression|NewExpression"(p) {
    const c = p.node;
    // g("....base64....")
    if (
      c.callee.type === "Identifier" &&
      c.arguments.length === 1 &&
      c.arguments[0].type === "StringLiteral" &&
      c.arguments[0].value.length > 200
    ) {
      b64 = c.arguments[0].value;
    }
    // new r(F, [consts], D)
    if (c.callee.type === "Identifier") {
      for (const a of c.arguments) {
        if (a.type === "ArrayExpression" && a.elements.length > 5) {
          constTable = a.elements.map((e) => {
            if (e === null) return { t: "hole" };
            if (e.type === "StringLiteral") return { t: "str", v: e.value };
            if (e.type === "NumericLiteral") return { t: "num", v: e.value };
            if (e.type === "UnaryExpression" && e.operator === "-") return { t: "num", v: -e.argument.value };
            if (e.type === "Identifier" && e.name === "undefined") return { t: "undef" };
            return { t: "other", v: generate(e).code };
          });
        }
      }
    }
  },
});

const buf = Buffer.from(b64, "base64");
const words = new Uint32Array(buf.length / 4);
for (let i = 0; i < words.length; i++) words[i] = buf.readUInt32LE(i * 4);

console.log("handlers:", handlers.length);
console.log("bytecode words:", words.length);
console.log("const table:", constTable.length);

fs.writeFileSync(
  path.join(__dirname, "debug-handlers.txt"),
  handlers
    .sort((a, b) => a.op - b.op)
    .map((h) => `// ===== opcode ${h.op} =====\n${h.code}\n`)
    .join("\n")
);
fs.writeFileSync(
  path.join(__dirname, "debug-bytecode.txt"),
  Array.from(words)
    .map((w, i) => `${String(i).padStart(5)}: ${w}`)
    .join("\n")
);
fs.writeFileSync(
  path.join(__dirname, "debug-consts.txt"),
  constTable.map((c, i) => `${i}: ${c.t} ${JSON.stringify(c.v)}`).join("\n")
);
console.log("wrote debug-handlers.txt, debug-bytecode.txt, debug-consts.txt");
