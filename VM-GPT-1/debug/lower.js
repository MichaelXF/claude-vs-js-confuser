"use strict";

const fs = require("fs");
const generate = require("@babel/generator").default;
const t = require("@babel/types");
const { _internals } = require("../vm.js");

const source = fs.readFileSync(process.argv[2] || "input.js", "utf8");
const ast = _internals.parse(source);
const vm = _internals.findVm(ast);
const disassembly = _internals.disassemble(vm, ast);

function permutation(fn) {
  let result;
  function visit(node) {
    if (!node || typeof node !== "object" || result) return;
    if (
      t.isAssignmentExpression(node, { operator: "=" }) &&
      t.isIdentifier(node.left) &&
      t.isArrayExpression(node.right) &&
      node.right.elements.length > 1 &&
      node.right.elements.every((element) =>
        t.isMemberExpression(element, { computed: true }) &&
        t.isIdentifier(element.object, { name: node.left.name }) &&
        t.isNumericLiteral(element.property))
    ) {
      result = node.right.elements.map((element) => element.property.value);
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(fn.body);
  return result;
}

function classify(fn, readName, decodeName) {
  const code = generate(fn, { compact: true }).code;
  const reads = (() => {
    let count = 0;
    (function visit(node) {
      if (!node || typeof node !== "object") return;
      if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: readName })) count++;
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    })(fn.body);
    return count;
  })();
  let kind;
  if (code.includes("new r({") && code.includes("g.set(")) kind = "makeFunction";
  else if (code.includes("Reflect.construct(")) kind = "construct";
  else if (code.includes(".apply(null,")) kind = "directCall";
  else if (code.includes(".apply(d,")) kind = "methodCall";
  else if (code.includes("w(this,") && code.includes("this.g=d")) kind = "return";
  else if (code.includes("this.h[this.g+2]=")) kind = "jump";
  else if (code.includes("c[a+2]=c[c[a+9]+")) kind = "jumpRegister";
  else if (code.includes("f={}") && code.includes("f[k]=l")) kind = "object";
  else if (reads === 14 && code.includes("Array(f)") && code.includes("!==")) kind = "fused14Array";
  else if (reads === 14 && code.includes(`=${decodeName}(this,`)) kind = "fused14Decode";
  else if (reads === 14 && code.includes(">=") && code.includes(">>") && code.includes("!==")) kind = "fused14Compare";
  else if (reads === 13) kind = "fused13";
  else if (reads === 12 && code.includes("Array(f)") && code.includes("Array(f)")) kind = "fused12Arrays";
  else if (reads === 12 && code.includes("f={}")) kind = "fused12Object";
  else if (reads === 12) kind = "fused12Branch";
  else if (reads === 11 && code.includes(`=${decodeName}(this,`)) kind = "fused11Decode";
  else if (reads === 11 && code.includes("typeof d")) kind = "fused11Global";
  else if (reads === 11) kind = "fused11Arithmetic";
  else if (reads === 10 && code.includes("typeof f")) kind = "fused10Global";
  else if (reads === 10 && code.includes("Math.pow")) kind = "fused10Pow";
  else if (reads === 10) kind = "fused10Constants";
  else if (reads === 9 && code.includes(`=${decodeName}(this,`)) kind = "fused9Branch";
  else if (reads === 9 && code.includes("<<")) kind = "fused9Compare";
  else if (reads === 9) kind = "fused9Shift";
  else if (reads === 8) kind = "fused8";
  else if (reads === 3 && code.includes(`=${decodeName}(this,`)) kind = "decode";
  else if (reads === 3 && code.includes("][")) kind = "get";
  else if (reads === 3 && code.includes(" in this.b")) kind = "global";
  else if (reads === 2 && code.includes("=[v(this),v(this)]")) kind = "constant";
  else if (reads === 1 && code.includes("c[a+12]")) kind = "this";
  else if (reads === 1 && code.includes("w(this")) kind = "return";
  else if (reads === 0 && code.includes("Reflect.set(")) kind = "setFixed";
  else if (reads === 0 && code.includes("][")) kind = "getFixed";
  else if (reads === 0 && code.includes("this.b[")) kind = "globalFixed";
  else if (reads === 0 && code.includes(".j[0].w(")) kind = "captureLoad";
  else if (reads === 0 && code.includes("b.c=[")) kind = "captureStore";
  else if (reads === 0 && code.includes("c[a+12]")) kind = "thisFixed";
  else if (reads === 0 && code.includes(`=${decodeName}(this,`)) kind = "decodeFixed";
  else if (reads === 0 && /\+\d+\]=\d+/.test(code)) kind = "constantFixed";
  else if (reads === 0 && code.includes("debugger")) kind = "debugger";
  else kind = "UNKNOWN";
  return { kind, reads, permutation: permutation(fn), code };
}

const used = new Set(disassembly.instructions.map((instruction) => instruction.opcode));
const decodeName = _internals.findDecodeFunction(ast);
const rows = [...used].sort((a, b) => a - b).map((opcode) => ({
  opcode,
  ...classify(vm.handlers.get(opcode), disassembly.readName, decodeName),
}));
console.log(JSON.stringify(rows.map(({ code, ...row }) => row), null, 2));
for (const row of rows.filter((row) => row.kind === "UNKNOWN")) {
  console.error(`UNKNOWN ${row.opcode}: ${row.code}`);
}
