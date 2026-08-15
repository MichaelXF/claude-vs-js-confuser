"use strict";
/**
 * Loading + probing of a JS-Confuser VM sample.
 *
 * Nothing here decompiles the handler bodies: the live handlers are used as an
 * oracle. Each one is executed against a synthetic frame with instrumented
 * registers, globals, constant pool and bytecode so that its operand layout and
 * its effect can be observed directly. That keeps the tool working even though
 * the opcode numbers are randomized and the handler bodies are rewritten with
 * mixed boolean-arithmetic identities.
 */

const nodeVm = require("vm");
const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const FRAME = 4; // frame pointer used while probing
const REGBASE = 512; // register base inside the probe frame
const NREG = 256; // registers modelled per frame
const MAGIC_SPREAD = 1329987534; // argument count sentinel meaning "spread one array"

/** Parses `source` and decides whether it is a JS-Confuser VM sample. */
function inspect(source) {
  let ast;
  try {
    ast = parser.parse(source, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
  } catch (err) {
    return { ast: null, isVM: false, parseError: err };
  }
  const body = ast.program.body;
  let handlers = 0;
  for (const st of body) {
    if (st.type !== "ExpressionStatement") continue;
    const e = st.expression;
    if (e.type !== "AssignmentExpression") continue;
    const left = e.left;
    if (left.type === "MemberExpression" && left.computed && left.property.type === "NumericLiteral" &&
        (e.right.type === "FunctionExpression" || e.right.type === "ArrowFunctionExpression")) handlers++;
  }
  let entryStmt = null;
  for (let i = body.length - 1; i >= 0; i--) {
    const st = body[i];
    if (st.type !== "ExpressionStatement") continue;
    const e = st.expression;
    if (e.type !== "CallExpression" || e.callee.type !== "Identifier") continue;
    if (e.arguments.length < 2) continue;
    if (e.arguments[0].type !== "NewExpression" || e.arguments[1].type !== "NewExpression") continue;
    entryStmt = st;
    break;
  }
  return { ast, isVM: handlers >= 16 && !!entryStmt, entryStmt, handlers };
}

/** Executes the sample with its entry call intercepted, returning the VM state. */
function loadSample(ast, entryStmt, filename) {
  const runnerName = entryStmt.expression.callee.name;
  entryStmt.expression.callee = t.identifier("__vmCapture");

  const names = new Set([runnerName]);
  for (const st of ast.program.body) {
    if (st.type === "FunctionDeclaration" && st.id) names.add(st.id.name);
    else if (st.type === "VariableDeclaration") for (const d of st.declarations) if (d.id.type === "Identifier") names.add(d.id.name);
  }
  const exportSrc = `__vmCapture.exports = {${[...names]
    .map((n) => `${JSON.stringify(n)}: typeof ${n} !== "undefined" ? ${n} : undefined`)
    .join(", ")}};`;
  const code = generate(ast, { compact: false }).code + "\n" + exportSrc;

  const captured = [];
  const capture = function (...args) { captured.push(args); };
  capture.exports = null;

  const sandbox = {
    __vmCapture: capture,
    Math, Object, Array, String, Number, Boolean, JSON, Date, RegExp, Symbol, Promise,
    Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
    Map, Set, WeakMap, WeakSet, Proxy, Reflect, Function, Buffer,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    Float32Array, Float64Array, ArrayBuffer, DataView,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    Infinity, NaN, undefined: undefined,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    atob: (b) => Buffer.from(String(b), "base64").toString("binary"),
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
  };
  sandbox.globalThis = sandbox;
  nodeVm.createContext(sandbox);
  nodeVm.runInContext(code, sandbox, { filename: filename || "sample.js", timeout: 30000 });

  if (!capture.exports || !captured.length) throw new Error("the VM entry point was never reached");
  return { exports: capture.exports, entryArgs: captured[0], sandbox, runnerName };
}

// --- probe values -----------------------------------------------------------

const PROBE = Symbol("probe");

/** An object that records every operation performed on it. */
function makeProbeObject(index, log) {
  const target = function probe() {};
  target.index = index;
  const handler = {
    get(tgt, prop, recv) {
      if (prop === PROBE) return index;
      if (prop === Symbol.toPrimitive) return (hint) => (hint === "string" ? "@" + index : 1000 + index);
      if (prop === Symbol.iterator || prop === Symbol.hasInstance || prop === Symbol.toStringTag) return Reflect.get(tgt, prop);
      if (prop === "valueOf") return () => 1000 + index;
      if (prop === "toString") return () => "@" + index;
      if (prop === "apply" || prop === "call" || prop === "bind" || prop === "prototype" || prop === "constructor") {
        log.push({ type: "get", obj: index, prop: String(prop) });
        return Reflect.get(tgt, prop);
      }
      log.push({ type: "get", obj: index, prop: typeof prop === "symbol" ? prop : prop });
      return undefined;
    },
    set(tgt, prop, value) { log.push({ type: "set", obj: index, prop, value }); return true; },
    has(tgt, prop) { log.push({ type: "has", obj: index, prop }); return false; },
    deleteProperty(tgt, prop) { log.push({ type: "delete", obj: index, prop }); return true; },
    apply(tgt, thisArg, args) { log.push({ type: "apply", obj: index, thisArg, args }); return undefined; },
    construct(tgt, args) { log.push({ type: "construct", obj: index, args }); return { constructed: index }; },
    defineProperty(tgt, prop, desc) { log.push({ type: "defineProperty", obj: index, prop, desc }); return true; },
    getOwnPropertyDescriptor(tgt, prop) { log.push({ type: "getDescriptor", obj: index, prop }); return undefined; },
    ownKeys(tgt) { log.push({ type: "ownKeys", obj: index }); return Reflect.ownKeys(tgt); },
    getPrototypeOf(tgt) { log.push({ type: "getPrototypeOf", obj: index }); return Reflect.getPrototypeOf(tgt); },
  };
  return new Proxy(target, handler);
}

/** Returns the absolute pc a handler jumped to, or null if it only advanced. */
function jumpTarget(res) {
  const seq = res.frameWrites.filter(([k]) => k === 0).map(([, v]) => v);
  let expected = 2; // operand fetches produce 2, 3, 4, ... when probing from pc 0
  let target = null;
  for (const v of seq) {
    if (v === expected) expected++;
    else target = v;
  }
  return target;
}

class Machine {
  constructor(loaded) {
    this.ex = loaded.exports;
    this.entryArgs = loaded.entryArgs;
    this.vmInstance = loaded.entryArgs[0];
    this.proto = Object.getPrototypeOf(this.vmInstance);
    this.code = Array.from(this.vmInstance.i);
    this.consts = this.vmInstance.b;
    this.globals = this.vmInstance.k;
    this.topDesc = loaded.entryArgs[1].C;
    this.topFnObj = loaded.entryArgs[1];
    this.opcodes = Object.getOwnPropertyNames(this.proto).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    this.fnRecords = null;
    for (const v of Object.values(this.ex)) if (v instanceof WeakMap) this.fnRecords = v;
    this.probeAll();
  }

  /** Runs the instruction at `pc` over a synthetic frame. */
  runAt(code, pc, key, regs, opt) {
    opt = opt || {};
    const frame = [];
    frame[FRAME + 0] = pc + 1;
    frame[FRAME + 2] = opt.thisVal;
    frame[FRAME + 3] = opt.catchStack;
    frame[FRAME + 4] = opt.flags || 0;
    frame[FRAME + 6] = opt.fnObj || { j: [], prototype: {}, C: {} };
    frame[FRAME + 7] = key | 0;
    frame[FRAME + 8] = opt.args || [];
    frame[FRAME + 9] = 13 + NREG;
    frame[FRAME + 10] = opt.parent || 0;
    frame[FRAME + 11] = REGBASE;
    frame[FRAME + 12] = 0;
    for (let j = 0; j < NREG; j++) frame[REGBASE + j] = regs ? regs[j] : undefined;

    const regReads = [];
    const regWrites = [];
    const frameReads = [];
    const frameWrites = [];
    const proxy = new Proxy(frame, {
      get(target, prop) {
        if (typeof prop === "string") {
          const n = +prop;
          if (n >= REGBASE && n < REGBASE + NREG) regReads.push(n - REGBASE);
          else if (n >= 0 && n < REGBASE) frameReads.push(n - FRAME);
        }
        return target[prop];
      },
      set(target, prop, value) {
        if (typeof prop === "string") {
          const n = +prop;
          if (n >= REGBASE && n < REGBASE + NREG) regWrites.push([n - REGBASE, value]);
          else if (n >= 0 && n < REGBASE) frameWrites.push([n - FRAME, value]);
        }
        target[prop] = value;
        return true;
      },
    });

    const inst = Object.create(this.proto);
    inst.i = code;
    inst.g = proxy;
    inst.h = FRAME;
    inst.k = opt.globals || this.globals;
    inst.b = opt.consts || this.consts;
    inst.q = null;
    inst.p = FRAME + 13 + NREG;
    inst.r = 0;
    let error = null;
    try {
      inst[code[pc]]();
    } catch (e) {
      error = e;
    }
    return { regReads, regWrites, frameReads, frameWrites, error, inst, frame };
  }

  /** Operand layout, result type and behavioral kind for every opcode. */
  probeAll() {
    this.STRUCT = {};
    this.RESTYPE = {};
    this.KIND = {};
    const numericRegs = [];
    for (let j = 0; j < NREG; j++) numericRegs[j] = 1000 + j;

    for (const op of this.opcodes) {
      const words = [op];
      for (let j = 0; j < 64; j++) words.push(j);
      const reads = [];
      const codeProxy = new Proxy(words, {
        get(target, prop) { if (typeof prop === "string" && /^\d+$/.test(prop)) reads.push(+prop); return target[prop]; },
        set(target, prop, value) { target[prop] = value; return true; },
      });
      const res = this.runAt(codeProxy, 0, 0, numericRegs, {});
      const operandReads = reads.filter((r) => r >= 1 && r < 64);
      this.STRUCT[op] = {
        len: operandReads.length ? Math.max.apply(null, operandReads) : 0,
        regSlots: [...new Set(res.regReads)].filter((s) => s < 64),
        writes: res.regWrites.length > 0,
      };
      const types = new Set();
      for (let trial = 0; trial < 10; trial++) {
        const regs = [];
        for (let j = 0; j < NREG; j++) regs[j] = (Math.random() * 2 ** 32) | 0;
        const r = this.runAt(words, 0, 0, regs, {});
        if (r.error || !r.regWrites.length) { types.add("?"); continue; }
        types.add(typeof r.regWrites[r.regWrites.length - 1][1]);
      }
      this.RESTYPE[op] = types.size === 1 ? [...types][0] : "mixed";
    }
    // two passes: the first discovers the for-in enumerator shape, which the
    // second needs in order to recognize the "next key" opcode
    for (const op of this.opcodes) this.KIND[op] = this.classify(op);
    for (const op of this.opcodes) this.KIND[op] = this.classify(op);
  }

  /** Observes one opcode's behavior with instrumented operands. */
  classify(op) {
    const words = [op];
    for (let j = 0; j < 64; j++) words.push(j);
    const log = [];
    const regs = [];
    for (let j = 0; j < NREG; j++) regs[j] = makeProbeObject(j, log);
    const globalLog = [];
    const globals = new Proxy({ probeGlobal: 1 }, {
      get(target, prop) { globalLog.push(["get", prop]); return Reflect.get(target, prop); },
      set(target, prop, value) { globalLog.push(["set", prop, value]); return true; },
      has(target, prop) { globalLog.push(["has", prop]); return true; },
      getOwnPropertyDescriptor(target, prop) { globalLog.push(["descriptor", prop]); return Reflect.getOwnPropertyDescriptor(target, prop); },
    });
    const constLog = [];
    const consts = new Proxy(this.consts, {
      get(target, prop) { if (/^\d+$/.test(String(prop))) constLog.push(+prop); return Reflect.get(target, prop); },
    });
    const codeWrites = [];
    const codeProxy = new Proxy(words.slice(), {
      set(target, prop, value) { if (/^\d+$/.test(String(prop))) codeWrites.push([+prop, value]); target[prop] = value; return true; },
      get(target, prop) { return Reflect.get(target, prop); },
    });
    const fnObj = { j: [{ l: false, c: undefined, g: [], f: 0 }, { l: true, c: 7, g: [], f: 0 }], prototype: {}, C: {} };
    const res = this.runAt(codeProxy, 0, 0, regs, { globals, consts, fnObj, thisVal: makeProbeObject(-1, log) });

    const struct = this.STRUCT[op];
    const info = { log, globalLog, constLog, codeWrites, res, struct };
    return this.decideKind(op, info);
  }

  decideKind(op, info) {
    const { log, globalLog, constLog, codeWrites, res, struct } = info;
    const wrote = res.regWrites.length ? res.regWrites[res.regWrites.length - 1] : null;
    const jumped = jumpTarget(res) !== null;
    const isProbe = (v) => v !== null && (typeof v === "object" || typeof v === "function") && v[PROBE] !== undefined;

    // --- control transfer -------------------------------------------------
    if (res.error && isProbe(res.error)) return { kind: "throw" };
    if (res.inst.h !== FRAME) return { kind: "return" }; // popped the frame
    if (codeWrites.length) return { kind: "decrypt" };
    if (res.frameWrites.some(([k]) => k === 3)) return { kind: struct.len === 2 ? "trycatch" : "tryfinally" };
    const branch = this.probeBranch(op, struct);
    if (branch) return branch;
    if (jumped && !wrote) {
      if (struct.regSlots.length) return { kind: "dynjump" };
      if (struct.len === 1) return { kind: "jump" };
    }
    if (!struct.len && !wrote) {
      return /\bdebugger\b/.test(Function.prototype.toString.call(this.proto[op])) ? { kind: "debugger" } : { kind: "trypop" };
    }
    // --- object / environment interaction ---------------------------------
    if (log.some((l) => l.type === "apply")) {
      const call = log.find((l) => l.type === "apply");
      return { kind: call.thisArg === null || call.thisArg === undefined ? "call" : "mcall" };
    }
    if (log.some((l) => l.type === "construct")) return { kind: "new" };
    if (log.some((l) => l.type === "defineProperty")) {
      const d = log.find((l) => l.type === "defineProperty");
      return { kind: d.desc && "get" in d.desc ? "definegetter" : "definesetter" };
    }
    if (log.some((l) => l.type === "delete")) return { kind: "deletemember" };
    if (log.some((l) => l.type === "has") && wrote) return { kind: "binary", op: "in" };
    if (log.some((l) => l.type === "set")) return { kind: "setmember" };
    if (log.some((l) => l.type === "getPrototypeOf")) return { kind: "binary", op: "instanceof" };
    if (log.some((l) => l.type === "ownKeys")) {
      this.learnEnumShape(op, struct);
      return { kind: "forininit" };
    }
    if (globalLog.length) {
      if (globalLog.some(([k]) => k === "set")) return { kind: "setglobal" };
      if (globalLog.some(([k]) => k === "descriptor")) return { kind: "typeofglobal" };
      return { kind: "getglobal" };
    }
    if (this.enumProps && log.some((l) => l.type === "get" && this.enumProps.includes(l.prop))) return { kind: "forinnext" };
    if (log.some((l) => l.type === "get")) return { kind: "getmember" };
    if (res.frameReads.includes(6)) return { kind: wrote ? "getclosure" : "setclosure" };
    if (res.frameReads.includes(2) && struct.len === 1 && wrote) return { kind: "this" };
    if (wrote && typeof wrote[1] === "function" && !isProbe(wrote[1])) return { kind: "func" };
    if (wrote && Array.isArray(wrote[1])) return { kind: "array" };
    if (wrote && wrote[1] && typeof wrote[1] === "object" && !isProbe(wrote[1])) {
      const keys = Object.keys(wrote[1]);
      if (keys.length === 2 && Array.isArray(wrote[1][keys[0]])) { this.enumProps = keys; return { kind: "forininit" }; }
      return { kind: "object" };
    }
    if (constLog.length && !struct.regSlots.length) return { kind: "loadconst" };
    if (!struct.regSlots.length && struct.len === 2) {
      // either `dest = <immediate>` or `dest = void <ignored operand>`
      const probe = this.runAt([op, 3, 0xc0ffee], 0, 0, new Array(NREG).fill(0), {});
      const v = probe.regWrites.length ? probe.regWrites[probe.regWrites.length - 1][1] : undefined;
      if (v === 0xc0ffee) return { kind: "loadimm" };
      if (v === undefined) return { kind: "void" };
    }
    return { kind: "arith" }; // resolved later by fitting the operator
  }

  /** Runs the for-in opcode on a real object to learn the enumerator's shape. */
  learnEnumShape(op, struct) {
    if (this.enumProps || !struct.regSlots.length) return;
    const words = [op];
    for (let j = 0; j < 64; j++) words.push(j);
    const regs = new Array(NREG).fill(0);
    regs[struct.regSlots[0]] = { alpha: 1, beta: 2 };
    const r = this.runAt(words, 0, 0, regs, {});
    if (!r.error && r.regWrites.length) {
      const value = r.regWrites[r.regWrites.length - 1][1];
      if (value && typeof value === "object") this.enumProps = Object.keys(value);
    }
  }

  /** Detects conditional jumps by running the handler on a falsy and a truthy operand. */
  probeBranch(op, struct) {
    if (struct.writes || struct.len !== 2 || struct.regSlots.length !== 1) return null;
    const slot = struct.regSlots[0];
    const words = [op, 0, 0, 0];
    words[1 + slot] = 7; // register index carrying the condition
    const run = (value) => {
      const regs = new Array(NREG).fill(0);
      regs[7] = value;
      return jumpTarget(this.runAt(words, 0, 0, regs, {}));
    };
    const whenFalse = run(false);
    const whenTrue = run(true);
    if (whenFalse !== null && whenTrue === null) return { kind: "branch", whenFalse: true };
    if (whenTrue !== null && whenFalse === null) return { kind: "branch", whenFalse: false };
    return null;
  }

  /** Mirrors the sample's constant decoder (base64 + xorshift keystream). */
  decodeConst(index, key) {
    const raw = this.consts[index];
    if (!key) return raw;
    if (typeof raw === "number") return raw ^ key;
    if (typeof raw !== "string") return raw;
    const buf = Buffer.from(raw, "base64");
    let h = key >>> 0;
    let out = "";
    for (let i = 0; i < buf.length / 2; i++) {
      h = (h + 2654435769) | 0;
      out += String.fromCharCode((buf[i * 2] | (buf[i * 2 + 1] << 8)) ^ ((h ^ (h >>> 13)) & 65535));
    }
    return out;
  }
}

module.exports = { inspect, loadSample, Machine, FRAME, REGBASE, NREG, MAGIC_SPREAD, PROBE };
