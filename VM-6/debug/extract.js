// debug/extract.js -- pull the VM internals out of input.js without running the program
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

const file = process.argv[2] || path.join(__dirname, '..', 'input.js');
const src = fs.readFileSync(file, 'utf8');
const ast = parser.parse(src, { sourceType: 'script' });

const body = ast.program.body;
// last statement should be the bootstrap call z(new g(D, [pool], B), void 0, null, new t({...}))
const last = body[body.length - 1];
console.log('last stmt type:', last.type);
if (last.type === 'ExpressionStatement') {
  const e = last.expression;
  console.log('callee:', e.callee && e.callee.name, 'args:', e.arguments.length);
  e.arguments.forEach((a, i) => {
    console.log(' arg' + i, a.type, generate(a).code.slice(0, 120));
  });
}

// collect handler assignments  A[NNN] = function(){...}
const handlers = [];
for (const st of body) {
  if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression') {
    const l = st.expression.left, r = st.expression.right;
    if (l.type === 'MemberExpression' && l.computed && l.object.type === 'Identifier' &&
        l.property.type === 'NumericLiteral' && r.type === 'FunctionExpression') {
      handlers.push({ obj: l.object.name, op: l.property.value, code: generate(r).code });
    }
  }
}
console.log('handlers found:', handlers.length, 'objects:', [...new Set(handlers.map(h => h.obj))]);
handlers.sort((a, b) => a.code.length - b.code.length);
fs.writeFileSync(path.join(__dirname, 'handlers.txt'),
  handlers.map(h => `=== A[${h.op}]  (len ${h.code.length})\n${h.code}\n`).join('\n'));
console.log('shortest 45:');
for (const h of handlers.slice(0, 45)) console.log(`A[${h.op}] = ${h.code}`);
