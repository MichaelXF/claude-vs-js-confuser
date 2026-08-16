// Pretty-print disassembly with constant decryption inline.
const fs = require('fs');
const instrs = require('./disasm.json');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');

// Extract constants pool from input.js: the array passed as 3rd arg to `new d(...)`
const m = src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/);
// eslint-disable-next-line no-eval
const pool = eval(m[1]);

function decodeConst(idx, key) {
  let b = pool[idx];
  if (!key) return b;
  if (typeof b === 'number') return b ^ key;
  if (typeof b !== 'string') return b;
  const buf = Buffer.from(b, 'base64');
  let e = '';
  let c = key;
  for (let a = 0; a < buf.length / 2; a++) {
    c = c + 2654435769 | 0;
    e += String.fromCharCode((buf[a * 2] | buf[a * 2 + 1] << 8) ^ (c ^ c >>> 13) & 65535);
  }
  return e;
}

function fmtConst(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

const MAGIC = 3247410626;
for (const ins of instrs) {
  const o = ins.operands;
  let s = '';
  switch (ins.name) {
    case 'LOAD_CONST':
    case 'LOAD_GLOBAL':
    case 'TYPEOF_GLOBAL':
      s = `const[${o[1]}]=${fmtConst(decodeConst(o[1], o[2]))}`;
      break;
    case 'STORE_GLOBAL':
      s = `const[${o[0]}]=${fmtConst(decodeConst(o[0], o[1]))} = r${o[2]}`;
      break;
    case 'JUMP': s = `-> ${o[0]}`; break;
    case 'JUMP_IF_TRUE': s = `if r${o[0]} -> ${o[1]}`; break;
    case 'JUMP_IF_FALSE': s = `if !r${o[0]} -> ${o[1]}`; break;
    case 'JUMP_REG': s = `-> r${o[0]} (computed)`; break;
    case 'MAKE_FUNC':
      s = `r${o[0]} = func(entry=${o[1]}, j=${o[2]}, regs=${o[3]}, nclos=${o[4]}, d=${o[5]})`;
      break;
    case 'CALL': {
      const argc = o[3];
      const args = argc === MAGIC ? ['spread r' + o[4]] : o.slice(4).map(r => 'r' + r);
      s = `r${o[0]} = r${o[2]}.call(r${o[1]}, ${args.join(',')})`;
      break;
    }
    case 'CALL_NULL': {
      const argc = o[2];
      const args = argc === MAGIC ? ['spread r' + o[3]] : o.slice(3).map(r => 'r' + r);
      s = `r${o[0]} = r${o[1]}(${args.join(',')})`;
      break;
    }
    case 'NEW': {
      const argc = o[2];
      const args = argc === MAGIC ? ['spread r' + o[3]] : o.slice(3).map(r => 'r' + r);
      s = `r${o[0]} = new r${o[1]}(${args.join(',')})`;
      break;
    }
    case 'RETURN': s = `return r${o[0]}`; break;
    case 'MOVE': s = `r${o[0]} = r${o[1]}`; break;
    case 'LOAD_LITERAL': s = `r${o[0]} = ${o[1] >> 0} (0x${(o[1] >>> 0).toString(16)})`; break;
    case 'LOAD_THIS': s = `r${o[0]} = this`; break;
    case 'LOAD_UNDEF': s = `r${o[0]} = undefined`; break;
    case 'GET_PROP': s = `r${o[0]} = r${o[1]}[r${o[2]}]`; break;
    case 'SET_PROP': s = `r${o[0]}[r${o[1]}] = r${o[2]}`; break;
    case 'MAKE_ARRAY': s = `r${o[0]} = [${o.slice(2).map(r => 'r' + r).join(',')}] (n=${o[1]})`; break;
    case 'MAKE_OBJECT': {
      const pairs = [];
      for (let i = 0; i < o[1]; i++) pairs.push(`r${o[2 + i * 2]}:r${o[3 + i * 2]}`);
      s = `r${o[0]} = {${pairs.join(',')}}`;
      break;
    }
    case 'TRY': s = `try G=${o[0]} C=${o[1]} D=${o[2]} r=${o[3]}`; break;
    case 'TRY2': s = `try2 F=${o[0]} u=${o[1]}`; break;
    case 'FORIN_SETUP': s = `r${o[0]} = forin(r${o[1]})`; break;
    case 'FORIN_NEXT': s = `r${o[0]} = next(r${o[1]}) else -> ${o[2]}`; break;
    case 'LOAD_CLOSURE': s = `r${o[0]} = closure[${o[1]}]`; break;
    case 'STORE_CLOSURE': s = `closure[${o[0]}] = r${o[1]}`; break;
    case 'DECRYPT': s = `decrypt dst=${o[0]} src=[${o[1]},${o[2]}) seed=${o[3]}`; break;
    default: {
      // binary/unary
      const bin = ['ADD','SUB','MUL','DIV','MOD','POW','AND','OR','XOR','SHL','SHR','USHR','EQ','NE','STRICT_EQ','STRICT_NE','LT','LE','GT','GE','IN','INSTANCEOF'];
      const un = ['NEG','POS','NOT','BNOT','TYPEOF'];
      if (bin.includes(ins.name)) s = `r${o[0]} = r${o[1]} ${ins.name} r${o[2]}`;
      else if (un.includes(ins.name)) s = `r${o[0]} = ${ins.name} r${o[1]}`;
      else if (ins.name === 'DELETE') s = `delete r${o[1]}[r${o[2]}] -> r${o[0]}`;
    }
  }
  console.log(`${String(ins.ip).padStart(5)} ${ins.name.padEnd(14)} ${s}`);
}
