// debug/extract.js — pull the bytecode + constant pool out of input.js via AST
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const code = fs.readFileSync(file, "utf8");
const ast = parser.parse(code, { sourceType: "script" });

let b64 = null;
let pool = null;
let bootArgs = null;

traverse(ast, {
  StringLiteral(p) {
    if (p.node.value.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(p.node.value)) b64 = p.node.value;
  },
  CallExpression(p) {
    // the bootstrap: z(new u([], [...pool], F, 37, D), 85, null, new g({p,e,v}))
    const n = p.node;
    if (n.arguments.length >= 4 && n.arguments[0].type === "NewExpression") {
      const ne = n.arguments[0];
      const arr = ne.arguments.find(
        (a) => a.type === "ArrayExpression" && a.elements.length > 3
      );
      if (arr) {
        pool = arr.elements.map((el) => {
          if (!el) return undefined;
          if (el.type === "StringLiteral") return el.value;
          if (el.type === "NumericLiteral") return el.value;
          if (el.type === "UnaryExpression" && el.operator === "-") return -el.argument.value;
          if (el.type === "Identifier" && el.name === "undefined") return undefined;
          if (el.type === "UnaryExpression" && el.operator === "void") return undefined;
          return "??" + el.type;
        });
        const last = n.arguments[n.arguments.length - 1];
        bootArgs = require("@babel/generator").default(n).code.slice(0, 200);
        // entry template object
        if (last.type === "NewExpression" && last.arguments[0].type === "ObjectExpression") {
          const obj = {};
          for (const pr of last.arguments[0].properties) obj[pr.key.name] = pr.value.value;
          module.exports.entry = obj;
          console.log("entry template:", JSON.stringify(obj));
        }
        console.log("boot call head:", bootArgs.slice(0, 120));
      }
    }
  },
});

const bytes = Buffer.from(b64, "base64");
const words = new Uint32Array(bytes.length / 4);
for (let i = 0; i < words.length; i++) words[i] = bytes.readUInt32LE(i * 4);

console.log("b64 len:", b64.length, "bytes:", bytes.length, "words:", words.length);
console.log("pool size:", pool.length);
console.log("pool:", JSON.stringify(pool.slice(0, 30)));

fs.writeFileSync(path.join(__dirname, "bytecode.json"), JSON.stringify(Array.from(words)));
fs.writeFileSync(path.join(__dirname, "pool.json"), JSON.stringify(pool));

// histogram of word values to guess which are opcodes
const handlers = new Set();
traverse(ast, {
  AssignmentExpression(p) {
    const { left, right } = p.node;
    if (
      left.type === "MemberExpression" &&
      left.computed &&
      left.property.type === "NumericLiteral" &&
      right.type === "FunctionExpression"
    )
      handlers.add(left.property.value);
  },
});
let hit = 0;
const counts = new Map();
for (const wv of words)
  if (handlers.has(wv)) {
    hit++;
    counts.set(wv, (counts.get(wv) || 0) + 1);
  }
console.log("words matching a handler id:", hit, "/", words.length);
console.log(
  "distinct handler ids seen:",
  counts.size,
  "of",
  handlers.size
);
