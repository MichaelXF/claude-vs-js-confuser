'use strict';
// ---------------------------------------------------------------------------
// IR -> JavaScript AST.
// ---------------------------------------------------------------------------
const t = require('@babel/types');
const { mergeChains, dce, structureGraph, usesOf, defOf, succNodes, recomputePreds, introduceTemps, liveness } = require('./lib-emit.js');

const VIRT_BASE = 100000;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public', 'null', 'true', 'false']);

function literal(v) {
  if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
  if (v === null) return t.nullLiteral();
  switch (typeof v) {
    case 'string': return t.stringLiteral(v);
    case 'boolean': return t.booleanLiteral(v);
    case 'number':
      if (Number.isNaN(v)) return t.identifier('NaN');
      if (v === Infinity) return t.identifier('Infinity');
      if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
      return v < 0 || Object.is(v, -0)
        ? t.unaryExpression('-', t.numericLiteral(Math.abs(v)))
        : t.numericLiteral(v);
    default: return t.identifier('undefined');
  }
}

function memberOf(objExpr, key, names) {
  if (key.reg !== undefined) return t.memberExpression(objExpr, names.reg(key.reg), true);
  const k = key.lit;
  if (IDENT.test(k) && !RESERVED.has(k)) return t.memberExpression(objExpr, t.identifier(k));
  return t.memberExpression(objExpr, t.stringLiteral(k), true);
}

// --- per-node readability passes ------------------------------------------
// `t = obj.m; t.call(obj, ...)`  ->  `obj.m(...)`
function fuseMethodCalls(node, useCount) {
  const out = [];
  for (let i = 0; i < node.stmts.length; i++) {
    const s = node.stmts[i];
    const n = node.stmts[i + 1];
    if (s && n && s.kind === 'getprop' && n.kind === 'mcall' &&
        n.callee === s.dst && n.thisReg === s.obj && (useCount.get(s.dst) || 0) === 1) {
      out.push(Object.assign({}, n, { member: { obj: s.obj, key: s.key } }));
      i++;
      continue;
    }
    out.push(s);
  }
  node.stmts = out;
}

function countUses(nodes) {
  const counts = new Map();
  for (const n of nodes) {
    for (const s of n.stmts) for (const r of usesOf(s)) counts.set(r, (counts.get(r) || 0) + 1);
    const tm = n.term;
    if (tm && tm.type === 'if') counts.set(tm.cond.reg, (counts.get(tm.cond.reg) || 0) + 1);
    if (tm && (tm.type === 'ret' || tm.type === 'throw') && tm.value != null) {
      counts.set(tm.value, (counts.get(tm.value) || 0) + 1);
    }
  }
  return counts;
}

// --- codegen ---------------------------------------------------------------
function buildFunctions(M, R, pevals, opts) {
  const names = new Map(); // fnId -> Map(reg -> name)
  const upNames = new Map(); // fnId -> [name]
  for (const fn of R.functions) names.set(fn.id, new Map());

  for (const fn of R.functions) {
    const list = [];
    for (let i = 0; i < (fn.upvals || []).length; i++) {
      const d = fn.upvals[i];
      if (d && d.own !== undefined) {
        const pm = names.get(fn.parent);
        let nm = pm.get(d.own);
        if (!nm) { nm = 'c' + fn.id + '_' + i; pm.set(d.own, nm); }
        list.push(nm);
      } else if (d && d.up !== undefined) {
        const pu = upNames.get(fn.parent) || [];
        list.push(pu[d.up] || ('c' + fn.id + '_' + i));
      } else list.push('c' + fn.id + '_' + i);
    }
    upNames.set(fn.id, list);
  }

  const tempOrigin = new Map();
  const tempSeq = new Map();

  function nameOf(fn, reg) {
    const m = names.get(fn.id);
    if (m.has(reg)) return m.get(reg);
    let nm;
    if (reg >= VIRT_BASE) {
      const orig = (tempOrigin.get(fn.id) || new Map()).get(reg);
      const key = fn.id + ':' + orig;
      const seq = (tempSeq.get(key) || 0) + 1;
      tempSeq.set(key, seq);
      nm = orig === undefined ? 't' + (reg - VIRT_BASE) : 'v' + orig + '_' + seq;
    } else nm = reg < fn.nparams ? 'p' + reg : 'v' + reg;
    m.set(reg, nm);
    return nm;
  }

  const built = new Map();
  const warnings = [];
  const helpers = new Set();

  function buildFn(fn) {
    if (built.has(fn.id)) return built.get(fn.id);
    const P = pevals.get(fn.id);
    const pinned = new Set((function collect() {
      const s = [];
      for (const other of R.functions) {
        if (other.parent === fn.id) for (const d of other.upvals || []) if (d && d.own !== undefined) s.push(d.own);
      }
      return s;
    })());
    mergeChains(P.entry);
    dce(P.entry, pinned);
    mergeChains(P.entry);
    const { origin } = introduceTemps(P.entry, pinned, VIRT_BASE);
    tempOrigin.set(fn.id, origin);
    dce(P.entry, pinned);
    const nodes = mergeChains(P.entry);
    const entryLive = liveness(P.entry, pinned).liveIn.get(P.entry) || new Set();
    const counts = countUses(nodes);
    for (const n of nodes) fuseMethodCalls(n, counts);

    const used = new Set();
    const ctxNames = {
      reg(r) { used.add(r); return t.identifier(nameOf(fn, r)); },
      stmt(s) { return stmtToAst(fn, s, ctxNames, warnings); },
      excName() { return '__exc'; },
      assignExc(r) {
        used.add(r);
        return t.expressionStatement(t.assignmentExpression('=', t.identifier(nameOf(fn, r)), t.identifier('__exc')));
      },
      assignConst(r, v) {
        used.add(r);
        return t.expressionStatement(t.assignmentExpression('=', t.identifier(nameOf(fn, r)), literal(v)));
      },
    };
    const { body, failed } = structureGraph(P.entry, ctxNames);
    if (failed) warnings.push('function ' + fn.id + ': control flow could not be fully structured');

    // declarations
    const decls = [];
    const argReg = fn.nparams;
    for (const r of [...used].sort((a, b) => a - b)) {
      if (r < fn.nparams) continue;
      if (r >= VIRT_BASE) { decls.push(t.variableDeclarator(t.identifier(nameOf(fn, r)))); continue; }
      if (r === argReg && !fn.rest && entryLive.has(r)) {
        // the register the VM fills with the argument list
        decls.push(t.variableDeclarator(t.identifier(nameOf(fn, r)),
          t.callExpression(t.memberExpression(t.memberExpression(t.memberExpression(
            t.identifier('Array'), t.identifier('prototype')), t.identifier('slice')), t.identifier('call')),
          [t.identifier('arguments')])));
      } else decls.push(t.variableDeclarator(t.identifier(nameOf(fn, r))));
    }
    for (const r of pinned) {
      if (!used.has(r) && r >= fn.nparams) decls.push(t.variableDeclarator(t.identifier(nameOf(fn, r))));
    }
    const stmts = decls.length ? [t.variableDeclaration('var', decls), ...body] : body;
    const params = [];
    const np = fn.rest ? fn.nparams - 1 : fn.nparams;
    for (let i = 0; i < np; i++) params.push(t.identifier(nameOf(fn, i)));
    if (fn.rest) params.push(t.restElement(t.identifier(nameOf(fn, fn.nparams - 1))));
    const res = { params, body: stmts, fn };
    built.set(fn.id, res);
    return res;
  }

  function stmtToAst(fn, s, names2, warn) {
    const R_ = (r) => names2.reg(r);
    const assign = (dst, expr) => t.expressionStatement(t.assignmentExpression('=', R_(dst), expr));
    switch (s.kind) {
      case 'const': return assign(s.dst, literal(s.value));
      case 'select': {
        let c = R_(s.cond.reg);
        if (s.cond.neg) c = t.unaryExpression('!', c);
        return assign(s.dst, t.conditionalExpression(c, literal(s.t), literal(s.f)));
      }
      case 'mov': return assign(s.dst, R_(s.src));
      case 'bin':
        if (s.operator === 'imul') {
          return assign(s.dst, t.callExpression(t.memberExpression(t.identifier('Math'), t.identifier('imul')), [R_(s.a), R_(s.b)]));
        }
        return assign(s.dst, t.binaryExpression(s.operator, R_(s.a), R_(s.b)));
      case 'binimm': {
        if (s.operator === 'imul') {
          return assign(s.dst, t.callExpression(t.memberExpression(t.identifier('Math'), t.identifier('imul')), [R_(s.a), literal(s.imm | 0)]));
        }
        const imm = literal(s.imm > 0x7fffffff ? (s.imm | 0) : s.imm);
        return assign(s.dst, s.immFirst
          ? t.binaryExpression(s.operator, imm, R_(s.a))
          : t.binaryExpression(s.operator, R_(s.a), imm));
      }
      case 'un':
        if (s.operator === 'id') return assign(s.dst, R_(s.src));
        return assign(s.dst, t.unaryExpression(s.operator, R_(s.src)));
      case 'this': return assign(s.dst, t.thisExpression());
      case 'getglobal': return assign(s.dst, t.identifier(s.name));
      case 'setglobal': return t.expressionStatement(t.assignmentExpression('=', t.identifier(s.name), R_(s.src)));
      case 'typeofglobal': return assign(s.dst, t.unaryExpression('typeof', t.identifier(s.name)));
      case 'getprop': return assign(s.dst, memberOf(R_(s.obj), s.key, names2));
      case 'setprop': return t.expressionStatement(t.assignmentExpression('=', memberOf(R_(s.obj), s.key, names2), R_(s.src)));
      case 'delete': return assign(s.dst, t.unaryExpression('delete', memberOf(R_(s.obj), s.key, names2)));
      case 'array': return assign(s.dst, t.arrayExpression(s.items.map(R_)));
      case 'object': return assign(s.dst, t.objectExpression(s.pairs.map(([k, v]) => {
        if (k && k.reg !== undefined) return t.objectProperty(R_(k.reg), R_(v), true);
        const name = k && k.lit !== undefined ? k.lit : String(k);
        return t.objectProperty(IDENT.test(name) && !RESERVED.has(name) ? t.identifier(name) : t.stringLiteral(name), R_(v));
      })));
      case 'call': {
        const args = s.spread ? [t.spreadElement(R_(s.args[0]))] : s.args.map(R_);
        return assign(s.dst, t.callExpression(R_(s.callee), args));
      }
      case 'mcall': {
        const args = s.spread ? [t.spreadElement(R_(s.args[0]))] : s.args.map(R_);
        if (s.member) return assign(s.dst, t.callExpression(memberOf(R_(s.member.obj), s.member.key, names2), args));
        return assign(s.dst, t.callExpression(t.memberExpression(R_(s.callee), t.identifier('call')), [R_(s.thisReg), ...args]));
      }
      case 'new': {
        const args = s.spread ? [t.spreadElement(R_(s.args[0]))] : s.args.map(R_);
        return assign(s.dst, t.newExpression(R_(s.callee), args));
      }
      case 'closure': {
        const child = R.functions[s.target];
        const b = buildFn(child);
        return assign(s.dst, t.functionExpression(null, b.params, t.blockStatement(b.body)));
      }
      case 'getupval': return assign(s.dst, t.identifier(upNames.get(fn.id)[s.idx]));
      case 'setupval': return t.expressionStatement(t.assignmentExpression('=',
        t.identifier(upNames.get(fn.id)[s.idx]), R_(s.src)));
      case 'forin':
        helpers.add('forin');
        return assign(s.dst, t.callExpression(t.identifier('__forInKeys'), [R_(s.obj)]));
      case 'forinnext':
        helpers.add('forin');
        return assign(s.dst, t.callExpression(t.identifier('__iterNext'), [R_(s.obj)]));
      case 'defgetter': case 'defsetter':
        return t.expressionStatement(t.callExpression(
          t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
          [R_(s.obj), s.key.reg !== undefined ? R_(s.key.reg) : t.stringLiteral(s.key.lit),
            t.objectExpression([
              t.objectProperty(t.identifier(s.kind === 'defgetter' ? 'get' : 'set'), R_(s.fn)),
              t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
              t.objectProperty(t.identifier('enumerable'), t.booleanLiteral(true)),
            ])]));
      case 'debugger': return t.debuggerStatement();
      case 'nop': return t.emptyStatement();
      case 'opaque':
        warn.push('unresolved opcode ' + s.op + ' at pc ' + s.pc);
        return assign(s.dst, t.identifier('undefined'));
      default:
        warn.push('unhandled IR ' + s.kind);
        return t.emptyStatement();
    }
  }

  const main = buildFn(R.main);
  return { main, warnings, names, upNames, built, helpers };
}

module.exports = { buildFunctions, literal, IDENT, RESERVED };
