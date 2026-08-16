// Readable dump of all explored blocks.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const m = src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/);
const pool = eval(m[1]);
const blocks = new Map(require('./blocks.json'));

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

function fmtIns(ins) {
  const o = ins.operands;
  switch (ins.name) {
    case 'LOAD_CONST': return `r${o[0]} = ${JSON.stringify(decodeConst(o[1], o[2]))}`;
    case 'LOAD_GLOBAL': return `r${o[0]} = global.${decodeConst(o[1], o[2])}`;
    case 'TYPEOF_GLOBAL': return `r${o[0]} = typeof global.${decodeConst(o[1], o[2])}`;
    case 'STORE_GLOBAL': return `global.${decodeConst(o[0], o[1])} = r${o[2]}`;
    case 'LOAD_LITERAL': return `r${o[0]} = ${o[1] >> 0}`;
    case 'LOAD_THIS': return `r${o[0]} = this`;
    case 'LOAD_UNDEF': return `r${o[0]} = undefined`;
    case 'MOVE': return `r${o[0]} = r${o[1]}`;
    case 'GET_PROP': return `r${o[0]} = r${o[1]}[r${o[2]}]`;
    case 'SET_PROP': return `r${o[0]}[r${o[1]}] = r${o[2]}`;
    case 'JUMP': return `JUMP ${o[0]}`;
    case 'JUMP_REG': return `JUMP_REG r${o[0]}`;
    case 'RETURN': return `RETURN r${o[0]}`;
    case 'THROW': return `THROW r${o[0]}`;
    case 'MAKE_FUNC': return `r${o[0]} = func(entry=${o[1]},j=${o[2]},regs=${o[3]},nclos=${o[4]},d=${o[5]})`;
    case 'CALL': {
      const args = o[3] === 3247410626 ? ['...r' + o[4]] : o.slice(4).map(r => 'r' + r);
      return `r${o[0]} = r${o[2]}.call(r${o[1]},${args.join(',')})`;
    }
    case 'CALL_NULL': {
      const args = o[2] === 3247410626 ? ['...r' + o[3]] : o.slice(3).map(r => 'r' + r);
      return `r${o[0]} = r${o[1]}(${args.join(',')})`;
    }
    case 'MAKE_ARRAY': return `r${o[0]} = [${o.slice(2).map(r => 'r' + r).join(',')}]`;
    case 'MAKE_OBJECT': {
      const p = [];
      for (let i = 0; i < o[1]; i++) p.push(`r${o[2 + i * 2]}:r${o[3 + i * 2]}`);
      return `r${o[0]} = {${p.join(',')}}`;
    }
    case 'LOAD_CLOSURE': return `r${o[0]} = closure[${o[1]}]`;
    case 'STORE_CLOSURE': return `closure[${o[0]}] = r${o[1]}`;
    case 'TRY': return `TRY catch@${o[0]} (${o[1]},${o[2]},${o[3]})`;
    case 'TRY2': return `TRY2 catch@${o[0]} errReg=${o[1]}`;
    case 'POP_TRY': return 'POP_TRY';
    case 'FORIN_SETUP': return `r${o[0]} = forin_setup(r${o[1]})`;
    case 'FORIN_NEXT': return `r${o[0]} = forin_next(r${o[1]}) else->${o[2]}`;
    case 'DEFINE_GETTER': return `defineGet r${o[0]}[r${o[1]}]=r${o[2]}`;
    case 'DEFINE_SETTER': return `defineSet r${o[0]}[r${o[1]}]=r${o[2]}`;
    case 'DELETE': return `r${o[0]} = delete r${o[1]}[r${o[2]}]`;
    case 'NEW': {
      const args = o[2] === 3247410626 ? ['...r' + o[3]] : o.slice(3).map(r => 'r' + r);
      return `r${o[0]} = new r${o[1]}(${args.join(',')})`;
    }
    case 'DEBUGGER': return 'debugger';
    default: {
      const bin = ['ADD','SUB','MUL','DIV','MOD','POW','AND','OR','XOR','SHL','SHR','USHR','EQ','NE','STRICT_EQ','STRICT_NE','LT','LE','GT','GE','IN','INSTANCEOF'];
      const un = ['NEG','POS','NOT','BNOT','TYPEOF'];
      const sym = { ADD:'+',SUB:'-',MUL:'*',DIV:'/',MOD:'%',POW:'**',AND:'&',OR:'|',XOR:'^',SHL:'<<',SHR:'>>',USHR:'>>>',EQ:'==',NE:'!=',STRICT_EQ:'===',STRICT_NE:'!==',LT:'<',LE:'<=',GT:'>',GE:'>=',IN:'in',INSTANCEOF:'instanceof' }[ins.name];
      if (bin.includes(ins.name)) return `r${o[0]} = r${o[1]} ${sym} r${o[2]}`;
      if (un.includes(ins.name)) return `r${o[0]} = ${ins.name} r${o[1]}`;
      return ins.name + ' [' + o.join(',') + ']';
    }
  }
}

const sorted = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
const out = [];
for (const [ip, b] of sorted) {
  const tag = b.kind === 'dispatch' ? `==> ${b.targets[0]}`
    : b.kind === 'dispatch-cond' ? `==> T:${b.targetTrue} F:${b.targetFalse}`
    : b.kind === 'jump' ? `==> jump ${b.target}`
    : b.kind === 'condjump' ? `==> condjump T:${b.target} F:${b.fallthrough}`
    : `==> ${b.kind}`;
  out.push(`\n=== block ${ip} ${tag}`);
  for (const ins of b.instrs) out.push('   ' + fmtIns(ins));
}
fs.writeFileSync(__dirname + '/blocks.utf8.txt', out.join('\n'));
console.log('written', out.length, 'lines');
