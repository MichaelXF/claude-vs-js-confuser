// Structurally locate the VM internals in an obfuscated sample and expose them
// without executing the payload.
const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');

function locate(code) {
  const ast = parser.parse(code, { sourceType: 'script' });
  const body = ast.program.body;

  // The bootstrap call: interp(new VM(bytecode, ?, global, pool), new Fn({...}), ...)
  let idx = -1, info = null;
  for (let i = body.length - 1; i >= 0; i--) {
    const st = body[i];
    if (st.type !== 'ExpressionStatement') continue;
    const c = st.expression;
    if (c.type !== 'CallExpression' || c.callee.type !== 'Identifier') continue;
    const a = c.arguments;
    if (a.length < 2) continue;
    if (a[0].type !== 'NewExpression' || a[0].callee.type !== 'Identifier') continue;
    if (a[1].type !== 'NewExpression' || a[1].callee.type !== 'Identifier') continue;
    if (a[1].arguments.length !== 1 || a[1].arguments[0].type !== 'ObjectExpression') continue;
    const vmArgs = a[0].arguments;
    if (!vmArgs.some(n => n.type === 'ArrayExpression')) continue;
    idx = i;
    info = {
      interp: c.callee.name,
      vmCtor: a[0].callee.name,
      fnCtor: a[1].callee.name,
      vmArgs,
      meta: a[1].arguments[0],
    };
    break;
  }
  if (idx < 0) return null;

  // bytecode identifier = the Identifier arg of `new VM(...)`; pool = the ArrayExpression
  const bytecodeName = info.vmArgs.find(n => n.type === 'Identifier' &&
      !(n.name === info.vmArgs[2] && false)) ;
  // more precisely: first Identifier arg is the bytecode, third is the global object
  const identArgs = info.vmArgs.filter(n => n.type === 'Identifier');
  info.bytecode = identArgs[0] ? identArgs[0].name : null;
  info.globalName = identArgs[1] ? identArgs[1].name : null;
  info.poolIndex = info.vmArgs.findIndex(n => n.type === 'ArrayExpression');

  // handler prototype alias: var Y = VM.prototype
  let protoVar = null;
  for (const st of body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      if (d.init && d.init.type === 'MemberExpression' &&
          d.init.object.type === 'Identifier' && d.init.object.name === info.vmCtor &&
          !d.init.computed && d.init.property.name === 'prototype') protoVar = d.id.name;
    }
  }
  info.protoVar = protoVar;
  info.entryIndex = idx;
  info.ast = ast;
  return info;
}

// Build a runnable module that exposes internals but never runs the payload.
function buildModule(code) {
  const info = locate(code);
  if (!info) throw new Error('VM bootstrap not found');
  const body = info.ast.program.body;
  const entry = body[info.entryIndex];
  const call = entry.expression;

  const props = [
    ['VM', t.identifier(info.vmCtor)],
    ['Fn', t.identifier(info.fnCtor)],
    ['interp', t.identifier(info.interp)],
    ['proto', t.identifier(info.protoVar)],
    ['bytecode', t.identifier(info.bytecode)],
    ['globalObj', t.identifier(info.globalName)],
    ['pool', call.arguments[0].arguments[info.poolIndex]],
    ['meta', info.meta],
    ['vmExtra', t.arrayExpression(call.arguments[0].arguments.map((n, i) =>
        (n.type === 'ArrayExpression' || n.type === 'Identifier') ? t.nullLiteral() : n))],
    ['bootThis', call.arguments[2] || t.nullLiteral()],
  ];
  body[info.entryIndex] = t.expressionStatement(t.assignmentExpression('=',
    t.memberExpression(t.identifier('module'), t.identifier('exports')),
    t.objectExpression(props.map(([k, v]) => t.objectProperty(t.identifier(k), v)))));

  return { code: generate(info.ast, { compact: false }).code, info };
}

module.exports = { locate, buildModule };

if (require.main === module) {
  const src = fs.readFileSync(process.argv[2] || 'input.js', 'utf8');
  const { code, info } = buildModule(src);
  fs.writeFileSync('debug/loaded.js', code);
  console.log(JSON.stringify({
    interp: info.interp, vmCtor: info.vmCtor, fnCtor: info.fnCtor,
    protoVar: info.protoVar, bytecode: info.bytecode, globalName: info.globalName,
    poolIndex: info.poolIndex,
  }, null, 2));
}
