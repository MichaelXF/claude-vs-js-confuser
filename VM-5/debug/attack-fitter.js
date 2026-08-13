/**
 * attack-fitter.js — probes the limits of vm.js's MBA fitter.
 *
 *   node debug/attack-fitter.js
 *
 * Synthetic handlers are grafted onto the *real* VM prototype (so they see the same
 * mock frame, the same operand reader and the same field names as the genuine ones)
 * and vm.js's own `fitDataOpcode` is asked to solve them.  This is the evidence behind
 * section 6 of NOTES.md: which handler shapes the oracle-fitting attack solves, which
 * ones it gives up on, and which ones it gets *confidently wrong*.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const vm = require(path.join(ROOT, 'vm.js'));

const env = vm.buildEnv(fs.readFileSync(path.join(ROOT, 'input.js'), 'utf8'));
const F = env.fields;
const BASE = env.slots.base;
const SIZE = env.frameLayout.sizeSlot;
const HDR = env.frameLayout.header;

env.currentFrameSize = HDR + 68;                 // the register count of function #1

let NEXT = 900000;
const RR = ['dst', 'reg', 'reg'];
const RRR = ['dst', 'reg', 'reg', 'reg'];
const OPS3 = [3, 1, 2];
const OPS4 = [4, 1, 2, 3];

/** install a handler whose body computes `expr` from x0/x1(/x2) and stores it in dst */
function install(expr, roles) {
  const op = NEXT++;
  const nreg = roles.filter(r => r === 'reg').length;
  const reads = [];
  for (let i = 0; i < nreg; i++) reads.push(`var x${i} = a[e + this.${F.reader}()];`);
  env.proto[op] = eval(`(function () {
    var a = this.${F.stack}, e = a[this.${F.fp} + ${BASE}];
    var f = this.${F.reader}();
    ${reads.join('\n    ')}
    var K = a[this.${F.fp} + ${SIZE}] - ${HDR};
    a[e + f] = (${expr});
  })`);
  return op;
}

function fitOf(op, roles, operands) {
  let r;
  try { r = vm.fitDataOpcode(env, { op, kind: 'expr', n: roles.length, roles }, operands); }
  catch (e) { return 'THREW ' + e.message; }
  const form = (r.form === 'binary' || r.form === 'unary') ? r.form + ' ' + r.operator : r.form;
  return form + (r.ambiguous ? ` [${r.ambiguous.length} survivors]` : '') + (r.reason ? ` (${r.reason})` : '');
}

const show = (label, expr, roles = RR, operands = OPS3) =>
  console.log('  ' + label.padEnd(42), '->', fitOf(install(expr, roles), roles, operands));

console.log('=== baseline: the shapes the sample actually uses ===');
show('(a + b) | 0', '(x0 + x1) | 0');
show('a ^ b', 'x0 ^ x1');
show('MBA-obfuscated (a + b) | 0',
  '(((x0 | x1) - (~x0 & x1)) ^ ((x1 & ~x1) | (x1 & x1))) + ((((x0 | x0) - (~x0 & x0)) & x1) << 1) ^ 0');

console.log('\n=== 6.3  fuse a constant into a two-register op ===');
show('(a + b + 12345) | 0', '(x0 + x1 + 12345) | 0');
show('(a + b) ^ 0x5a5a5a5a', '(x0 + x1) ^ 0x5a5a5a5a');

console.log('\n=== 6.3  raise the arity ===');
show('(a + b + c) | 0', '(x0 + x1 + x2) | 0', RRR, OPS4);
show('(a + b) | 0  with a dead third read', '((x0 + x1) | 0) + 0 * x2', RRR, OPS4);

console.log('\n=== 6.2  encoded value domain ===');
const ka = 0x1f2e3d4c, kb = 0x77aabbcc, kd = 0x0badf00d;
show('xor masks   ((A^ka)+(B^kb))^kd', `((((x0 ^ ${ka}) + (x1 ^ ${kb})) | 0) ^ ${kd})`);
show('xor masks   (A^B)^(ka^kb^kd)', `(x0 ^ x1 ^ ${(ka ^ kb ^ kd) | 0})`);
show('mul mask    imul(imul(A,B), Minv)', 'Math.imul(Math.imul(x0, x1), -421393541)');
show('add masks   A+B-(ka+kb-kd)', `(x0 + x1 - ${(0x111 + 0x222 - 0x555) | 0}) | 0`);
show('mul mask, ADD stays linear', '(x0 + x1) | 0');
show('add masks that happen to cancel', '((x0 - 111) + (x1 - 222) + 333) | 0');

console.log('\n=== 6.4  identities that only hold where the program goes ===');
const GRID = '[0,1,2,3,7,33,255,1000,65535,123456,-1,-7,-100,-65536,2147483647,-2147483648]';
show('garbage outside |v| < 2^20',
  '(x0 > -1048576 && x0 < 1048576 && x1 > -1048576 && x1 < 1048576) ' +
  '? (x0 + x1 | 0) : (Math.imul(x0, 2654435761) ^ x1)');
console.log('  agrees with "+" on the probe grid only    ->',
  fitOf(install(`(${GRID}.indexOf(x0) >= 0 && ${GRID}.indexOf(x1) >= 0) ? (x0 + x1 | 0) : (x0 - x1 | 0)`, RR), RR, OPS3),
  '   <-- the true function is "-" off the grid');

console.log('\n=== 6.3  break "the last register write is the result" ===');
{
  const op = NEXT++;
  env.proto[op] = eval(`(function () {
    var a = this.${F.stack}, e = a[this.${F.fp} + ${BASE}];
    var f = this.${F.reader}();
    var x0 = a[e + this.${F.reader}()], x1 = a[e + this.${F.reader}()];
    a[e + f] = (x0 + x1) | 0;                      // the real result, written first
    a[e + 63] = Math.imul(x0 ^ x1, 2654435761);    // decoy, written after
  })`);
  console.log('  dst first, decoy second'.padEnd(44), '->', fitOf(op, RR, OPS3));
}

console.log('\n=== 6.1  identity keyed on the bytecode stream (SILENT MISCOMPILATION) ===');
{
  // The fitter probes with a synthetic 4-word stream, so any word the handler reads
  // outside its own operands is present at runtime and missing during fitting.
  const W = env.code[10] | 0;
  const op = NEXT++;
  env.proto[op] = eval(`(function () {
    var a = this.${F.stack}, e = a[this.${F.fp} + ${BASE}];
    var f = this.${F.reader}();
    var x0 = a[e + this.${F.reader}()], x1 = a[e + this.${F.reader}()];
    var c = this.${F.code}[this.${F.stack}[this.${F.fp} + ${env.PC}] - 3] | 0;
    var t = ((c ^ ${W}) | -(c ^ ${W})) >> 31;      // 0 iff the context word is the real one
    a[e + f] = (x0 + ((x1 ^ t) - t)) | 0;          // (x^-1)+1 === -x   =>   a+b  or  a-b
  })`);
  const f = (c, x0, x1) => { const t = ((c ^ W) | -(c ^ W)) >> 31; return (x0 + ((x1 ^ t) - t)) | 0; };
  console.log('  real context word =', W);
  console.log('  real VM      : f(W, 5, 3) =', f(W, 5, 3), '  -> the handler is (a + b) | 0');
  console.log('  fitter sees  : f(0, 5, 3) =', f(0, 5, 3), '  -> the handler looks like (a - b) | 0');
  console.log('  vm.js emits  :', fitOf(op, RR, OPS3), '  <-- wrong, with no warning');
}

console.log('\n=== 6.5  how much does the fitter execute? ===');
{
  let calls = 0;
  global.__tick = () => { calls++; };
  const op = NEXT++;
  env.proto[op] = eval(`(function () {
    var a = this.${F.stack}, e = a[this.${F.fp} + ${BASE}];
    var f = this.${F.reader}();
    var x0 = a[e + this.${F.reader}()], x1 = a[e + this.${F.reader}()];
    __tick(); a[e + f] = (x0 + x1) | 0;
  })`);
  vm.fitDataOpcode(env, { op, kind: 'expr', n: 3, roles: RR }, OPS3);
  console.log('  handler executions per two-register fit:', calls);
  calls = 0;
  vm.fitDataOpcode(env, { op, kind: 'expr', n: 3, roles: ['dst', 'reg', 'imm'] }, [3, 1, 0x5a5a5a5a]);
  console.log('  handler executions per one-register fit:', calls);
}
