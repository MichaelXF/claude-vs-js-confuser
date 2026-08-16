// Block-graph explorer with flow-sensitive constant propagation.
// Resolves the flattened control flow into a CFG.
const fs = require('fs');
const words = require('./bytecode.json');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const m = src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/);
const pool = eval(m[1]);

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
  return { ip, opcode, name, operands: words.slice(ip + 1, ip + 1 + n), size: 1 + n };
}

const u = x => x >>> 0;
function dispatch(A, B) {
  let b1 = u(~B);
  let b2 = u((b1 << 7) | (b1 >>> 25));
  let b3 = u(b2 + 371738263);
  let b4 = u(b3 ^ A);
  let b5 = u(b4 ^ (b4 >>> 26));
  let b6 = u(~b5);
  return Math.imul(b6, -2010834351) | 0;
}

const C = v => ({ t: 'c', v });
const X = s => ({ t: 'x', s });
const E = (op, ...args) => ({ t: 'e', op, args });

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

function evalTree(v, condNode, condVal) {
  if (matchVar(v, condNode)) return condVal;
  if (v.t === 'c') return v.v;
  if (v.t === 'e') {
    const c = v.args.map(a => matchVar(a, condNode) ? condVal : (a.t === 'c' ? a.v : evalTree(a, condNode, condVal)));
    switch (v.op) {
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
    throw new Error('applyOp ' + v.op);
  }
  throw new Error('opaque in select: ' + JSON.stringify(v).slice(0, 120));
}
function matchVar(v, condNode) {
  if (!condNode) return false;
  if (condNode.t === 'x') return v.t === 'x' && v.s === condNode.s;
  return v === condNode;
}
// Collect distinct "condition variables": comparison E-nodes and opaque X leaves.
function findVars(v, cmpAcc, xAcc) {
  if (v.t === 'x') { if (!xAcc.some(x => x.s === v.s)) xAcc.push(v); return; }
  if (v.t === 'e') {
    if (/^(STRICT_EQ|STRICT_NE|EQ|NE|LT|LE|GT|GE)$/.test(v.op)) { if (!cmpAcc.includes(v)) cmpAcc.push(v); return; }
    v.args.forEach(a => findVars(a, cmpAcc, xAcc));
  }
}

const XMERGE = X('merge');
function mergeVal(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === XMERGE) return a;
  if (a.t === 'c' && b.t === 'c' && a.v === b.v) return a;
  if (a.t === 'x' && b.t === 'x' && a.s === b.s) return a;
  return XMERGE;
}

function runBlock(startIp, regsIn) {
  const regs = regsIn.slice();
  const instrs = [];
  let ip = startIp;
  while (true) {
    const ins = decodeAt(ip);
    if (!ins) throw new Error('undecodable at ' + ip);
    instrs.push(ins);
    const o = ins.operands;
    const R = i => regs[i] || X('r' + i);
    switch (ins.name) {
      case 'LOAD_THIS': regs[o[0]] = X('this'); break;
      case 'LOAD_CONST': regs[o[0]] = C(decodeConst(o[1], o[2])); break;
      case 'LOAD_LITERAL': regs[o[0]] = C(o[1] >> 0); break;
      case 'LOAD_UNDEF': regs[o[0]] = C(undefined); break;
      case 'MOVE': regs[o[0]] = R(o[1]); break;
      case 'LOAD_GLOBAL': regs[o[0]] = X('global:' + decodeConst(o[1], o[2])); break;
      case 'TYPEOF_GLOBAL': regs[o[0]] = X('typeofglobal'); break;
      case 'STORE_GLOBAL': break;
      case 'GET_PROP': regs[o[0]] = X('prop'); break;
      case 'SET_PROP': break;
      case 'CALL': case 'CALL_NULL': regs[o[0]] = X('call'); break;
      case 'NEW': regs[o[0]] = X('new'); break;
      case 'MAKE_FUNC': regs[o[0]] = X('func@' + o[1]); break;
      case 'MAKE_ARRAY': regs[o[0]] = X('array'); break;
      case 'MAKE_OBJECT': regs[o[0]] = X('object'); break;
      case 'LOAD_CLOSURE': regs[o[0]] = X('closure' + o[1]); break;
      case 'STORE_CLOSURE': break;
      case 'FORIN_SETUP': regs[o[0]] = X('forin'); break;
      case 'FORIN_NEXT': regs[o[0]] = X('forinnext'); break;
      case 'DEFINE_GETTER': case 'DEFINE_SETTER': case 'DELETE': break;
      case 'POP_TRY': case 'DEBUGGER': break;
      case 'TRY': case 'TRY2': break;
      case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'MOD': case 'POW':
      case 'AND': case 'OR': case 'XOR': case 'SHL': case 'SHR': case 'USHR':
      case 'EQ': case 'NE': case 'STRICT_EQ': case 'STRICT_NE':
      case 'LT': case 'LE': case 'GT': case 'GE':
        regs[o[0]] = evalBin(ins.name, R(o[1]), R(o[2])); break;
      case 'IN': case 'INSTANCEOF':
        regs[o[0]] = E(ins.name, R(o[1]), R(o[2])); break;
      case 'NEG': case 'POS': case 'NOT': case 'BNOT': case 'TYPEOF':
        regs[o[0]] = evalUn(ins.name, R(o[1])); break;
      case 'JUMP':
        if (o[0] === 2517) return finishDispatch(instrs, regs);
        return { instrs, regs, kind: 'jump', target: o[0] };
      case 'JUMP_REG':
        return { instrs, regs, kind: 'jumpreg', reg: o[0] };
      case 'RETURN': return { instrs, regs, kind: 'return', reg: o[0] };
      case 'THROW': return { instrs, regs, kind: 'throw', reg: o[0] };
      case 'JUMP_IF_TRUE':
        return { instrs, regs, kind: 'condjump', condReg: o[0], target: o[1], fallthrough: ip + ins.size, when: true };
      case 'JUMP_IF_FALSE':
        return { instrs, regs, kind: 'condjump', condReg: o[0], target: o[1], fallthrough: ip + ins.size, when: false };
      default:
        throw new Error('unhandled ' + ins.name);
    }
    ip += ins.size;
  }
}

function finishDispatch(instrs, regs) {
  const A = regs[144];
  const B = regs[143];
  if (!A || A.t !== 'c') throw new Error('A not concrete: ' + JSON.stringify(A));
  if (B.t === 'c') {
    return { instrs, regs, kind: 'dispatch', A: A.v, B: B.v, targets: [dispatch(A.v, B.v)] };
  }
  if (B.t === 'e') {
    const cmpAcc = [], xAcc = [];
    findVars(B, cmpAcc, xAcc);
    const vars = cmpAcc.length + xAcc.length;
    if (vars === 1) {
      const condNode = cmpAcc[0] || xAcc[0];
      const Btrue = evalTree(B, condNode, true) | 0;
      const Bfalse = evalTree(B, condNode, false) | 0;
      return {
        instrs, regs, kind: 'dispatch-cond', A: A.v, cond: condNode,
        Btrue, Bfalse,
        targetTrue: dispatch(A.v, Btrue),
        targetFalse: dispatch(A.v, Bfalse),
      };
    }
  }
  throw new Error('cannot resolve dispatch; B=' + JSON.stringify(B).slice(0, 300));
}

const NREG = 160;
function regInitMain() {
  const r = [];
  for (let i = 0; i < NREG; i++) r.push(X('undef'));
  r[0] = X('arguments');
  for (let i = 1; i < 8; i++) r[i] = X('arg' + i);
  return r;
}

function explore(entryIp, quiet) {
  const envs = new Map(); // ip -> merged regs
  const wl = [];
  function pushState(ip, regs) {
    if (!envs.has(ip)) {
      envs.set(ip, regs.slice());
      wl.push(ip);
    } else {
      const cur = envs.get(ip);
      const merged = cur.map((v, i) => mergeVal(v, regs[i]));
      if (merged.some((v, i) => v !== cur[i])) {
        envs.set(ip, merged);
        wl.push(ip); // reprocess with widened env
      }
    }
  }

  pushState(entryIp, regInitMain());
  const results = new Map();
  let guard = 0;
  while (wl.length) {
    if (++guard > 20000) { console.log('GUARD TRIPPED'); break; }
    const ip = wl.pop();
    const regs = envs.get(ip);
    let res;
    try {
      res = runBlock(ip, regs);
    } catch (e) {
      console.log('block ' + ip + ' ERROR: ' + e.message);
      continue;
    }
    results.set(ip, res);
    if (!quiet) {
      const tag = res.kind === 'dispatch' ? `dispatch -> ${res.targets[0]}`
        : res.kind === 'dispatch-cond' ? `cond T:${res.targetTrue} F:${res.targetFalse}`
        : res.kind === 'jump' ? `jump ${res.target}`
        : res.kind === 'condjump' ? `condjump T:${res.target} F:${res.fallthrough}`
        : res.kind;
      console.log(`block ${ip}: ${tag}`);
    }
    if (res.kind === 'dispatch') pushState(res.targets[0], res.regs);
    else if (res.kind === 'dispatch-cond') { pushState(res.targetTrue, res.regs); pushState(res.targetFalse, res.regs); }
    else if (res.kind === 'jump') pushState(res.target, res.regs);
    else if (res.kind === 'condjump') { pushState(res.target, res.regs); pushState(res.fallthrough, res.regs); }
  }
  return results;
}

if (require.main === module) {
  const entry = Number(process.argv[2] || 36);
  const results = explore(entry, false);
  console.log('total blocks:', results.size);
  fs.writeFileSync(__dirname + '/blocks.json', JSON.stringify([...results.entries()].map(([k, v]) => [k, { kind: v.kind, instrs: v.instrs, targets: v.targets, targetTrue: v.targetTrue, targetFalse: v.targetFalse, target: v.target, fallthrough: v.fallthrough, condReg: v.condReg, reg: v.reg }]), null, 0));
}

module.exports = { explore, decodeAt, decodeConst, dispatch, OPS, words, pool };
