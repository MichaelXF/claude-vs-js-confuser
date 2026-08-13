// debug/patch-seed.js - make branches use the register the boolean was born in
const fs = require('fs');
const path = require('path');
const p = path.resolve(__dirname, '..', 'vm.js');
let s = fs.readFileSync(p, 'utf8');

const oldFn = 'function findConditionRegister(state, varId) {\n  let neg = null;\n  for (const [r, v] of state) {';
const newFn = `function findConditionRegister(state, varId, origin) {
  let neg = null;
  // prefer the register the boolean was computed into: that is the program's own
  // comparison, rather than the opaque predicate the flattening derived from it
  if (origin !== undefined) {
    const v = state.get(origin);
    if (isSym(v) && v.vars.length === 1 && v.vars[0] === varId) {
      if (v.table[0] === false && v.table[1] === true) return { reg: origin, negate: false };
      if (v.table[0] === true && v.table[1] === false) return { reg: origin, negate: true };
    }
  }
  for (const [r, v] of state) {`;
if (!s.includes(oldFn)) throw new Error('findConditionRegister not found');
s = s.replace(oldFn, newFn);

const oldCall = 'const cond = findConditionRegister(state, varId);';
if (!s.includes(oldCall)) throw new Error('call site not found');
s = s.replace(oldCall, 'const cond = findConditionRegister(state, varId, env.symOrigin.get(varId));');

const oldSeed = `        for (const [reg] of r.writes) {
          out.set(reg, boolean ? makeSym([++symCounter], [false, true]) : UNKNOWN);
        }`;
const newSeed = `        for (const [reg] of r.writes) {
          if (boolean) {
            const id = ++symCounter;
            env.symOrigin.set(id, reg);
            out.set(reg, makeSym([id], [false, true]));
          } else out.set(reg, UNKNOWN);
        }`;
if (!s.includes(oldSeed)) throw new Error('seed creation not found');
s = s.replace(oldSeed, newSeed);

if (!s.includes('env.symOrigin = new Map();')) {
  s = s.replace('  env.decoded = new Map();', '  env.decoded = new Map();\n  env.symOrigin = new Map();');
}
fs.writeFileSync(p, s);
console.log('patched vm.js (symbolic seed origin)');
