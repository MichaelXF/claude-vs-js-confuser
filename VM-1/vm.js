#!/usr/bin/env node
"use strict";
/*
 * vm.js - AST-based devirtualizer for the JS-Confuser "VM" obfuscation (VM-1).
 *
 * Usage:
 *   node vm.js input.js output.js     // writes deobfuscated source to output.js
 *   var src = require('./vm.js')('input.js')  // returns deobfuscated source string
 *
 * The obfuscation embeds a register-based bytecode VM:
 *   - a Uint32Array of bytecode (base64 -> bytes -> 32-bit words)
 *   - a constants array
 *   - an interpreter loop (~60 opcodes)
 *   - strings stored XOR+base64 encoded, decoded lazily.
 *
 * This tool parses input.js with Babel, statically extracts the bytecode and
 * constants, disassembles every function, decodes all strings, and lifts the
 * bytecode back into a real JavaScript AST which is printed with @babel/generator.
 *
 * If the input does not contain a recognizable VM, the source is returned
 * unchanged (a "regular" file passes through fine).
 */

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverseMod = require("@babel/traverse");
const traverse = traverseMod.default || traverseMod;
const generate = require("@babel/generator").default || require("@babel/generator");
const t = require("@babel/types");

// ---------------------------------------------------------------------------
// Opcode tables
// ---------------------------------------------------------------------------
const OP = {
  LOAD_CONST: 39506,
  LOAD_IMM: 44945,
  LOAD_GLOBAL: 51710,
  LOAD_UPVAL: 52351,
  LOAD_THIS: 41751,
  MOVE: 4920,
  STORE_GLOBAL: 9389,
  STORE_UPVAL: 29532,
  GET_PROP: 42504,
  SET_PROP: 54062,
  DELETE_PROP: 61394,
  POW: 1146,
  TYPEOF_GLOBAL: 61704,
  JUMP: 46712,
  JUMP_IF_FALSE: 7516,
  JUMP_IF_TRUE: 51834,
  CALL: 1764,
  CALL_METHOD: 7823,
  NEW: 30265,
  RETURN: 28328,
  THROW: 61131,
  DEFINE_FUNCTION: 62201,
  NEW_ARRAY: 31141,
  NEW_OBJECT: 22617,
  DEFINE_GETTER: 29830,
  DEFINE_SETTER: 64480,
  FORIN_INIT: 61237,
  FORIN_NEXT: 21108,
  TRY_CATCH: 52371,
  TRY_POP: 31393,
  TRY_FINALLY: 42108,
  CODE_COPY: 14094,
  JUMP_DYN: 4672,
  DEBUGGER: 61044,
};

const BINOP = {
  41803: "+", 59011: "-", 59384: "*", 4477: "/", 39537: "%",
  50375: "&", 51860: "|", 14774: "^", 20716: "<<", 16870: ">>", 7714: ">>>",
  56927: "<", 51657: ">", 7504: "<=", 34973: ">=",
  34542: "===", 32489: "!==", 17785: "==", 7941: "!=",
  36259: "in", 16620: "instanceof",
};

const UNOP = { 30043: "-", 37044: "+", 30386: "!", 8976: "~", 43589: "typeof" };
const VOID_OP = 34224;

const SPREAD_SENTINEL = 1609168361;

// Set of opcodes that terminate a basic block (control transfer)
const TERMINATORS = new Set([
  OP.JUMP, OP.JUMP_IF_FALSE, OP.JUMP_IF_TRUE, OP.RETURN, OP.THROW,
  OP.FORIN_NEXT, OP.JUMP_DYN,
]);

// ---------------------------------------------------------------------------
// Extraction: pull bytecode words + constants out of input.js via AST
// ---------------------------------------------------------------------------
function extractVM(src) {
  const ast = parser.parse(src, { sourceType: "script" });
  let base64 = null;
  let constArrayNode = null;
  let frameSize = null;

  traverse(ast, {
    StringLiteral(p) {
      const v = p.node.value;
      if (v.length > 800 && /^[A-Za-z0-9+/=]+$/.test(v)) base64 = v;
    },
    NewExpression(p) {
      const args = p.node.arguments;
      const arr = args.find((a) => a.type === "ArrayExpression");
      if (arr && args.length >= 3 && !constArrayNode) {
        constArrayNode = arr;
        const num = args.find((a) => a.type === "NumericLiteral");
        if (num) frameSize = num.value;
      }
    },
  });

  if (!base64 || !constArrayNode || frameSize == null) return null;

  const consts = constArrayNode.elements.map(evalConstNode);
  const bytes = Buffer.from(base64, "base64");
  const words = new Uint32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < words.length; i++) {
    words[i] =
      (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
  }
  return { words, consts, frameSize };
}

function evalConstNode(el) {
  if (el == null) return undefined;
  switch (el.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return el.value;
    case "NullLiteral":
      return null;
    case "UnaryExpression":
      if (el.operator === "void") return undefined;
      if (el.operator === "-") return -evalConstNode(el.argument);
      if (el.operator === "+") return +evalConstNode(el.argument);
      break;
    case "Identifier":
      if (el.name === "undefined") return undefined;
      if (el.name === "NaN") return NaN;
      if (el.name === "Infinity") return Infinity;
      break;
  }
  throw new Error("Cannot statically evaluate constant node: " + el.type);
}

// Decode a J-style constant: (constIndex, key)
function decodeConst(consts, e, g) {
  let a = consts[e];
  if (!g) return a;
  if (typeof a === "number") return (a ^ g) >>> 0 === (a ^ g) ? a ^ g : a ^ g;
  const bytes = Buffer.from(a, "base64");
  let s = "";
  for (let k = 0; k < bytes.length / 2; k++) {
    s += String.fromCharCode(((bytes[k * 2] | (bytes[k * 2 + 1] << 8)) ^ ((g + k) & 65535)) & 65535);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Disassembler
// ---------------------------------------------------------------------------
function disassemble(words, consts) {
  const instrs = {}; // pc -> instruction
  let pc = 0;
  while (pc < words.length) {
    const ins = decodeInstr(words, consts, pc);
    instrs[pc] = ins;
    pc += ins.size;
  }
  return instrs;
}

function decodeInstr(words, consts, start) {
  let pc = start;
  const op = words[pc++];
  const rd = () => words[pc++];
  const J = () => {
    const e = rd();
    const g = rd();
    return decodeConst(consts, e, g);
  };
  const ins = { op, start };

  switch (op) {
    case OP.LOAD_CONST: ins.f = rd(); ins.k = J(); break;
    case OP.LOAD_IMM: ins.f = rd(); ins.k = rd(); break;
    case OP.LOAD_GLOBAL: ins.f = rd(); ins.name = J(); break;
    case OP.LOAD_UPVAL: ins.f = rd(); ins.idx = rd(); break;
    case OP.LOAD_THIS: ins.f = rd(); break;
    case OP.MOVE: ins.f = rd(); ins.src = rd(); break;
    case OP.STORE_GLOBAL: ins.name = J(); ins.src = rd(); break;
    case OP.STORE_UPVAL: ins.idx = rd(); ins.src = rd(); break;
    case OP.GET_PROP: ins.f = rd(); ins.obj = rd(); ins.key = rd(); break;
    case OP.SET_PROP: ins.obj = rd(); ins.key = rd(); ins.val = rd(); break;
    case OP.DELETE_PROP: ins.f = rd(); ins.obj = rd(); ins.key = rd(); break;
    case OP.POW: ins.f = rd(); ins.a = rd(); ins.b = rd(); break;
    case OP.TYPEOF_GLOBAL: ins.f = rd(); ins.name = J(); break;
    case OP.JUMP: ins.target = rd(); break;
    case OP.JUMP_IF_FALSE:
    case OP.JUMP_IF_TRUE: ins.cond = rd(); ins.target = rd(); break;
    case OP.CALL: {
      ins.f = rd(); ins.fn = rd();
      ins.args = readArgs(rd, rd());
      break;
    }
    case OP.CALL_METHOD: {
      ins.f = rd(); ins.recv = rd(); ins.fn = rd();
      ins.args = readArgs(rd, rd());
      break;
    }
    case OP.NEW: {
      ins.f = rd(); ins.fn = rd();
      ins.args = readArgs(rd, rd());
      break;
    }
    case OP.RETURN: ins.val = rd(); break;
    case OP.THROW: ins.val = rd(); break;
    case OP.DEFINE_FUNCTION: {
      ins.f = rd();
      ins.fT = rd(); ins.fl = rd(); ins.fi = rd();
      const nCap = rd();
      ins.fJ = rd();
      ins.caps = [];
      for (let i = 0; i < nCap; i++) ins.caps.push({ Y: rd(), M: rd() });
      break;
    }
    case OP.NEW_ARRAY: {
      ins.f = rd();
      const len = rd();
      ins.elems = [];
      for (let i = 0; i < len; i++) ins.elems.push(rd());
      break;
    }
    case OP.NEW_OBJECT: {
      ins.f = rd();
      const count = rd();
      ins.pairs = [];
      for (let i = 0; i < count; i++) ins.pairs.push({ k: rd(), v: rd() });
      break;
    }
    case OP.DEFINE_GETTER:
    case OP.DEFINE_SETTER: ins.obj = rd(); ins.key = rd(); ins.fn = rd(); break;
    case OP.FORIN_INIT: ins.f = rd(); ins.obj = rd(); break;
    case OP.FORIN_NEXT: ins.f = rd(); ins.iter = rd(); ins.target = rd(); break;
    case OP.TRY_CATCH: ins.catchPc = rd(); ins.catchReg = rd(); break;
    case OP.TRY_POP: break;
    case OP.TRY_FINALLY:
      ins.W = rd(); ins.V = rd(); ins.Z = rd(); ins.aa = rd(); break;
    case OP.CODE_COPY: ins.dst = rd(); ins.lo = rd(); ins.hi = rd(); break;
    case OP.JUMP_DYN: ins.reg = rd(); break;
    case OP.DEBUGGER: break;
    default: {
      if (BINOP[op]) { ins.f = rd(); ins.a = rd(); ins.b = rd(); break; }
      if (UNOP[op] || op === VOID_OP) { ins.f = rd(); ins.a = rd(); break; }
      throw new Error("Unknown opcode " + op + " at pc " + start);
    }
  }
  ins.size = pc - start;
  return ins;
}

function readArgs(rd, argc) {
  if (argc === SPREAD_SENTINEL) return { spread: rd() };
  const a = [];
  for (let i = 0; i < argc; i++) a.push(rd());
  return { list: a };
}

// ---------------------------------------------------------------------------
// Function discovery
// ---------------------------------------------------------------------------
// Returns an array of function descriptors. Index 0 is the top-level program.
function discoverFunctions(instrs, frameSize) {
  const funcs = [];
  const byStart = new Map();

  function addFunc(meta) {
    if (byStart.has(meta.start)) return byStart.get(meta.start);
    const fid = funcs.length;
    const f = Object.assign({ fid }, meta);
    funcs.push(f);
    byStart.set(meta.start, f);
    return f;
  }

  // Top-level program
  addFunc({ start: 0, params: 0, frameSize, rest: 0, caps: [], top: true });

  // Walk all instructions to find DEFINE_FUNCTION targets
  for (const pc of Object.keys(instrs)) {
    const ins = instrs[pc];
    if (ins.op === OP.DEFINE_FUNCTION) {
      addFunc({
        start: ins.fT, params: ins.fl, frameSize: ins.fi, rest: ins.fJ,
        caps: ins.caps, top: false,
      });
    }
  }

  // For each function, compute the set of instructions reachable from its entry.
  for (const f of funcs) f.body = collectBody(instrs, f.start);
  return funcs;
}

// BFS over control-flow successors (including exception targets) to collect the
// instruction addresses that belong to a single function.
function collectBody(instrs, start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const pc = stack.pop();
    if (seen.has(pc)) continue;
    if (!(pc in instrs)) continue;
    seen.add(pc);
    const ins = instrs[pc];
    for (const s of successors(ins, instrs)) stack.push(s);
  }
  return [...seen].sort((a, b) => a - b);
}

function successors(ins, instrs) {
  const next = ins.start + ins.size;
  switch (ins.op) {
    case OP.JUMP: return [ins.target];
    case OP.JUMP_IF_FALSE:
    case OP.JUMP_IF_TRUE: return [next, ins.target];
    case OP.FORIN_NEXT: return [next, ins.target];
    case OP.RETURN:
    case OP.THROW: return [];
    case OP.JUMP_DYN: return []; // dynamic; handled via try-finally targets below
    case OP.TRY_CATCH: return [next, ins.catchPc];
    case OP.TRY_FINALLY: return [next, ins.W, ins.V, ins.aa].filter((x) => x != null);
    default: return [next];
  }
}

// ---------------------------------------------------------------------------
// Basic blocks
// ---------------------------------------------------------------------------
function buildBlocks(instrs, f) {
  const body = f.body;
  const bodySet = new Set(body);
  const leaders = new Set([f.start]);

  for (const pc of body) {
    const ins = instrs[pc];
    const next = ins.start + ins.size;
    switch (ins.op) {
      case OP.JUMP:
        if (bodySet.has(ins.target)) leaders.add(ins.target);
        break;
      case OP.JUMP_IF_FALSE:
      case OP.JUMP_IF_TRUE:
      case OP.FORIN_NEXT:
        if (bodySet.has(ins.target)) leaders.add(ins.target);
        if (bodySet.has(next)) leaders.add(next);
        break;
      case OP.RETURN:
      case OP.THROW:
        if (bodySet.has(next)) leaders.add(next);
        break;
      case OP.TRY_CATCH:
        if (bodySet.has(ins.catchPc)) leaders.add(ins.catchPc);
        if (bodySet.has(next)) leaders.add(next);
        break;
      case OP.TRY_POP:
        // Split before TRY_POP so a try body ends cleanly on a block boundary.
        leaders.add(ins.start);
        if (bodySet.has(next)) leaders.add(next);
        break;
      case OP.TRY_FINALLY:
        leaders.add(ins.start);
        for (const x of [ins.W, ins.V, ins.aa]) if (bodySet.has(x)) leaders.add(x);
        if (bodySet.has(next)) leaders.add(next);
        break;
    }
  }

  const leaderList = [...leaders].filter((x) => bodySet.has(x)).sort((a, b) => a - b);
  const blocks = new Map(); // leader -> {addr, instrs:[], end}
  for (let i = 0; i < leaderList.length; i++) {
    const ld = leaderList[i];
    const blkInstrs = [];
    let pc = ld;
    while (pc in instrs && bodySet.has(pc)) {
      const ins = instrs[pc];
      blkInstrs.push(ins);
      const np = ins.start + ins.size;
      if (TERMINATORS.has(ins.op)) break;
      if (leaders.has(np)) break;
      pc = np;
    }
    blocks.set(ld, { addr: ld, instrs: blkInstrs });
  }
  return { blocks, leaderList };
}

// ---------------------------------------------------------------------------
// Lifting helpers: build AST register/value expressions
// ---------------------------------------------------------------------------
function litNode(v) {
  if (v === undefined) return t.identifier("undefined");
  if (v === null) return t.nullLiteral();
  if (typeof v === "string") return t.stringLiteral(v);
  if (typeof v === "boolean") return t.booleanLiteral(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return t.identifier("NaN");
    if (v === Infinity) return t.identifier("Infinity");
    if (v === -Infinity) return t.unaryExpression("-", t.identifier("Infinity"));
    if (v < 0) return t.unaryExpression("-", t.numericLiteral(-v));
    return t.numericLiteral(v);
  }
  throw new Error("Cannot build literal for " + typeof v);
}

// Context maps a register index to an AST node (Identifier or MemberExpression).
function makeRegAccessor(model, prefix) {
  if (model === "array") {
    const R = t.identifier(prefix);
    return (n) => t.memberExpression(R, t.numericLiteral(n), true);
  }
  // named
  return (n) => t.identifier(prefix + "r" + n);
}

module.exports = deobfuscateFile;
module.exports.deobfuscate = deobfuscateSource;

function deobfuscateSource(src) {
  let vm;
  try {
    vm = extractVM(src);
  } catch (e) {
    vm = null;
  }
  if (!vm) {
    // Not a recognized VM: pass through (reformat only).
    try {
      const ast = parser.parse(src, { sourceType: "unambiguous" });
      return generate(ast, { comments: true }).code;
    } catch (e) {
      return src;
    }
  }

  const instrs = disassemble(vm.words, vm.consts);
  const funcs = discoverFunctions(instrs, vm.frameSize);

  let program;
  if (process.env.VM_FORCE_DISPATCH) {
    program = emitDispatcher(instrs, funcs, vm);
    return generate(program, { comments: true, jsescOption: { minimal: true } }).code;
  }
  try {
    program = emitStructured(instrs, funcs, vm);
  } catch (err) {
    if (process.env.VM_DEBUG) {
      console.error("[vm.js] structured recovery failed, falling back to dispatcher:\n", (err && err.stack) || err);
    }
    program = emitDispatcher(instrs, funcs, vm);
  }
  return generate(program, { comments: true, jsescOption: { minimal: true } }).code;
}

function deobfuscateFile(filename) {
  const abs = path.isAbsolute(filename) ? filename : path.resolve(process.cwd(), filename);
  const src = fs.readFileSync(abs, "utf8");
  return deobfuscateSource(src);
}

// ===========================================================================
//  Emitters
// ===========================================================================
const emitterDeps = {
  OP, BINOP, UNOP, VOID_OP, SPREAD_SENTINEL, litNode, makeRegAccessor,
  buildBlocks, successors, collectBody, t,
};
const emitDispatcher = require("./emit-dispatcher.js")(emitterDeps);
const emitStructured = require("./emit-structured.js")(emitterDeps);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const [, , inFile, outFile] = process.argv;
  if (!inFile) {
    console.error("Usage: node vm.js <input.js> [output.js]");
    process.exit(1);
  }
  const result = deobfuscateFile(inFile);
  if (outFile) {
    fs.writeFileSync(outFile, result);
    console.error("Wrote " + outFile);
  } else {
    process.stdout.write(result);
  }
}
