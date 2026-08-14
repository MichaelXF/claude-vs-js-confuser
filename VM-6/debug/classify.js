// debug/classify.js -- classify every opcode handler by structure (AST features) + dynamic probing
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

// ---- structural classification from the handler source ----------------------
// Each handler is a tiny function; we look at robust syntactic markers rather
// than at the (randomized) opcode number.
function structuralKind(code) {
  const has = (re) => re.test(code);
  if (has(/\bdebugger\b/)) return { kind: 'DEBUGGER' };
  if (has(/this\.i\[/)) return { kind: 'DECRYPT' };
  if (has(/\bnew t\(/) || has(/r\.set\(/)) return { kind: 'MAKEFUNC' };
  if (has(/this\.t\(/)) {
    if (has(/Reflect\.construct/)) return { kind: 'NEW' };
    if (has(/\.apply\(null,/)) return { kind: 'CALL' };
    return { kind: 'CALLMETHOD' };
  }
  if (has(/x\(this,\s*\[\],/)) return { kind: 'RETURN' };
  if (has(/\bthrow\b/) && !has(/ReferenceError/)) return { kind: 'THROW' };
  if (has(/\.pop\(\)/)) return { kind: 'POPTRY' };
  if (has(/\.push\(\{/)) return has(/\bp:/) ? { kind: 'TRYFIN' } : { kind: 'TRYCATCH' };
  if (has(/Object\.getOwnPropertyNames/)) return { kind: 'FORIN_INIT' };
  if (has(/\.q\s*>=/)) return { kind: 'FORIN_NEXT' };
  if (has(/Object\.defineProperty/)) return has(/get:\s*c/) ? { kind: 'DEFGET' } : { kind: 'DEFSET' };
  if (has(/Reflect\.set/)) return { kind: 'SETMEMBER' };
  if (has(/\bdelete\b/)) return { kind: 'DELETE' };
  if (has(/ReferenceError/)) return { kind: 'LOADGLOBAL' };
  if (has(/hasOwnProperty/)) return { kind: 'TYPEOFGLOBAL' };
  if (has(/this\.h\[v\(this\)\]\s*=/)) return { kind: 'STOREGLOBAL' };
  if (has(/\.l\[/)) return has(/\.v\s*\?\s*\w+\.u\s*=/) ? { kind: 'STORECELL' } : { kind: 'LOADCELL' };
  if (has(/=\s*\{\s*\}[,;]/) && has(/for\s*\(/)) return { kind: 'OBJECT' };
  if (has(/Array\(\w+\)/) && has(/for\s*\(/)) return { kind: 'ARRAY' };
  return null;
}

// jump-family + misc detection needs a look at what the body assigns to
function jumpKind(code) {
  // pc slot is frame[fp+2]
  if (/\[[^\]]+\+ 2\] = w\(this\)/.test(code)) return 'JMP';
  if (/\[[^\]]+\+ 2\] = \w+\[\w+\[[^\]]+\+ 1\] \+ w\(this\)\]/.test(code)) return 'JMPDYN';
  if (/&&\s*\(\w+\[\w+ \+ 2\] = \w+\)/.test(code)) return 'JMPIF';
  if (/\|\|\s*\(\w+\[\w+ \+ 2\] = \w+\)/.test(code)) return 'JMPIFNOT';
  return null;
}

module.exports = { structuralKind, jumpKind };
