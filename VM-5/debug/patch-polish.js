// debug/patch-polish.js - method-call normalisation, dead-value calls as statements,
// `return;` instead of `return void 0`, and no top-level return
const fs = require('fs');
const path = require('path');
const p = path.resolve(__dirname, '..', 'vm.js');
let s = fs.readFileSync(p, 'utf8');

/* 1. `f.call(obj, ...)` where f is obj.m  ->  obj.m(...)  (drops the duplicate use of obj) */
if (!s.includes('function normalizeCalls')) {
  const anchor = 'function irUsesRegisters(e, out = []) {';
  s = s.replace(anchor, `/**
 * Once the member expression has been re-nested into the callee, a method call mentions
 * its object twice (as \`this\` and inside the callee).  Dropping the redundant \`this\`
 * lets the object expression itself be inlined.
 */
function normalizeCalls(node) {
  if (!node || typeof node !== 'object') return node;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(normalizeCalls);
    else if (v && typeof v === 'object' && v.t) normalizeCalls(v);
  }
  if (node.t === 'call' && node.thisArg && node.callee && node.callee.t === 'member' &&
      sameIR(node.callee.obj, node.thisArg)) {
    node.thisArg = null;
  }
  return node;
}

` + anchor);
}

/* 2. run it before each inlining pass */
const oldLoop = `function inlineTemporaries(bb, liveOut, capturedRegs) {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;`;
if (!s.includes(oldLoop)) throw new Error('inlineTemporaries not found');
s = s.replace(oldLoop, `function inlineTemporaries(bb, liveOut, capturedRegs) {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const st of bb.ir) if (st.expr) normalizeCalls(st.expr);
    if (bb.term && bb.term.test) normalizeCalls(bb.term.test);`);

/* 3. an assignment whose destination is dead but whose value is not becomes a statement */
const oldDce = `      if (s.kind === 'assign' && !live.has(s.dst) && !capturedRegs.has(s.dst) && irIsPure(s.expr)) {
        keep[i] = false; changed = true; continue;
      }`;
if (!s.includes(oldDce)) throw new Error('dce guard not found');
s = s.replace(oldDce, `      if (s.kind === 'assign' && !live.has(s.dst) && !capturedRegs.has(s.dst)) {
        if (irIsPure(s.expr)) { keep[i] = false; changed = true; continue; }
        if (s.expr.t === 'call') { bb.ir[i] = { kind: 'effect', expr: s.expr, pc: s.pc }; changed = true; }
      }`);

/* 4. `return void 0;` -> `return;` */
const oldRet = `      case 'ret': return t.returnStatement(expr(s.expr));`;
if (!s.includes(oldRet)) throw new Error('ret emit not found');
s = s.replace(oldRet, `      case 'ret': {
        const v = s.expr;
        if (v && v.t === 'lit' && v.v === undefined) return t.returnStatement(null);
        return t.returnStatement(expr(v));
      }`);

/* 5. the program body must not end in a top-level return */
const oldProg = `  program.push(...main.body);
  return t.program(program);`;
if (!s.includes(oldProg)) throw new Error('liftProgram tail not found');
s = s.replace(oldProg, `  let body = main.body;
  // a trailing \`return undefined\` is how the VM's main function ends; at program level
  // that is not valid JavaScript, so drop it (or wrap the body when a real return remains)
  while (body.length && t.isReturnStatement(body[body.length - 1]) && !body[body.length - 1].argument) {
    body = body.slice(0, -1);
  }
  const hasReturn = body.some(function walk(n) {
    if (!n || typeof n !== 'object') return false;
    if (t.isReturnStatement(n)) return true;
    if (t.isFunction(n)) return false;
    return Object.keys(n).some(k => {
      const v = n[k];
      if (Array.isArray(v)) return v.some(walk);
      return v && typeof v === 'object' && v.type ? walk(v) : false;
    });
  });
  if (hasReturn) {
    body = [t.expressionStatement(t.callExpression(
      t.functionExpression(null, [], t.blockStatement(body)), []))];
  }
  program.push(...body);
  return t.program(program);`);

fs.writeFileSync(p, s);
console.log('patched vm.js (polish)');
