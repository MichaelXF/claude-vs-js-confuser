// Loads input.js in a sandbox with the top-level VM entry call neutralized,
// exposing the internals (handler table, bytecode, constant pool, entry descriptor).
const fs = require("fs");
const path = require("path");
const vmMod = require("vm");
const parser = require("@babel/parser");
const generator = require("@babel/generator").default;

function load(file) {
  const src = fs.readFileSync(file, "utf8");
  const ast = parser.parse(src, { sourceType: "script" });
  const body = ast.program.body;

  // Last top-level statement is `A(new g(E, C, [...]), new r({...}), void 0, null, "k")`.
  let entryStmt = null;
  for (let i = body.length - 1; i >= 0; i--) {
    const st = body[i];
    if (st.type === "ExpressionStatement" && st.expression.type === "CallExpression" && st.expression.callee.type === "Identifier") {
      entryStmt = st;
      break;
    }
  }
  if (!entryStmt) throw new Error("entry call not found");
  const runnerName = entryStmt.expression.callee.name;
  entryStmt.expression.callee = { type: "Identifier", name: "__capture" };

  // Collect the names of top-level function declarations / var decls so we can export them.
  const names = new Set();
  for (const st of body) {
    if (st.type === "FunctionDeclaration") names.add(st.id.name);
    else if (st.type === "VariableDeclaration") for (const d of st.declarations) if (d.id.type === "Identifier") names.add(d.id.name);
  }
  names.add(runnerName);

  const exportSrc = `__capture.exports = {${[...names].map((n) => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ")}};`;
  const code = generator(ast, { compact: false }).code + "\n" + exportSrc;

  const captured = { calls: [], exports: null };
  const capture = function (...args) {
    captured.calls.push(args);
  };
  capture.exports = null;
  const sandbox = {
    __capture: capture,
    Math, Object, Array, String, Number, Boolean, JSON, Date, RegExp, Error, TypeError, ReferenceError, SyntaxError, RangeError,
    Uint8Array, Uint32Array, Int32Array, Float64Array, WeakMap, Map, Set, Symbol, Promise, Proxy, Reflect, Function,
    Buffer, console, parseInt, parseFloat, isNaN, isFinite, undefined: undefined,
  };
  sandbox.globalThis = sandbox;
  vmMod.createContext(sandbox);
  vmMod.runInContext(code, sandbox, { filename: file });

  const ex = capture.exports;
  const call = captured.calls[0];
  return { exports: ex, entryCall: call, sandbox, runnerName };
}

module.exports = { load };

if (require.main === module) {
  const f = process.argv[2] || path.join(__dirname, "..", "input.js");
  const { exports: ex, entryCall } = load(f);
  console.log("exports:", Object.keys(ex));
  console.log("entry call args:", entryCall.length);
  const vm = entryCall[0];
  console.log("bytecode len:", vm.i.length);
  console.log("consts len:", vm.b.length);
  console.log("fnObj:", JSON.stringify(entryCall[1].C));
  console.log("thisArg:", entryCall[2], "args:", entryCall[3], "r:", entryCall[4]);
  const protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(vm)).filter((k) => /^\d+$/.test(k));
  console.log("handlers:", protoKeys.length);
}
