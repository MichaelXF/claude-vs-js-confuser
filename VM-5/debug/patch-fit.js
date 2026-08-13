// debug/patch-fit.js - fit with the instruction's real operands first, and fall back to a
// verbatim copy of the VM handler for MBA expressions that reduce to no JS operator
const fs = require('fs');
const path = require('path');
const p = path.resolve(__dirname, '..', 'vm.js');
let s = fs.readFileSync(p, 'utf8');

/* 1. try the real operands before canonicalising the registers.  Canonicalising can break
      the MBA identities (register numbers also seed the junk terms) and hides aliasing
      such as `r15 = f(r13, r13)`. */
const old = `  // canonical operands: give every register operand its own register
  const canon = operands.slice();
  regSlots.forEach((s, i) => { canon[s] = 900 + i; });`;
if (!s.includes(old)) throw new Error('canon block not found');
s = s.replace(old, `  // Use the instruction's own operands.  Canonicalising the register numbers can break
  // the MBA identities (the operand words also seed the junk terms) and would hide
  // aliasing such as \`r15 = f(r13, r13)\`; only fall back to canonical registers when
  // the real ones are ambiguous because two register operands are the same.
  const canon = operands.slice();
  if (opts.canonical) regSlots.forEach((s, i) => { canon[s] = 900 + i; });`);

const oldSig = 'function fitDataOpcode(env, kind, operands) {';
if (!s.includes(oldSig)) throw new Error('fitDataOpcode signature not found');
s = s.replace(oldSig, `function fitDataOpcode(env, kind, operands, opts = {}) {
  if (!opts.canonical) {
    const direct = fitDataOpcodeInner(env, kind, operands, opts);
    if (direct.form !== 'unknown') return direct;
    const regSlots0 = kind.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
    const aliased = new Set(regSlots0.map(i => operands[i])).size !== regSlots0.length;
    if (!aliased) return direct;
    const canon = fitDataOpcodeInner(env, kind, operands, { canonical: true });
    return canon.form !== 'unknown' ? canon : direct;
  }
  return fitDataOpcodeInner(env, kind, operands, opts);
}

function fitDataOpcodeInner(env, kind, operands, opts = {}) {`);

/* 2. IR + emitter for irreducible handlers */
const oldUnknown = `      } else {
        assign(o[fit.dstSlot >= 0 ? fit.dstSlot : 0], { t: 'unknown', op: ins.op, pc: ins.pc });
      }`;
if (!s.includes(oldUnknown)) throw new Error('unknown emit not found');
s = s.replace(oldUnknown, `      } else {
        // No JavaScript operator reproduces this handler (a multi-round MBA mixer).  Keep
        // the original handler verbatim behind a helper so the output still runs.
        const regSlots = ins.k.roles.map((r, i) => (r === 'reg' ? i : -1)).filter(i => i >= 0);
        assign(o[fit.dstSlot >= 0 ? fit.dstSlot : 0], {
          t: 'opaque', op: ins.op, operands: o.slice(),
          args: regSlots.map(sl => IR.reg(o[sl])),
          regSlots: regSlots.map(sl => o[sl]),
          dstReg: o[fit.dstSlot >= 0 ? fit.dstSlot : 0],
          frameSize: env.currentFrameSize,
        });
      }`);

const oldEmit = `      case 'unknown': return t.identifier('__vm_unknown_' + e.op);`;
if (!s.includes(oldEmit)) throw new Error('unknown expr emit not found');
s = s.replace(oldEmit, `      case 'unknown': return t.identifier('__vm_unknown_' + e.op);
      case 'opaque': return t.callExpression(t.identifier(helpers.opaqueHelper(e)), e.args.map(expr));`);

/* 3. helper generation in liftProgram */
const oldHelpers = `    forInHelper: () => { helperState.forIn = true; return '__vmForIn'; },`;
if (!s.includes(oldHelpers)) throw new Error('helpers object not found');
s = s.replace(oldHelpers, `    forInHelper: () => { helperState.forIn = true; return '__vmForIn'; },
    opaqueHelper: e => {
      const name = '__vmMba' + e.op + '_' + e.operands.join('_').slice(0, 40).replace(/[^0-9_]/g, '');
      if (!helperState.opaque.has(name)) helperState.opaque.set(name, buildOpaqueHelper(env, name, e));
      return name;
    },`);

const oldState = `  const helperState = { forIn: false };`;
if (!s.includes(oldState)) throw new Error('helperState not found');
s = s.replace(oldState, `  const helperState = { forIn: false, opaque: new Map() };`);

const oldPush = `  program.push(...body);
  return t.program(program);`;
if (!s.includes(oldPush)) throw new Error('program tail not found');
s = s.replace(oldPush, `  for (const decl of helperState.opaque.values()) program.push(...decl);
  program.push(...body);
  return t.program(program);`);

/* 4. the builder itself */
const anchor = 'function liftProgram(env, prog) {';
s = s.replace(anchor, `/**
 * Wrap a VM handler that could not be reduced to a JavaScript operator.  The handler is a
 * pure function of one or two registers, so it is emitted verbatim behind a shim that
 * feeds it the same operands and frame that the VM would have.
 */
function buildOpaqueHelper(env, name, e) {
  const F = env.fields;
  const B = 64;                                   // register base used inside the shim
  const params = e.regSlots.map((_, i) => 'x' + i);
  const setup = e.regSlots.map((r, i) => \`  st.\${F.stack}[\${B} + \${r}] = x\${i};\`).join('\\n');
  const src = Function.prototype.toString.call(env.proto[e.op]);
  const code = \`
function \${name}(\${params.join(', ')}) {
  var st = {};
  st.\${F.stack} = [];
  st.\${F.fp} = 0;
  st.\${F.stack}[\${env.slots.base}] = \${B};
  st.\${F.stack}[\${env.frameLayout.sizeSlot}] = \${e.frameSize};
\${setup}
  var __ops = \${JSON.stringify(e.operands)}, __k = 0;
  st.\${F.reader} = function () { return __ops[__k++]; };
  (\${src}).call(st);
  return st.\${F.stack}[\${B} + \${e.dstReg}];
}\`;
  const body = parseSource(code).program.body;
  t.addComment(body[0], 'leading',
    ' vm.js: opcode ' + e.op + ' is an MBA expression with no JavaScript equivalent;\\n' +
    '   the original VM handler is kept verbatim so that behaviour is preserved ');
  return body;
}

` + anchor);

fs.writeFileSync(p, s);
console.log('patched vm.js (fitting + opaque helpers)');
