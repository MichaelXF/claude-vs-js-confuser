"use strict";

const fs = require("fs");
const nodeVm = require("vm");
const generate = require("@babel/generator").default;
const traverse = require("@babel/traverse").default;
const t = require("@babel/types");

function lift(source, _internals, options = {}) {
const ast = _internals.parse(source);
const vmInfo = _internals.findVm(ast);
const disassembly = _internals.disassemble(vmInfo, ast);
const decodedConstants = _internals.collectDecodedConstants(source, vmInfo, disassembly);
const decodeName = _internals.findDecodeFunction(ast, vmInfo);
const cfgSummaries = [];

function universal(label) {
  const target = function placeholder() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => 0;
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

function traceProgram() {
  const traceAst = _internals.parse(source);
  let replaced = false;
  traverse(traceAst, {
    ExpressionStatement(path) {
      if (replaced || path.node.expression.start !== vmInfo.bootstrap.start) return;
      replaced = true;
      path.replaceWith(t.expressionStatement(t.assignmentExpression(
        "=",
        t.memberExpression(t.identifier("globalThis"), t.identifier("__bootstrap")),
        t.arrowFunctionExpression([], t.cloneNode(path.node.expression, true)),
      )));
    },
  });
  const traceEffects = [];
  let randomState = 123456789;
  let clock = 1700000000000;
  const tracedMath = Object.create(Math);
  tracedMath.random = () => ((randomState = (1103515245 * randomState + 12345) >>> 0) / 0x100000000);
  class TracedDate extends Date {}
  TracedDate.now = () => clock++;
  const sandbox = {
    Buffer,
    console: { log: (...values) => traceEffects.push(values), info() {}, warn() {}, error() {}, debug() {} },
    module: { exports: {} },
    exports: {},
    window: {},
    document: universal("document"),
    requestAnimationFrame: universal("requestAnimationFrame"),
    cancelAnimationFrame: universal("cancelAnimationFrame"),
    alert: universal("alert"),
    ...(options.deterministic ? { Math: tracedMath, Date: TracedDate } : {}),
  };
  sandbox.globalThis = sandbox;
  nodeVm.createContext(sandbox);
  nodeVm.runInContext(generate(traceAst, { compact: true }).code, sandbox, { timeout: 10000 });

  const events = [];
  const originalRead = sandbox[disassembly.readName];
  sandbox[disassembly.readName] = function tracedRead(machine) {
    const pc = machine.h[machine.g + 2];
    const value = originalRead(machine);
    events[events.length - 1].reads.push({ pc, value });
    return value;
  };

  for (const key of Object.getOwnPropertyNames(sandbox[vmInfo.machineConstructor].prototype)) {
    if (!/^\d+$/.test(key)) continue;
    const original = sandbox[vmInfo.machineConstructor].prototype[key];
    const handlerCode = generate(vmInfo.handlers.get(Number(key)), { compact: true }).code;
    const isReturnHandler = handlerCode.includes("w(this,") && handlerCode.includes("this.g=d");
    const isJumpHandler = handlerCode.includes("this.h[this.g+2]=");
    sandbox[vmInfo.machineConstructor].prototype[key] = function tracedHandler() {
      const frame = this.g;
      const metadata = this.h[frame + 3];
      const event = {
        opcode: Number(key),
        pc: this.h[frame + 2] - 1,
        frame,
        entry: metadata && metadata.I ? metadata.I.B : null,
        reads: [],
      };
      const registerBase = this.h[frame + 9];
      if (isReturnHandler || isJumpHandler) {
        const registerBase = this.h[frame + 9];
        const registerCount = this.h[frame + 8] - 15;
        event.beforeRegisters = Array.from({ length: registerCount }, (_, index) => this.h[registerBase + index]);
      }
      events.push(event);
      try {
        return original.call(this);
      } finally {
        event.nextFrame = this.g;
        event.next = this.g ? this.h[this.g + 2] : null;
        const nextMetadata = this.g ? this.h[this.g + 3] : null;
        event.nextEntry = nextMetadata && nextMetadata.I ? nextMetadata.I.B : null;
        try {
          const tracedInstruction = instructionByPc.get(event.pc);
          if (tracedInstruction && semantics.get(event.opcode).kind === "makeFunction") {
            const childMetadata = functionMetadata.get(tracedInstruction.operands[1]);
            if (childMetadata) childMetadata.parentEntry = event.entry;
          }
          const lowered = lower(event);
          const destinations = [];
          for (const statement of lowered) {
            if (!t.isExpressionStatement(statement) || !t.isAssignmentExpression(statement.expression)) continue;
            const left = statement.expression.left;
            if (t.isMemberExpression(left, { computed: true }) && t.isNumericLiteral(left.property)) destinations.push(left.property.value);
          }
          event.destValues = Object.fromEntries([...new Set(destinations)].map((destination) => [destination, this.h[registerBase + destination]]));
        } catch {}
      }
    };
  }

  sandbox.__bootstrap();
  const callbackStart = events.length;
  const windowKey = Object.keys(sandbox.window).find((key) => typeof sandbox.window[key] === "function");
  if (!windowKey) throw new Error("No browser callback was installed");
  sandbox.__entry = sandbox.window[windowKey];
  const callbackRuns = [];
  for (let invocation = 0; invocation < 2; invocation++) {
    const invocationStart = events.length;
    nodeVm.runInContext("globalThis.__entry()", sandbox, { timeout: 20000 });
    callbackRuns.push(events.slice(invocationStart));
  }
  return { rootEvents: events.slice(0, callbackStart), callbackEvents: callbackRuns.flat(), callbackRuns, windowKey };
}

function countReads(fn) {
  let count = 0;
  (function visit(node) {
    if (!node || typeof node !== "object") return;
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: disassembly.readName })) count++;
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  })(fn.body);
  return count;
}

function permutation(fn) {
  let result;
  (function visit(node) {
    if (!node || typeof node !== "object" || result) return;
    if (t.isArrayExpression(node) && node.elements.length > 1 && node.elements.every((element) =>
      t.isMemberExpression(element, { computed: true }) && t.isIdentifier(element.object) && t.isNumericLiteral(element.property))) {
      const objectName = node.elements[0].object.name;
      if (node.elements.every((element) => element.object.name === objectName)) {
        result = node.elements.map((element) => element.property.value);
        return;
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  })(fn.body);
  return result;
}

function classify(fn) {
  const code = generate(fn, { compact: true }).code;
  const reads = countReads(fn);
  let kind;
  if (code.includes(`new ${vmInfo.metadataConstructor}({`) && code.includes("g.set(")) kind = "makeFunction";
  else if (code.includes("Reflect.construct(")) kind = "construct";
  else if (code.includes(".apply(null,")) kind = "directCall";
  else if (code.includes(".apply(d,")) kind = "methodCall";
  else if (code.includes("w(this,") && code.includes("this.g=d")) kind = "return";
  else if (code.includes("this.h[this.g+2]=")) kind = "jump";
  else if (code.includes("c[a+2]=c[c[a+9]+")) kind = "jumpRegister";
  else if (code.includes("for(") && code.includes("={}") && code.includes("]=l")) kind = "object";
  else if (reads === 14 && code.includes("Array(f)") && code.includes("!==")) kind = "fused14Array";
  else if (reads === 14 && code.includes(`=${decodeName}(this,`)) kind = "fused14Decode";
  else if (reads === 14) kind = "fused14Compare";
  else if (reads === 13) kind = "fused13";
  else if (reads === 12 && (code.match(/Array\(f\)/g) || []).length === 2) kind = "fused12Arrays";
  else if (reads === 12 && code.includes("={}")) kind = "fused12Object";
  else if (reads === 12) kind = "fused12Branch";
  else if (reads === 11 && code.includes("typeof d")) kind = "fused11Global";
  else if (reads === 11 && code.includes(`=${decodeName}(this,`)) kind = "fused11Decode";
  else if (reads === 11) kind = "fused11Arithmetic";
  else if (reads === 10 && code.includes("typeof f")) kind = "fused10Global";
  else if (reads === 10 && code.includes("Math.pow")) kind = "fused10Pow";
  else if (reads === 10) kind = "fused10Constants";
  else if (reads === 9 && code.includes(`=${decodeName}(this,`)) kind = "fused9Branch";
  else if (reads === 9 && code.includes("<<")) kind = "fused9Compare";
  else if (reads === 9) kind = "fused9Shift";
  else if (reads === 8) kind = "fused8";
  else if (reads === 3 && code.includes(" in this.b")) kind = "global";
  else if (reads === 3 && code.includes(`=${decodeName}(this,`)) kind = "decode";
  else if (reads === 3 && code.includes("][")) kind = "get";
  else if (reads === 2 && code.includes("=[v(this),v(this)]")) kind = "constant";
  else if (reads === 1 && code.includes("c[a+12]")) kind = "this";
  else if (reads === 0 && code.includes("Reflect.set(")) kind = "setFixed";
  else if (reads === 0 && code.includes("][")) kind = "getFixed";
  else if (reads === 0 && code.includes("this.b[")) kind = "globalFixed";
  else if (reads === 0 && code.includes(".j[0].w(")) kind = "captureLoad";
  else if (reads === 0 && code.includes("b.c=[")) kind = "captureStore";
  else if (reads === 0 && code.includes("c[a+12]")) kind = "thisFixed";
  else if (reads === 0 && code.includes(`=${decodeName}(this,`)) kind = "decodeFixed";
  else if (reads === 0 && /\+\d+\]=\d+/.test(code)) kind = "constantFixed";
  else if (reads === 0 && code.includes("debugger")) kind = "debugger";
  else kind = "unknown";
  return { kind, code, permutation: permutation(fn) };
}

const semantics = new Map([...vmInfo.handlers].map(([opcode, fn]) => [opcode, classify(fn)]));
const instructionByPc = new Map(disassembly.instructions.map((instruction) => [instruction.pc, instruction]));
const functionMetadata = new Map();
for (const instruction of disassembly.instructions) {
  if (semantics.get(instruction.opcode).kind !== "makeFunction") continue;
  const [destination, entry, arity, registers, captures, rest, ...pairs] = instruction.operands;
  functionMetadata.set(entry, { destination, entry, arity, registers, captures, rest, pairs, creationPc: instruction.pc });
}

const id = (name) => t.identifier(name);
const reg = (entry, index) => t.memberExpression(id(`registers_${entry}`), t.numericLiteral(index), true);
const valueNode = (value) => value === undefined ? t.unaryExpression("void", t.numericLiteral(0)) : t.valueToNode(value);
const bin = (operator, left, right) => t.binaryExpression(operator, left, right);
const unary = (operator, argument) => t.unaryExpression(operator, argument, true);
const assign = (entry, destination, expression) => t.expressionStatement(t.assignmentExpression("=", reg(entry, destination), expression));
const globalMember = (name) => t.memberExpression(id("globalThis"), t.stringLiteral(name), true);
const decode = (index, key = 0) => {
  const raw = vmInfo.constants[index];
  return valueNode(typeof raw === "number" && key ? raw ^ key : decodedConstants[index]);
};

function permuted(instruction, semantic) {
  return semantic.permutation ? semantic.permutation.map((index) => instruction.operands[index]) : instruction.operands;
}

function fixedNumbers(code) {
  return [...code.matchAll(/\+(\d+)\]/g)].map((match) => Number(match[1]));
}

function returnRegister(semantic, instruction) {
  if (instruction.operands.length === 1) return instruction.operands[0];
  const match = semantic.code.match(/b=c\[c\[a\+9\]\+(\d+)\]/) || semantic.code.match(/b=c\[b\+(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function capturedRegister(entry, semantic) {
  const metadata = functionMetadata.get(entry);
  const captureMatch = semantic.code.match(/\.j\[(\d+)\]/);
  const captureIndex = captureMatch ? Number(captureMatch[1]) : 0;
  const captureKind = metadata && metadata.pairs[captureIndex * 2];
  const sourceRegister = metadata && metadata.pairs[captureIndex * 2 + 1];
  if (!metadata || metadata.parentEntry === undefined || captureKind !== 1 || sourceRegister === undefined) {
    throw new Error(`Unsupported capture ${captureIndex} in function ${entry}`);
  }
  return reg(metadata.parentEntry, sourceRegister);
}

function lower(event) {
  const instruction = instructionByPc.get(event.pc);
  const semantic = semantics.get(event.opcode);
  const entry = event.entry;
  const p = permuted(instruction, semantic);
  const R = (index) => reg(entry, index);
  const A = (destination, expression) => assign(entry, destination, expression);
  const statements = [];
  switch (semantic.kind) {
    case "constant": statements.push(A(p[0], valueNode(p[1]))); break;
    case "decode": statements.push(A(p[0], decode(p[1], p[2]))); break;
    case "get": statements.push(A(p[0], t.memberExpression(R(p[1]), R(p[2]), true))); break;
    case "global": statements.push(A(p[0], globalMember(decodedConstants[p[1]]))); break;
    case "this": statements.push(A(instruction.operands[0], id(`this_${entry}`))); break;
    case "object": {
      const [destination, count, ...pairs] = instruction.operands;
      statements.push(A(destination, t.objectExpression(Array.from({ length: count }, (_, index) =>
        t.objectProperty(R(pairs[index * 2]), R(pairs[index * 2 + 1]), true)))));
      break;
    }
    case "methodCall":
    case "directCall":
    case "construct": {
      const method = semantic.kind === "methodCall";
      const destination = instruction.operands[0];
      const receiver = method ? instruction.operands[1] : null;
      const fnRegister = instruction.operands[method ? 2 : 1];
      const count = instruction.operands[method ? 3 : 2];
      const variadicSentinel = disassembly.handlerInfo.get(instruction.opcode).variadicSentinel;
      const argumentRegisters = count === variadicSentinel
        ? null
        : instruction.operands.slice(method ? 4 : 3, (method ? 4 : 3) + count);
      let expression;
      if (semantic.kind === "construct") {
        expression = argumentRegisters
          ? t.newExpression(R(fnRegister), argumentRegisters.map(R))
          : t.callExpression(t.memberExpression(id("Reflect"), id("construct")), [R(fnRegister), R(instruction.operands[3])]);
      } else {
        const args = argumentRegisters ? t.arrayExpression(argumentRegisters.map(R)) : R(instruction.operands[method ? 4 : 3]);
        expression = t.callExpression(t.memberExpression(R(fnRegister), id("apply")), [method ? R(receiver) : t.nullLiteral(), args]);
      }
      statements.push(A(destination, expression));
      break;
    }
    case "setFixed": {
      const numbers = fixedNumbers(semantic.code);
      const last = numbers.slice(-3);
      statements.push(t.expressionStatement(t.callExpression(t.memberExpression(id("Reflect"), id("set")), last.map(R))));
      break;
    }
    case "getFixed": {
      const numbers = fixedNumbers(semantic.code);
      const last = numbers.slice(-3);
      statements.push(A(last[0], t.memberExpression(R(last[1]), R(last[2]), true)));
      break;
    }
    case "globalFixed": {
      const destination = Number((semantic.code.match(/\+(\d+)\]=this\.b/) || [])[1]);
      const index = Number((semantic.code.match(new RegExp(`${decodeName}\\(this,(\\d+),`)) || [])[1]);
      statements.push(A(destination, globalMember(decodedConstants[index])));
      break;
    }
    case "decodeFixed": {
      const destination = Number((semantic.code.match(/\+(\d+)\]=/) || [])[1]);
      const index = Number((semantic.code.match(new RegExp(`${decodeName}\\(this,(\\d+),`)) || [])[1]);
      const key = Number((semantic.code.match(new RegExp(`${decodeName}\\(this,\\d+,(\\d+)\\)`)) || [])[1] || 0);
      statements.push(A(destination, decode(index, key)));
      break;
    }
    case "constantFixed": {
      const match = semantic.code.match(/\+(\d+)\]=(\d+)/);
      statements.push(A(Number(match[1]), valueNode(Number(match[2]))));
      break;
    }
    case "thisFixed": {
      const destination = Number((semantic.code.match(/\+(\d+)\]=c\[a\+12\]/) || [])[1]);
      statements.push(A(destination, id(`this_${entry}`)));
      break;
    }
    case "captureLoad": {
      const destination = Number((semantic.code.match(/\+(\d+)\]=c\[a\+3\]/) || [])[1]);
      const capture = capturedRegister(entry, semantic);
      statements.push(A(destination, capture));
      break;
    }
    case "captureStore": {
      const sourceRegister = Number((semantic.code.match(/\+9\]\+(\d+)\]/) || [])[1]);
      const capture = capturedRegister(entry, semantic);
      statements.push(t.expressionStatement(t.assignmentExpression("=", capture, R(sourceRegister))));
      break;
    }
    case "fused8":
      statements.push(A(p[0], bin("/", R(p[1]), R(p[2]))), A(p[3], unary("+", R(p[4]))), A(p[5], bin("&", R(p[6]), R(p[7]))));
      break;
    case "fused9Shift":
      statements.push(A(p[0], bin("===", R(p[1]), R(p[2]))), A(p[3], bin(">>>", R(p[4]), R(p[5]))), A(p[6], bin(">>>", R(p[7]), R(p[8]))));
      break;
    case "fused9Compare":
      statements.push(A(p[0], bin("<<", R(p[1]), R(p[2]))), A(p[3], bin(">", R(p[4]), R(p[5]))), A(p[6], bin("!==", R(p[7]), R(p[8]))));
      break;
    case "fused9Branch":
      statements.push(A(p[0], unary("+", R(p[1]))), A(p[4], decode(p[5], p[6])), A(p[7], unary("+", R(p[8]))));
      break;
    case "fused10Pow":
      statements.push(A(p[0], bin("**", R(p[1]), R(p[2]))), A(p[3], R(p[4])), A(p[5], bin("==", R(p[6]), R(p[7]))), A(p[8], unary("-", R(p[9]))));
      break;
    case "fused10Constants":
      statements.push(A(p[0], unary("~", R(p[1]))), A(p[2], valueNode(p[3])), A(p[4], unary("-", R(p[5]))), A(p[6], unary("~", R(p[7]))), A(p[8], valueNode(p[9])));
      break;
    case "fused10Global":
      statements.push(A(p[0], unary("-", R(p[1]))), A(p[2], unary("typeof", globalMember(decodedConstants[p[3]]))), A(p[5], valueNode(p[6])), A(p[7], bin("<=", R(p[8]), R(p[9]))));
      break;
    case "fused11Arithmetic":
      statements.push(A(p[0], bin(">=", R(p[1]), R(p[2]))), A(p[3], bin("^", R(p[4]), R(p[5]))), A(p[6], unary("-", R(p[7]))), A(p[8], bin("*", R(p[9]), R(p[10]))));
      break;
    case "fused11Decode":
      statements.push(A(p[0], bin(">>>", R(p[1]), R(p[2]))), A(p[3], bin("^", R(p[4]), R(p[5]))), A(p[6], unary("typeof", R(p[7]))), A(p[8], decode(p[9], p[10])));
      break;
    case "fused11Global":
      statements.push(A(p[0], bin(">>>", R(p[1]), R(p[2]))), A(p[3], bin("-", R(p[4]), R(p[5]))), A(p[6], valueNode(p[7])), A(p[8], unary("typeof", globalMember(decodedConstants[p[9]]))));
      break;
    case "fused12Branch":
      statements.push(A(p[0], unary("!", R(p[1]))), A(p[2], bin("/", R(p[3]), R(p[4]))), A(p[7], bin("^", R(p[8]), R(p[9]))));
      break;
    case "fused12Object": {
      const properties = Array.from({ length: p[1] }, () => t.objectProperty(R(p[2]), R(p[3]), true));
      statements.push(A(p[0], t.objectExpression(properties)), A(p[4], bin("&", R(p[5]), R(p[6]))), A(p[7], bin("<", R(p[8]), R(p[9]))), A(p[10], valueNode(p[11])));
      break;
    }
    case "fused12Arrays":
      statements.push(A(p[0], t.arrayExpression(Array.from({ length: p[1] }, () => R(p[2])))), A(p[3], t.arrayExpression(Array.from({ length: p[4] }, () => R(p[5])))), A(p[6], bin("|", R(p[7]), R(p[8]))), A(p[9], bin("-", R(p[10]), R(p[11]))));
      break;
    case "fused13":
      statements.push(A(p[0], globalMember(decodedConstants[p[1]])), A(p[3], unary("typeof", R(p[4]))), A(p[7], bin("<", R(p[8]), R(p[9]))), A(p[10], bin("%", R(p[11]), R(p[12]))));
      break;
    case "fused14Compare":
      statements.push(A(p[0], unary("-", R(p[1]))), A(p[2], bin(">", R(p[3]), R(p[4]))), A(p[5], bin(">=", R(p[6]), R(p[7]))), A(p[8], bin("!==", R(p[9]), R(p[10]))), A(p[11], bin(">>", R(p[12]), R(p[13]))));
      break;
    case "fused14Array":
      statements.push(A(p[0], unary("+", R(p[1]))), A(p[2], bin("+", R(p[3]), R(p[4]))), A(p[5], bin("!==", R(p[6]), R(p[7]))), A(p[8], t.arrayExpression(Array.from({ length: p[9] }, () => R(p[10])))), A(p[11], bin(">>", R(p[12]), R(p[13]))));
      break;
    case "fused14Decode":
      statements.push(A(p[0], t.arrayExpression(Array.from({ length: p[1] }, () => R(p[2])))), A(p[3], bin("%", R(p[4]), R(p[5]))), A(p[6], unary("~", R(p[7]))), A(p[8], bin("^", R(p[9]), R(p[10]))), A(p[11], decode(p[12], p[13])));
      break;
    case "jump": case "jumpRegister": case "debugger": case "makeFunction": case "return":
      break;
    default:
      throw new Error(`Cannot lower ${semantic.kind} opcode ${event.opcode} at ${event.pc}`);
  }
  return statements;
}

const trace = traceProgram();

function findFlattening(events) {
  const perEntry = new Map();
  for (const event of events) {
    if (!perEntry.has(event.entry)) perEntry.set(event.entry, []);
    perEntry.get(event.entry).push(event);
  }
  const helperEntries = new Set();
  const stubPcs = new Set();
  const edgesByEntry = new Map();
  const stateRegisterByEntry = new Map();
  for (const sequence of perEntry.values()) {
    const targets = new Map();
    const frequency = new Map();
    for (const event of sequence) {
      if (!targets.has(event.pc)) targets.set(event.pc, new Set());
      targets.get(event.pc).add(event.next);
      frequency.set(event.pc, (frequency.get(event.pc) || 0) + 1);
    }
    const dynamic = [...targets].find(([, values]) => values.size > 3);
    if (!dynamic) continue;
    const [dispatchPc] = dynamic;
    const dispatchEvent = sequence.find((event) => event.pc === dispatchPc);
    const stateMatch = semantics.get(dispatchEvent.opcode).code.match(/\+9\]\+(\d+)\]/);
    if (stateMatch) stateRegisterByEntry.set(sequence[0].entry, Number(stateMatch[1]));
    const dispatchCount = frequency.get(dispatchPc);
    const localStub = [...frequency].filter(([pc, count]) => pc <= dispatchPc && count === dispatchCount).map(([pc]) => pc);
    localStub.forEach((pc) => stubPcs.add(pc));
    for (const event of sequence) {
      if (localStub.includes(event.pc) && event.nextEntry !== event.entry) helperEntries.add(event.nextEntry);
    }
    const edges = new Map();
    for (let index = 1; index < sequence.length; index++) {
      if (sequence[index].pc !== dispatchPc) continue;
      let predecessorIndex = index - 1;
      while (predecessorIndex >= 0 && localStub.includes(sequence[predecessorIndex].pc)) predecessorIndex--;
      if (predecessorIndex < 0) continue;
      const predecessor = sequence[predecessorIndex];
      if (!edges.has(predecessor.pc)) edges.set(predecessor.pc, new Map());
      const edgeTargets = edges.get(predecessor.pc);
      if (!edgeTargets.has(sequence[index].next)) edgeTargets.set(sequence[index].next, []);
      edgeTargets.get(sequence[index].next).push(predecessor.beforeRegisters || []);
    }
    edgesByEntry.set(sequence[0].entry, edges);
  }
  return { helperEntries, stubPcs, edgesByEntry, stateRegisterByEntry };
}

const flattening = findFlattening(trace.callbackEvents);
const helperCallPcs = new Set(trace.callbackEvents
  .filter((event) => event.nextEntry !== event.entry && flattening.helperEntries.has(event.nextEntry))
  .map((event) => event.pc));
const liftedFunctionCache = new Map();

function branchCondition(targets, registerCount, preferredRegister) {
  const candidates = preferredRegister === undefined
    ? Array.from({ length: registerCount }, (_, index) => index)
    : [preferredRegister, ...Array.from({ length: registerCount }, (_, index) => index).filter((index) => index !== preferredRegister)];
  for (const registerIndex of candidates) {
    const entries = [...targets].map(([target, samples]) => ({ target, values: samples.map((sample) => sample[registerIndex]) }));
    if (!entries.every(({ values }) => values.length && values.every((value) => value === true || value === false || value === 0 || value === 1))) continue;
    const truthiness = entries.map(({ target, values }) => ({ target, values: new Set(values.map(Boolean)) }));
    if (truthiness.every(({ values }) => values.size === 1) && truthiness[0].values.has(true) !== truthiness[1].values.has(true)) {
      return { registerIndex, truthyTarget: truthiness.find(({ values }) => values.has(true)).target };
    }
  }
  throw new Error(`Could not identify a Boolean branch register for targets ${[...targets.keys()].join(", ")}`);
}

function buildLiftedFunction(entry) {
  if (liftedFunctionCache.has(entry)) return t.cloneNode(liftedFunctionCache.get(entry), true);
  const metadata = functionMetadata.get(entry);
  const edgeSamples = flattening.edgesByEntry.get(entry);
  if (!metadata || !edgeSamples) throw new Error(`No reconstructed metadata/edges for function ${entry}`);
  const edges = new Map([...edgeSamples].map(([pc, targets]) => [pc, [...targets.keys()]]));
  const starts = new Set([entry]);
  for (const targets of edges.values()) targets.forEach((target) => starts.add(target));
  const sortedStarts = [...starts].sort((a, b) => a - b);
  const regionEnd = [...functionMetadata.keys()].filter((candidate) => candidate > entry).sort((a, b) => a - b)[0] || disassembly.words.length;
  const functionInstructions = disassembly.instructions.filter((instruction) => instruction.pc >= entry && instruction.pc < regionEnd);
  const blocks = new Map();

  for (let startIndex = 0; startIndex < sortedStarts.length; startIndex++) {
    const start = sortedStarts[startIndex];
    const physicalEnd = sortedStarts[startIndex + 1] || regionEnd;
    const instructions = functionInstructions.filter((instruction) => instruction.pc >= start && instruction.pc < physicalEnd && !flattening.stubPcs.has(instruction.pc));
    const statements = [];
    const kinds = new Set();
    let terminal = null;
    let lastPc = null;
    for (const instruction of instructions) {
      lastPc = instruction.pc;
      const semantic = semantics.get(instruction.opcode);
      kinds.add(semantic.kind);
      if (semantic.kind === "return") {
        const sourceRegister = returnRegister(semantic, instruction);
        terminal = t.returnStatement(sourceRegister === null ? null : reg(entry, sourceRegister));
      } else if (semantic.kind === "jump" || semantic.kind === "jumpRegister") {
        // Replaced by reconstructed edges.
      } else if (semantic.kind === "makeFunction") {
        const childEntry = instruction.operands[1];
        if (!flattening.helperEntries.has(childEntry)) statements.push(assign(entry, instruction.operands[0], buildLiftedFunction(childEntry)));
      } else if (!helperCallPcs.has(instruction.pc)) {
        statements.push(...lower({ pc: instruction.pc, opcode: instruction.opcode, entry }));
      }
      if (["return", "jump", "jumpRegister"].includes(semantic.kind)) break;
    }
    const successors = lastPc !== null && edges.has(lastPc)
      ? edges.get(lastPc)
      : terminal ? [] : sortedStarts[startIndex + 1] ? [sortedStarts[startIndex + 1]] : [];
    blocks.set(start, { start, statements, terminal, successors, endPc: lastPc, kinds });
  }

  const flattenedIncoming = new Map();
  for (const block of blocks.values()) {
    for (const successor of block.successors) flattenedIncoming.set(successor, (flattenedIncoming.get(successor) || 0) + 1);
  }
  const dispatcherHeader = [...flattenedIncoming].filter(([target]) => target !== entry).sort((a, b) => b[1] - a[1])[0][0];
  const applicationKinds = new Set(["makeFunction", "get", "getFixed", "setFixed", "methodCall", "directCall", "construct", "captureLoad", "captureStore", "object", "return"]);
  const boundaryBlock = [...blocks.values()]
    .filter((block) => block.start > dispatcherHeader && [...block.kinds].some((kind) => applicationKinds.has(kind)))
    .sort((a, b) => a.start - b.start)[0];
  if (!boundaryBlock) throw new Error(`Could not separate dispatcher and application blocks for ${entry}`);
  const applicationBoundary = boundaryBlock.start;
  const applicationStarts = new Set([...blocks.keys()].filter((start) => start === entry || start >= applicationBoundary));
  const directEdges = new Map();
  for (const invocationEvents of trace.callbackRuns) {
    let currentApplication = null;
    let transitionRegisters = null;
    for (const event of invocationEvents) {
      if (event.entry !== entry) continue;
      if (applicationStarts.has(event.pc)) {
        if (currentApplication !== null) {
          if (!directEdges.has(currentApplication)) directEdges.set(currentApplication, new Map());
          const targets = directEdges.get(currentApplication);
          if (!targets.has(event.pc)) targets.set(event.pc, []);
          targets.get(event.pc).push(transitionRegisters || []);
        }
        currentApplication = event.pc;
        transitionRegisters = null;
      }
      if (currentApplication !== null && event.beforeRegisters) transitionRegisters = event.beforeRegisters;
    }
  }
  for (const [start, targets] of directEdges) {
    const block = blocks.get(start);
    block.successors = [...targets.keys()];
    block.branchSamples = targets;
  }
  for (const start of [...blocks.keys()]) {
    if (start !== entry && start < applicationBoundary) blocks.delete(start);
  }

  function reaches(start, target, seen = new Set()) {
    if (start === target) return true;
    if (seen.has(start) || !blocks.has(start)) return false;
    seen.add(start);
    return blocks.get(start).successors.some((successor) => reaches(successor, target, seen));
  }
  const cyclicTargets = [];
  for (const block of blocks.values()) {
    for (const successor of block.successors) {
      if (successor !== entry && blocks.has(successor) && reaches(successor, block.start)) cyclicTargets.push(successor);
    }
  }
  const loopHeader = cyclicTargets.length
    ? [...new Set(cyclicTargets)].sort((a, b) => {
      const incomingA = [...blocks.values()].filter((block) => block.successors.includes(a)).length;
      const incomingB = [...blocks.values()].filter((block) => block.successors.includes(b)).length;
      return incomingB - incomingA;
    })[0]
    : null;

  function outcome(start, seen = new Set()) {
    if (loopHeader !== null && start === loopHeader) return "continue";
    if (seen.has(start)) return "cycle";
    seen.add(start);
    const block = blocks.get(start);
    if (!block) return "missing";
    if (block.terminal) return "return";
    if (block.successors.length !== 1) return "branch";
    return outcome(block.successors[0], seen);
  }

  function emitFrom(start, seen = new Set(), withinLoop = true) {
    if (loopHeader !== null && start === loopHeader && seen.size) return withinLoop ? [t.continueStatement()] : [];
    if (seen.has(start)) throw new Error(`Unexpected irreducible cycle at ${start}`);
    seen.add(start);
    const block = blocks.get(start);
    if (!block) throw new Error(`Missing lifted block ${start}`);
    const result = [...block.statements];
    if (block.terminal) return [...result, block.terminal];
    if (block.successors.length === 0) return result;
    if (block.successors.length === 1) return [...result, ...emitFrom(block.successors[0], seen, withinLoop)];
    if (block.successors.length !== 2) throw new Error(`Unsupported ${block.successors.length}-way branch at ${start}`);

    let preferredRegister;
    for (let index = block.statements.length - 1; index >= 0 && preferredRegister === undefined; index--) {
      const statement = block.statements[index];
      if (!t.isExpressionStatement(statement) || !t.isAssignmentExpression(statement.expression, { operator: "=" })) continue;
      const { left, right } = statement.expression;
      if (!t.isMemberExpression(left, { computed: true }) || !t.isNumericLiteral(left.property) || !t.isBinaryExpression(right, { operator: "+" })) continue;
      if (t.isMemberExpression(right.right, { computed: true }) && t.isNumericLiteral(right.right.property)) preferredRegister = right.right.property.value;
    }
    const condition = branchCondition(block.branchSamples || edgeSamples.get(block.endPc), metadata.registers, preferredRegister);
    const [first, second] = block.successors;
    const firstOutcome = outcome(first);
    const secondOutcome = outcome(second);
    if (["continue", "return"].includes(firstOutcome) !== ["continue", "return"].includes(secondOutcome)) {
      const branchTarget = ["continue", "return"].includes(firstOutcome) ? first : second;
      const continuationTarget = branchTarget === first ? second : first;
      const test = condition.truthyTarget === branchTarget ? reg(entry, condition.registerIndex) : unary("!", reg(entry, condition.registerIndex));
      result.push(t.ifStatement(test, t.blockStatement(emitFrom(branchTarget, new Set(seen), withinLoop))));
      result.push(...emitFrom(continuationTarget, seen, withinLoop));
      return result;
    }
    const test = condition.truthyTarget === first ? reg(entry, condition.registerIndex) : unary("!", reg(entry, condition.registerIndex));
    return [...result, t.ifStatement(test, t.blockStatement(emitFrom(first, new Set(seen), withinLoop)), t.blockStatement(emitFrom(second, new Set(seen), withinLoop)))];
  }

  const parameters = Array.from({ length: metadata.arity }, (_, index) => id(`argument_${index}`));
  const body = [t.variableDeclaration("let", [
    t.variableDeclarator(id(`registers_${entry}`), t.arrayExpression([])),
    t.variableDeclarator(id(`this_${entry}`), t.conditionalExpression(bin("==", t.thisExpression(), t.nullLiteral()), id("globalThis"), t.thisExpression())),
  ])];
  parameters.forEach((parameter, index) => body.push(assign(entry, index, parameter)));
  if (metadata.arity < metadata.registers) body.push(assign(entry, metadata.arity, id("arguments")));
  body.push(...emitFrom(entry, new Set(), false));
  if (loopHeader !== null) body.push(t.whileStatement(t.booleanLiteral(true), t.blockStatement(emitFrom(loopHeader))));
  const result = t.functionExpression(id(`lifted_${entry}`), parameters, t.blockStatement(body));
  liftedFunctionCache.set(entry, result);
  return t.cloneNode(result, true);
}
function compileCallback() {
  return buildLiftedFunction(trace.callbackRuns[0][0].entry);
}

function compileRoot(callback) {
  const rootEntry = trace.rootEvents[0].entry;
  const statements = [
    t.variableDeclaration("let", [t.variableDeclarator(id(`registers_${rootEntry}`), t.arrayExpression([]))]),
    t.variableDeclaration("const", [t.variableDeclarator(id(`this_${rootEntry}`), id("globalThis"))]),
  ];
  for (const event of trace.rootEvents) {
    const instruction = instructionByPc.get(event.pc);
    const semantic = semantics.get(event.opcode);
    if (semantic.kind === "makeFunction" && instruction.operands[1] === trace.callbackEvents[0].entry) {
      statements.push(assign(rootEntry, instruction.operands[0], callback));
    } else if (semantic.kind !== "return") {
      statements.push(...lower(event));
    }
  }
  return t.program(statements);
}

function registerSlot(node) {
  if (!t.isMemberExpression(node, { computed: true }) || !t.isIdentifier(node.object) || !/^registers_\d+$/.test(node.object.name) || !t.isNumericLiteral(node.property)) return null;
  return { array: node.object.name, index: node.property.value, key: `${node.object.name}:${node.property.value}` };
}

function removeDeadRegisterStores(program) {
  for (let pass = 0; pass < 100; pass++) {
    const reads = new Set();
    traverse(program, {
      MemberExpression(path) {
        const slot = registerSlot(path.node);
        if (!slot) return;
        const parent = path.parentPath;
        if (parent.isAssignmentExpression() && parent.node.left === path.node && parent.node.operator === "=") return;
        reads.add(slot.key);
      },
    });
    let changed = false;
    traverse(program, {
      ExpressionStatement(path) {
        const expression = path.node.expression;
        if (!t.isAssignmentExpression(expression, { operator: "=" })) return;
        const slot = registerSlot(expression.left);
        if (!slot || reads.has(slot.key)) return;
        const right = path.get("expression.right");
        if (right.isPure()) path.remove();
        else path.replaceWith(t.expressionStatement(t.cloneNode(expression.right, true)));
        changed = true;
      },
    });
    if (!changed) break;
  }
}

function removeDisconnectedRegisterStores(program) {
  const dependencies = new Map();
  const roots = new Set();
  const assignments = [];
  traverse(program, {
    AssignmentExpression(path) {
      if (path.node.operator !== "=") return;
      const destination = registerSlot(path.node.left);
      if (!destination) return;
      let reads = registerReads(path.node.right);
      if (t.isFunction(path.node.right)) {
        const localArrays = new Set();
        (function findFunctions(node) {
          if (!node || typeof node !== "object") return;
          if (t.isFunction(node) && node.id && /^lifted_\d+$/.test(node.id.name)) localArrays.add(`registers_${node.id.name.slice("lifted_".length)}`);
          for (const key of t.VISITOR_KEYS[node.type] || []) {
            const child = node[key];
            if (Array.isArray(child)) child.forEach(findFunctions);
            else findFunctions(child);
          }
        })(path.node.right);
        reads = new Set([...reads].filter((key) => !localArrays.has(key.split(":")[0])));
      }
      if (!dependencies.has(destination.key)) dependencies.set(destination.key, new Set());
      reads.forEach((key) => dependencies.get(destination.key).add(key));
      if (!obviouslyPure(path.node.right)) reads.forEach((key) => roots.add(key));
      assignments.push({ path, destination });
    },
    MemberExpression(path) {
      const slot = registerSlot(path.node);
      if (!slot) return;
      if (path.parentPath.isAssignmentExpression() && path.parentPath.node.left === path.node && path.parentPath.node.operator === "=") return;
      const functionParent = path.getFunctionParent();
      let ancestor = path.parentPath;
      while (ancestor && ancestor !== functionParent) {
        if (ancestor.isAssignmentExpression({ operator: "=" }) && registerSlot(ancestor.node.left)) return;
        ancestor = ancestor.parentPath;
      }
      roots.add(slot.key);
    },
  });
  const live = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const key = queue.pop();
    for (const dependency of dependencies.get(key) || []) {
      if (live.has(dependency)) continue;
      live.add(dependency);
      queue.push(dependency);
    }
  }
  for (const { path, destination } of assignments.reverse()) {
    if (!path.node || live.has(destination.key)) continue;
    if (obviouslyPure(path.node.right)) {
      if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
      else path.replaceWith(t.unaryExpression("void", t.numericLiteral(0)));
    } else {
      path.replaceWith(t.cloneNode(path.node.right, true));
    }
  }
}

function registerReads(node, reads = new Set(), root = node) {
  if (!node || typeof node !== "object") return reads;
  const slot = registerSlot(node);
  if (slot) {
    reads.add(slot.key);
    return reads;
  }
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item) => registerReads(item, reads, root));
    else registerReads(child, reads, root);
  }
  return reads;
}

function obviouslyPure(node) {
  if (t.isLiteral(node) || t.isIdentifier(node) || t.isThisExpression(node) || t.isFunction(node)) return true;
  if (t.isUnaryExpression(node) && node.operator !== "delete") return obviouslyPure(node.argument);
  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) return obviouslyPure(node.left) && obviouslyPure(node.right);
  if (t.isConditionalExpression(node)) return obviouslyPure(node.test) && obviouslyPure(node.consequent) && obviouslyPure(node.alternate);
  if (t.isArrayExpression(node)) return node.elements.every((element) => !element || obviouslyPure(element));
  if (t.isObjectExpression(node)) return node.properties.every((property) => t.isObjectProperty(property) && obviouslyPure(property.key) && obviouslyPure(property.value));
  const slot = registerSlot(node);
  return Boolean(slot);
}

function removeOverwrittenStores(program) {
  function optimizeList(statements) {
    const live = new Set();
    for (let index = statements.length - 1; index >= 0; index--) {
      const statement = statements[index];
      if (t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression, { operator: "=" })) {
        const destination = registerSlot(statement.expression.left);
        if (destination) {
          if (!live.has(destination.key)) {
            if (obviouslyPure(statement.expression.right)) statements.splice(index, 1);
            else {
              statements[index] = t.expressionStatement(t.cloneNode(statement.expression.right, true));
              registerReads(statement.expression.right, live);
            }
            continue;
          }
          live.delete(destination.key);
          registerReads(statement.expression.right, live);
          continue;
        }
      }
      registerReads(statement, live);
    }
  }
  optimizeList(program.program.body);
  traverse(program, {
    Function(path) {
      const statements = path.node.body.body;
      const hasStructuredControl = statements.some((statement) =>
        t.isIfStatement(statement) || t.isLoop(statement) || t.isSwitchStatement(statement) || t.isTryStatement(statement));
      if (!hasStructuredControl) optimizeList(statements);
      path.skip();
    },
  });
}

function foldExpressions(program) {
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    traverse(program, {
      "BinaryExpression|LogicalExpression|UnaryExpression|ConditionalExpression": {
        exit(path) {
          if (path.isUnaryExpression({ operator: "delete" })) return;
          if (path.isBinaryExpression({ operator: "+" }) && t.isUnaryExpression(path.node.right, { operator: "-" }) &&
              t.isNumericLiteral(path.node.right.argument)) {
            path.replaceWith(t.binaryExpression("-", t.cloneNode(path.node.left, true), t.cloneNode(path.node.right.argument, true)));
            changed = true;
            return;
          }
          const evaluation = path.evaluate();
          if (!evaluation.confident || !["undefined", "boolean", "number", "string"].includes(typeof evaluation.value)) return;
          const replacement = valueNode(evaluation.value);
          if (generate(path.node, { compact: true }).code === generate(replacement, { compact: true }).code) return;
          path.replaceWith(replacement);
          changed = true;
        },
      },
    });
    if (!changed) break;
  }
}

function materializeRegistersAsLocals(program) {
  const slots = new Map();
  traverse(program, {
    MemberExpression(path) {
      const slot = registerSlot(path.node);
      if (!slot) return;
      if (!slots.has(slot.array)) slots.set(slot.array, new Set());
      slots.get(slot.array).add(slot.index);
    },
  });
  traverse(program, {
    VariableDeclaration(path) {
      const declarations = [];
      for (const declaration of path.node.declarations) {
        if (!t.isIdentifier(declaration.id) || !/^registers_\d+$/.test(declaration.id.name)) {
          declarations.push(declaration);
          continue;
        }
        const entry = declaration.id.name.slice("registers_".length);
        for (const index of [...(slots.get(declaration.id.name) || [])].sort((a, b) => a - b)) {
          declarations.push(t.variableDeclarator(id(`r${entry}_${index}`)));
        }
      }
      if (!declarations.length) path.remove();
      else path.node.declarations = declarations;
    },
    MemberExpression: {
      exit(path) {
        const slot = registerSlot(path.node);
        if (!slot) return;
        const entry = slot.array.slice("registers_".length);
        path.replaceWith(id(`r${entry}_${slot.index}`));
      },
    },
  });
}

function simplifyStructuredControl(program) {
  traverse(program, {
    VariableDeclaration(path) {
      path.node.declarations = path.node.declarations.filter((declaration) =>
        !t.isIdentifier(declaration.id) || !/^first_iteration_\d+$/.test(declaration.id.name));
      if (!path.node.declarations.length) path.remove();
    },
    IfStatement(path) {
      if (t.isIdentifier(path.node.test) && /^first_iteration_\d+$/.test(path.node.test.name) && !path.node.alternate) {
        path.remove();
        return;
      }
      if (!t.isBlockStatement(path.node.consequent) || !t.isBlockStatement(path.node.alternate)) return;
      const consequent = path.node.consequent.body;
      const alternate = path.node.alternate.body;
      if (consequent.length && alternate.length && t.isReturnStatement(consequent[consequent.length - 1]) && t.isReturnStatement(alternate[alternate.length - 1])) {
        const inverted = t.isUnaryExpression(path.node.test, { operator: "!" })
          ? t.cloneNode(path.node.test.argument, true)
          : t.unaryExpression("!", t.cloneNode(path.node.test, true));
        path.replaceWithMultiple([
          t.ifStatement(inverted, t.cloneNode(path.node.alternate, true)),
          ...consequent.map((statement) => t.cloneNode(statement, true)),
        ]);
        return;
      }
      if (!consequent.length || !t.isContinueStatement(consequent[consequent.length - 1])) return;
      const inverted = t.isUnaryExpression(path.node.test, { operator: "!" })
        ? t.cloneNode(path.node.test.argument, true)
        : t.unaryExpression("!", t.cloneNode(path.node.test, true));
      path.replaceWithMultiple([
        t.ifStatement(inverted, t.cloneNode(path.node.alternate, true)),
        ...consequent.slice(0, -1).map((statement) => t.cloneNode(statement, true)),
      ]);
    },
    ExpressionStatement(path) {
      const expression = path.node.expression;
      const globalLookup = t.isMemberExpression(expression) && t.isIdentifier(expression.object, { name: "globalThis" });
      const typedGlobalLookup = t.isUnaryExpression(expression, { operator: "typeof" }) &&
        t.isMemberExpression(expression.argument) && t.isIdentifier(expression.argument.object, { name: "globalThis" });
      if (t.isIdentifier(expression) || t.isLiteral(expression) || globalLookup || typedGlobalLookup) path.remove();
    },
  });
}

function normalizeLiftedSyntax(program) {
  traverse(program, {
    VariableDeclaration(path) {
      path.node.kind = "var";
    },
    MemberExpression(path) {
      if (path.node.computed && t.isStringLiteral(path.node.property) && t.isValidIdentifier(path.node.property.value)) {
        path.node.property = id(path.node.property.value);
        path.node.computed = false;
      }
    },
    ExpressionStatement(path) {
      const expression = path.node.expression;
      if (!t.isCallExpression(expression) || !t.isMemberExpression(expression.callee) ||
          !t.isIdentifier(expression.callee.object, { name: "Reflect" }) || !t.isIdentifier(expression.callee.property, { name: "set" }) ||
          expression.arguments.length !== 3) return;
      path.replaceWith(t.expressionStatement(t.assignmentExpression("=", t.memberExpression(
        t.cloneNode(expression.arguments[0], true), t.cloneNode(expression.arguments[1], true), true,
      ), t.cloneNode(expression.arguments[2], true))));
    },
    ReturnStatement(path) {
      if (t.isUnaryExpression(path.node.argument, { operator: "void" }) &&
          t.isNumericLiteral(path.node.argument.argument, { value: 0 })) path.node.argument = null;
    },
  });
}

function foldAdjacentCopies(program) {
  function assignment(statement) {
    return t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression, { operator: "=" }) &&
      t.isIdentifier(statement.expression.left) ? statement.expression : null;
  }

  function replaceIdentifier(node, name, replacement, parent = null, key = null) {
    if (!node || typeof node !== "object") return node;
    if (t.isIdentifier(node, { name })) {
      const property = parent && key === "property" && t.isMemberExpression(parent) && !parent.computed;
      const objectKey = parent && key === "key" && (t.isObjectProperty(parent) || t.isObjectMethod(parent)) && !parent.computed;
      if (!property && !objectKey) return t.cloneNode(replacement, true);
    }
    for (const visitorKey of t.VISITOR_KEYS[node.type] || []) {
      const child = node[visitorKey];
      if (Array.isArray(child)) node[visitorKey] = child.map((item) => replaceIdentifier(item, name, replacement, node, visitorKey));
      else node[visitorKey] = replaceIdentifier(child, name, replacement, node, visitorKey);
    }
    return node;
  }

  function countIdentifiers(node, name) {
    if (!node || typeof node !== "object") return 0;
    let count = t.isIdentifier(node, { name }) ? 1 : 0;
    for (const visitorKey of t.VISITOR_KEYS[node.type] || []) {
      const child = node[visitorKey];
      if (Array.isArray(child)) count += child.reduce((total, item) => total + countIdentifiers(item, name), 0);
      else count += countIdentifiers(child, name);
    }
    return count;
  }

  function foldBody(body) {
    for (let index = 0; index + 1 < body.length; index++) {
      const first = assignment(body[index]);
      const second = assignment(body[index + 1]);
      if (!first || !second || first.left.name !== second.left.name || !obviouslyPure(first.right)) continue;
      if (countIdentifiers(second.right, first.left.name) > 1 &&
          (t.isFunction(first.right) || t.isArrayExpression(first.right) || t.isObjectExpression(first.right))) continue;
      second.right = replaceIdentifier(second.right, first.left.name, first.right);
      body.splice(index, 1);
      index--;
    }
    for (let index = 0; index + 2 < body.length; index++) {
      const first = assignment(body[index]);
      const copy = assignment(body[index + 1]);
      const overwrite = assignment(body[index + 2]);
      if (!first || !copy || !overwrite || !obviouslyPure(first.right) ||
          !t.isIdentifier(copy.right, { name: first.left.name }) || overwrite.left.name !== first.left.name) continue;
      copy.right = t.cloneNode(first.right, true);
      body.splice(index, 1);
      index--;
    }
  }
  foldBody(program.program.body);
  traverse(program, {
    BlockStatement(path) {
      foldBody(path.node.body);
    },
  });
}

function versionScratchTemporaries(program) {
  function rewriteExpression(node, environment, parent = null, key = null) {
    if (!node || typeof node !== "object" || t.isFunction(node)) return node;
    if (t.isIdentifier(node) && environment.has(node.name)) {
      const protectedProperty = parent && key === "property" && t.isMemberExpression(parent) && !parent.computed;
      const protectedKey = parent && key === "key" && (t.isObjectProperty(parent) || t.isObjectMethod(parent)) && !parent.computed;
      if (!protectedProperty && !protectedKey) return t.cloneNode(environment.get(node.name), true);
    }
    for (const visitorKey of t.VISITOR_KEYS[node.type] || []) {
      const child = node[visitorKey];
      if (Array.isArray(child)) node[visitorKey] = child.map((item) => rewriteExpression(item, environment, node, visitorKey));
      else node[visitorKey] = rewriteExpression(child, environment, node, visitorKey);
    }
    return node;
  }

  traverse(program, {
    Function(path) {
      let containsLoop = false;
      const assignmentCounts = new Map();
      path.traverse({
        Function(inner) { inner.skip(); },
        Loop(inner) { containsLoop = true; inner.skip(); },
        AssignmentExpression(inner) {
          if (t.isIdentifier(inner.node.left, { name: path.node.id && path.node.id.name })) return;
          if (t.isIdentifier(inner.node.left) && /^r\d+_\d+$/.test(inner.node.left.name)) {
            assignmentCounts.set(inner.node.left.name, (assignmentCounts.get(inner.node.left.name) || 0) + 1);
          }
        },
      });
      if (containsLoop) return;
      const selected = new Set([...assignmentCounts].filter(([, count]) => count >= 5).map(([name]) => name));
      if (!selected.size) return;
      const counters = new Map();
      const declarations = [];

      function rewriteStatements(statements, environment) {
        for (const statement of statements) {
          if (t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression, { operator: "=" })) {
            statement.expression.right = rewriteExpression(statement.expression.right, environment);
            if (t.isIdentifier(statement.expression.left) && selected.has(statement.expression.left.name)) {
              const base = statement.expression.left.name;
              const version = (counters.get(base) || 0) + 1;
              counters.set(base, version);
              const versionId = id(`${base}_v${version}`);
              statement.expression.left = versionId;
              environment.set(base, versionId);
              declarations.push(t.variableDeclarator(t.cloneNode(versionId)));
            } else {
              statement.expression.left = rewriteExpression(statement.expression.left, environment);
            }
            continue;
          }
          if (t.isIfStatement(statement)) {
            statement.test = rewriteExpression(statement.test, environment);
            if (t.isBlockStatement(statement.consequent)) rewriteStatements(statement.consequent.body, new Map(environment));
            if (t.isBlockStatement(statement.alternate)) rewriteStatements(statement.alternate.body, new Map(environment));
            continue;
          }
          rewriteExpression(statement, environment);
        }
      }
      rewriteStatements(path.node.body.body, new Map());
      const declaration = path.node.body.body.find((statement) => t.isVariableDeclaration(statement, { kind: "let" }));
      if (declaration) declaration.declarations.push(...declarations);
      path.skip();
    },
  });
}

function substituteExpression(node, environment, stack = new Set()) {
  if (!node || typeof node !== "object") return node;
  if (t.isIdentifier(node) && environment.has(node.name) && !stack.has(node.name)) {
    const nextStack = new Set(stack);
    nextStack.add(node.name);
    return substituteExpression(environment.get(node.name), environment, nextStack);
  }
  const clone = t.cloneNode(node, false);
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const child = node[key];
    const skipProperty = key === "property" && t.isMemberExpression(node) && !node.computed;
    const skipKey = key === "key" && (t.isObjectProperty(node) || t.isObjectMethod(node)) && !node.computed;
    if (skipProperty || skipKey) {
      clone[key] = t.cloneNode(child, true);
    } else if (Array.isArray(child)) {
      clone[key] = child.map((item) => substituteExpression(item, environment, stack));
    } else {
      clone[key] = substituteExpression(child, environment, stack);
    }
  }
  return clone;
}

function structureNaturalLoops(program) {
  traverse(program, {
    WhileStatement(path) {
      if (!t.isBooleanLiteral(path.node.test, { value: true }) || !t.isBlockStatement(path.node.body)) return;
      const statements = path.node.body.body;
      const exitIndex = statements.findIndex((statement) => t.isIfStatement(statement) && !statement.alternate &&
        t.isBlockStatement(statement.consequent) && statement.consequent.body.length === 1 && t.isReturnStatement(statement.consequent.body[0]));
      if (exitIndex <= 0) return;
      const prefix = statements.slice(0, exitIndex);
      if (!prefix.every((statement) => t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression, { operator: "=" }) && t.isIdentifier(statement.expression.left))) return;
      const environment = new Map();
      for (const statement of prefix) environment.set(statement.expression.left.name, substituteExpression(statement.expression.right, environment));
      const exit = statements[exitIndex];
      const resolvedExit = substituteExpression(exit.test, environment);
      let loopTest;
      if (t.isUnaryExpression(resolvedExit, { operator: "+" })) loopTest = resolvedExit.argument;
      else loopTest = resolvedExit;
      loopTest = t.isUnaryExpression(loopTest, { operator: "!" })
        ? t.cloneNode(loopTest.argument, true)
        : t.unaryExpression("!", t.cloneNode(loopTest, true));
      const replacementLoop = t.whileStatement(loopTest, t.blockStatement(statements.slice(exitIndex + 1).map((statement) => t.cloneNode(statement, true))));
      path.replaceWithMultiple([replacementLoop, t.cloneNode(exit.consequent.body[0], true)]);
    },
  });
}

function removeUnusedLocals(program) {
  traverse(program, {
    Program(path) { path.scope.crawl(); },
    Function(path) { path.scope.crawl(); },
  });
  traverse(program, {
    VariableDeclaration: {
      exit(path) {
        path.node.declarations = path.node.declarations.filter((declaration) => {
          if (!t.isIdentifier(declaration.id)) return true;
          const binding = path.scope.getBinding(declaration.id.name);
          return !binding || binding.referenced || (declaration.init && !obviouslyPure(declaration.init));
        });
        if (!path.node.declarations.length) path.remove();
      },
    },
  });
}

function mergeInitialAssignments(program) {
  function merge(body) {
    for (let index = 0; index + 1 < body.length; index++) {
      const declaration = body[index];
      const statement = body[index + 1];
      if (!t.isVariableDeclaration(declaration, { kind: "var" }) || !t.isExpressionStatement(statement) ||
          !t.isAssignmentExpression(statement.expression, { operator: "=" }) || !t.isIdentifier(statement.expression.left)) continue;
      const declarator = declaration.declarations.find((item) => t.isIdentifier(item.id, { name: statement.expression.left.name }) && !item.init);
      if (!declarator) continue;
      declarator.init = t.cloneNode(statement.expression.right, true);
      body.splice(index + 1, 1);
    }
  }
  merge(program.program.body);
  traverse(program, {
    BlockStatement(path) {
      merge(path.node.body);
    },
  });
}

function removeUnusedLocalAssignments(program) {
  for (let pass = 0; pass < 20; pass++) {
    traverse(program, {
      Program(path) { path.scope.crawl(); },
      Function(path) { path.scope.crawl(); },
    });
    let changed = false;
    traverse(program, {
      ExpressionStatement(path) {
        const expression = path.node.expression;
        if (!t.isAssignmentExpression(expression, { operator: "=" }) || !t.isIdentifier(expression.left) || !/^r\d+_\d+(?:_v\d+)?$/.test(expression.left.name)) return;
        const binding = path.scope.getBinding(expression.left.name);
        if (!binding || binding.referenced) return;
        if (obviouslyPure(expression.right)) path.remove();
        else path.replaceWith(t.expressionStatement(t.cloneNode(expression.right, true)));
        changed = true;
      },
    });
    if (!changed) break;
  }
}

function inlineSingleUseTemporaries(program) {
  for (let pass = 0; pass < 200; pass++) {
    traverse(program, {
      Program(path) { path.scope.crawl(); },
      Function(path) { path.scope.crawl(); },
    });
    let changed = false;
    traverse(program, {
      VariableDeclarator(path) {
        if (changed || !t.isIdentifier(path.node.id) || !/^r\d+_\d+(?:_v\d+)?$/.test(path.node.id.name) || path.node.init) return;
        const binding = path.scope.getBinding(path.node.id.name);
        if (!binding || binding.referencePaths.length !== 1 || binding.constantViolations.length !== 1) return;
        let assignment = binding.constantViolations[0];
        if (!assignment.isAssignmentExpression()) assignment = assignment.findParent((candidate) => candidate.isAssignmentExpression());
        if (!assignment || assignment.node.operator !== "=" || !t.isIdentifier(assignment.node.left, { name: path.node.id.name })) return;
        const reference = binding.referencePaths[0];
        const assignmentStatement = assignment.getStatementParent();
        const referenceStatement = reference.getStatementParent();
        if (!assignmentStatement || !referenceStatement || assignmentStatement.parentPath !== referenceStatement.parentPath) return;
        const siblings = assignmentStatement.parentPath.get("body");
        if (!Array.isArray(siblings)) return;
        const assignmentIndex = siblings.findIndex((item) => item.node === assignmentStatement.node);
        const referenceIndex = siblings.findIndex((item) => item.node === referenceStatement.node);
        if (assignmentIndex < 0 || referenceIndex <= assignmentIndex) return;
        if (!obviouslyPure(assignment.node.right) && referenceIndex !== assignmentIndex + 1) return;

        const dependencies = new Set();
        (function collectIdentifiers(node) {
          if (!node || typeof node !== "object") return;
          if (t.isIdentifier(node)) dependencies.add(node.name);
          for (const key of t.VISITOR_KEYS[node.type] || []) {
            const child = node[key];
            if (Array.isArray(child)) child.forEach(collectIdentifiers);
            else collectIdentifiers(child);
          }
        })(assignment.node.right);
        let dependencyChanged = false;
        for (let index = assignmentIndex + 1; index < referenceIndex && !dependencyChanged; index++) {
          siblings[index].traverse({
            AssignmentExpression(inner) {
              if (t.isIdentifier(inner.node.left) && dependencies.has(inner.node.left.name)) dependencyChanged = true;
            },
            UpdateExpression(inner) {
              if (t.isIdentifier(inner.node.argument) && dependencies.has(inner.node.argument.name)) dependencyChanged = true;
            },
          });
        }
        if (dependencyChanged) return;
        reference.replaceWith(t.cloneNode(assignment.node.right, true));
        assignmentStatement.remove();
        changed = true;
        path.stop();
      },
    });
    if (!changed) break;
  }
}

function optimize(program) {
  const file = t.file(program);
  removeDisconnectedRegisterStores(file);
  removeOverwrittenStores(file);
  removeDeadRegisterStores(file);
  foldExpressions(file);
  removeOverwrittenStores(file);
  removeDeadRegisterStores(file);
  materializeRegistersAsLocals(file);
  simplifyStructuredControl(file);
  versionScratchTemporaries(file);
  inlineSingleUseTemporaries(file);
  normalizeLiftedSyntax(file);
  structureNaturalLoops(file);
  foldAdjacentCopies(file);
  inlineSingleUseTemporaries(file);
  foldExpressions(file);
  removeUnusedLocalAssignments(file);
  removeUnusedLocals(file);
  normalizeLiftedSyntax(file);
  mergeInitialAssignments(file);
  return file.program;
}

const compiledAst = compileRoot(compileCallback());
const outputAst = options.noOptimize ? compiledAst : optimize(compiledAst);
const output = generate(outputAst, { compact: false, jsescOption: { minimal: true } }).code + "\n";
return {
  output,
  ast: outputAst,
  stats: {
    bytes: Buffer.byteLength(output),
    instructions: disassembly.instructions.length,
    tracedEvents: trace.callbackEvents.length,
    helperFunctionsRemoved: flattening.helperEntries.size,
    ...(options.debugCfg ? { cfg: cfgSummaries } : {}),
  },
};
}

module.exports = { lift };

if (require.main === module) {
  const { _internals } = require("./vm.js");
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    console.error("Usage: node lifter.js <input.js> <output.js>");
    process.exitCode = 1;
  } else {
    const source = fs.readFileSync(inputPath, "utf8");
    const result = lift(source, _internals, {
      deterministic: process.argv.includes("--deterministic"),
      blockTrace: process.argv.includes("--block-trace"),
      noOptimize: process.argv.includes("--no-optimize"),
      debugCfg: process.argv.includes("--debug-cfg"),
    });
    fs.writeFileSync(outputPath, result.output);
    console.log(JSON.stringify(result.stats, null, 2));
  }
}
