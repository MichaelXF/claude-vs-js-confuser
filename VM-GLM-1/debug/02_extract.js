// Extract VM components from input.js: handlers, constants pool, bytecode, entry meta
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const traverse = require("@babel/traverse").default;

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
const ast = parser.parse(src);

const info = {};

// 1. Find handler assignments: <x>[<number>] = function(){...}  where x is q.prototype alias
traverse(ast, {
  AssignmentExpression(p) {
    const n = p.node;
    if (n.left.type === "MemberExpression" && n.left.computed && n.left.property.type === "NumericLiteral" && n.right.type === "FunctionExpression" && n.right.params.length === 0) {
      const name = generate(n.left.object).code;
      info.handlers = info.handlers || {};
      info.handlers[name] = info.handlers[name] || [];
      info.handlers[name].push({ opcode: n.left.property.value, ast: n.right });
    }
  },
});

// 2. Find the VM class: function with the dispatch loop `this[<x>]()` inside try
let vmCtorName = null;
traverse(ast, {
  FunctionDeclaration(p) {
    const code = generate(p.node).code;
    if (code.includes("this[") && code.includes("].r=")) { /* prototype assignment outside */ }
  },
});

// Find `X.prototype.r=function` (dispatcher) and note X
let dispatcherOwner = null;
traverse(ast, {
  AssignmentExpression(p) {
    const n = p.node;
    if (n.left.type === "MemberExpression" && !n.left.computed && n.left.property.name === "r" && n.right.type === "FunctionExpression") {
      const code = generate(n.right).code;
      if (code.includes("catch") && /\[\w+\]\(\)/.test(code)) {
        dispatcherOwner = generate(n.left.object).code;
        info.dispatcher = { owner: dispatcherOwner, code };
      }
    }
  },
});

// 3. Constants pool: the `new q(<array>, X, C)` call
traverse(ast, {
  NewExpression(p) {
    const n = p.node;
    if (dispatcherOwner && generate(n.callee).code === dispatcherOwner && n.arguments.length >= 3) {
      info.vmNew = n.arguments.map((a) => generate(a).code.slice(0, 100));
      const arr = n.arguments[0];
      if (arr.type === "ArrayExpression") {
        info.constants = arr.elements.map((e) =>
          e == null ? null : e.type === "StringLiteral" ? { t: "str", v: e.value } : e.type === "NumericLiteral" ? { t: "num", v: e.value } : e.type === "BooleanLiteral" ? { t: "bool", v: e.value } : e.type === "UnaryExpression" && e.operator === "-" && e.argument.type === "NumericLiteral" ? { t: "num", v: -e.argument.value } : { t: generate(e).code, v: generate(e).code }
        );
      }
    }
  },
});

// 4. bytecode base64 string: variable B = v("...")
traverse(ast, {
  VariableDeclarator(p) {
    const n = p.node;
    if (n.init && n.init.type === "CallExpression" && n.init.arguments.length === 1 && n.init.arguments[0].type === "StringLiteral" && n.init.arguments[0].value.length > 500) {
      info.bytecodeB64 = n.init.arguments[0].value;
      info.bytecodeVar = n.id.name;
    }
  },
});

// 5. entry meta: new u({m:..,b:..,v:..})
traverse(ast, {
  NewExpression(p) {
    const n = p.node;
    if (n.arguments.length === 1 && n.arguments[0].type === "ObjectExpression" && n.arguments[0].properties.some((pr) => pr.key && pr.key.name === "v")) {
      const meta = {};
      for (const pr of n.arguments[0].properties) meta[pr.key.name] = pr.value.value;
      info.entryMeta = info.entryMeta || [];
      info.entryMeta.push(meta);
    }
  },
});

// 6. dump handlers pretty
const hname = Object.keys(info.handlers || {});
let out = [];
for (const hn of hname) {
  out.push(`// ===== handlers on ${hn} (${info.handlers[hn].length} total) =====`);
  for (const h of info.handlers[hn]) {
    out.push(`// opcode ${h.opcode}`);
    out.push(generate(h.ast, { retainLines: false, concise: false }).code);
    out.push("");
  }
}
fs.writeFileSync(path.join(__dirname, "handlers_dump.js"), out.join("\n"));

// 7. decode bytecode
const b64 = info.bytecodeB64;
const bytes = Buffer.from(b64, "base64");
const u32 = [];
for (let i = 0; i + 3 < bytes.length; i += 4) u32.push(bytes.readUInt32LE(i));
info.bytecodeLen = u32.length;
fs.writeFileSync(path.join(__dirname, "bytecode.json"), JSON.stringify(u32));

console.log("dispatcherOwner:", dispatcherOwner);
console.log("handler groups:", hname.map((h) => `${h}:${info.handlers[h].length}`).join(" "));
console.log("constants:", JSON.stringify(info.constants && info.constants.map((c) => (c && c.t === "num" ? c.v : c ? c.v : null))));
console.log("bytecode u32 length:", u32.length);
console.log("entryMeta:", JSON.stringify(info.entryMeta));
console.log("first 40 opcodes:", u32.slice(0, 40).join(", "));
