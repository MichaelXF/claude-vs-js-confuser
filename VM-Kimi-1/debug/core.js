// Reusable core: bytecode loading, disassembly, dispatcher emulation, CFG exploration.
const fs = require('fs');

// ---------- opcode table ----------
const MAGIC = 3247410626;
const OPS = {
  26: ['NOT', 2], 464: ['THROW', 1], 750: ['DEFINE_GETTER', 3], 1149: ['RETURN', 1],
  1864: ['JUMP', 1], 2073: ['XOR', 3], 2939: ['JUMP_REG', 1], 3207: ['CALL', 'call'],
  4239: ['MAKE_OBJECT', 'object'], 5540: ['LOAD_UNDEF', 2], 8957: ['GE', 3], 9273: ['MOD', 3],
  10246: ['STRICT_NE', 3], 10292: ['NEG', 2], 11549: ['TYPEOF', 2], 12250: ['SUB', 3],
  14945: ['FORIN_NEXT', 3], 16990: ['SHR', 3], 19562: ['MOVE', 2], 21410: ['SET_PROP', 3],
  24481: ['LOAD_GLOBAL', 3], 25103: ['TRY', 4], 28700: ['STORE_CLOSURE', 2], 29884: ['IN', 3],
  30300: ['INSTANCEOF', 3], 31355: ['EQ', 3], 31655: ['GT', 3], 31871: ['USHR', 3],
  33322: ['LOAD_CLOSURE', 2], 34503: ['AND', 3], 35033: ['SHL', 3], 35122: ['JUMP_IF_FALSE', 2],
  36652: ['DEFINE_SETTER', 3], 38134: ['POW', 3], 38534: ['LOAD_CONST', 3], 40370: ['LT', 3],
  43207: ['GET_PROP', 3], 43221: ['MAKE_ARRAY', 'array'], 43498: ['LE', 3], 44050: ['POS', 2],
  44091: ['FORIN_SETUP', 2], 44681: ['DECRYPT', 4], 45389: ['BNOT', 2], 46657: ['NEW', 'new'],
  48269: ['TYPEOF_GLOBAL', 3], 52128: ['LOAD_THIS', 1], 53842: ['OR', 3], 56068: ['POP_TRY', 0],
  56444: ['DEBUGGER', 0], 57129: ['ADD', 3], 59112: ['JUMP_IF_TRUE', 2], 60197: ['CALL_NULL', 'callnull'],
  60563: ['DELETE', 3], 60779: ['STRICT_EQ', 3], 61109: ['NE', 3], 61360: ['STORE_GLOBAL', 3],
  61431: ['MAKE_FUNC', 'func'], 62094: ['DIV', 3], 62459: ['TRY2', 2], 63117: ['LOAD_LITERAL', 2],
  65297: ['MUL', 3],
};
function varCount(kind, w, i) {
  switch (kind) {
    case 'func': return 6 + 2 * w[i + 4];
    case 'call': return 4 + (w[i + 3] === MAGIC ? 1 : w[i + 3]);
    case 'callnull': case 'new': return 3 + (w[i + 2] === MAGIC ? 1 : w[i + 2]);
    case 'object': return 2 + 2 * w[i + 1];
    case 'array': return 2 + w[i + 1];
  }
}
const BIN_SYM = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%', POW: '**', AND: '&', OR: '|', XOR: '^', SHL: '<<', SHR: '>>', USHR: '>>>', EQ: '==', NE: '!=', STRICT_EQ: '===', STRICT_NE: '!==', LT: '<', LE: '<=', GT: '>', GE: '>=' };
const BIN_OPS = Object.keys(BIN_SYM);
const UN_OPS = ['NEG', 'POS', 'NOT', 'BNOT', 'TYPEOF'];

function makeCtx(words, pool) {
  function decodeConst(idx, key) {
    let b = pool[idx];
    if (!key) return b;
    if (typeof b === 'number') return b ^ key;
    if (typeof b !== 'string') return b;
    const buf = Buffer.from(b, 'base64');
    let e = '', c = key;
    for (let a = 0; a < buf.length / 2; a++) {
      c = c + 2654435769 | 0;
      e += String.fromCharCode((buf[a * 2] | buf[a * 2 + 1] << 8) ^ (c ^ c >>> 13) & 65535);
    }
    return e;
  }
  function decodeAt(ip) {
    const opcode = words[ip];
    const info = OPS[opcode];
    if (!info) return null;
    const [name, kind] = info;
    const n = typeof kind === 'number' ? kind : varCount(kind, words, ip + 1);
    return { ip, opcode, name, operands: Array.from(words.slice(ip + 1, ip + 1 + n)), size: 1 + n };
  }
  return { words, pool, decodeConst, decodeAt };
}

// ---------- abstract values ----------
const C = v => ({ t: 'c', v });
const X = s => ({ t: 'x', s });
const E = (op, ...args) => ({ t: 'e', op, args });
const XMERGE = { t: 'x', s: 'merge' };

function evalBin(op, a, b) {
  if (a.t === 'c' && b.t === 'c') {
    switch (op) {
      case 'ADD': return C(a.v + b.v);
      case 'SUB': return C(a.v - b.v);
      case 'MUL': return C(a.v * b.v);
      case 'DIV': return C(a.v / b.v);
      case 'MOD': return C(a.v % b.v);
      case 'POW': return C(Math.pow(a.v, b.v));
      case 'AND': return C(a.v & b.v);
      case 'OR': return C(a.v | b.v);
      case 'XOR': return C(a.v ^ b.v);
      case 'SHL': return C(a.v << b.v);
      case 'SHR': return C(a.v >> b.v);
      case 'USHR': return C(a.v >>> b.v);
      case 'EQ': return C(a.v == b.v);
      case 'NE': return C(a.v != b.v);
      case 'STRICT_EQ': return C(a.v === b.v);
      case 'STRICT_NE': return C(a.v !== b.v);
      case 'LT': return C(a.v < b.v);
      case 'LE': return C(a.v <= b.v);
      case 'GT': return C(a.v > b.v);
      case 'GE': return C(a.v >= b.v);
    }
  }
  return E(op, a, b);
}
function evalUn(op, a) {
  if (a.t === 'c') {
    switch (op) {
      case 'NEG': return C(-a.v);
      case 'POS': return C(+a.v);
      case 'NOT': return C(!a.v);
      case 'BNOT': return C(~a.v);
      case 'TYPEOF': return C(typeof a.v);
    }
  }
  return E(op, a);
}
function matchVar(v, condNode) {
  if (!condNode) return false;
  if (condNode.t === 'x') return v.t === 'x' && v.s === condNode.s;
  return v === condNode;
}
function evalTree(v, condNode, condVal) {
  if (matchVar(v, condNode)) return condVal;
  if (v.t === 'c') return v.v;
  if (v.t === 'e') {
    const c = v.args.map(a => matchVar(a, condNode) ? condVal : (a.t === 'c' ? a.v : evalTree(a, condNode, condVal)));
    return applyOp(v.op, c);
  }
  throw new Error('opaque in select: ' + JSON.stringify(v).slice(0, 120));
}
function applyOp(op, c) {
  switch (op) {
    case 'ADD': return c[0] + c[1];
    case 'SUB': return c[0] - c[1];
    case 'MUL': return c[0] * c[1];
    case 'DIV': return c[0] / c[1];
    case 'MOD': return c[0] % c[1];
    case 'AND': return c[0] & c[1];
    case 'OR': return c[0] | c[1];
    case 'XOR': return c[0] ^ c[1];
    case 'SHL': return c[0] << c[1];
    case 'SHR': return c[0] >> c[1];
    case 'USHR': return c[0] >>> c[1];
    case 'NEG': return -c[0];
    case 'POS': return +c[0];
    case 'NOT': return !c[0];
    case 'BNOT': return ~c[0];
    case 'TYPEOF': return typeof c[0];
    case 'STRICT_EQ': return c[0] === c[1];
    case 'STRICT_NE': return c[0] !== c[1];
    case 'EQ': return c[0] == c[1];
    case 'NE': return c[0] != c[1];
    case 'LT': return c[0] < c[1];
    case 'LE': return c[0] <= c[1];
    case 'GT': return c[0] > c[1];
    case 'GE': return c[0] >= c[1];
  }
  throw new Error('applyOp ' + op);
}
function findVars(v, cmpAcc, xAcc) {
  if (v.t === 'x') { if (!xAcc.some(x => x.s === v.s)) xAcc.push(v); return; }
  if (v.t === 'e') {
    if (/^(STRICT_EQ|STRICT_NE|EQ|NE|LT|LE|GT|GE)$/.test(v.op)) { if (!cmpAcc.includes(v)) cmpAcc.push(v); return; }
    v.args.forEach(a => findVars(a, cmpAcc, xAcc));
  }
}
function mergeVal(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === XMERGE) return a;
  if (a.t === 'c' && b.t === 'c' && a.v === b.v) return a;
  if (a.t === 'x' && b.t === 'x' && a.s === b.s) return a;
  return XMERGE;
}

// ---------- concrete dispatcher emulation ----------
// Runs a dispatcher function's bytecode with r0=A, r1=B and returns the raw result value.
function runDispatcher(ctx, dispEntry, A, B) {
  const regs = [];
  for (let i = 0; i < 16; i++) regs.push(undefined);
  regs[0] = A; regs[1] = B; regs[2] = [A, B];
  let ip = dispEntry, guard = 0;
  while (guard++ < 500) {
    const ins = ctx.decodeAt(ip);
    if (!ins) throw new Error('dispatcher: undecodable at ' + ip);
    const o = ins.operands;
    const R = i => regs[i];
    const N = ins.name;
    if (N === 'RETURN') return R(o[0]);
    else if (N === 'LOAD_THIS') regs[o[0]] = { __this: true };
    else if (N === 'LOAD_CONST') regs[o[0]] = ctx.decodeConst(o[1], o[2]);
    else if (N === 'LOAD_LITERAL') regs[o[0]] = o[1] >> 0;
    else if (N === 'LOAD_UNDEF') regs[o[0]] = undefined;
    else if (N === 'MOVE') regs[o[0]] = R(o[1]);
    else if (BIN_OPS.includes(N)) {
      const a = R(o[1]), b = R(o[2]);
      regs[o[0]] = applyOp(N, [a, b]);
    } else if (UN_OPS.includes(N)) {
      regs[o[0]] = applyOp(N, [R(o[1])]);
    } else if (N === 'LOAD_GLOBAL') {
      regs[o[0]] = { __global: ctx.decodeConst(o[1], o[2]) };
    } else if (N === 'GET_PROP') {
      const obj = R(o[1]), prop = R(o[2]);
      if (obj && obj.__global === 'Math' && prop === 'imul') regs[o[0]] = { __imul: true };
      else regs[o[0]] = obj[prop];
    } else if (N === 'CALL' || N === 'CALL_NULL') {
      const funcReg = N === 'CALL' ? o[2] : o[1];
      const argc = N === 'CALL' ? o[3] : o[2];
      const argStart = N === 'CALL' ? 4 : 3;
      const args = argc === MAGIC ? R(o[argStart]) : Array.from({ length: argc }, (_, i) => R(o[argStart + i]));
      const fn = R(funcReg);
      if (fn && fn.__imul) regs[o[0]] = Math.imul(args[0], args[1]);
      else throw new Error('dispatcher: unknown call');
    } else if (N === 'MAKE_ARRAY') {
      regs[o[0]] = o.slice(2).map(R);
    } else if (N === 'MAKE_OBJECT') {
      const obj = {};
      for (let i = 0; i < o[1]; i++) obj[R(o[2 + i * 2])] = R(o[3 + i * 2]);
      regs[o[0]] = obj;
    } else throw new Error('dispatcher: unhandled ' + N);
    ip += ins.size;
  }
  throw new Error('dispatcher: no return');
}

module.exports = { OPS, BIN_OPS, UN_OPS, makeCtx, C, X, E, XMERGE, evalBin, evalUn, evalTree, findVars, mergeVal, runDispatcher, MAGIC };
