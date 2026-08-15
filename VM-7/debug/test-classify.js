// Checks the behavioral classifier against the opcode roles read by hand.
const fs = require("fs");
const path = require("path");
const { inspect, loadSample, Machine } = require("../lib/machine");

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
const info = inspect(src);
console.log("isVM:", info.isVM, "handlers:", info.handlers);
const loaded = loadSample(info.ast, info.entryStmt, "input.js");
const m = new Machine(loaded);

const EXPECTED = {
  44744: "debugger", 29585: "trypop", 31145: "jump", 31178: "throw", 47933: "dynjump",
  14166: "setglobal", 39896: "loadimm", 3501: "loadconst", 19461: "move",
  45888: "unary+", 12149: "unary!", 16504: "unary~", 50146: "unary-", 21415: "unarytypeof",
  63862: "void", 40602: "this", 6548: "+", 22273: "-", 24492: "*", 26926: "/", 9164: "%",
  4969: "**", 39540: "&", 47762: "|", 36699: "^", 56680: "<<", 28171: ">>", 49537: ">>>",
  55744: "<", 14822: ">", 26487: "<=", 58658: ">=", 48837: "==", 30837: "!=", 27901: "===",
  12213: "!==", 23847: "in", 36092: "instanceof", 223: "branch", 51943: "branch",
  37457: "getmember", 63716: "setmember", 17515: "deletemember", 18114: "trycatch",
  32278: "tryfinally", 7574: "getclosure", 56439: "setclosure", 46215: "array",
  20969: "object", 21434: "definegetter", 25878: "definesetter", 3291: "forininit",
  46118: "forinnext", 51395: "getglobal", 64259: "typeofglobal", 41417: "call",
  42977: "mcall", 48258: "new", 37176: "return", 34577: "func", 5170: "decrypt",
};

let ok = 0, bad = 0;
for (const op of m.opcodes) {
  const k = m.KIND[op];
  const exp = EXPECTED[op];
  const got = k.kind + (k.op ? k.op : "");
  if (exp === undefined) continue;
  const match = got === exp || k.kind === exp || (exp.startsWith("unary") && k.kind === "arith") ||
    (k.kind === "binary" && k.op === exp) || (k.kind === "arith" && "+-*/%&|^<>".includes(exp[0]));
  if (match) ok++;
  else { bad++; console.log(`MISMATCH op ${op}: expected ${exp}, got ${JSON.stringify(k)} struct=${JSON.stringify(m.STRUCT[op])}`); }
}
console.log(`classifier: ${ok} ok, ${bad} mismatched (of ${Object.keys(EXPECTED).length} known)`);
const unknown = m.opcodes.filter((op) => m.KIND[op].kind === "arith");
console.log(`opcodes left to operator-fitting: ${unknown.length}`);
