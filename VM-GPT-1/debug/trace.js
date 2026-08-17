"use strict";

const fs = require("fs");
const nodeVm = require("vm");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const filename = process.argv[2] || "input.js";
const source = fs.readFileSync(filename, "utf8");
const ast = parser.parse(source, { sourceType: "script" });
let bootstrap;

traverse(ast, {
  ExpressionStatement(path) {
    if (t.isCallExpression(path.node.expression) && t.isIdentifier(path.node.expression.callee, { name: "y" })) {
      bootstrap = path.node.expression;
      path.replaceWith(
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.memberExpression(t.identifier("globalThis"), t.identifier("__run")),
            t.arrowFunctionExpression([], bootstrap),
          ),
        ),
      );
    }
  },
});

if (!bootstrap) throw new Error("VM bootstrap call not found");

const events = [];
function universal(label) {
  const target = function placeholder() {};
  let proxy;
  proxy = new Proxy(target, {
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
  return proxy;
}
function summarize(value) {
  if (value === null) return { type: "null", value: null };
  const type = typeof value;
  if (["undefined", "boolean", "number", "string"].includes(type)) return { type, value };
  let text;
  try { text = String(value); } catch { text = "<unprintable>"; }
  return { type, text: text.slice(0, 120) };
}
const sandbox = {
  Buffer,
  console,
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
nodeVm.runInContext(generate(ast, { compact: true }).code, sandbox, { filename });
const initialBytecode = Array.from(sandbox.D);

const originalRead = sandbox.v;
const decodedConstants = new Map();
const originalDecode = sandbox.x;
sandbox.x = function tracedDecode(machine, index, key) {
  const actualIndex = index ?? sandbox.v(machine);
  const actualKey = key ?? sandbox.v(machine);
  const value = originalDecode(machine, actualIndex, actualKey);
  decodedConstants.set(`${actualIndex}:${actualKey}`, value);
  return value;
};
sandbox.v = function tracedRead(machine) {
  const frame = machine.g;
  const pc = machine.h[frame + 2];
  const value = originalRead(machine);
  const event = events[events.length - 1];
  if (event) event.reads.push({ pc, value });
  return value;
};

for (const key of Object.getOwnPropertyNames(sandbox.t.prototype)) {
  if (!/^\d+$/.test(key)) continue;
  const original = sandbox.t.prototype[key];
  sandbox.t.prototype[key] = function tracedOpcode() {
    const frame = this.g;
    const registerBase = this.h[frame + 9];
    const registerCount = Math.max(0, this.h[frame + 8] - 15);
    const registersBefore = [11015, 14507, 27551].includes(Number(key))
      ? Array.from({ length: registerCount }, (_, index) => this.h[registerBase + index])
      : null;
    const event = {
      opcode: Number(key),
      pc: this.h[frame + 2] - 1,
      frame,
      entry: this.h[frame + 3] && this.h[frame + 3].I ? this.h[frame + 3].I.B : null,
      reads: [],
    };
    events.push(event);
    try {
      return original.call(this);
    } catch (caught) {
      event.error = String(caught);
      throw caught;
    } finally {
      event.next = this.h[this.g + 2];
      if (registersBefore) {
        event.registers = Object.fromEntries(
          [...new Set(event.reads.map((read) => read.value))]
            .filter((index) => Number.isInteger(index) && index >= 0 && index < registersBefore.length)
            .map((index) => [index, summarize(registersBefore[index])]),
        );
      }
    }
  };
}

let error;
try {
  sandbox.__run();
} catch (caught) {
  error = caught && caught.stack ? caught.stack : String(caught);
}

const windowKeys = Object.keys(sandbox.window);
if (process.argv.includes("--invoke-window")) {
  for (const key of windowKeys) {
    if (typeof sandbox.window[key] !== "function") continue;
    try {
      sandbox.window[key]();
    } catch (caught) {
      error = caught && caught.stack ? caught.stack : String(caught);
    }
  }
}

const entries = [];
for (const event of events) {
  if (event.opcode !== 43545 || event.reads.length < 6) continue;
  const values = event.reads.map((read) => read.value);
  entries.push({
    pc: event.pc,
    destination: values[0],
    entry: values[1],
    arity: values[2],
    registers: values[3],
    captures: values[4],
    rest: values[5],
  });
}

const includeEvents = process.argv.includes("--events");
const tailFlag = process.argv.indexOf("--tail");
const tailCount = tailFlag >= 0 ? Number(process.argv[tailFlag + 1] || 20) : 0;
const coveredWords = new Set();
for (const event of events) {
  coveredWords.add(event.pc);
  for (const read of event.reads) coveredWords.add(read.pc);
}
const controlFlow = {};
for (const event of events) {
  const fallthrough = event.reads.length ? event.reads[event.reads.length - 1].pc + 1 : event.pc + 1;
  if (event.next === fallthrough) continue;
  const key = String(event.pc);
  controlFlow[key] ||= [];
  if (!controlFlow[key].includes(event.next)) controlFlow[key].push(event.next);
}
const perFunction = {};
for (const event of events) {
  const key = String(event.entry);
  perFunction[key] ||= { events: 0, uniquePcs: new Set(), opcodes: new Set() };
  perFunction[key].events++;
  perFunction[key].uniquePcs.add(event.pc);
  perFunction[key].opcodes.add(event.opcode);
}
for (const value of Object.values(perFunction)) {
  value.uniquePcs = value.uniquePcs.size;
  value.opcodes = [...value.opcodes].sort((a, b) => a - b);
}
const sequenceEntryFlag = process.argv.indexOf("--sequence-entry");
const sequenceEntry = sequenceEntryFlag >= 0 ? Number(process.argv[sequenceEntryFlag + 1]) : null;
const selectedSequence = sequenceEntry === null ? null : events.filter((event) => event.entry === sequenceEntry).map((event) => event.pc);
const selectedFrequency = selectedSequence ? Object.entries(selectedSequence.reduce((counts, pc) => {
  counts[pc] = (counts[pc] || 0) + 1;
  return counts;
}, {})).sort((a, b) => b[1] - a[1]).slice(0, 30) : null;
const flattenedEdges = {};
for (const entry of Object.keys(perFunction).map(Number)) {
  const sequence = events.filter((event) => event.entry === entry);
  const targetsByPc = new Map();
  for (const event of sequence) {
    if (!targetsByPc.has(event.pc)) targetsByPc.set(event.pc, new Set());
    targetsByPc.get(event.pc).add(event.next);
  }
  const dispatchPcs = [...targetsByPc].filter(([, targets]) => targets.size > 3).map(([pc]) => pc);
  for (const dispatchPc of dispatchPcs) {
    const dispatchEvents = sequence.filter((event) => event.pc === dispatchPc).length;
    const stubPcs = new Set([...targetsByPc].filter(([pc]) =>
      sequence.filter((event) => event.pc === pc).length === dispatchEvents && pc <= dispatchPc,
    ).map(([pc]) => pc));
    const edges = {};
    for (let index = 1; index < sequence.length; index++) {
      if (sequence[index].pc !== dispatchPc) continue;
      let predecessorIndex = index - 1;
      while (predecessorIndex >= 0 && stubPcs.has(sequence[predecessorIndex].pc)) predecessorIndex--;
      if (predecessorIndex < 0) continue;
      const predecessor = sequence[predecessorIndex].pc;
      edges[predecessor] ||= [];
      if (!edges[predecessor].includes(sequence[index].next)) edges[predecessor].push(sequence[index].next);
    }
    flattenedEdges[entry] = {
      dispatchPc,
      stubPcs: [...stubPcs].sort((a, b) => a - b),
      edgeCount: Object.keys(edges).length,
      multiEdges: Object.fromEntries(Object.entries(edges).filter(([, targets]) => targets.length > 1)),
      edges: process.argv.includes("--flattened-edges") ? edges : undefined,
    };
  }
}
console.log(JSON.stringify({
  error,
  eventCount: events.length,
  uniqueProgramCounters: new Set(events.map((event) => event.pc)).size,
  coveredWords: coveredWords.size,
  bytecodeWords: sandbox.D.length,
  changedBytecodeWords: sandbox.D.reduce(
    (count, word, index) => count + (word !== initialBytecode[index] ? 1 : 0),
    0,
  ),
  uncoveredWords: sandbox.D.length - coveredWords.size,
  programCounterRange: events.length ? events.reduce(
    (range, event) => [Math.min(range[0], event.pc), Math.max(range[1], event.pc)],
    [Infinity, -Infinity],
  ) : null,
  uniqueOpcodes: [...new Set(events.map((event) => event.opcode))].sort((a, b) => a - b),
  operandCounts: Object.fromEntries(
    [...new Set(events.map((event) => event.opcode))].sort((a, b) => a - b).map((opcode) => [
      opcode,
      [...new Set(events.filter((event) => event.opcode === opcode).map((event) => event.reads.length))].sort((a, b) => a - b),
    ]),
  ),
  decodedConstantPairs: decodedConstants.size,
  decodedConstantIndexes: new Set([...decodedConstants.keys()].map((key) => key.split(":", 1)[0])).size,
  ...(process.argv.includes("--control") ? { controlFlow } : {}),
  perFunction,
  flattenedEdges,
  ...(selectedSequence ? {
    selectedSequenceLength: selectedSequence.length,
    selectedFrequency,
    selectedSequence: process.argv.includes("--full-sequence") ? selectedSequence : selectedSequence.slice(0, 300),
  } : {}),
  windowKeys,
  entries,
  ...(includeEvents ? { events } : {}),
  ...(tailCount ? { tail: events.slice(-tailCount) } : {}),
}, null, 2));
