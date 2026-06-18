// Debug disassembler for the VM-1 bytecode.
// Extracts bytecode + constants from input.js via Babel AST, then linearly decodes.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverseMod = require("@babel/traverse");
const traverse = traverseMod.default || traverseMod;

function b64(a) {
  return Buffer.from(a, "base64");
}

// ---- Extract bytecode + constants from input.js ----
function extract(src) {
  const ast = parser.parse(src);
  let base64 = null;
  let constArray = null;
  let frameSize = null;

  traverse(ast, {
    StringLiteral(p) {
      const v = p.node.value;
      if (v.length > 800 && /^[A-Za-z0-9+/=]+$/.test(v)) base64 = v;
    },
    NewExpression(p) {
      // new H(Y, frameSize, [constants...], W)
      const args = p.node.arguments;
      const arr = args.find((a) => a.type === "ArrayExpression");
      if (arr && args.length >= 3 && !constArray) {
        constArray = arr;
        const num = args.find((a) => a.type === "NumericLiteral");
        if (num) frameSize = num.value;
      }
    },
  });

  // Evaluate the constants array statically.
  const consts = constArray.elements.map((el) => evalNode(el));
  const bytes = b64(base64);
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] =
      (bytes[i * 4] |
        (bytes[i * 4 + 1] << 8) |
        (bytes[i * 4 + 2] << 16) |
        (bytes[i * 4 + 3] << 24)) >>>
      0;
  }
  return { words, consts, frameSize };
}

function evalNode(el) {
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
      if (el.operator === "-") return -evalNode(el.argument);
      if (el.operator === "+") return +evalNode(el.argument);
      break;
    case "Identifier":
      if (el.name === "undefined") return undefined;
      break;
  }
  throw new Error("cannot eval const node: " + el.type);
}

// ---- Decode a J-style constant (constIndex, key) ----
function decodeConst(consts, e, g) {
  let a = consts[e];
  if (!g) return a;
  if (typeof a === "number") return a ^ g;
  const bytes = b64(a);
  let s = "";
  for (let k = 0; k < bytes.length / 2; k++) {
    s += String.fromCharCode(
      ((bytes[k * 2] | (bytes[k * 2 + 1] << 8)) ^ ((g + k) & 65535)) & 65535
    );
  }
  return s;
}

// ---- Opcode operand metadata ----
// For most opcodes the operand count is fixed; CALL/NEW/DEFINE_FUNCTION/arrays are variable.
const NAMES = {
  39506: "LOAD_CONST",
  44945: "LOAD_IMM",
  51710: "LOAD_GLOBAL",
  52351: "LOAD_UPVAL",
  41751: "LOAD_THIS",
  4920: "MOVE",
  9389: "STORE_GLOBAL",
  29532: "STORE_UPVAL",
  42504: "GET_PROP",
  54062: "SET_PROP",
  61394: "DELETE_PROP",
  41803: "ADD",
  59011: "SUB",
  59384: "MUL",
  4477: "DIV",
  39537: "MOD",
  1146: "POW",
  50375: "BAND",
  51860: "BOR",
  14774: "BXOR",
  20716: "SHL",
  16870: "SHR",
  7714: "USHR",
  56927: "LT",
  51657: "GT",
  7504: "LE",
  34973: "GE",
  34542: "SEQ",
  32489: "SNE",
  17785: "EQ",
  7941: "NE",
  36259: "IN",
  16620: "INSTANCEOF",
  30043: "NEG",
  37044: "UPLUS",
  30386: "NOT",
  8976: "BNOT",
  43589: "TYPEOF",
  34224: "VOID",
  61704: "TYPEOF_GLOBAL",
  46712: "JUMP",
  7516: "JUMP_IF_FALSE",
  51834: "JUMP_IF_TRUE",
  1764: "CALL",
  7823: "CALL_METHOD",
  30265: "NEW",
  28328: "RETURN",
  61131: "THROW",
  62201: "DEFINE_FUNCTION",
  31141: "NEW_ARRAY",
  22617: "NEW_OBJECT",
  29830: "DEFINE_GETTER",
  64480: "DEFINE_SETTER",
  61237: "FORIN_INIT",
  21108: "FORIN_NEXT",
  52371: "TRY_CATCH",
  31393: "TRY_POP",
  42108: "TRY_FINALLY",
  14094: "CODE_COPY",
  4672: "JUMP_DYN",
  61044: "DEBUGGER",
};

const SPREAD = 1609168361;

// Decode one instruction at pc; returns {op, args:[...], size, raw}
function decode(words, consts, pc) {
  const start = pc;
  const op = words[pc++];
  const rd = () => words[pc++];
  const args = [];
  const J = () => {
    const e = rd();
    const g = rd();
    return { e, g, val: decodeConst(consts, e, g) };
  };
  switch (op) {
    case 39506: args.push(rd(), J()); break; // LOAD_CONST f, const
    case 44945: args.push(rd(), rd()); break; // LOAD_IMM f, imm
    case 51710: args.push(rd(), J()); break; // LOAD_GLOBAL f, name
    case 52351: args.push(rd(), rd()); break; // LOAD_UPVAL f, idx
    case 41751: args.push(rd()); break; // LOAD_THIS f
    case 4920: args.push(rd(), rd()); break; // MOVE f, src
    case 9389: args.push(J(), rd()); break; // STORE_GLOBAL name, src
    case 29532: args.push(rd(), rd()); break; // STORE_UPVAL idx, src
    case 42504: args.push(rd(), rd(), rd()); break; // GET_PROP f, obj, key
    case 54062: args.push(rd(), rd(), rd()); break; // SET_PROP obj, key, val
    case 61394: args.push(rd(), rd(), rd()); break; // DELETE_PROP f, obj, key
    // binary ops f, a, b
    case 41803: case 59011: case 59384: case 4477: case 39537:
    case 1146: case 50375: case 51860: case 14774: case 20716:
    case 16870: case 7714: case 56927: case 51657: case 7504:
    case 34973: case 34542: case 32489: case 17785: case 7941:
    case 36259: case 16620:
      args.push(rd(), rd(), rd()); break;
    // unary f, a
    case 30043: case 37044: case 30386: case 8976: case 43589: case 34224:
      args.push(rd(), rd()); break;
    case 61704: args.push(rd(), J()); break; // TYPEOF_GLOBAL f, name
    case 46712: args.push(rd()); break; // JUMP target
    case 7516: case 51834: args.push(rd(), rd()); break; // JUMP_IF cond, target
    case 1764: { // CALL f, fn, argc, args...
      const f = rd(), fn = rd(), argc = rd();
      const a = [];
      if (argc === SPREAD) a.push({ spread: rd() });
      else for (let i = 0; i < argc; i++) a.push(rd());
      args.push(f, fn, { argc, a });
      break;
    }
    case 7823: { // CALL_METHOD f, recv, fn, argc, args...
      const f = rd(), recv = rd(), fn = rd(), argc = rd();
      const a = [];
      if (argc === SPREAD) a.push({ spread: rd() });
      else for (let i = 0; i < argc; i++) a.push(rd());
      args.push(f, recv, fn, { argc, a });
      break;
    }
    case 30265: { // NEW f, fn, argc, args...
      const f = rd(), fn = rd(), argc = rd();
      const a = [];
      if (argc === SPREAD) a.push({ spread: rd() });
      else for (let i = 0; i < argc; i++) a.push(rd());
      args.push(f, fn, { argc, a });
      break;
    }
    case 28328: args.push(rd()); break; // RETURN val
    case 61131: args.push(rd()); break; // THROW val
    case 62201: { // DEFINE_FUNCTION
      const f = rd(), T = rd(), l = rd(), i = rd(), nCap = rd(), J0 = rd();
      const caps = [];
      for (let k = 0; k < nCap; k++) caps.push({ Y: rd(), M: rd() });
      args.push(f, { T, l, i, J: J0, caps });
      break;
    }
    case 31141: { // NEW_ARRAY f, len, elems...
      const f = rd(), len = rd();
      const a = [];
      for (let i = 0; i < len; i++) a.push(rd());
      args.push(f, { len, a });
      break;
    }
    case 22617: { // NEW_OBJECT f, count, (key,val)...
      const f = rd(), count = rd();
      const a = [];
      for (let i = 0; i < count; i++) a.push({ k: rd(), v: rd() });
      args.push(f, { count, a });
      break;
    }
    case 29830: case 64480: args.push(rd(), rd(), rd()); break; // getter/setter obj,key,fn
    case 61237: args.push(rd(), rd()); break; // FORIN_INIT f, obj
    case 21108: args.push(rd(), rd(), rd()); break; // FORIN_NEXT f, iter, target
    case 52371: args.push(rd(), rd()); break; // TRY_CATCH catchPc, catchReg
    case 31393: break; // TRY_POP
    case 42108: args.push(rd(), rd(), rd(), rd()); break; // TRY_FINALLY W,V,Z,aa
    case 14094: args.push(rd(), rd(), rd()); break; // CODE_COPY
    case 4672: args.push(rd()); break; // JUMP_DYN reg
    case 61044: break; // DEBUGGER
    default:
      return { op, unknown: true, size: 1, start };
  }
  return { op, name: NAMES[op], args, size: pc - start, start };
}

function fmtArg(a) {
  if (a == null) return String(a);
  if (typeof a === "number") return "r" + a;
  if (a.val !== undefined || "val" in a) return "K(" + JSON.stringify(a.val) + ")";
  return JSON.stringify(a);
}

function main() {
  const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
  const { words, consts, frameSize } = extract(src);
  console.log("frameSize:", frameSize);
  console.log("total words:", words.length);
  console.log("consts:", JSON.stringify(consts));
  console.log("");

  const funcStarts = new Set([0]);
  const instrs = {};
  let pc = 0;
  const lines = [];
  while (pc < words.length) {
    const ins = decode(words, consts, pc);
    instrs[pc] = ins;
    if (ins.unknown) {
      lines.push(`${pc}: ??? op=${ins.op}`);
      pc += 1;
      continue;
    }
    if (ins.op === 62201) funcStarts.add(ins.args[1].T);
    lines.push(`${pc}: ${ins.name} ${ins.args.map(fmtArg).join(", ")}`);
    pc += ins.size;
  }

  console.log("function starts:", [...funcStarts].sort((a, b) => a - b).join(", "));
  console.log("");
  console.log(lines.join("\n"));
}

main();
