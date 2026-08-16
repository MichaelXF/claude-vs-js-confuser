// Linear-sweep disassembly of a region to inspect block structure.
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

const start = Number(process.argv[2] || 36);
const end = Number(process.argv[3] || 2530);
let ip = start;
while (ip < end) {
  const opcode = words[ip];
  const info = OPS[opcode];
  if (!info) {
    console.log(`${ip}: UNDECODABLE word=${opcode}`);
    ip++;
    continue;
  }
  const [name, kind] = info;
  const n = typeof kind === 'number' ? kind : varCount(kind, words, ip + 1);
  const ops = words.slice(ip + 1, ip + 1 + n);
  let extra = '';
  if (name === 'LOAD_CONST' || name === 'LOAD_GLOBAL' || name === 'TYPEOF_GLOBAL') {
    extra = ' ; ' + JSON.stringify(decodeConst(ops[1], ops[2]));
  } else if (name === 'STORE_GLOBAL') {
    extra = ' ; ' + JSON.stringify(decodeConst(ops[0], ops[1]));
  } else if (name === 'LOAD_LITERAL') {
    extra = ' ; ' + (ops[1] >> 0);
  }
  console.log(`${String(ip).padStart(5)} ${name.padEnd(13)} [${ops.join(',')}]${extra}`);
  ip += 1 + n;
}
