// Lifter: convert a function's real CFG into structured Babel AST statements.
const core = require('./core');

// ---- AST builders (plain objects for @babel/generator) ----
const id = name => ({ type: 'Identifier', name });
const lit = v => v === undefined ? id('undefined')
  : v === null ? { type: 'NullLiteral' }
  : typeof v === 'string' ? { type: 'StringLiteral', value: v }
  : typeof v === 'boolean' ? { type: 'BooleanLiteral', value: v }
  : typeof v === 'number' ? (v < 0 ? { type: 'UnaryExpression', operator: '-', argument: { type: 'NumericLiteral', value: -v }, prefix: true } : { type: 'NumericLiteral', value: v })
  : id('undefined');
const bin = (op, l, r) => ({ type: 'BinaryExpression', operator: op, left: l, right: r });
const un = (op, a) => ({ type: 'UnaryExpression', operator: op, argument: a, prefix: true });
const isIdent = s => typeof s === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const mem = (o, p) => isIdent(p) ? { type: 'MemberExpression', object: o, property: id(p), computed: false } : { type: 'MemberExpression', object: o, property: typeof p === 'string' ? lit(p) : p, computed: true };
const memC = (o, p) => ({ type: 'MemberExpression', object: o, property: p, computed: true });
const call = (c, args) => ({ type: 'CallExpression', callee: c, arguments: args });
const assign = (l, r) => ({ type: 'AssignmentExpression', operator: '=', left: l, right: r });
const exprStmt = e => ({ type: 'ExpressionStatement', expression: e });
const varDecls = names => ({ type: 'VariableDeclaration', kind: 'var', declarations: names.map(n => ({ type: 'VariableDeclarator', id: id(n), init: null })) });
const ret = arg => ({ type: 'ReturnStatement', argument: arg || null });
const ifStmt = (test, cons, alt) => ({ type: 'IfStatement', test, consequent: blockStmt(cons), alternate: alt ? blockStmt(alt) : null });
const whileStmt = (test, body) => ({ type: 'WhileStatement', test, body: blockStmt(body) });
const blockStmt = body => ({ type: 'BlockStatement', body });
const throwStmt = arg => ({ type: 'ThrowStatement', argument: arg });
const funcExpr = (params, body) => ({ type: 'FunctionExpression', id: null, params: params.map(id), body: blockStmt(body), generator: false, async: false });

const BIN_SYM = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%', POW: '**', AND: '&', OR: '|', XOR: '^', SHL: '<<', SHR: '>>', USHR: '>>>', EQ: '==', NE: '!=', STRICT_EQ: '===', STRICT_NE: '!==', LT: '<', LE: '<=', GT: '>', GE: '>=', IN: 'in', INSTANCEOF: 'instanceof' };
const UN_SYM = { NEG: '-', POS: '+', NOT: '!', BNOT: '~', TYPEOF: 'typeof' };

// cfg: { stateReg, accReg, headerIp, trampIp, argRegs:[..], maskRegs:[..], deltaReg, j, nreg, paramNames:[..] }
function liftFunction(ctx, blocks, uf, cfg, closureMap, makeFunc) {
  const prefix = cfg.prefix || 'v';
  const V = reg => {
    const pi = cfg.paramRegs && cfg.paramRegs.indexOf(reg);
    if (pi >= 0) return cfg.paramNames[pi];
    return prefix + reg;
  };

  const argRegs = new Set(cfg.argRegs);
  function isMachineryIns(ins) {
    const o = ins.operands;
    if (ins.name === 'JUMP' && o[0] === cfg.trampIp) return true;
    if (ins.name === 'JUMP_REG') return true;
    if (argRegs.has(o[0]) || cfg.maskRegs.includes(o[0])) return true;
    if (o[0] === cfg.stateReg && (ins.name === 'ADD' || ins.name === 'SUB' || ins.name === 'MOVE')) return true;
    if (o[0] === cfg.deltaReg && (ins.name === 'LOAD_LITERAL' || ins.name === 'LOAD_CONST')) return true;
    return false;
  }

  function buildValue(ins, R) {
    const o = ins.operands;
    switch (ins.name) {
      case 'LOAD_CONST': return { node: lit(ctx.decodeConst(o[1], o[2])), pure: true };
      case 'LOAD_LITERAL': return { node: lit(o[1] >> 0), pure: true };
      case 'LOAD_UNDEF': return { node: id('undefined'), pure: true };
      case 'LOAD_THIS': return { node: { type: 'ThisExpression' }, pure: true };
      case 'MOVE': return { node: R(o[1]), pure: true };
      case 'LOAD_GLOBAL': return { node: id(String(ctx.decodeConst(o[1], o[2]))), pure: true };
      case 'TYPEOF_GLOBAL': return { node: un('typeof', id(String(ctx.decodeConst(o[1], o[2])))), pure: true };
      case 'LOAD_CLOSURE': return { node: id(closureMap[o[1]]), pure: true };
      case 'GET_PROP': return { node: memC(R(o[1]), R(o[2])), pure: true };
      case 'CALL': {
        const args = o[3] === core.MAGIC ? [{ type: 'SpreadElement', argument: R(o[4]) }] : o.slice(4).map(r => R(r));
        return { node: call(mem(R(o[2]), 'call'), [R(o[1]), ...args]), pure: false };
      }
      case 'CALL_NULL': {
        const args = o[2] === core.MAGIC ? [{ type: 'SpreadElement', argument: R(o[3]) }] : o.slice(3).map(r => R(r));
        return { node: call(R(o[1]), args), pure: false };
      }
      case 'NEW': {
        const args = o[2] === core.MAGIC ? [{ type: 'SpreadElement', argument: R(o[3]) }] : o.slice(3).map(r => R(r));
        return { node: { type: 'NewExpression', callee: R(o[1]), arguments: args }, pure: false };
      }
      case 'MAKE_ARRAY': return { node: { type: 'ArrayExpression', elements: o.slice(2).map(r => R(r)) }, pure: true };
      case 'MAKE_OBJECT': {
        const props = [];
        for (let i = 0; i < o[1]; i++) props.push({ type: 'ObjectProperty', key: R(o[2 + i * 2]), value: R(o[3 + i * 2]), computed: true, shorthand: false });
        return { node: { type: 'ObjectExpression', properties: props }, pure: true };
      }
      case 'MAKE_FUNC': return { node: makeFunc(o[1]), pure: false };
      case 'DELETE': return { node: un('delete', memC(R(o[1]), R(o[2]))), pure: true };
      default:
        if (BIN_SYM[ins.name]) return { node: bin(BIN_SYM[ins.name], R(o[1]), R(o[2])), pure: true };
        if (UN_SYM[ins.name]) return { node: un(UN_SYM[ins.name], R(o[1])), pure: true };
        return null;
    }
  }

  // ---- read-before-write analysis (cross-block registers need vars) ----
  const crossBlock = new Set();
  for (const n of uf.realNodes.values()) {
    const written = new Set();
    for (const ins of n.block.instrs) {
      if (isMachineryIns(ins)) continue;
      const o = ins.operands;
      const srcRegs = [];
      switch (ins.name) {
        case 'MOVE': case 'NEG': case 'POS': case 'NOT': case 'BNOT': case 'TYPEOF': srcRegs.push(o[1]); break;
        case 'GET_PROP': case 'DELETE': srcRegs.push(o[1], o[2]); break;
        case 'SET_PROP': srcRegs.push(o[0], o[1], o[2]); break;
        case 'CALL': srcRegs.push(o[1], o[2], ...(o[3] === core.MAGIC ? [o[4]] : o.slice(4))); break;
        case 'CALL_NULL': case 'NEW': srcRegs.push(o[1], ...(o[2] === core.MAGIC ? [o[3]] : o.slice(3))); break;
        case 'MAKE_ARRAY': srcRegs.push(...o.slice(2)); break;
        case 'MAKE_OBJECT': for (let i = 0; i < o[1]; i++) srcRegs.push(o[2 + i * 2], o[3 + i * 2]); break;
        case 'STORE_GLOBAL': case 'STORE_CLOSURE': srcRegs.push(o[2] !== undefined ? o[2] : o[1]); break;
        case 'THROW': srcRegs.push(o[0]); break;
        default:
          if (BIN_SYM[ins.name]) srcRegs.push(o[1], o[2]);
          break;
      }
      for (const r of srcRegs) if (typeof r === 'number' && r < (cfg.nreg || 160) && !written.has(r)) crossBlock.add(r);
      // dest written
      if (!['SET_PROP', 'STORE_GLOBAL', 'STORE_CLOSURE', 'THROW'].includes(ins.name)) written.add(o[0]);
    }
  }
  // Params are cross-block by definition but they're declared in the signature
  for (const pr of cfg.paramRegs || []) crossBlock.delete(pr);

  // ---- lift one block's real instructions to statements ----
  // env: block-local inline map (pure exprs). Cross-block regs -> V(reg) vars;
  // block-local impure -> fresh temp names (SSA-ish, so cleanup can inline).
  let tempCounter = 0;
  function liftBlock(node, env, stmts) {
    const localNames = new Map();
    const R = i => (env.has(i) ? env.get(i) : id(localNames.get(i) || V(i)));
    for (const ins of node.block.instrs) {
      if (isMachineryIns(ins)) continue;
      const o = ins.operands;
      if (ins.name === 'SET_PROP') { stmts.push(exprStmt(assign(memC(R(o[0]), R(o[1])), R(o[2])))); continue; }
      if (ins.name === 'STORE_GLOBAL') { stmts.push(exprStmt(assign(mem(id('window'), String(ctx.decodeConst(o[0], o[1]))), R(o[2])))); continue; }
      if (ins.name === 'STORE_CLOSURE') { stmts.push(exprStmt(assign(id(closureMap[o[0]]), R(o[1])))); continue; }
      if (ins.name === 'THROW') { stmts.push(throwStmt(R(o[0]))); continue; }
      if (ins.name === 'RETURN') continue; // handled by emit()
      const val = buildValue(ins, R);
      if (!val) throw new Error('lift: unhandled ' + ins.name);
      const dest = o[0];
      if (val.pure && !crossBlock.has(dest)) {
        env.set(dest, val.node); // inline pure block-locals
      } else if (crossBlock.has(dest)) {
        env.delete(dest);
        stmts.push(exprStmt(assign(id(V(dest)), val.node)));
      } else {
        // block-local impure -> fresh temp
        const t = prefix + 't' + tempCounter++;
        localNames.set(dest, t);
        env.delete(dest);
        stmts.push(exprStmt(assign(id(t), val.node)));
      }
    }
  }

  // find condition register of a dispatch-cond block: walk forward from the first
  // NOT/POS/NEG that writes a mask register, following sources back to the real value.
  function findCondReg(node) {
    const def = new Map(); // reg -> [writing ins...] (in order)
    for (const ins of node.block.instrs) {
      if (!def.has(ins.operands[0])) def.set(ins.operands[0], []);
      def.get(ins.operands[0]).push(ins);
    }
    const maskRegs = new Set(cfg.maskRegs);
    // first NOT/POS/NEG writing a mask register
    let start = null;
    for (const ins of node.block.instrs) {
      if (maskRegs.has(ins.operands[0]) && ['NOT', 'POS', 'NEG'].includes(ins.name)) { start = ins; break; }
    }
    if (!start) return null;
    let reg = start.operands[1];
    const seen = new Set();
    while (!seen.has(reg)) {
      seen.add(reg);
      const writers = def.get(reg);
      const w = writers && writers.find(x => ['NOT', 'POS', 'NEG'].includes(x.name));
      if (w) { reg = w.operands[1]; continue; }
      break;
    }
    return reg;
  }

  // ---- structuring ----
  function reaches(from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from) || from === null) return false;
    seen.add(from);
    const n = uf.realNodes.get(from);
    if (!n) return false;
    return n.succs.some(s => s.ip !== null && reaches(s.ip, to, seen));
  }
  const loopHeaders = new Set();
  for (const n of uf.realNodes.values()) {
    if (n.succs.some(s => s.ip !== null && reaches(s.ip, n.ip))) loopHeaders.add(n.ip);
  }
  function findMerge(a, b) {
    if (a === null || b === null) return null;
    const reachA = new Set();
    const stack = [a];
    while (stack.length) {
      const x = stack.pop();
      if (x === null || reachA.has(x)) continue;
      reachA.add(x);
      const n = uf.realNodes.get(x);
      if (n) for (const s of n.succs) if (s.ip !== null) stack.push(s.ip);
    }
    const q = [b], dist = new Map([[b, 0]]);
    while (q.length) {
      const x = q.shift();
      if (reachA.has(x)) return x;
      const n = uf.realNodes.get(x);
      if (n) for (const s of n.succs) if (s.ip !== null && !dist.has(s.ip)) { dist.set(s.ip, dist.get(x) + 1); q.push(s.ip); }
    }
    return null;
  }

  function emit(cur, stops, out) {
    const env = new Map(); // per-"straight-line-run" inline map; reset when control merges
    while (cur !== null && !stops.has(cur)) {
      const node = uf.realNodes.get(cur);
      if (!node) return;
      const isLoop = loopHeaders.has(cur);
      if (node.block.kind === 'dispatch-cond') {
        liftBlock(node, env, out);
        const creg = findCondReg(node);
        const cexpr = env.has(creg) ? env.get(creg) : id(V(creg));
        const t = node.succs.find(s => s.cond === true);
        const f = node.succs.find(s => s.cond === false);
        if (isLoop) {
          let bodySucc = t && reaches(t.ip, cur) ? t : f;
          let exitSucc = bodySucc === t ? f : t;
          let test = cexpr;
          if (bodySucc && bodySucc.cond === false) test = un('!', cexpr);
          const bodyStmts = [];
          if (bodySucc && bodySucc.ip !== null) emit(bodySucc.ip, new Set([cur]), bodyStmts);
          out.push(whileStmt(test, bodyStmts));
          cur = exitSucc ? exitSucc.ip : null;
          env.clear();
          continue;
        }
        const merge = findMerge(t ? t.ip : null, f ? f.ip : null);
        const tStmts = [], fStmts = [];
        if (t && t.ip !== null) emit(t.ip, new Set([...(merge !== null ? [merge] : []), ...stops]), tStmts);
        if (f && f.ip !== null) emit(f.ip, new Set([...(merge !== null ? [merge] : []), ...stops]), fStmts);
        out.push(ifStmt(cexpr, tStmts, fStmts.length ? fStmts : null));
        cur = merge;
        env.clear();
        continue;
      }
      // unconditional / return
      liftBlock(node, env, out);
      if (node.block.kind === 'return') { out.push(ret(env.has(node.block.reg) ? env.get(node.block.reg) : id(V(node.block.reg)))); return; }
      if (node.block.kind === 'throw') return;
      cur = node.succs.length ? node.succs[0].ip : null;
    }
  }

  const body = [];
  emit(uf.entryReal, new Set(), body);

  // collect all vars referenced / assigned (this function's prefix only)
  const usedVars = new Set();
  const re = new RegExp('^' + prefix + '(t?\\d+)$');
  const collect = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (n.type === 'Identifier' && re.test(n.name)) usedVars.add(n.name);
    for (const k in n) if (typeof n[k] === 'object') collect(n[k]);
  };
  collect(body);
  // declare vars at top
  if (usedVars.size) {
    body.unshift(varDecls([...usedVars].sort((a, b) => parseInt(a.slice(prefix.length)) - parseInt(b.slice(prefix.length)))));
  }

  return { body, usedVars };
}

module.exports = { liftFunction, id, lit, bin, un, mem, memC, call, assign, exprStmt, varDecls, ret, ifStmt, whileStmt, blockStmt, throwStmt, funcExpr };
