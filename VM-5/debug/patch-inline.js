// debug/patch-inline.js - allow duplicable values (literals, globals) to be inlined into
// every use, and recognise `obj.method(...)` for global objects
const fs = require('fs');
const path = require('path');
const p = path.resolve(__dirname, '..', 'vm.js');
let s = fs.readFileSync(p, 'utf8');

/* 1. sameIR: compare globals and member chains too, so `Math.floor.call(Math, x)`
      collapses back to `Math.floor(x)` */
const oldSame = `function sameIR(a, b) {
  if (!a || !b) return false;
  if (a.t !== b.t) return false;
  if (a.t === 'reg') return a.i === b.i;
  if (a.t === 'lit') return sameValue(a.v, b.v);
  return false;
}`;
if (!s.includes(oldSame)) throw new Error('sameIR not found');
s = s.replace(oldSame, `function sameIR(a, b) {
  if (!a || !b) return false;
  if (a.t !== b.t) return false;
  if (a.t === 'reg') return a.i === b.i;
  if (a.t === 'lit') return sameValue(a.v, b.v);
  if (a.t === 'global' || a.t === 'typeofglobal') return a.name === b.name;
  if (a.t === 'this') return true;
  if (a.t === 'member') return sameIR(a.obj, b.obj) && sameIR(a.key, b.key);
  return false;
}`);

/* 2. inline duplicable expressions into every use */
const oldInline = `      let termUses = 0;
      if (!redefined && bb.term && bb.term.test) termUses = irUsesRegisters(bb.term.test).filter(r => r === s.dst).length;
      if (uses + termUses !== 1) continue;`;
if (!s.includes(oldInline)) throw new Error('inline guard not found');
s = s.replace(oldInline, `      let termUses = 0;
      if (!redefined && bb.term && bb.term.test) termUses = irUsesRegisters(bb.term.test).filter(r => r === s.dst).length;
      // a literal / global / plain register can be duplicated into every use: it has no
      // cost and no side effects, and it is what turns \`x = document; x.body\` back into
      // \`document.body\`
      const duplicable = DUPLICABLE.has(s.expr.t);
      if (!duplicable && uses + termUses !== 1) continue;
      if (duplicable && uses + termUses === 0) continue;`);

const oldPure = `      const pure = irIsPure(s.expr);
      const targetIdx = uses ? useIdx : -1;
      if (!pure && targetIdx !== i + 1 && !(uses === 0 && termUses === 1 && i === bb.ir.length - 1)) continue;
      const readsOfExpr = new Set(irUsesRegisters(s.expr));
      let safe = true;
      const stopIdx = uses ? useIdx : bb.ir.length;
      for (let j = i + 1; j < stopIdx; j++) {
        const mid = bb.ir[j];
        if (mid.kind === 'assign' && readsOfExpr.has(mid.dst)) { safe = false; break; }
        if (!irIsPure(mid.expr)) { safe = false; break; }
      }
      if (!safe) continue;
      if (uses) bb.ir[useIdx] = substituteStatement(bb.ir[useIdx], s.dst, s.expr);
      else bb.term.test = substituteReg(bb.term.test, s.dst, s.expr);
      bb.ir.splice(i, 1);`;
if (!s.includes(oldPure)) throw new Error('inline body not found');
s = s.replace(oldPure, `      const pure = irIsPure(s.expr);
      const targetIdx = uses ? useIdx : -1;
      if (!duplicable && !pure && targetIdx !== i + 1 && !(uses === 0 && termUses === 1 && i === bb.ir.length - 1)) continue;
      const readsOfExpr = new Set(irUsesRegisters(s.expr));
      // find the last statement the value has to travel to
      let lastUse = -1;
      for (let j = i + 1; j < bb.ir.length; j++) {
        const rs = bb.ir[j];
        if (statementReads(rs).some(r => r === s.dst)) lastUse = j;
        if (rs.kind === 'assign' && rs.dst === s.dst) break;
      }
      let safe = true;
      const stopIdx = duplicable ? (lastUse < 0 ? bb.ir.length : lastUse) : (uses ? useIdx : bb.ir.length);
      for (let j = i + 1; j < stopIdx; j++) {
        const mid = bb.ir[j];
        if (mid.kind === 'assign' && readsOfExpr.has(mid.dst)) { safe = false; break; }
        if (!duplicable && !irIsPure(mid.expr)) { safe = false; break; }
        if (duplicable && s.expr.t === 'global' && !irIsPure(mid.expr) && mid.kind === 'effect' &&
            mid.expr && mid.expr.t === 'setglobal') { safe = false; break; }
      }
      if (!safe) continue;
      if (duplicable) {
        for (let j = i + 1; j < bb.ir.length; j++) {
          const rs = bb.ir[j];
          if (statementReads(rs).some(r => r === s.dst)) bb.ir[j] = substituteStatement(rs, s.dst, s.expr);
          if (rs.kind === 'assign' && rs.dst === s.dst) break;
        }
        if (termUses) bb.term.test = substituteReg(bb.term.test, s.dst, s.expr);
      } else if (uses) bb.ir[useIdx] = substituteStatement(bb.ir[useIdx], s.dst, s.expr);
      else bb.term.test = substituteReg(bb.term.test, s.dst, s.expr);
      bb.ir.splice(i, 1);`);

/* 3. the duplicable set */
if (!s.includes('const DUPLICABLE')) {
  s = s.replace("const PURE_EXPR = new Set([", "const DUPLICABLE = new Set(['lit', 'global', 'reg', 'this', 'typeofglobal']);\nconst PURE_EXPR = new Set([");
}
fs.writeFileSync(p, s);
console.log('patched vm.js (duplicable inlining)');
