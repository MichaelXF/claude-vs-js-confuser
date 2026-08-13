/* ------------------------------------------------------------------ *
 * Function lifting driver
 * ------------------------------------------------------------------ */

function terminatorOf(env, bb) {
  const last = bb.nodes[bb.nodes.length - 1];
  const ins = last.ins, k = ins.k, o = ins.operands;
  if (ins.kind === 'ret') return { kind: 'return', reg: o[0] };
  if (ins.kind === 'throw') return { kind: 'throw', reg: o[0] };
  if (last.branch && bb.succ.length === 2) {
    const test = last.branch.negate
      ? IR.un('!', IR.reg(last.branch.reg))
      : IR.reg(last.branch.reg);
    return { kind: 'branch', test, trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
  }
  if ((ins.kind === 'jz' || ins.kind === 'jnz') && bb.succ.length === 2) {
    const reg = o[k.cond];
    const test = ins.kind === 'jz' ? IR.un('!', IR.reg(reg)) : IR.reg(reg);
    return { kind: 'branch', test, trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
  }
  if (ins.kind === 'forin_next' && bb.succ.length === 2) {
    return { kind: 'branch', test: IR.un('!', IR.reg(o[k.dst])), trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
  }
  if (bb.succ.length === 1) return { kind: 'goto', target: bb.succ[0] };
  if (bb.succ.length === 0) return { kind: 'end' };
  return { kind: 'branch', test: IR.lit(true), trueTarget: bb.succ[0], falseTarget: bb.succ[1] };
}

/** registers of `fn` that a nested function captures (they must survive DCE) */
function capturedRegisters(prog, fn) {
  const out = new Set();
  for (const child of prog.order) {
    if (child.parent !== fn) continue;
    for (const uv of child.upvals || []) if (uv.local) out.add(uv.index);
  }
  return out;
}

function liftFunction(env, prog, fn, helpers) {
  const prevFrame = env.currentFrameSize;
  env.currentFrameSize = env.frameLayout.header + fn.l;
  const merged = mergeNodes(fn);
  const { bbs, entry } = buildBasicBlocks(merged);

  for (const [, bb] of bbs) {
    bb.ir = [];
    for (const node of bb.nodes) {
      const stmts = liftInstruction(env, fn, node.ins, {});
      for (const s of stmts) bb.ir.push(s);
    }
    bb.term = terminatorOf(env, bb);
    if (bb.term.kind === 'return') { bb.ir.push({ kind: 'ret', expr: IR.reg(bb.term.reg) }); bb.retStmt = bb.ir[bb.ir.length - 1]; }
    if (bb.term.kind === 'throw') { bb.ir.push({ kind: 'throw', expr: IR.reg(bb.term.reg) }); bb.retStmt = bb.ir[bb.ir.length - 1]; }
  }

  const captured = capturedRegisters(prog, fn);
  const { liveOut } = computeLiveness(bbs, captured);
  for (const [id, bb] of bbs) {
    const lo = new Set(liveOut.get(id));
    if (bb.term.kind === 'return' || bb.term.kind === 'throw') { /* handled via the ir statement */ }
    optimiseBlock(bb, lo, captured);
  }

  const em = makeEmitter(env, prog, fn, helpers);
  let labelSeq = 0;
  const ctx = {
    blockStatements: bb => bb.ir.filter(s => s.kind !== 'ret' && s.kind !== 'throw').map(em.statement).filter(Boolean),
    terminator: bb => {
      if (bb.term.kind === 'return' || bb.term.kind === 'throw') {
        const st = bb.ir[bb.ir.length - 1];
        return { kind: bb.term.kind, stmt: em.statement(st) };
      }
      return bb.term;
    },
    makeIf: (test, consequent, alternate) => t.ifStatement(em.expr(test),
      t.blockStatement(consequent), alternate.length ? t.blockStatement(alternate) : null),
    makeLoop: (body, label) => {
      const w = t.whileStatement(t.booleanLiteral(true), t.blockStatement(body));
      return label ? t.labeledStatement(t.identifier(label), w) : w;
    },
    makeBreak: label => t.breakStatement(label ? t.identifier(label) : null),
    makeContinue: label => t.continueStatement(label ? t.identifier(label) : null),
    newLabel: () => 'L' + (++labelSeq) + '_' + fn.id,
  };

  let body;
  try {
    body = structureFunction(ctx, bbs, entry);
  } catch (e) {
    if (e !== RESTRUCTURE) throw e;
    body = emitDispatchLoop(ctx, bbs, entry, em, fn);
  }

  // variable declarations
  const decls = [];
  const params = [];
  for (let i = 0; i < fn.m; i++) {
    const name = em.prefix + i;
    params.push(fn.rest && i === fn.m - 1 ? t.restElement(t.identifier(name)) : t.identifier(name));
  }
  const locals = [...em.used].filter(i => i >= fn.m).sort((a, b) => a - b);
  const argsReg = fn.m < fn.l ? fn.m : -1;
  for (const i of locals) {
    const name = em.prefix + i;
    if (i === argsReg && !fn.rest) {
      decls.push(t.variableDeclarator(t.identifier(name),
        t.callExpression(t.memberExpression(t.memberExpression(t.memberExpression(
          t.identifier('Array'), t.identifier('prototype')), t.identifier('slice')), t.identifier('call')),
        [t.identifier('arguments')])));
    } else {
      decls.push(t.variableDeclarator(t.identifier(name), null));
    }
  }
  const stmts = decls.length ? [t.variableDeclaration('var', decls), ...body] : body;
  env.currentFrameSize = prevFrame;
  return { params, body: stmts };
}

/** last-resort emitter: a program-counter dispatch loop (always correct) */
function emitDispatchLoop(ctx, bbs, entry, em, fn) {
  const ids = [...bbs.keys()];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const pcVar = t.identifier('_pc' + fn.id);
  const cases = [];
  for (const id of ids) {
    const bb = bbs.get(id);
    const body = ctx.blockStatements(bb);
    const term = ctx.terminator(bb);
    if (term.kind === 'return' || term.kind === 'throw') body.push(term.stmt);
    else if (term.kind === 'branch') {
      body.push(t.expressionStatement(t.assignmentExpression('=', pcVar,
        t.conditionalExpression(em.expr(term.test),
          t.numericLiteral(idx.get(term.trueTarget)), t.numericLiteral(idx.get(term.falseTarget))))));
      body.push(t.continueStatement(t.identifier('_vm' + fn.id)));
    } else if (term.kind === 'goto') {
      body.push(t.expressionStatement(t.assignmentExpression('=', pcVar, t.numericLiteral(idx.get(term.target)))));
      body.push(t.continueStatement(t.identifier('_vm' + fn.id)));
    } else body.push(t.returnStatement(null));
    cases.push(t.switchCase(t.numericLiteral(idx.get(id)), body));
  }
  return [
    t.variableDeclaration('var', [t.variableDeclarator(pcVar, t.numericLiteral(idx.get(entry)))]),
    t.labeledStatement(t.identifier('_vm' + fn.id),
      t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.switchStatement(pcVar, cases)]))),
  ];
}

/* ------------------------------------------------------------------ *
 * Whole program
 * ------------------------------------------------------------------ */

function liftProgram(env, prog) {
  env.fitCache = new Map();
  const helperState = { forIn: false };
  const built = new Map();

  const helpers = {
    functionExpression: ref => {
      const child = prog.funcs.get(ref.entry);
      if (!child) return t.identifier('undefined');
      const lifted = built.get(child.entry) || liftFunction(env, prog, child, helpers);
      built.set(child.entry, lifted);
      return t.functionExpression(null, lifted.params, t.blockStatement(lifted.body));
    },
    forInHelper: () => { helperState.forIn = true; return '__vmForIn'; },
  };

  const main = liftFunction(env, prog, prog.main, helpers);
  const program = [];
  if (helperState.forIn) {
    program.push(...parseSource(`
function __vmForIn(o) {
  var keys = [], i = 0;
  for (var k in o) keys.push(k);
  return { next: function () { return i < keys.length ? keys[i++] : undefined; } };
}`).program.body);
  }
  program.push(...main.body);
  return t.program(program);
}
