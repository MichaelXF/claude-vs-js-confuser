"use strict";
/*
 * Dispatcher emitter: lowers each VM function into a real JS function whose body
 * is a `while(true) switch(pc){...}` dispatcher over the original basic blocks.
 *
 * This form is a guaranteed-correct devirtualization: it removes the bytecode
 * interpreter and inlines every decoded constant/string, but keeps control flow
 * as an explicit program-counter machine. It is used directly as a fallback and
 * as the correctness baseline that the structured emitter is validated against.
 */
const parser = require("@babel/parser");

module.exports = function install(deps) {
  const { OP, BINOP, UNOP, VOID_OP, SPREAD_SENTINEL, litNode, buildBlocks, t } = deps;

  function stmt(code) { return parser.parse(code).program.body[0]; }
  function expr(code) { return parser.parse("(" + code + ")").program.body[0].expression; }
  const clone = (n) => t.cloneDeepWithoutLoc ? t.cloneDeepWithoutLoc(n) : JSON.parse(JSON.stringify(n));

  function bodyUsesForIn(instrs, f) {
    return f.body.some((pc) => instrs[pc].op === OP.FORIN_INIT || instrs[pc].op === OP.FORIN_NEXT);
  }
  function bodyUsesHandlers(instrs, f) {
    return f.body.some((pc) => instrs[pc].op === OP.TRY_CATCH || instrs[pc].op === OP.TRY_FINALLY);
  }

  // Build the whole program.
  function emitProgram(instrs, funcs, vm) {
    const byStart = new Map(funcs.map((f) => [f.start, f]));
    let needForIn = false;

    function emitFunc(f, upvalNodes) {
      const Rid = t.identifier("R");
      const reg = (n) => t.memberExpression(clone(Rid), t.numericLiteral(n), true);
      const ctx = {
        f, instrs, reg,
        upval: (idx) => clone(upvalNodes[idx]),
        setUpval: (idx, valNode) => t.assignmentExpression("=", clone(upvalNodes[idx]), valNode),
        emitChild(startPc) {
          const child = byStart.get(startPc);
          const defIns = f.body.map((pc) => instrs[pc]).find((i) => i.op === OP.DEFINE_FUNCTION && i.fT === startPc);
          const caps = defIns ? defIns.caps : [];
          const childUpvals = caps.map((c) => (c.Y ? reg(c.M) : ctx.upval(c.M)));
          return emitFunc(child, childUpvals);
        },
        isTop: f.top,
        markForIn() { needForIn = true; },
      };

      const { blocks, leaderList } = buildBlocks(instrs, f);
      const useHandlers = bodyUsesHandlers(instrs, f);
      if (bodyUsesForIn(instrs, f)) needForIn = true;

      const cases = [];
      for (const ld of leaderList) {
        const blk = blocks.get(ld);
        const caseBody = emitBlock(blk, ctx);
        cases.push(t.switchCase(t.numericLiteral(ld), caseBody));
      }

      const switchStmt = t.switchStatement(t.identifier("pc"), cases);

      const inner = [];
      if (useHandlers) {
        const handler = t.catchClause(
          t.identifier("e"),
          t.blockStatement([
            stmt("if (!H.length) throw e;"),
            stmt("var hd = H.pop();"),
            stmt("if (hd.kind === 'catch') { R[hd.reg] = e; pc = hd.pc; } else { R[hd.regV] = hd.marker; R[hd.regZ] = e; pc = hd.pc; }"),
          ])
        );
        inner.push(t.tryStatement(t.blockStatement([switchStmt]), handler));
      } else {
        inner.push(switchStmt);
      }
      const loop = t.whileStatement(t.booleanLiteral(true), t.blockStatement(inner));

      // Prologue: register array + argument loading.
      const prologue = [];
      prologue.push(stmt("var R = [];"));
      prologue.push(stmt("var A = Array.prototype.slice.call(arguments);"));
      const l = f.params, i = f.frameSize;
      if (f.rest) {
        prologue.push(stmt(`for (var w = 0; w < ${l - 1}; w++) R[w] = w < A.length ? A[w] : undefined;`));
        prologue.push(stmt(`R[${l - 1}] = A.slice(${l - 1});`));
      } else {
        prologue.push(stmt(`for (var w = 0; w < A.length && w < ${i}; w++) R[w] = A[w];`));
      }
      if (l < i) prologue.push(stmt(`R[${l}] = A;`));
      if (useHandlers) prologue.push(stmt("var H = [];"));
      prologue.push(stmt(`var pc = ${f.start};`));

      const body = t.blockStatement(prologue.concat([loop]));
      return t.functionExpression(null, [], body);
    }

    const topFn = emitFunc(byStart.get(0), []);
    const programBody = [];
    if (needForIn) {
      programBody.push(stmt("function __forInKeys(o) { var keys = []; if (o != null) for (var k in o) keys.push(k); return { keys: keys, i: 0 }; }"));
    }
    programBody.push(t.expressionStatement(t.callExpression(topFn, [])));
    return t.program(programBody);
  }

  // Lower a basic block into an array of statements (the body of a switch case).
  function emitBlock(blk, ctx) {
    const out = [];
    const list = blk.instrs;
    for (let idx = 0; idx < list.length; idx++) {
      const ins = list[idx];
      const isLast = idx === list.length - 1;
      const next = ins.start + ins.size;
      if (lowerSideEffect(ins, ctx, out)) continue; // produced side-effect statement(s)
      // terminator / control flow
      lowerControl(ins, ctx, out, next);
      return out; // terminators end the block
    }
    // Fell through without a terminator: go to the next leader.
    const last = list[list.length - 1];
    const next = last.start + last.size;
    out.push(t.expressionStatement(t.assignmentExpression("=", t.identifier("pc"), t.numericLiteral(next))));
    out.push(t.breakStatement());
    return out;
  }

  // Returns true if the instruction was a (non-control) side effect that was
  // emitted; false if it is a control-flow terminator to be handled separately.
  function lowerSideEffect(ins, ctx, out) {
    const reg = ctx.reg;
    const assign = (n, valNode) => out.push(t.expressionStatement(t.assignmentExpression("=", reg(n), valNode)));

    switch (ins.op) {
      case OP.LOAD_CONST: assign(ins.f, litNode(ins.k)); return true;
      case OP.LOAD_IMM: assign(ins.f, litNode(ins.k)); return true;
      case OP.LOAD_GLOBAL: assign(ins.f, identRef(ins.name)); return true;
      case OP.LOAD_THIS: assign(ins.f, ctx.isTop ? t.identifier("undefined") : t.thisExpression()); return true;
      case OP.LOAD_UPVAL: assign(ins.f, ctx.upval(ins.idx)); return true;
      case OP.STORE_UPVAL: out.push(t.expressionStatement(ctx.setUpval(ins.idx, reg(ins.src)))); return true;
      case OP.MOVE: assign(ins.f, reg(ins.src)); return true;
      case OP.STORE_GLOBAL:
        out.push(t.expressionStatement(t.assignmentExpression("=", identRef(ins.name), reg(ins.src)))); return true;
      case OP.GET_PROP: assign(ins.f, t.memberExpression(reg(ins.obj), reg(ins.key), true)); return true;
      case OP.SET_PROP:
        out.push(t.expressionStatement(t.assignmentExpression("=",
          t.memberExpression(reg(ins.obj), reg(ins.key), true), reg(ins.val)))); return true;
      case OP.DELETE_PROP:
        assign(ins.f, t.unaryExpression("delete", t.memberExpression(reg(ins.obj), reg(ins.key), true))); return true;
      case OP.POW: assign(ins.f, t.binaryExpression("**", reg(ins.a), reg(ins.b))); return true;
      case OP.TYPEOF_GLOBAL: assign(ins.f, t.unaryExpression("typeof", identRef(ins.name))); return true;
      case OP.CALL:
        assign(ins.f, t.callExpression(reg(ins.fn), argNodes(ins.args, ctx))); return true;
      case OP.CALL_METHOD:
        assign(ins.f, t.callExpression(
          t.memberExpression(reg(ins.fn), t.identifier("apply")),
          [reg(ins.recv), argArray(ins.args, ctx)])); return true;
      case OP.NEW:
        assign(ins.f, t.newExpression(reg(ins.fn), argNodes(ins.args, ctx))); return true;
      case OP.DEFINE_FUNCTION:
        assign(ins.f, ctx.emitChild(ins.fT)); return true;
      case OP.NEW_ARRAY:
        assign(ins.f, t.arrayExpression(ins.elems.map((r) => reg(r)))); return true;
      case OP.NEW_OBJECT:
        assign(ins.f, t.objectExpression(ins.pairs.map((p) =>
          t.objectProperty(reg(p.k), reg(p.v), true)))); return true;
      case OP.DEFINE_GETTER:
      case OP.DEFINE_SETTER: {
        const kind = ins.op === OP.DEFINE_GETTER ? "get" : "set";
        out.push(t.expressionStatement(t.callExpression(
          t.memberExpression(t.identifier("Object"), t.identifier("defineProperty")),
          [reg(ins.obj), reg(ins.key), t.objectExpression([
            t.objectProperty(t.identifier(kind), reg(ins.fn)),
            t.objectProperty(t.identifier("configurable"), t.booleanLiteral(true)),
            t.objectProperty(t.identifier("enumerable"), t.booleanLiteral(true)),
          ])])));
        return true;
      }
      case OP.FORIN_INIT:
        ctx.markForIn();
        assign(ins.f, t.callExpression(t.identifier("__forInKeys"), [reg(ins.obj)])); return true;
      case OP.TRY_CATCH:
        out.push(stmtPush(`H.push({ kind: 'catch', pc: ${ins.catchPc}, reg: ${ins.catchReg} });`)); return true;
      case OP.TRY_FINALLY:
        out.push(stmtPush(`H.push({ kind: 'finally', pc: ${ins.W}, regV: ${ins.V}, regZ: ${ins.Z}, marker: ${ins.aa} });`)); return true;
      case OP.TRY_POP:
        out.push(stmtPush("H.pop();")); return true;
      case OP.DEBUGGER:
        out.push(t.debuggerStatement()); return true;
      case OP.CODE_COPY:
        // Self-modifying bytecode primitive; not expressible. Leave a marker.
        out.push(t.expressionStatement(t.stringLiteral("__CODE_COPY_UNSUPPORTED__"))); return true;
      default:
        break;
    }

    if (BINOP[ins.op]) {
      assign(ins.f, t.binaryExpression(BINOP[ins.op], ctx.reg(ins.a), ctx.reg(ins.b)));
      return true;
    }
    if (UNOP[ins.op]) {
      assign(ins.f, t.unaryExpression(UNOP[ins.op], ctx.reg(ins.a), true));
      return true;
    }
    if (ins.op === VOID_OP) {
      assign(ins.f, t.unaryExpression("void", ctx.reg(ins.a)));
      return true;
    }
    return false; // not a side effect -> control flow
  }

  function lowerControl(ins, ctx, out, next) {
    const reg = ctx.reg;
    const setPc = (node) => out.push(t.expressionStatement(t.assignmentExpression("=", t.identifier("pc"), node)));
    const brk = () => out.push(t.breakStatement());
    switch (ins.op) {
      case OP.JUMP:
        setPc(t.numericLiteral(ins.target)); brk(); return;
      case OP.JUMP_IF_FALSE:
        setPc(t.conditionalExpression(reg(ins.cond), t.numericLiteral(next), t.numericLiteral(ins.target))); brk(); return;
      case OP.JUMP_IF_TRUE:
        setPc(t.conditionalExpression(reg(ins.cond), t.numericLiteral(ins.target), t.numericLiteral(next))); brk(); return;
      case OP.RETURN:
        out.push(t.returnStatement(reg(ins.val))); return;
      case OP.THROW:
        out.push(t.throwStatement(reg(ins.val))); return;
      case OP.JUMP_DYN:
        setPc(reg(ins.reg)); brk(); return;
      case OP.FORIN_NEXT: {
        ctx.markForIn();
        const iter = reg(ins.iter);
        const cond = t.binaryExpression(">=",
          t.memberExpression(clone(iter), t.identifier("i")),
          t.memberExpression(t.memberExpression(clone(iter), t.identifier("keys")), t.identifier("length")));
        const thenB = t.blockStatement([
          t.expressionStatement(t.assignmentExpression("=", t.identifier("pc"), t.numericLiteral(ins.target))),
        ]);
        const elseB = t.blockStatement([
          t.expressionStatement(t.assignmentExpression("=", reg(ins.f),
            t.memberExpression(
              t.memberExpression(clone(iter), t.identifier("keys")),
              t.updateExpression("++", t.memberExpression(clone(iter), t.identifier("i")), false),
              true))),
          t.expressionStatement(t.assignmentExpression("=", t.identifier("pc"), t.numericLiteral(next))),
        ]);
        out.push(t.ifStatement(cond, thenB, elseB));
        brk(); return;
      }
      default:
        throw new Error("lowerControl: unexpected op " + ins.op);
    }
  }

  function argNodes(args, ctx) {
    if (args.spread != null) return [t.spreadElement(ctx.reg(args.spread))];
    return args.list.map((r) => ctx.reg(r));
  }
  function argArray(args, ctx) {
    if (args.spread != null) return ctx.reg(args.spread);
    return t.arrayExpression(args.list.map((r) => ctx.reg(r)));
  }

  function identRef(name) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return t.identifier(name);
    return t.memberExpression(t.identifier("globalThis"), t.stringLiteral(name), true);
  }

  function stmtPush(code) { return parser.parse(code).program.body[0]; }

  return emitProgram;
};
