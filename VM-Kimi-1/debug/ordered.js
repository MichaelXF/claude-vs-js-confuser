// Dump payload blocks in simulated execution order, excluding dispatch scratch.
const fs = require('fs');
const blocks = new Map(require('./blocks.json'));
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const m = src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/);
const pool = eval(m[1]);
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
      return `r${o[0]} = r${o[2]}.call(r${o[1]}, ${args.join(', ')})`;
    }
    case 'CALL_NULL': {
      const args = o[2] === 3247410626 ? ['...r' + o[3]] : o.slice(3).map(r => 'r' + r);
      return `r${o[0]} = r${o[1]}(${args.join(', ')})`;
    }
    case 'MAKE_ARRAY': return `r${o[0]} = [${o.slice(2).map(r => 'r' + r).join(',')}]`;
    case 'MAKE_OBJECT': {
      const p = [];
      for (let i = 0; i < o[1]; i++) p.push(`r${o[2 + i * 2]}:r${o[3 + i * 2]}`);
      return `r${o[0]} = {${p.join(',')}}`;
    }
    case 'LOAD_CLOSURE': return `r${o[0]} = closure[${o[1]}]`;
    case 'STORE_CLOSURE': return `closure[${o[0]}] = r${o[1]}`;
    case 'NEW': {
      const args = o[2] === 3247410626 ? ['...r' + o[3]] : o.slice(3).map(r => 'r' + r);
      return `r${o[0]} = new r${o[1]}(${args.join(', ')})`;
    }
    default: {
      const sym = { ADD:'+',SUB:'-',MUL:'*',DIV:'/',MOD:'%',POW:'**',AND:'&',OR:'|',XOR:'^',SHL:'<<',SHR:'>>',USHR:'>>>',EQ:'==',NE:'!=',STRICT_EQ:'===',STRICT_NE:'!==',LT:'<',LE:'<=',GT:'>',GE:'>=',IN:' in ',INSTANCEOF:' instanceof ' }[ins.name];
      if (sym) return `r${o[0]} = r${o[1]}${sym}r${o[2]}`;
      const un = { NEG:'-',POS:'+',NOT:'!',BNOT:'~',TYPEOF:'typeof ' }[ins.name];
      if (un !== undefined) return `r${o[0]} = ${un}r${o[1]}`;
      return ins.name + ' [' + o.join(',') + ']';
    }
  }
}

// Filter out dispatch-scratch instructions: writes to r143,r144,r147,r148 and the MBA select chain and JUMP 2517
const SCRATCH = new Set([143, 144, 147, 148]);
function isScratch(ins) {
  const o = ins.operands;
  if (ins.name === 'JUMP' && o[0] === 2517) return true;
  // instructions writing scratch regs
  if ((ins.name !== 'JUMP' && ins.name !== 'JUMP_REG') && SCRATCH.has(o[0])) return true;
  return false;
}

const order = process.argv.slice(2).map(Number);
for (const ip of order) {
  const b = blocks.get(ip);
  if (!b) { console.log(`\n### block ${ip} MISSING`); continue; }
  console.log(`\n### block ${ip} (${b.kind}${b.kind === 'dispatch-cond' ? ' T:' + b.targetTrue + ' F:' + b.targetFalse : ''})`);
  for (const ins of b.instrs) {
    if (isScratch(ins)) continue;
    console.log('   ' + fmtIns(ins));
  }
}
