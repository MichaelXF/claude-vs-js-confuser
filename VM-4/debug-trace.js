// debug-trace.js - instrument input.js's dispatch loop + operand fetcher so we
// get ground-truth (pc, opcode, operands) for every executed instruction.
// Purely a research aid; the real deobfuscator (vm.js) is static.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });

// 1. instrument `function x(a){return a.j[a.c[a.g+11]++]}`
// 2. instrument dispatch loop `var d=a.j[c]` inside B
traverse(ast, {
  FunctionDeclaration(p) {
    const body = p.node.body.body;
    if (
      body.length === 1 &&
      body[0].type === "ReturnStatement" &&
      generate(body[0]).code.replace(/\s+/g, "").includes("+11]++]")
    ) {
      // x(a) -> operand fetch
      const inner = generate(body[0].argument).code;
      p.node.body.body = parser.parse(
        `function __t(){ var __v = ${inner}; __OPERAND(__v); return __v; }`
      ).program.body[0].body.body;
    }
  },
  VariableDeclarator(p) {
    if (
      p.node.id.type === "Identifier" &&
      p.node.init &&
      generate(p.node).code === "d = a.j[c]"
    ) {
      const stmt = p.findParent((x) => x.isVariableDeclaration());
      stmt.insertAfter(parser.parse("__DISPATCH(c, d, a);").program.body);
      p.stop();
    }
  },
});

const code = generate(ast, { compact: false }).code;

const trace = [];
let cur = null;
const sandbox = {
  console,
  Buffer,
  Math,
  Object,
  Reflect,
  Array,
  String,
  Number,
  Boolean,
  JSON,
  Date,
  RegExp,
  Error,
  TypeError,
  ReferenceError,
  WeakMap,
  Uint8Array,
  Uint32Array,
  Symbol,
  Promise,
  parseInt,
  parseFloat,
  isNaN,
  undefined,
  __DISPATCH(pc, op) {
    cur = { pc, op, operands: [] };
    trace.push(cur);
  },
  __OPERAND(v) {
    if (cur) cur.operands.push(v);
  },
};
sandbox.globalThis = sandbox;
// browser-ish stubs the payload expects
const logs = [];
sandbox.window = sandbox;
sandbox.document = {
  createElement: (t) => ({ tag: t, style: {}, appendChild() {}, setAttribute() {} }),
  body: { appendChild() {} },
  getElementById: () => null,
  querySelector: () => null,
};
sandbox.alert = (...a) => logs.push(["alert", ...a]);
sandbox.console = {
  log: (...a) => {
    logs.push(["log", ...a]);
    console.log("[payload]", ...a);
  },
  error: (...a) => logs.push(["error", ...a]),
  warn: (...a) => logs.push(["warn", ...a]),
};

const BASE_KEYS = new Set(Object.keys(sandbox));
const TRY_ARGS = [[], [3], ["abc"], [[1, 2, 3]], [{ a: 1 }]];

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: "input-instrumented.js" });
} catch (e) {
  console.error("RUN ERROR:", e && e.message);
  console.error(e && e.stack && e.stack.split("\n").slice(0, 4).join("\n"));
}

// Anything the payload installed on `window` is the real entry point - call it.
// (skip the VM's own single-letter helpers - calling those corrupts the sandbox)
const installed = Object.keys(sandbox).filter(
  (k) => typeof sandbox[k] === "function" && !BASE_KEYS.has(k) && k.length > 2
);
console.log("installed globals:", installed);
for (const name of installed) {
  for (const args of TRY_ARGS) {
    try {
      const res = sandbox[name](...args);
      console.log(`  ${name}(${args.map((a) => JSON.stringify(a)).join(",")}) =>`, res);
    } catch (e) {
      console.log(`  ${name}(${args.map((a) => JSON.stringify(a)).join(",")}) threw:`, e.message);
    }
  }
}

console.log("traced instructions:", trace.length);
// unique opcodes with their observed operand counts
const byOp = new Map();
for (const t of trace) {
  if (!byOp.has(t.op)) byOp.set(t.op, new Set());
  byOp.get(t.op).add(t.operands.length);
}
const summary = [...byOp.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([op, ns]) => `${op}: nops=${[...ns].join("/")}`)
  .join("\n");
fs.writeFileSync(path.join(__dirname, "debug-trace-ops.txt"), summary);

// linear log (first 4000)
fs.writeFileSync(
  path.join(__dirname, "debug-trace.txt"),
  trace
    .slice(0, 4000)
    .map((t) => `${String(t.pc).padStart(5)}  op=${t.op}  [${t.operands.join(", ")}]`)
    .join("\n")
);
console.log("unique opcodes executed:", byOp.size);
console.log("logs:", JSON.stringify(logs).slice(0, 2000));
