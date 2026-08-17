"use strict";

const fs = require("fs");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const filename = process.argv[2] || "input.js";
const source = fs.readFileSync(filename, "utf8");
const ast = parser.parse(source, { sourceType: "unambiguous" });

function literalValue(node) {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
    return node.value;
  }
  if (t.isNullLiteral(node)) return null;
  if (t.isUnaryExpression(node, { operator: "-" }) && t.isNumericLiteral(node.argument)) {
    return -node.argument.value;
  }
  if (t.isUnaryExpression(node, { operator: "!" }) && t.isNumericLiteral(node.argument)) {
    return !node.argument.value;
  }
  if (t.isUnaryExpression(node, { operator: "void" })) return undefined;
  if (t.isArrayExpression(node)) return node.elements.map(literalValue);
  throw new Error(`Unsupported literal: ${generate(node).code}`);
}

let prototypeAlias;
const handlers = new Map();
let bytecodeBase64;
let constants;
let entryMetadata;

traverse(ast, {
  VariableDeclarator(path) {
    const { node } = path;
    if (
      t.isIdentifier(node.id) &&
      t.isMemberExpression(node.init) &&
      !node.init.computed &&
      t.isIdentifier(node.init.property, { name: "prototype" })
    ) {
      prototypeAlias = node.id.name;
    }

    if (
      t.isIdentifier(node.id) &&
      t.isCallExpression(node.init) &&
      t.isIdentifier(node.init.callee, { name: "e" }) &&
      t.isStringLiteral(node.init.arguments[0])
    ) {
      bytecodeBase64 = node.init.arguments[0].value;
    }
  },
  AssignmentExpression(path) {
    const { node } = path;
    if (
      t.isMemberExpression(node.left, { computed: true }) &&
      t.isIdentifier(node.left.object, { name: prototypeAlias }) &&
      t.isNumericLiteral(node.left.property) &&
      (t.isFunctionExpression(node.right) || t.isArrowFunctionExpression(node.right))
    ) {
      handlers.set(node.left.property.value, node.right);
    }
  },
  CallExpression(path) {
    const { node } = path;
    if (!t.isIdentifier(node.callee, { name: "y" }) || node.arguments.length < 5) return;
    const machine = node.arguments[0];
    if (!t.isNewExpression(machine) || machine.arguments.length < 2) return;
    if (t.isArrayExpression(machine.arguments[1])) constants = literalValue(machine.arguments[1]);
    const metadata = node.arguments[4];
    if (t.isNewExpression(metadata) && t.isObjectExpression(metadata.arguments[0])) {
      entryMetadata = Object.fromEntries(
        metadata.arguments[0].properties.map((property) => [
          property.key.name || property.key.value,
          literalValue(property.value),
        ]),
      );
    }
  },
});

if (!bytecodeBase64 || !constants || !entryMetadata) {
  throw new Error("Could not locate the VM bootstrap pattern");
}

const bytes = Buffer.from(bytecodeBase64, "base64");
const bytecode = new Uint32Array(bytes.length / 4);
for (let index = 0; index < bytecode.length; index++) {
  bytecode[index] = bytes.readUInt32LE(index * 4);
}

const report = {
  filename,
  bytes: bytes.length,
  words: bytecode.length,
  constants: constants.length,
  handlers: handlers.size,
  entryMetadata,
  handlerTable: Object.fromEntries(
    [...handlers].sort(([a], [b]) => a - b).map(([opcode, fn]) => [opcode, generate(fn).code]),
  ),
};

console.log(JSON.stringify(report, null, 2));
