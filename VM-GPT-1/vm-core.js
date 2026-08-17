"use strict";

// Structural analysis primitives used by the bytecode lifter.

const fs = require("fs");
const nodeVm = require("vm");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const bt = require("@babel/types");

function parse(source) {
  return parser.parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: ["jsx", "classProperties", "classPrivateProperties", "classPrivateMethods"],
  });
}

function literalValue(node) {
  if (bt.isStringLiteral(node) || bt.isNumericLiteral(node) || bt.isBooleanLiteral(node)) return node.value;
  if (bt.isNullLiteral(node)) return null;
  if (bt.isUnaryExpression(node, { operator: "-" }) && bt.isNumericLiteral(node.argument)) return -node.argument.value;
  if (bt.isUnaryExpression(node, { operator: "!" }) && bt.isNumericLiteral(node.argument)) return !node.argument.value;
  if (bt.isUnaryExpression(node, { operator: "void" })) return undefined;
  if (bt.isArrayExpression(node)) return node.elements.map(literalValue);
  throw new Error(`Unsupported VM literal: ${generate(node).code}`);
}

function objectLiteralValue(node) {
  if (!bt.isObjectExpression(node)) throw new Error("Expected VM metadata object");
  return Object.fromEntries(node.properties.map((property) => [
    property.key.name || property.key.value,
    literalValue(property.value),
  ]));
}

function countCalls(node, calleeName) {
  let count = 0;
  function visit(current) {
    if (!current || typeof current !== "object") return;
    if (bt.isCallExpression(current) && bt.isIdentifier(current.callee, { name: calleeName })) count++;
    for (const key of bt.VISITOR_KEYS[current.type] || []) {
      const child = current[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(node);
  return count;
}

function findVm(ast) {
  let prototypeAlias;
  let machineConstructor;
  let bootstrap;
  let bytecodeBase64;
  const handlers = new Map();

  traverse(ast, {
    VariableDeclarator(path) {
      const { node } = path;
      if (
        bt.isIdentifier(node.id) &&
        bt.isMemberExpression(node.init) &&
        !node.init.computed &&
        bt.isIdentifier(node.init.object) &&
        bt.isIdentifier(node.init.property, { name: "prototype" })
      ) {
        prototypeAlias = node.id.name;
        machineConstructor = node.init.object.name;
      }
      if (
        bt.isCallExpression(node.init) &&
        node.init.arguments.some((argument) => bt.isStringLiteral(argument) && argument.value.length > 1000)
      ) {
        const payload = node.init.arguments.find((argument) => bt.isStringLiteral(argument) && argument.value.length > 1000);
        bytecodeBase64 = payload.value;
      }
    },
    AssignmentExpression(path) {
      const { node } = path;
      if (
        bt.isMemberExpression(node.left, { computed: true }) &&
        bt.isIdentifier(node.left.object, { name: prototypeAlias }) &&
        bt.isNumericLiteral(node.left.property) &&
        bt.isFunctionExpression(node.right)
      ) {
        handlers.set(node.left.property.value, node.right);
      }
    },
    CallExpression(path) {
      const { node } = path;
      if (
        node.arguments.length >= 5 &&
        bt.isNewExpression(node.arguments[0]) &&
        bt.isIdentifier(node.arguments[0].callee, { name: machineConstructor }) &&
        bt.isArrayExpression(node.arguments[0].arguments[1])
      ) {
        bootstrap = node;
      }
    },
  });

  if (!prototypeAlias || !machineConstructor || !bootstrap || !bytecodeBase64 || handlers.size < 20) return null;
  const machine = bootstrap.arguments[0];
  const metadataNode = bootstrap.arguments[4];
  if (!bt.isNewExpression(metadataNode) || !bt.isObjectExpression(metadataNode.arguments[0])) return null;

  return {
    prototypeAlias,
    machineConstructor,
    bootstrap,
    bytecodeBase64,
    handlers,
    constants: literalValue(machine.arguments[1]),
    globalExpression: machine.arguments[2],
    metadata: objectLiteralValue(metadataNode.arguments[0]),
    metadataConstructor: metadataNode.callee.name,
    interpreterName: bt.isIdentifier(bootstrap.callee) ? bootstrap.callee.name : null,
  };
}

function decodeBytecode(base64) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length % 4 !== 0) throw new Error("The VM bytecode payload is not word-aligned");
  const words = [];
  for (let offset = 0; offset < bytes.length; offset += 4) words.push(bytes.readUInt32LE(offset));
  return words;
}

function classifyHandler(fn, readName) {
  const code = generate(fn, { compact: true }).code;
  let variadicSentinel;
  traverse(bt.file(bt.program([bt.expressionStatement(bt.cloneNode(fn, true))])), {
    BinaryExpression(path) {
      if (!["===", "==", "!==", "!="].includes(path.node.operator)) return;
      const literal = bt.isNumericLiteral(path.node.left) ? path.node.left : bt.isNumericLiteral(path.node.right) ? path.node.right : null;
      const variable = literal === path.node.left ? path.node.right : path.node.left;
      if (literal && bt.isIdentifier(variable)) variadicSentinel = literal.value;
    },
  });
  return {
    code,
    fixedOperands: countCalls(fn.body, readName),
    makeFunction: code.includes("new r({") && code.includes("g.set("),
    construct: code.includes("Reflect.construct("),
    directCall: code.includes(".apply(null,"),
    methodCall: code.includes(".apply(d,"),
    dynamicObject: code.includes("f={}") && code.includes("f[k]=l"),
    dynamicArray: code.includes("f=Array(d)") && code.includes("h<d"),
    variadicSentinel,
  };
}

function findReadFunction(ast) {
  let result = "v";
  traverse(ast, {
    FunctionDeclaration(path) {
      const code = generate(path.node.body, { compact: true }).code;
      if (code.includes(".l[") && code.includes(".h[") && code.includes("++]")) result = path.node.id.name;
    },
  });
  return result;
}

function operandCount(info, words, pc) {
  if (info.makeFunction) return 6 + 2 * words[pc + 5];
  if (info.dynamicObject) return 2 + 2 * words[pc + 2];
  if (info.dynamicArray) return 2 + words[pc + 2];
  if (info.methodCall) {
    const count = words[pc + 4];
    return 4 + (count === info.variadicSentinel ? 1 : count);
  }
  if (info.directCall || info.construct) {
    const count = words[pc + 3];
    return 3 + (count === info.variadicSentinel ? 1 : count);
  }
  return info.fixedOperands;
}

function disassemble(vmInfo, ast) {
  const words = decodeBytecode(vmInfo.bytecodeBase64);
  const readName = findReadFunction(ast);
  const classified = new Map([...vmInfo.handlers].map(([opcode, fn]) => [opcode, classifyHandler(fn, readName)]));
  const instructions = [];
  let pc = 0;
  while (pc < words.length) {
    const opcode = words[pc];
    const info = classified.get(opcode);
    if (!info) throw new Error(`Unknown opcode ${opcode} at bytecode word ${pc}`);
    const count = operandCount(info, words, pc);
    if (!Number.isSafeInteger(count) || count < 0 || pc + count >= words.length + 1) {
      throw new Error(`Invalid operand count ${count} for opcode ${opcode} at ${pc}`);
    }
    instructions.push({ pc, next: pc + count + 1, opcode, operands: words.slice(pc + 1, pc + count + 1) });
    pc += count + 1;
  }
  return { words, instructions, readName, handlerInfo: classified };
}

function universal(label) {
  const target = function placeholder() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => `[${label}]`;
      if (property === "toString") return () => `[${label}]`;
      if (property === "valueOf") return () => 0;
      if (property === "length") return 0;
      return universal(`${label}.${String(property)}`);
    },
    set() { return true; },
    apply() { return universal(`${label}()`); },
    construct() { return universal(`new ${label}()`); },
  });
}

function collectDecodedConstants(source, vmInfo, disassembly) {
  const ast = parse(source);
  let replaced = false;
  traverse(ast, {
    ExpressionStatement(path) {
      if (path.node.expression.start !== vmInfo.bootstrap.start || replaced) return;
      replaced = true;
      path.replaceWith(bt.expressionStatement(bt.assignmentExpression(
        "=",
        bt.memberExpression(bt.identifier("globalThis"), bt.identifier("__runVmBootstrap")),
        bt.arrowFunctionExpression([], bt.cloneNode(path.node.expression, true)),
      )));
    },
  });
  if (!replaced) throw new Error("Could not isolate the VM bootstrap");

  const silentConsole = Object.fromEntries(
    ["log", "info", "warn", "error", "debug", "trace", "dir"].map((name) => [name, () => {}]),
  );
  const sandbox = {
    Buffer,
    console: silentConsole,
    module: { exports: {} },
    exports: {},
    window: {},
    document: universal("document"),
    requestAnimationFrame: universal("requestAnimationFrame"),
    cancelAnimationFrame: universal("cancelAnimationFrame"),
    alert: universal("alert"),
  };
  sandbox.globalThis = sandbox;
  nodeVm.createContext(sandbox);
  nodeVm.runInContext(generate(ast, { compact: true }).code, sandbox, { timeout: 10000 });

  const decodeName = findDecodeFunction(ast, vmInfo);
  const originalDecode = sandbox[decodeName];
  if (typeof originalDecode !== "function") throw new Error("Could not find the VM constant decoder");
  const decodedByIndex = new Map();
  sandbox[decodeName] = function recordDecode(machine, index, key) {
    const actualIndex = index ?? sandbox[findReadFunction(ast)](machine);
    const actualKey = key ?? sandbox[findReadFunction(ast)](machine);
    const value = originalDecode(machine, actualIndex, actualKey);
    if (typeof machine.C[actualIndex] === "string") decodedByIndex.set(actualIndex, value);
    return value;
  };

  nodeVm.runInContext("globalThis.__runVmBootstrap()", sandbox, { timeout: 10000 });
  for (const key of Object.keys(sandbox.window)) {
    if (typeof sandbox.window[key] !== "function") continue;
    sandbox.__vmEntry = sandbox.window[key];
    nodeVm.runInContext("globalThis.__vmEntry()", sandbox, { timeout: 15000 });
  }

  // Probe every statically decoded string operation as well. This covers cold
  // branches without executing their surrounding application behavior.
  for (const instruction of disassembly.instructions) {
    const handlerInfo = vmInfo.handlers.get(instruction.opcode);
    if (!handlerInfo || !generate(handlerInfo, { compact: true }).code.includes(`${decodeName}(`)) continue;
    const machine = new sandbox[vmInfo.machineConstructor](disassembly.words.slice(), vmInfo.constants, universal("global"));
    machine.g = 0;
    machine.i = 200;
    machine.h = Array.from({ length: 220 }, () => universal("register"));
    machine.h[2] = instruction.pc + 1;
    machine.h[3] = { j: Array.from({ length: 20 }, () => ({ w: () => universal("capture"), c: null })) };
    machine.h[6] = [];
    machine.h[8] = 180;
    machine.h[9] = 20;
    machine.h[12] = universal("this");
    try { sandbox[vmInfo.machineConstructor].prototype[instruction.opcode].call(machine); } catch {}
  }

  const decoded = vmInfo.constants.map((value, index) => {
    if (typeof value !== "string") return value;
    return decodedByIndex.has(index) ? decodedByIndex.get(index) : undefined;
  });
  return decoded;
}

function findDecodeFunction(ast, vmInfo) {
  const handlerCallees = new Set();
  for (const handler of vmInfo.handlers.values()) {
    traverse(bt.file(bt.program([bt.expressionStatement(bt.cloneNode(handler, true))])), {
      CallExpression(path) {
        if (bt.isIdentifier(path.node.callee)) handlerCallees.add(path.node.callee.name);
      },
    });
  }
  let name;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (!path.node.id || !handlerCallees.has(path.node.id.name) || path.node.params.length < 3 ||
          !path.node.params.slice(0, 3).every((parameter) => bt.isIdentifier(parameter))) return;
      const [machine, index] = path.node.params;
      let indexesMachineStorage = false;
      path.traverse({
        MemberExpression(memberPath) {
          const member = memberPath.node;
          if (member.computed && bt.isIdentifier(member.property, { name: index.name }) && bt.isMemberExpression(member.object) &&
              bt.isIdentifier(member.object.object, { name: machine.name })) indexesMachineStorage = true;
        },
      });
      if (indexesMachineStorage) name = path.node.id.name;
    },
  });
  if (!name) throw new Error("Could not structurally identify the VM constant decoder");
  return name;
}

function transform(source) {
  const ast = parse(source);
  const vmInfo = findVm(ast);
  if (!vmInfo) return generate(ast, { comments: true, compact: false }).code + "\n";
  const { lift } = require("./lifter.js");
  return lift(source, module.exports._internals).output;
}

function deobfuscate(inputPath, outputPath) {
  const source = fs.readFileSync(inputPath, "utf8");
  const output = transform(source);
  if (outputPath) fs.writeFileSync(outputPath, output);
  return output;
}

module.exports = deobfuscate;
module.exports.transform = transform;
module.exports._internals = {
  parse,
  findVm,
  disassemble,
  collectDecodedConstants,
  findReadFunction,
  findDecodeFunction,
};

if (require.main === module) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error("Usage: node vm.js <input.js> <output.js>");
    process.exitCode = 1;
  } else {
    deobfuscate(inputPath, outputPath);
  }
}
