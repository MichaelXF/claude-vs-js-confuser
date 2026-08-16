// Static disassembler for the JS-Confuser-VM bytecode.
// Applies runtime DECRYPT ops (44681) in-place as they are encountered.
const fs = require('fs');
const words = require('./bytecode.json');

// Operand layout table.
// kind: 'fixed' (n operands), or a function(ops, i, words) => total operand count for variable-length
const MAGIC = 3247410626;
const OPS = {
  26:    { name: 'NOT',          n: 2 }, // a[b+c]=!a[b+v]
  464:   { name: 'THROW',        n: 1 }, // throw a[b+v]
  750:   { name: 'DEFINE_GETTER',n: 3 },
  1149:  { name: 'RETURN',       n: 1 },
  1864:  { name: 'JUMP',         n: 1 },
  2073:  { name: 'XOR',          n: 3 },
  2939:  { name: 'JUMP_REG',     n: 1 }, // ip = a[b+v]  (computed)
  3207:  { name: 'CALL',         var: 'call' },  // dest, thisReg, funcReg, argc|MAGIC, args...
  4239:  { name: 'MAKE_OBJECT',  var: 'object' },// dest, count, (key,val)*
  5540:  { name: 'LOAD_UNDEF',   n: 2 }, // c=v; v(this); a[b+c]=void 0
  8957:  { name: 'GE',           n: 3 },
  9273:  { name: 'MOD',          n: 3 },
  10246: { name: 'STRICT_NE',    n: 3 },
  10292: { name: 'NEG',          n: 2 },
  11549: { name: 'TYPEOF',       n: 2 },
  12250: { name: 'SUB',          n: 3 },
  14945: { name: 'FORIN_NEXT',   n: 3 },
  16990: { name: 'SHR',          n: 3 },
  19562: { name: 'MOVE',         n: 2 },
  21410: { name: 'SET_PROP',     n: 3 },
  24481: { name: 'LOAD_GLOBAL',  n: 3, aConst: true }, // c, A()=idx,key
  25103: { name: 'TRY',          n: 4 }, // G,C,D,r  (catch/finally setup)
  28700: { name: 'STORE_CLOSURE',n: 2 },
  29884: { name: 'IN',           n: 3 },
  30300: { name: 'INSTANCEOF',   n: 3 },
  31355: { name: 'EQ',           n: 3 },
  31655: { name: 'GT',           n: 3 },
  31871: { name: 'USHR',         n: 3 },
  33322: { name: 'LOAD_CLOSURE', n: 2 },
  34503: { name: 'AND',          n: 3 },
  35033: { name: 'SHL',          n: 3 },
  35122: { name: 'JUMP_IF_FALSE',n: 2 },
  36652: { name: 'DEFINE_SETTER',n: 3 },
  38134: { name: 'POW',          n: 3 },
  38534: { name: 'LOAD_CONST',   n: 3, aConst: true }, // c, A()=idx,key
  40370: { name: 'LT',           n: 3 },
  43207: { name: 'GET_PROP',     n: 3 },
  43221: { name: 'MAKE_ARRAY',   var: 'array' }, // dest, count, regs...
  43498: { name: 'LE',           n: 3 },
  44050: { name: 'POS',          n: 2 },
  44091: { name: 'FORIN_SETUP',  n: 2 },
  44681: { name: 'DECRYPT',      n: 4 }, // a(destOff), b(srcStart), c(srcEnd), e(seed)
  45389: { name: 'BNOT',         n: 2 },
  46657: { name: 'NEW',          var: 'new' },   // dest, funcReg, argc|MAGIC, args...
  48269: { name: 'TYPEOF_GLOBAL',n: 3, aConst: true },
  52128: { name: 'LOAD_THIS',    n: 1 },
  53842: { name: 'OR',           n: 3 },
  56068: { name: 'POP_TRY',      n: 0 },
  56444: { name: 'DEBUGGER',     n: 0 },
  57129: { name: 'ADD',          n: 3 },
  59112: { name: 'JUMP_IF_TRUE', n: 2 },
  60197: { name: 'CALL_NULL',    var: 'callnull' }, // dest, funcReg, argc|MAGIC, args...
  60563: { name: 'DELETE',       n: 3 },
  60779: { name: 'STRICT_EQ',    n: 3 },
  61109: { name: 'NE',           n: 3 },
  61360: { name: 'STORE_GLOBAL', n: 3, aConst: true }, // A()=idx,key, valReg
  61431: { name: 'MAKE_FUNC',    var: 'func' },  // dest, p, j, b, nclosures, d, (H,e)*
  62094: { name: 'DIV',          n: 3 },
  62459: { name: 'TRY2',         n: 2 }, // F,u
  63117: { name: 'LOAD_LITERAL', n: 2 },
  65297: { name: 'MUL',          n: 3 },
};

function varCount(kind, w, i) {
  // i points at first operand word
  switch (kind) {
    case 'func': {
      const nclosures = w[i + 4];
      return 6 + 2 * nclosures;
    }
    case 'call': {
      const h = w[i + 3];
      return 4 + (h === MAGIC ? 1 : h);
    }
    case 'callnull':
    case 'new': {
      const f = w[i + 2];
      return 3 + (f === MAGIC ? 1 : f);
    }
    case 'object': {
      const e = w[i + 1];
      return 2 + 2 * e;
    }
    case 'array': {
      const e = w[i + 1];
      return 2 + e;
    }
  }
  throw new Error('bad var kind ' + kind);
}

// Disassemble with worklist; apply DECRYPTs encountered.
const K = words.slice(); // mutable copy
const visited = new Set();
const instrs = new Map(); // ip -> {ip, opcode, name, operands, size}
const decryptsApplied = new Set();
const jumpRegSites = [];

function decodeAt(ip) {
  const opcode = K[ip];
  const info = OPS[opcode];
  if (!info) return null;
  let n;
  if (info.var) n = varCount(info.var, K, ip + 1);
  else n = info.n;
  const operands = K.slice(ip + 1, ip + 1 + n);
  return { ip, opcode, name: info.name, operands, size: 1 + n };
}

const worklist = [0]; // entry of top-level
const funcEntries = [0];

while (worklist.length) {
  const start = worklist.pop();
  let ip = start;
  while (true) {
    if (visited.has(ip)) break;
    if (ip < 0 || ip >= K.length) break;
    let ins = decodeAt(ip);
    if (!ins) {
      console.log('UNDECODABLE at ip=' + ip + ' word=' + K[ip]);
      break;
    }
    visited.add(ip);
    instrs.set(ip, ins);
    const ops = ins.operands;
    switch (ins.name) {
      case 'JUMP':
        ip = ops[0];
        continue; // fallthrough to target
      case 'JUMP_IF_TRUE':
      case 'JUMP_IF_FALSE':
        worklist.push(ops[1]);
        ip = ip + ins.size;
        continue;
      case 'JUMP_REG':
        jumpRegSites.push(ip);
        break; // cannot follow statically
      case 'RETURN':
      case 'THROW':
        break; // end of this path
      case 'MAKE_FUNC':
        funcEntries.push(ops[1]);
        worklist.push(ops[1]);
        ip = ip + ins.size;
        continue;
      case 'DECRYPT': {
        const [a, b, c, e0] = ops;
        const key = ip + ':' + a + ',' + b + ',' + c + ',' + e0;
        if (!decryptsApplied.has(key)) {
          decryptsApplied.add(key);
          let e = e0 ^ a | 0;
          for (let f = b; f < c; f++) {
            e = e + 2654435769 | 0;
            K[a + (f - b)] = (K[f] ^ e ^ (e >>> 13)) >>> 0;
          }
          console.log(`DECRYPT applied: dst=${a} src=[${b},${c}) seed=${e0}`);
        }
        ip = ip + ins.size;
        continue;
      }
      case 'TRY':
      case 'TRY2':
        // try targets are possible continuations
        for (const o of ops) worklist.push(o);
        ip = ip + ins.size;
        continue;
      default:
        ip = ip + ins.size;
        continue;
    }
    break; // for RETURN/THROW/JUMP_REG
  }
}

console.log('instructions decoded:', instrs.size);
console.log('function entries:', JSON.stringify(funcEntries));
console.log('JUMP_REG sites:', JSON.stringify(jumpRegSites));
console.log('decrypts applied:', decryptsApplied.size);

fs.writeFileSync(
  __dirname + '/disasm.json',
  JSON.stringify(
    Array.from(instrs.values()).sort((a, b) => a.ip - b.ip),
    null,
    0
  )
);
