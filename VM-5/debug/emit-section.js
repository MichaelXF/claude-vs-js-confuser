/* ------------------------------------------------------------------ *
 * IR -> JavaScript
 * ------------------------------------------------------------------ */

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public', 'null', 'true', 'false']);

function varPrefix(id) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return id < 26 ? letters[id] : letters[id % 26] + Math.floor(id / 26);
}

function literalNode(v) {
  if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
  if (v === null) return t.nullLiteral();
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return t.identifier('NaN');
    if (v === Infinity) return t.identifier('Infinity');
    if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
    return v < 0 || Object.is(v, -0) ? t.unaryExpression('-', t.numericLiteral(Math.abs(v))) : t.numericLiteral(v);
  }
  if (Array.isArray(v)) return t.arrayExpression(v.map(literalNode));
  if (typeof v === 'object') {
    return t.objectExpression(Object.keys(v).map(kk => t.objectProperty(
      IDENT_RE.test(kk) && !RESERVED.has(kk) ? t.identifier(kk) : t.stringLiteral(kk), literalNode(v[kk]))));
  }
  return t.identifier('undefined');
}

const INT_OPS = { '+|0': '+', '-|0': '-' };

function makeEmitter(env, prog, fnInfo, helpers) {
  const prefix = varPrefix(fnInfo.id);
  const used = new Set();
  const regName = i => { used.add(i); return prefix + i; };

  const ownerOfUpvalue = (fn, index) => {
    // resolve upvalue `index` of `fn` to the (function, register) that really owns it
    let cur = fn, idx = index;
    while (cur && cur.upvals && cur.upvals[idx]) {
      const uv = cur.upvals[idx];
      if (uv.local) return { fn: cur.parent, reg: uv.index };
      cur = cur.parent; idx = uv.index;
    }
    return null;
  };

  const expr = e => {
    switch (e.t) {
      case 'reg': return t.identifier(regName(e.i));
      case 'lit': return literalNode(e.v);
      case 'this': return fnInfo.main ? t.identifier('undefined') : t.thisExpression();
      case 'bin': {
        if (e.op === '*|0') return t.callExpression(t.memberExpression(t.identifier('Math'), t.identifier('imul')), [expr(e.l), expr(e.r)]);
        if (INT_OPS[e.op]) return t.binaryExpression('|', t.binaryExpression(INT_OPS[e.op], expr(e.l), expr(e.r)), t.numericLiteral(0));
        return t.binaryExpression(e.op, expr(e.l), expr(e.r));
      }
      case 'un': {
        if (e.op === '!!') return t.unaryExpression('!', t.unaryExpression('!', expr(e.a)));
        if (e.op === '|0') return t.binaryExpression('|', expr(e.a), t.numericLiteral(0));
        if (e.op === '>>>0') return t.binaryExpression('>>>', expr(e.a), t.numericLiteral(0));
        return t.unaryExpression(e.op, expr(e.a));
      }
      case 'member': {
        const key = e.key;
        if (key.t === 'lit' && typeof key.v === 'string' && IDENT_RE.test(key.v) && !RESERVED.has(key.v)) {
          return t.memberExpression(expr(e.obj), t.identifier(key.v));
        }
        return t.memberExpression(expr(e.obj), expr(key), true);
      }
      case 'global': return IDENT_RE.test(e.name) && !RESERVED.has(e.name)
        ? t.identifier(e.name)
        : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(e.name), true);
      case 'typeofglobal': return t.unaryExpression('typeof', IDENT_RE.test(e.name) && !RESERVED.has(e.name)
        ? t.identifier(e.name)
        : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(e.name), true));
      case 'array': return t.arrayExpression(e.els.map(expr));
      case 'object': return t.objectExpression(e.props.map(p => {
        if (p.key.t === 'lit' && typeof p.key.v === 'string' && IDENT_RE.test(p.key.v) && !RESERVED.has(p.key.v)) {
          return t.objectProperty(t.identifier(p.key.v), expr(p.value));
        }
        if (p.key.t === 'lit' && (typeof p.key.v === 'string' || typeof p.key.v === 'number')) {
          return t.objectProperty(literalNode(p.key.v), expr(p.value));
        }
        return t.objectProperty(expr(p.key), expr(p.value), true);
      }));
      case 'delete': {
        const m = expr({ t: 'member', obj: e.obj, key: e.key });
        return t.unaryExpression('delete', m);
      }
      case 'call': {
        const args = e.spread ? [t.spreadElement(expr(e.args[0]))] : e.args.map(expr);
        if (e.isNew) return t.newExpression(expr(e.callee), args);
        if (e.thisArg) {
          const callee = e.callee, thisArg = e.thisArg;
          // `obj.m(...)` when the callee is a member expression of the same object
          if (callee.t === 'member' && sameIR(callee.obj, thisArg)) return t.callExpression(expr(callee), args);
          if (callee.t === 'reg' && thisArg.t === 'reg' && callee.i === thisArg.i) return t.callExpression(expr(callee), args);
          const call = t.memberExpression(expr(callee), t.identifier(e.spread ? 'apply' : 'call'));
          return t.callExpression(call, e.spread
            ? [expr(thisArg), expr(e.args[0])]
            : [expr(thisArg), ...args]);
        }
        return t.callExpression(expr(e.callee), args);
      }
      case 'func': return helpers.functionExpression(e.ref);
      case 'closure': {
        const owner = ownerOfUpvalue(fnInfo, e.index);
        if (!owner || !owner.fn) return t.identifier('undefined');
        return t.identifier(varPrefix(owner.fn.id) + owner.reg);
      }
      case 'forinkeys': return t.callExpression(t.identifier(helpers.forInHelper()), [expr(e.obj)]);
      case 'forinnext': return t.callExpression(t.memberExpression(expr(e.iter), t.identifier('next')), []);
      case 'unknown': return t.identifier('__vm_unknown_' + e.op);
      default: throw new Error('cannot emit expression ' + e.t);
    }
  };

  const statement = s => {
    switch (s.kind) {
      case 'assign': return t.expressionStatement(t.assignmentExpression('=', t.identifier(regName(s.dst)), expr(s.expr)));
      case 'effect': {
        const e = s.expr;
        if (e.t === 'setglobal') {
          const target = IDENT_RE.test(e.name) && !RESERVED.has(e.name)
            ? t.identifier(e.name)
            : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(e.name), true);
          return t.expressionStatement(t.assignmentExpression('=', target, expr(e.value)));
        }
        if (e.t === 'setmember') {
          return t.expressionStatement(t.assignmentExpression('=', expr({ t: 'member', obj: e.obj, key: e.key }), expr(e.value)));
        }
        if (e.t === 'setclosure') {
          const owner = ownerOfUpvalue(fnInfo, e.index);
          const target = owner && owner.fn ? t.identifier(varPrefix(owner.fn.id) + owner.reg) : t.identifier('__vm_upvalue');
          return t.expressionStatement(t.assignmentExpression('=', target, expr(e.value)));
        }
        if (e.t === 'defineaccessor') {
          return t.expressionStatement(t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
            [expr(e.obj), expr(e.key), t.objectExpression([
              t.objectProperty(t.identifier(e.accessor), expr(e.value)),
              t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
              t.objectProperty(t.identifier('enumerable'), t.booleanLiteral(true)),
            ])]));
        }
        return t.expressionStatement(expr(e));
      }
      case 'ret': return t.returnStatement(expr(s.expr));
      case 'throw': return t.throwStatement(expr(s.expr));
      case 'debugger': return t.debuggerStatement();
      case 'comment': {
        const st = t.emptyStatement();
        t.addComment(st, 'leading', ' ' + s.text + ' ');
        return st;
      }
      case 'push_try': case 'pop_try': return null;
      default: throw new Error('cannot emit statement ' + s.kind);
    }
  };

  return { expr, statement, regName, used, prefix };
}

function sameIR(a, b) {
  if (!a || !b) return false;
  if (a.t !== b.t) return false;
  if (a.t === 'reg') return a.i === b.i;
  if (a.t === 'lit') return sameValue(a.v, b.v);
  return false;
}

/* ------------------------------------------------------------------ *
 * Optimisation passes on the IR (dead code + expression re-nesting)
 * ------------------------------------------------------------------ */

function computeLiveness(bbs, capturedRegs) {
  const use = new Map(), def = new Map(), liveOut = new Map(), liveIn = new Map();
  for (const [id, bb] of bbs) {
    const u = new Set(), d = new Set();
    for (const s of bb.ir) {
      for (const r of statementReads(s)) if (!d.has(r)) u.add(r);
      if (s.kind === 'assign') d.add(s.dst);
    }
    if (bb.term && bb.term.test) for (const r of irUsesRegisters(bb.term.test)) if (!d.has(r)) u.add(r);
    use.set(id, u); def.set(id, d);
    liveOut.set(id, new Set()); liveIn.set(id, new Set());
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, bb] of bbs) {
      const out = new Set();
      for (const s of bb.succ) if (liveIn.has(s)) for (const r of liveIn.get(s)) out.add(r);
      for (const r of capturedRegs) out.add(r);
      const inn = new Set(out);
      for (const r of def.get(id)) inn.delete(r);
      for (const r of use.get(id)) inn.add(r);
      if (inn.size !== liveIn.get(id).size || [...inn].some(r => !liveIn.get(id).has(r))) { liveIn.set(id, inn); changed = true; }
      liveOut.set(id, out);
    }
  }
  return { liveIn, liveOut };
}

function statementReads(s) {
  const out = [];
  if (s.expr) irUsesRegisters(s.expr, out);
  return out;
}

function optimiseBlock(bb, liveOut, capturedRegs) {
  // 1. dead store elimination
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const live = new Set(liveOut);
    const keep = new Array(bb.ir.length).fill(true);
    if (bb.term && bb.term.test) for (const r of irUsesRegisters(bb.term.test)) live.add(r);
    for (let i = bb.ir.length - 1; i >= 0; i--) {
      const s = bb.ir[i];
      if (s.kind === 'assign' && !live.has(s.dst) && !capturedRegs.has(s.dst) && irIsPure(s.expr)) {
        keep[i] = false; changed = true; continue;
      }
      if (s.kind === 'assign') live.delete(s.dst);
      for (const r of statementReads(s)) live.add(r);
    }
    bb.ir = bb.ir.filter((_, i) => keep[i]);
    if (!changed) break;
  }

  // 2. inline single-use temporaries so expressions nest again
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let i = 0; i < bb.ir.length; i++) {
      const s = bb.ir[i];
      if (s.kind !== 'assign' || capturedRegs.has(s.dst)) continue;
      if (liveOut.has(s.dst)) continue;
      // find the next use
      let useIdx = -1, uses = 0, redefined = false;
      for (let j = i + 1; j < bb.ir.length; j++) {
        const rs = bb.ir[j];
        const reads = statementReads(rs).filter(r => r === s.dst).length;
        if (reads) { if (useIdx < 0) useIdx = j; uses += reads; }
        if (rs.kind === 'assign' && rs.dst === s.dst) { redefined = true; break; }
      }
      if (useIdx < 0) continue;
      let termUses = 0;
      if (!redefined && bb.term && bb.term.test) termUses = irUsesRegisters(bb.term.test).filter(r => r === s.dst).length;
      if (uses + termUses !== 1) continue;
      if (!redefined && termUses === 0 && !isLastUseSafe(bb, s.dst, useIdx)) continue;
      // moving the expression across the statements in between must be safe
      const pure = irIsPure(s.expr);
      if (!pure && useIdx !== i + 1) continue;
      const readsOfExpr = new Set(irUsesRegisters(s.expr));
      let safe = true;
      for (let j = i + 1; j < useIdx; j++) {
        const mid = bb.ir[j];
        if (mid.kind === 'assign' && readsOfExpr.has(mid.dst)) { safe = false; break; }
        if (!irIsPure(mid.expr) && !pure) { safe = false; break; }
        if (!irIsPure(mid.expr) && readsOfExpr.size) { safe = false; break; }
      }
      if (!safe) continue;
      if (termUses === 1) {
        bb.term.test = substituteReg(bb.term.test, s.dst, s.expr);
      } else {
        bb.ir[useIdx] = substituteStatement(bb.ir[useIdx], s.dst, s.expr);
      }
      bb.ir.splice(i, 1);
      i--;
      changed = true;
    }
    if (!changed) break;
  }
}

function isLastUseSafe() { return true; }

function substituteReg(e, reg, repl) {
  if (!e || typeof e !== 'object') return e;
  if (e.t === 'reg' && e.i === reg) return repl;
  const out = Array.isArray(e) ? [] : {};
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (Array.isArray(v)) out[k] = v.map(x => substituteReg(x, reg, repl));
    else if (v && typeof v === 'object' && v.t) out[k] = substituteReg(v, reg, repl);
    else out[k] = v;
  }
  return out;
}

function substituteStatement(s, reg, repl) {
  const out = { ...s };
  if (s.expr) out.expr = substituteReg(s.expr, reg, repl);
  return out;
}
