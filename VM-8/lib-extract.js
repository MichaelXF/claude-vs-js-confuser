'use strict';
// ---------------------------------------------------------------------------
// Structural extraction of the JS-Confuser VM runtime from an obfuscated file.
//
// Nothing here is keyed on identifier names or opcode numbers: the bootstrap
// call is found by shape, and the payload is never executed.
// ---------------------------------------------------------------------------
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const vmMod = require('vm');

function parse(code) {
  return parser.parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
}

// Find `interp(new VM(bytecode, ?, global, pool), new Fn({...}), thisArg)`.
function locateBootstrap(ast) {
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const st = body[i];
    if (st.type !== 'ExpressionStatement') continue;
    const call = st.expression;
    if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') continue;
    const a = call.arguments;
    if (a.length < 2) continue;
    if (a[0].type !== 'NewExpression' || a[0].callee.type !== 'Identifier') continue;
    if (a[1].type !== 'NewExpression' || a[1].callee.type !== 'Identifier') continue;
    if (a[1].arguments.length !== 1 || a[1].arguments[0].type !== 'ObjectExpression') continue;
    const vmArgs = a[0].arguments;
    if (!vmArgs.some(n => n.type === 'ArrayExpression')) continue;
    const idents = vmArgs.filter(n => n.type === 'Identifier');
    if (idents.length < 2) continue;
    let protoVar = null;
    for (const s of body) {
      if (s.type !== 'VariableDeclaration') continue;
      for (const d of s.declarations) {
        const ini = d.init;
        if (ini && ini.type === 'MemberExpression' && ini.object.type === 'Identifier' &&
            ini.object.name === a[0].callee.name && !ini.computed &&
            ini.property.type === 'Identifier' && ini.property.name === 'prototype') protoVar = d.id.name;
      }
    }
    return {
      index: i, statement: st, interp: call.callee.name, vmCtor: a[0].callee.name,
      fnCtor: a[1].callee.name, bytecodeVar: idents[0].name, globalVar: idents[1].name,
      poolIndex: vmArgs.findIndex(n => n.type === 'ArrayExpression'),
      vmArgs, meta: a[1].arguments[0], protoVar,
    };
  }
  return null;
}

// Evaluate the sample in an isolated context with the bootstrap call replaced by
// an export of the runtime pieces we need.
function loadRuntime(code) {
  const ast = parse(code);
  const boot = locateBootstrap(ast);
  if (!boot) return null;
  const vmCallArgs = boot.statement.expression.arguments[0].arguments;
  const props = [
    ['VM', t.identifier(boot.vmCtor)],
    ['Fn', t.identifier(boot.fnCtor)],
    ['interp', t.identifier(boot.interp)],
    ['proto', boot.protoVar
      ? t.identifier(boot.protoVar)
      : t.memberExpression(t.identifier(boot.vmCtor), t.identifier('prototype'))],
    ['bytecode', t.identifier(boot.bytecodeVar)],
    ['pool', vmCallArgs[boot.poolIndex]],
    ['meta', boot.meta],
    ['ctorArgs', t.arrayExpression(vmCallArgs.map(n =>
      (n.type === 'ArrayExpression' || n.type === 'Identifier') ? t.nullLiteral() : n))],
  ];
  ast.program.body[boot.index] = t.expressionStatement(t.assignmentExpression('=',
    t.memberExpression(t.identifier('module'), t.identifier('exports')),
    t.objectExpression(props.map(([k, v]) => t.objectProperty(t.identifier(k), v)))));

  const out = generate(ast, { compact: true }).code;
  const sandbox = {
    module: { exports: {} }, exports: {}, console,
    Math, JSON, Object, Array, String, Number, Boolean, Function, Symbol, Reflect, Proxy,
    Error, TypeError, RangeError, ReferenceError, SyntaxError, Date, RegExp, Map, Set,
    WeakMap, WeakSet, Promise, Uint8Array, Uint32Array, Int32Array, ArrayBuffer, Buffer,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {}, atob: undefined, btoa: undefined,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = undefined;
  sandbox.document = undefined;
  vmMod.createContext(sandbox);
  try {
    vmMod.runInContext(out, sandbox, { timeout: 20000, filename: 'vm-runtime.js' });
  } catch (e) {
    return null;
  }
  const M = sandbox.module.exports;
  if (!M || !M.proto || !M.bytecode) return null;
  M.info = boot;
  M.sandbox = sandbox;
  return M;
}

module.exports = { parse, locateBootstrap, loadRuntime, generate, t };
