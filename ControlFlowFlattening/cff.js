"use strict";
// ============================================================================
//  cff.js  —  Deobfuscation engine for JS-Confuser "Control Flow Flattening"
//             (state-vector + sum-dispatch variant), plus its companion
//             string-encoding (Caesar shift over printable ASCII).
//
//  Strategy (see README): the obfuscator turns each original function into an
//  entry into a shared dispatcher `K(S, T, U, V)` whose control flow is driven
//  by `J(S)` = sum of a numeric state vector `S`.  Every "block" mutates `S`
//  by constant-additive deltas to select the next block; data-dependent
//  branches are real `if`s that pick between two successor states.
//
//  Because the entry `S` is a constant and all transitions are deterministic
//  functions of `S`, we can *concretely simulate* each function from its fixed
//  entry vector, recover its real control-flow graph, fold every `S[..]` read
//  and every `I(..)` string-decode to a constant, and re-emit each function as
//  a clean integer-state machine with the obfuscation removed.
//
//  Exports: deobfuscate(sourceCode) -> { code, changed, info }
// ============================================================================

const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const t = require("@babel/types");

class NotConcrete extends Error {}

// --------------------------------------------------------------------------
//  Pattern detection: locate the decoder (I), the array-sum (J) and the
//  dispatcher (K).  Returns null if the file is not this obfuscation form.
// --------------------------------------------------------------------------
function detect(ast) {
  const funcs = {};
  for (const n of ast.program.body)
    if (t.isFunctionDeclaration(n) && n.id) funcs[n.id.name] = n;

  let disp = null, sumName = null, stateParam = null, terminal = null, sw = null;
  for (const name in funcs) {
    const fn = funcs[name];
    const wh = fn.body.body.find(
      (s) =>
        t.isWhileStatement(s) &&
        t.isBinaryExpression(s.test, { operator: "!==" }) &&
        t.isCallExpression(s.test.left) &&
        t.isIdentifier(s.test.left.callee) &&
        s.test.left.arguments.length === 1 &&
        t.isIdentifier(s.test.left.arguments[0]) &&
        t.isNumericLiteral(s.test.right)
    );
    if (!wh) continue;
    const switchStmt = wh.body.body.find((s) => t.isSwitchStatement(s));
    if (!switchStmt) continue;
    // confirm switch discriminant is the same sum-call
    if (!t.isCallExpression(switchStmt.discriminant)) continue;
    disp = fn;
    sumName = wh.test.left.callee.name;
    stateParam = wh.test.left.arguments[0].name;
    terminal = wh.test.right.value;
    sw = switchStmt;
    break;
  }
  if (!disp) return null;

  // decoder: 2-param function using charCodeAt + fromCharCode
  let decoderName = null;
  for (const name in funcs) {
    const fn = funcs[name];
    if (fn.params.length !== 2) continue;
    const code = generate(fn).code;
    if (code.includes("charCodeAt") && code.includes("fromCharCode")) {
      decoderName = name;
      break;
    }
  }

  // top-level dispatcher call: K([...])
  let mainCall = null, mainStmtIndex = -1;
  ast.program.body.forEach((n, i) => {
    if (
      t.isExpressionStatement(n) &&
      t.isCallExpression(n.expression) &&
      t.isIdentifier(n.expression.callee, { name: disp.id.name }) &&
      n.expression.arguments.length >= 1 &&
      t.isArrayExpression(n.expression.arguments[0])
    ) {
      mainCall = n.expression;
      mainStmtIndex = i;
    }
  });
  if (!mainCall) return null;

  return { funcs, disp, dispName: disp.id.name, sumName, stateParam, terminal, sw, decoderName, mainCall, mainStmtIndex };
}

// --------------------------------------------------------------------------
//  The companion string decoder (re-implementation of function I).
// --------------------------------------------------------------------------
function makeDecoder() {
  return function decode(str, shift) {
    let out = "";
    const m = (((shift % 95) + 95) % 95);
    for (let i = 0; i < str.length; i++) {
      const q = ((str.charCodeAt(i) - 32) - m + 95) % 95;
      out += String.fromCharCode(q + 32);
    }
    return out;
  };
}

// --------------------------------------------------------------------------
//  Canonical key for a member chain (Identifier / string+ident member access).
//  e.g.  S -> "S",  T["F"]["a"] -> "T.F.a"
// --------------------------------------------------------------------------
function memberKey(node) {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) {
    let prop;
    if (!node.computed && t.isIdentifier(node.property)) prop = node.property.name;
    else if (node.computed && t.isStringLiteral(node.property)) prop = node.property.value;
    else return null;
    const base = memberKey(node.object);
    return base ? base + "." + prop : null;
  }
  return null;
}

// --------------------------------------------------------------------------
//  Concrete evaluator over a set of tracked numeric arrays (env.arrays) plus
//  the decoder.  Returns { t: 'n'|'s'|'b', v } or throws NotConcrete.
// --------------------------------------------------------------------------
function makeEval(ctx) {
  const decode = ctx.decode;
  const decoderName = ctx.decoderName;
  const sumName = ctx.sumName;

  function num(r) { if (r.t === "n" || r.t === "b") return +r.v; throw new NotConcrete(); }
  function asStr(r) { if (r.t === "s") return r.v; throw new NotConcrete(); }

  function evalConst(node, env) {
    switch (node.type) {
      case "NumericLiteral": return { t: "n", v: node.value };
      case "StringLiteral": return { t: "s", v: node.value };
      case "BooleanLiteral": return { t: "b", v: node.value };
      case "ParenthesizedExpression": return evalConst(node.expression, env);
      case "UnaryExpression": {
        const a = evalConst(node.argument, env);
        if (node.operator === "-") return { t: "n", v: -num(a) };
        if (node.operator === "+") return { t: "n", v: +num(a) };
        if (node.operator === "!") return { t: "b", v: !num(a) };
        if (node.operator === "~") return { t: "n", v: ~num(a) };
        throw new NotConcrete();
      }
      case "BinaryExpression": {
        const l = num(evalConst(node.left, env));
        const r = num(evalConst(node.right, env));
        switch (node.operator) {
          case "+": return { t: "n", v: l + r };
          case "-": return { t: "n", v: l - r };
          case "*": return { t: "n", v: l * r };
          case "/": return { t: "n", v: l / r };
          case "%": return { t: "n", v: l % r };
          case "**": return { t: "n", v: l ** r };
          case "&": return { t: "n", v: l & r };
          case "|": return { t: "n", v: l | r };
          case "^": return { t: "n", v: l ^ r };
          case "<<": return { t: "n", v: l << r };
          case ">>": return { t: "n", v: l >> r };
          case ">>>": return { t: "n", v: l >>> r };
          case "==": return { t: "b", v: l == r };
          case "===": return { t: "b", v: l === r };
          case "!=": return { t: "b", v: l != r };
          case "!==": return { t: "b", v: l !== r };
          case "<": return { t: "b", v: l < r };
          case ">": return { t: "b", v: l > r };
          case "<=": return { t: "b", v: l <= r };
          case ">=": return { t: "b", v: l >= r };
          default: throw new NotConcrete();
        }
      }
      case "LogicalExpression": {
        const l = evalConst(node.left, env);
        if (node.operator === "&&") return l.v ? evalConst(node.right, env) : l;
        if (node.operator === "||") return l.v ? l : evalConst(node.right, env);
        throw new NotConcrete();
      }
      case "MemberExpression": {
        const key = memberKey(node.object);
        if (key && env.arrays[key]) {
          const idx = num(evalConst(node.property, env));
          const arr = env.arrays[key];
          if (idx < 0 || idx >= arr.length || typeof arr[idx] !== "number")
            throw new NotConcrete();
          return { t: "n", v: arr[idx] };
        }
        throw new NotConcrete();
      }
      case "CallExpression": {
        if (decoderName && t.isIdentifier(node.callee, { name: decoderName })) {
          const s = asStr(evalConst(node.arguments[0], env));
          const j = num(evalConst(node.arguments[1], env));
          return { t: "s", v: decode(s, j) };
        }
        if (sumName && t.isIdentifier(node.callee, { name: sumName })) {
          const key = memberKey(node.arguments[0]);
          if (key && env.arrays[key]) {
            const arr = env.arrays[key];
            let s = 0;
            for (let i = 0; i < arr.length; i++) s += arr[i];
            return { t: "n", v: s };
          }
        }
        throw new NotConcrete();
      }
      default:
        throw new NotConcrete();
    }
  }

  function evalArray(node, env) {
    if (!t.isArrayExpression(node)) throw new NotConcrete();
    return node.elements.map((e) => num(evalConst(e, env)));
  }

  return { evalConst, evalArray, num, asStr };
}

// --------------------------------------------------------------------------
//  AST literal builders.
// --------------------------------------------------------------------------
function litNum(v) {
  if (!Number.isFinite(v)) throw new NotConcrete();
  if (v < 0) return t.unaryExpression("-", t.numericLiteral(-v));
  return t.numericLiteral(v);
}
function litFromResult(r) {
  if (r.t === "n") return litNum(r.v);
  if (r.t === "s") return t.stringLiteral(r.v);
  if (r.t === "b") return t.booleanLiteral(r.v);
  throw new NotConcrete();
}

// --------------------------------------------------------------------------
//  Fold maximal concrete sub-expressions of `node` into literals, in place.
//  Does NOT descend into nested functions (their `S` is a different binding).
// --------------------------------------------------------------------------
function makeFolder(EV) {
  function fold(node, env) {
    if (!node || typeof node.type !== "string") return node;
    if (
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node) ||
      t.isFunctionDeclaration(node)
    )
      return node; // leave nested functions untouched
    // try to evaluate the whole node
    try {
      const r = EV.evalConst(node, env);
      if (r.t === "n" && !Number.isFinite(r.v)) {
        // fall through to child recursion
      } else {
        return litFromResult(r);
      }
    } catch (e) {
      if (!(e instanceof NotConcrete)) throw e;
    }
    // recurse into children
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++)
          if (child[i] && typeof child[i].type === "string")
            child[i] = fold(child[i], env);
      } else if (child && typeof child.type === "string") {
        node[key] = fold(child, env);
      }
    }
    return node;
  }
  return fold;
}

// --------------------------------------------------------------------------
//  Main engine.
// --------------------------------------------------------------------------
function deobfuscate(source) {
  const ast = parser.parse(source, { sourceType: "unambiguous" });
  const det = detect(ast);
  if (!det) return { code: source, changed: false, info: "pattern not found" };

  const ctx = {
    decode: makeDecoder(),
    decoderName: det.decoderName,
    sumName: det.sumName,
    stateParam: det.stateParam,
    dispName: det.dispName,
    terminal: det.terminal,
    sw: det.sw,
  };
  const EV = makeEval(ctx);
  const fold = makeFolder(EV);
  const SP = det.stateParam; // "S"

  // ---- function table / worklist -----------------------------------------
  const functions = new Map(); // entryKey -> { name, entry, blocks, order }
  const worklist = [];
  let funcCounter = 0;
  const closureMap = {}; // memberKey -> funcName
  const concreteV = {}; // funcName -> number[] (the V argument array)

  function entryKeyOf(arr) { return arr.join(","); }
  function nameForEntry(arr, isMain) {
    const key = entryKeyOf(arr);
    if (functions.has(key)) return functions.get(key).name;
    const name = isMain ? "f_main" : "f_" + ++funcCounter;
    functions.set(key, { name, entry: arr.slice(), blocks: null, order: null });
    worklist.push(key);
    return name;
  }

  // ---- rewrite K(...) calls anywhere inside a (cloned) node --------------
  function rewriteKCalls(node) {
    if (!node || typeof node.type !== "string") return;
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee, { name: det.dispName }) &&
      node.arguments.length >= 1 &&
      t.isArrayExpression(node.arguments[0])
    ) {
      let entry;
      try { entry = EV.evalArray(node.arguments[0], { arrays: {} }); }
      catch (e) { entry = null; }
      if (entry) {
        const name = nameForEntry(entry, false);
        node.callee = t.identifier(name);
        node.arguments = node.arguments.slice(1); // drop baked-in state vector
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => rewriteKCalls(c));
      else rewriteKCalls(child);
    }
  }

  // record closure assignments (prop = function(){return f_x(...)}) and
  // concrete call sites (prop(<concrete array>)) so nested VMs can resolve V.
  function recordClosures(node, env) {
    if (!node || typeof node.type !== "string") return;
    if (t.isAssignmentExpression(node) && t.isFunction(node.right)) {
      const lk = memberKey(node.left);
      const body = node.right.body;
      let ret = null;
      if (t.isBlockStatement(body)) ret = body.body.find((s) => t.isReturnStatement(s));
      const call = ret && ret.argument;
      if (lk && call && t.isCallExpression(call) && t.isIdentifier(call.callee)) {
        // is callee one of our generated funcs?
        for (const f of functions.values())
          if (f.name === call.callee.name) closureMap[lk] = f.name;
      }
    }
    if (t.isCallExpression(node)) {
      let callee = node.callee;
      if (t.isSequenceExpression(callee)) callee = callee.expressions[callee.expressions.length - 1];
      const ck = memberKey(callee);
      if (ck && closureMap[ck] && node.arguments.length >= 1) {
        try {
          const arr = EV.evalArray(node.arguments[0], env);
          concreteV[closureMap[ck]] = [arr]; // V = [ <args array> ]
        } catch (e) { /* not concrete */ }
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => recordClosures(c, env));
      else recordClosures(child, env);
    }
  }

  // ---- helpers for statement classification ------------------------------
  function isStateAssign(expr, stateKey) {
    return (
      t.isAssignmentExpression(expr) &&
      t.isMemberExpression(expr.left) &&
      memberKey(expr.left.object) === stateKey
    );
  }
  function applyStateAssign(expr, arr, env) {
    const idx = EV.num(EV.evalConst(expr.left.property, env));
    const rhs = EV.num(EV.evalConst(expr.right, env));
    if (expr.operator === "+=") arr[idx] += rhs;
    else if (expr.operator === "=") arr[idx] = rhs;
    else if (expr.operator === "-=") arr[idx] -= rhs;
    else if (expr.operator === "*=") arr[idx] *= rhs;
    else throw new Error("unsupported state op " + expr.operator);
  }
  function seqElems(expr) {
    return t.isSequenceExpression(expr) ? expr.expressions : [expr];
  }

  // gather statements from case index to end of a switch (fall-through aware)
  function gatherFrom(sw, idx) {
    let out = [];
    for (let j = idx; j < sw.cases.length; j++) out = out.concat(sw.cases[j].consequent);
    return out.map((s) => t.cloneNode(s, true)); // clone: folding mutates
  }

  function findCaseIndex(sw, S, sum, stateKey, extraArrays) {
    const env = { arrays: Object.assign({ [stateKey]: S }, extraArrays) };
    for (let i = 0; i < sw.cases.length; i++) {
      const c = sw.cases[i];
      if (!c.test) continue;
      let v;
      try { v = EV.evalConst(c.test, env); } catch (e) { v = null; }
      if (v && (v.t === "n" || v.t === "b") && +v.v === sum) return i;
    }
    return -1;
  }

  // ---- nested VM (data-driven, but concretely resolvable) linearizer -----
  // Returns an array of cleaned statements.
  function linearizeNestedVM(whileNode, outerS, vArr) {
    const sumCall = whileNode.test.left;
    const nestedKey = memberKey(sumCall.arguments[0]); // "T.F.a"
    const nestedTerminal = EV.num(EV.evalConst(whileNode.test.right, { arrays: {} }));
    const nsw = whileNode.body.body.find((s) => t.isSwitchStatement(s));
    if (!nestedKey || !nsw || !vArr) return null;
    const nS = vArr[0].slice(); // initial nested state = V[0]
    const out = [];
    let guard = 0;
    for (;;) {
      if (++guard > 100000) throw new Error("nested VM did not terminate");
      let sum = 0;
      for (const x of nS) sum += x;
      if (sum === nestedTerminal) break;
      // dispatch array is the nested state (T.F.a); the outer S is still bound
      // so that S-relative labels/indices resolve correctly.
      const ci = findCaseIndex(nsw, outerS, sum, SP, { [nestedKey]: nS });
      if (ci < 0) throw new Error("nested VM: no case for sum " + sum);
      const stmts = gatherFrom(nsw, ci);
      if (!stepStatements(stmts, nS, nestedKey, outerS, out, vArr)) {
        // no break encountered -> would loop forever; bail
        throw new Error("nested VM block had no break");
      }
    }
    return out;
  }

  // Execute a (cloned) statement list of a nested-VM block until a `break`.
  // Side-effects are folded (with both outer S and nested array concrete) and
  // pushed to `out`; nested-state assignments mutate `nArr`. Returns true if a
  // break was hit.
  function stepStatements(stmts, nArr, nestedKey, outerS, out, vArr) {
    for (const stmt of stmts) {
      if (t.isBreakStatement(stmt)) return true;
      const env = { arrays: { [SP]: outerS, [nestedKey]: nArr } };
      if (t.isExpressionStatement(stmt)) {
        for (const el of seqElems(stmt.expression)) {
          if (isStateAssign(el, nestedKey)) applyStateAssign(el, nArr, env);
          else {
            rewriteKCalls(el);
            const folded = fold(el, env);
            recordClosures(folded, env);
            out.push(t.expressionStatement(folded));
          }
        }
        continue;
      }
      if (t.isIfStatement(stmt)) {
        // live branch inside nested VM: condition is concrete here
        let cond;
        try { cond = EV.evalConst(stmt.test, env); } catch (e) { cond = null; }
        if (!cond) throw new Error("nested VM: non-concrete branch");
        const arm = cond.v ? stmt.consequent : stmt.alternate;
        if (!arm) continue;
        const body = t.isBlockStatement(arm) ? arm.body : [arm];
        if (stepStatements(body, nArr, nestedKey, outerS, out, vArr)) return true;
        continue;
      }
      // generic side-effect statement
      rewriteKCalls(stmt);
      const folded = fold(stmt, env);
      recordClosures(folded, env);
      out.push(folded);
    }
    return false; // no break
  }

  // ---- simulate one outer function ---------------------------------------
  function simulate(entryKey) {
    const fnRec = functions.get(entryKey);
    const entry = fnRec.entry;
    const vArr = concreteV[fnRec.name] || null;
    const blocks = new Map();
    const order = [];
    const stack = [entry.slice()];
    let guard = 0;

    while (stack.length) {
      if (++guard > 50000) throw new Error("block explosion in " + fnRec.name);
      const S = stack.pop();
      const key = S.join(",");
      if (blocks.has(key)) continue;
      const block = { key, code: [], term: null };
      blocks.set(key, block);
      order.push(key);

      let sum = 0; for (const x of S) sum += x;
      if (sum === ctx.terminal) { block.term = { kind: "exit" }; continue; }
      const ci = findCaseIndex(det.sw, S, sum, SP, {});
      if (ci < 0) throw new Error(`${fnRec.name}: no case matches sum ${sum} (S=[${S}])`);

      const stmts = gatherFrom(det.sw, ci);
      const cur = S.slice();
      let term = null;

      for (let si = 0; si < stmts.length && !term; si++) {
        const stmt = stmts[si];
        const env = { arrays: { [SP]: cur } };

        if (t.isBreakStatement(stmt)) {
          let ns = 0; for (const x of cur) ns += x;
          if (ns === ctx.terminal) term = { kind: "exit" };
          else { term = { kind: "goto", target: cur.join(",") }; stack.push(cur.slice()); }
          break;
        }
        if (t.isReturnStatement(stmt)) {
          let arg = null;
          if (stmt.argument) {
            rewriteKCalls(stmt.argument);
            arg = fold(stmt.argument, env);
            recordClosures(arg, env);
          }
          term = { kind: "return", arg };
          break;
        }
        if (t.isExpressionStatement(stmt)) {
          for (const el of seqElems(stmt.expression)) {
            if (isStateAssign(el, SP)) applyStateAssign(el, cur, env);
            else {
              rewriteKCalls(el);
              const folded = fold(el, env);
              recordClosures(folded, env);
              block.code.push(t.expressionStatement(folded));
            }
          }
          continue;
        }
        if (t.isIfStatement(stmt)) {
          // VM branch: both arms are transitions (possibly with side-effects)
          rewriteKCalls(stmt.test);
          const condNode = fold(stmt.test, env);
          recordClosures(condNode, env);
          const arms = [];
          for (const arm of [stmt.consequent, stmt.alternate]) {
            const armS = cur.slice();
            const armEnv = { arrays: { [SP]: armS } };
            const se = [];
            const body = arm ? (t.isBlockStatement(arm) ? arm.body : [arm]) : [];
            let hitBreak = false;
            for (const bs of body) {
              if (t.isBreakStatement(bs)) { hitBreak = true; break; }
              if (t.isExpressionStatement(bs)) {
                for (const el of seqElems(bs.expression)) {
                  if (isStateAssign(el, SP)) applyStateAssign(el, armS, armEnv);
                  else { rewriteKCalls(el); se.push(t.expressionStatement(fold(el, armEnv))); }
                }
              } else { rewriteKCalls(bs); se.push(fold(bs, armEnv)); }
            }
            let ns = 0; for (const x of armS) ns += x;
            const exit = ns === ctx.terminal;
            if (!exit) stack.push(armS.slice());
            arms.push({ se, target: exit ? null : armS.join(","), exit });
          }
          term = { kind: "branch", cond: condNode, then: arms[0], else: arms[1] };
          break;
        }
        if (t.isWhileStatement(stmt)) {
          // nested VM
          const lin = linearizeNestedVM(stmt, cur, vArr);
          if (lin) block.code.push(...lin);
          else block.code.push(stmt); // fallback: keep raw
          continue;
        }
        // generic side-effect statement (for-loops, declarations, etc.)
        rewriteKCalls(stmt);
        const folded = fold(stmt, env);
        recordClosures(folded, env);
        block.code.push(folded);
      }

      if (!term) {
        // fell off the end of the case body without break/return: re-dispatch
        let ns = 0; for (const x of cur) ns += x;
        if (ns === ctx.terminal) term = { kind: "exit" };
        else { term = { kind: "goto", target: cur.join(",") }; stack.push(cur.slice()); }
      }
      block.term = term;
    }

    fnRec.blocks = blocks;
    fnRec.order = order;
  }

  // ---- seed with the main entry and process the worklist -----------------
  const mainEntry = EV.evalArray(det.mainCall.arguments[0], { arrays: {} });
  nameForEntry(mainEntry, true);
  while (worklist.length) {
    const key = worklist.shift();
    if (functions.get(key).blocks) continue;
    simulate(key);
  }

  // ---- peephole: collapse pure "relay" blocks (empty body, single goto) --
  function optimize(fnRec) {
    const blocks = fnRec.blocks;
    const isRelay = (b) => b && b.code.length === 0 && b.term.kind === "goto";
    function resolve(key) {
      const seen = new Set();
      let cur = key;
      while (isRelay(blocks.get(cur))) {
        if (seen.has(cur)) return cur; // relay cycle -> leave as-is
        seen.add(cur);
        cur = blocks.get(cur).term.target;
      }
      return cur;
    }
    for (const b of blocks.values()) {
      if (b.term.kind === "goto") b.term.target = resolve(b.term.target);
      else if (b.term.kind === "branch") {
        if (!b.term.then.exit) b.term.then.target = resolve(b.term.then.target);
        if (!b.term.else.exit) b.term.else.target = resolve(b.term.else.target);
      }
    }
    const entryKey = resolve(fnRec.entry.join(","));
    const reachable = new Set();
    const stack = [entryKey];
    while (stack.length) {
      const k = stack.pop();
      if (reachable.has(k)) continue;
      reachable.add(k);
      const b = blocks.get(k);
      if (!b) continue;
      if (b.term.kind === "goto") stack.push(b.term.target);
      else if (b.term.kind === "branch") {
        if (!b.term.then.exit) stack.push(b.term.then.target);
        if (!b.term.else.exit) stack.push(b.term.else.target);
      }
    }
    fnRec.order = fnRec.order.filter((k) => reachable.has(k));
    fnRec.entryKey = entryKey;
  }
  for (const fnRec of functions.values()) optimize(fnRec);

  // ---- structured control-flow recovery ----------------------------------
  // Iterative dominators (Cooper/Harvey/Kennedy). Reused for post-dominators
  // by passing the reversed edge functions and EXIT as the entry.
  function computeIdom(entry, getSucc, getPred) {
    const post = [];
    const seen = new Set();
    (function dfs(n) {
      seen.add(n);
      for (const s of getSucc(n)) if (!seen.has(s)) dfs(s);
      post.push(n);
    })(entry);
    const rpo = post.slice().reverse();
    const order = new Map();
    rpo.forEach((n, i) => order.set(n, i));
    const idom = new Map();
    idom.set(entry, entry);
    function intersect(a, b) {
      while (a !== b) {
        while (order.get(a) > order.get(b)) a = idom.get(a);
        while (order.get(b) > order.get(a)) b = idom.get(b);
      }
      return a;
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of rpo) {
        if (n === entry) continue;
        let nd = null;
        for (const p of getPred(n)) {
          if (!order.has(p)) continue;
          if (idom.has(p)) nd = nd == null ? p : intersect(p, nd);
        }
        if (nd != null && idom.get(n) !== nd) { idom.set(n, nd); changed = true; }
      }
    }
    return idom;
  }

  const EXIT = "$exit";
  // Recover structured statements for a function; returns a BlockStatement, or
  // null if the CFG is cyclic / irreducible (caller falls back to the switch).
  function tryStructure(fnRec) {
    const blocks = fnRec.blocks;
    const order = fnRec.order;
    const entryKey = fnRec.entryKey || fnRec.entry.join(",");

    const succOf = (k) => {
      if (k === EXIT) return [];
      const tm = blocks.get(k).term;
      if (tm.kind === "goto") return [tm.target];
      if (tm.kind === "branch")
        return [tm.then.exit ? EXIT : tm.then.target, tm.else.exit ? EXIT : tm.else.target];
      return [EXIT]; // return / exit
    };
    const predMap = new Map(order.concat([EXIT]).map((n) => [n, []]));
    for (const n of order) for (const s of succOf(n)) if (predMap.has(s)) predMap.get(s).push(n);
    const predOf = (k) => predMap.get(k) || [];

    // cycle detection (white=0 / gray=1 / black=2)
    const color = new Map();
    let cyclic = false;
    (function dfs(n) {
      color.set(n, 1);
      for (const s of succOf(n)) {
        if (color.get(s) === 1) { cyclic = true; return; }
        if (!color.get(s)) { dfs(s); if (cyclic) return; }
      }
      color.set(n, 2);
    })(entryKey);
    if (cyclic) return null;

    const postIdom = computeIdom(EXIT, predOf, succOf);
    const ipdomOf = (n) => postIdom.get(n);

    const visited = new Set();
    const UNSTRUCT = {};
    const flip = { "==": "!=", "!=": "==", "===": "!==", "!==": "===", "<": ">=", ">": "<=", "<=": ">", ">=": "<" };
    const negate = (c) => {
      if (t.isBinaryExpression(c) && flip[c.operator]) return t.binaryExpression(flip[c.operator], c.left, c.right);
      if (t.isUnaryExpression(c, { operator: "!" })) return c.argument;
      return t.unaryExpression("!", c);
    };
    const buildIf = (cond, thenS, elseS) => {
      if (thenS.length === 0 && elseS.length > 0) return t.ifStatement(negate(cond), t.blockStatement(elseS));
      if (elseS.length === 0) return t.ifStatement(cond, t.blockStatement(thenS));
      return t.ifStatement(cond, t.blockStatement(thenS), t.blockStatement(elseS));
    };
    const armStmts = (a, join) => {
      const out = (a.se || []).map((s) => t.cloneNode(s, true));
      if (a.exit) { out.push(t.returnStatement()); return out; }
      if (a.target === join) return out;
      out.push(...genSeq(a.target, join));
      return out;
    };
    function genSeq(start, stop) {
      const out = [];
      let n = start;
      while (n !== stop && n !== EXIT) {
        if (visited.has(n)) throw UNSTRUCT;
        visited.add(n);
        const b = blocks.get(n);
        for (const s of b.code) out.push(t.cloneNode(s, true));
        const tm = b.term;
        if (tm.kind === "return") { out.push(t.returnStatement(tm.arg ? t.cloneNode(tm.arg, true) : null)); return out; }
        if (tm.kind === "exit") { out.push(t.returnStatement()); return out; }
        if (tm.kind === "goto") { n = tm.target; continue; }
        if (tm.kind === "branch") {
          const join = ipdomOf(n);
          out.push(buildIf(tm.cond, armStmts(tm.then, join), armStmts(tm.else, join)));
          if (join === EXIT || join == null) return out;
          n = join;
          continue;
        }
        return out;
      }
      return out;
    }
    try { return t.blockStatement(genSeq(entryKey, EXIT)); }
    catch (e) { if (e === UNSTRUCT) return null; throw e; }
  }

  function paramsForFunction() {
    const params = [t.identifier("T"), t.identifier("U"), t.identifier("V")];
    const tDefault = det.disp.params[1];
    if (t.isAssignmentPattern(tDefault))
      params[0] = t.assignmentPattern(t.identifier("T"), t.cloneNode(tDefault.right, true));
    return params;
  }

  // ---- emit each function (structured if possible, else state machine) ---
  function emitFunction(fnRec) {
    const structured = tryStructure(fnRec);
    if (structured)
      return t.functionDeclaration(t.identifier(fnRec.name), paramsForFunction(), structured);

    const order = fnRec.order;
    const idOf = new Map();
    order.forEach((k, i) => idOf.set(k, i));
    const entryId = idOf.get(fnRec.entryKey || fnRec.entry.join(","));

    function transition(term) {
      // returns array of statements implementing the block terminator
      if (term.kind === "exit") return [t.returnStatement()];
      if (term.kind === "return") return [t.returnStatement(term.arg || null)];
      if (term.kind === "goto")
        return [
          t.expressionStatement(t.assignmentExpression("=", t.identifier("state"), litNum(idOf.get(term.target)))),
          t.breakStatement(),
        ];
      if (term.kind === "branch") {
        const armStmts = (arm) => {
          const s = arm.se.slice();
          if (arm.exit) s.push(t.returnStatement());
          else s.push(t.expressionStatement(t.assignmentExpression("=", t.identifier("state"), litNum(idOf.get(arm.target)))));
          return s;
        };
        return [
          t.ifStatement(term.cond, t.blockStatement(armStmts(term.then)), t.blockStatement(armStmts(term.else))),
          t.breakStatement(),
        ];
      }
      // nomatch / unknown
      return [t.throwStatement(t.newExpression(t.identifier("Error"), [t.stringLiteral("deobf: unreachable")]))];
    }

    const cases = order.map((k, i) => {
      const b = fnRec.blocks.get(k);
      const body = b.code.concat(transition(b.term));
      return t.switchCase(litNum(i), [t.blockStatement(body)]);
    });

    const loop = t.forStatement(
      null, null, null,
      t.blockStatement([t.switchStatement(t.identifier("state"), cases)])
    );
    const fnBody = t.blockStatement([
      t.variableDeclaration("let", [t.variableDeclarator(t.identifier("state"), litNum(entryId))]),
      loop,
    ]);

    return t.functionDeclaration(t.identifier(fnRec.name), paramsForFunction(), fnBody);
  }

  const emittedFns = [];
  for (const fnRec of functions.values()) emittedFns.push(emitFunction(fnRec));

  // ---- promote the shared outer scope `T["o"]` to plain variables --------
  // The "o" scope is a single object instance created once (f_main's default
  // `{o:{}}`) and threaded by reference into every function, never reassigned.
  // Its properties are therefore semantically global variables, so each static
  // `T["o"][<prop>]` access can be rewritten to a top-level `var o_<prop>`.
  // (e.g. the shared game-state `T["o"]["i"]` -> `o_i`.)
  function staticProp(m) {
    if (!m.computed && t.isIdentifier(m.property)) return m.property.name;
    if (m.computed && t.isStringLiteral(m.property)) return m.property.value;
    return null;
  }
  function promoteScope(scopeKey) {
    const props = new Set();
    const okName = (p) => /^[A-Za-z_$][\w$]*$/.test(p);
    function rep(node) {
      if (!node || typeof node.type !== "string") return node;
      if (t.isMemberExpression(node) && memberKey(node.object) === "T." + scopeKey) {
        const p = staticProp(node);
        if (p != null && okName(p)) { props.add(p); return t.identifier(scopeKey + "_" + p); }
      }
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) {
          for (let i = 0; i < child.length; i++)
            if (child[i] && typeof child[i].type === "string") child[i] = rep(child[i]);
        } else if (child && typeof child.type === "string") node[key] = rep(child);
      }
      return node;
    }
    for (const fn of emittedFns) rep(fn.body);
    return props;
  }
  // After promotion nothing reads `T["o"]` anymore, so drop the now-vestigial
  // `["o"]: T["o"]` / `["o"]: {}` scope-threading from object literals & defaults.
  function stripScopeThreading(scopeKey) {
    const keyMatch = (p) =>
      (t.isObjectProperty(p) &&
        ((!p.computed && t.isIdentifier(p.key, { name: scopeKey })) ||
          (t.isStringLiteral(p.key, { value: scopeKey }))) &&
        (t.isObjectExpression(p.value) && p.value.properties.length === 0 ||
          memberKey(p.value) === "T." + scopeKey));
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isObjectExpression(node)) node.properties = node.properties.filter((p) => !keyMatch(p));
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    }
    for (const fn of emittedFns) { walk(fn.body); fn.params.forEach(walk); }
  }

  // --- discover every scope key used as `T[<key>][...]` -------------------
  function discoverScopes() {
    const keys = new Set();
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isMemberExpression(node) && t.isIdentifier(node.object, { name: "T" })) {
        const p = staticProp(node);
        if (p != null) keys.add(p);
      }
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    }
    for (const fn of emittedFns) walk(fn.body);
    return [...keys];
  }

  // --- remove whole-scope init statements: `T[<scope>] = ...;` -------------
  function removeWholeScopeAssigns(scopeKeys) {
    const set = new Set(scopeKeys.map((s) => "T." + s));
    const isInit = (st) =>
      t.isExpressionStatement(st) &&
      t.isAssignmentExpression(st.expression, { operator: "=" }) &&
      set.has(memberKey(st.expression.left));
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isBlockStatement(node) || t.isProgram(node))
        node.body = node.body.filter((st) => !isInit(st));
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    }
    for (const fn of emittedFns) walk(fn.body);
  }

  // --- hoist `<ident> = function(...){...}` to a function declaration ------
  function hoistClosures() {
    const decls = [];
    const names = new Set();
    const isClosureAssign = (st) =>
      t.isExpressionStatement(st) &&
      t.isAssignmentExpression(st.expression, { operator: "=" }) &&
      t.isIdentifier(st.expression.left) &&
      t.isFunctionExpression(st.expression.right);
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isBlockStatement(node) || t.isProgram(node)) {
        node.body = node.body.filter((st) => {
          if (!isClosureAssign(st)) return true;
          const name = st.expression.left.name;
          const fe = st.expression.right;
          decls.push(t.functionDeclaration(t.identifier(name), fe.params, fe.body));
          names.add(name);
          return false;
        });
      }
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    }
    for (const fn of emittedFns) walk(fn.body);
    return { decls, names };
  }

  // --- simplify obfuscator's `(0, X)(...)` indirect-call form to `X(...)` --
  function simplifySeqCallees(roots) {
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isCallExpression(node) && t.isSequenceExpression(node.callee)) {
        const seq = node.callee.expressions;
        node.callee = seq[seq.length - 1];
      }
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    }
    roots.forEach((r) => walk(r));
  }

  // --- remove unused parameters (fixpoint) and fix every call site --------
  const paramName = (p) =>
    t.isRestElement(p) ? p.argument.name
    : t.isAssignmentPattern(p) && t.isIdentifier(p.left) ? p.left.name
    : t.isIdentifier(p) ? p.name
    : null;
  function refersTo(fnNode, name) {
    let found = false;
    (function walk(n, shadowed) {
      if (found || !n || typeof n.type !== "string") return;
      if (!shadowed && t.isIdentifier(n) && n.name === name) { found = true; return; }
      if (t.isObjectProperty(n) && !n.computed) { walk(n.value, shadowed); return; }
      if (t.isMemberExpression(n) && !n.computed) { walk(n.object, shadowed); return; }
      let sh = shadowed;
      if (t.isFunction(n) && n.params.some((p) => paramName(p) === name)) sh = true;
      for (const key of t.VISITOR_KEYS[n.type] || []) {
        const child = n[key];
        if (Array.isArray(child)) child.forEach((x) => walk(x, sh));
        else walk(child, sh);
      }
    })(fnNode.body, false);
    return found;
  }
  function fixCallArgs(name, plan, roots) {
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name })) {
        const args = node.arguments;
        const out = [];
        for (const { index, isRest, keep } of plan) {
          if (isRest) { if (keep) out.push(...args.slice(index)); }
          else if (keep && index < args.length) out.push(args[index]);
        }
        node.arguments = out;
      }
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(walk);
        else walk(child);
      }
    }
    roots.forEach((r) => walk(r));
  }
  function removeUnusedParams(allFns, roots) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const fn of allFns) {
        if (!fn.params.length) continue;
        const keepFlags = fn.params.map((p) => {
          const nm = paramName(p);
          return nm == null ? true : refersTo(fn, nm);
        });
        if (keepFlags.every(Boolean)) continue;
        const plan = fn.params.map((p, i) => ({ index: i, isRest: t.isRestElement(p), keep: keepFlags[i] }));
        fn.params = fn.params.filter((_, i) => keepFlags[i]);
        fixCallArgs(fn.id.name, plan, roots);
        changed = true;
      }
    }
  }

  // --- rename identifier *references* (skip member/property keys & binders) -
  function replaceIdents(node, rename) {
    if (!node || typeof node.type !== "string") return node;
    if (t.isIdentifier(node) && rename.has(node.name)) return t.identifier(rename.get(node.name));
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      if (t.isMemberExpression(node) && key === "property" && !node.computed) continue;
      if ((t.isObjectProperty(node) || t.isObjectMethod(node)) && key === "key" && !node.computed) continue;
      if (t.isFunction(node) && (key === "id" || key === "params")) continue;
      const child = node[key];
      if (Array.isArray(child)) { for (let i = 0; i < child.length; i++) child[i] = replaceIdents(child[i], rename); }
      else node[key] = replaceIdents(child, rename);
    }
    return node;
  }

  // --- inline pure forwarders/delegators: a no-param function whose whole
  //     body is `return F();` or `F();` (a single no-arg call) -> F ---------
  function inlineTrivialForwarders(fns, extraRoots) {
    const fwdTarget = (fn) => {
      if (fn.params.length !== 0 || fn.body.body.length !== 1) return null;
      const st = fn.body.body[0];
      const call = t.isReturnStatement(st) ? st.argument : t.isExpressionStatement(st) ? st.expression : null;
      if (!call || !t.isCallExpression(call) || !t.isIdentifier(call.callee) || call.arguments.length !== 0) return null;
      return call.callee.name;
    };
    const tgt = new Map();
    for (const fn of fns) { const tn = fwdTarget(fn); if (tn) tgt.set(fn.id.name, tn); }
    if (!tgt.size) return new Set();
    const resolve = (n) => { const seen = new Set(); while (tgt.has(n) && !seen.has(n)) { seen.add(n); n = tgt.get(n); } return n; };
    const rename = new Map([...tgt.keys()].map((n) => [n, resolve(n)]));
    function rep(node) {
      if (!node || typeof node.type !== "string") return node;
      // a call to a forwarder: forward to the final target, dropping pure
      // (ignored) arguments since the forwarder takes & passes none.
      if (t.isCallExpression(node) && t.isIdentifier(node.callee) && rename.has(node.callee.name)) {
        const finalName = rename.get(node.callee.name);
        const args = node.arguments.every(isPureExpr) ? [] : node.arguments.map((a) => rep(a));
        return t.callExpression(t.identifier(finalName), args);
      }
      if (t.isIdentifier(node) && rename.has(node.name)) return t.identifier(rename.get(node.name));
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        if (t.isMemberExpression(node) && key === "property" && !node.computed) continue;
        if ((t.isObjectProperty(node) || t.isObjectMethod(node)) && key === "key" && !node.computed) continue;
        if (t.isFunction(node) && (key === "id" || key === "params")) continue;
        const child = node[key];
        if (Array.isArray(child)) { for (let i = 0; i < child.length; i++) child[i] = rep(child[i]); }
        else node[key] = rep(child);
      }
      return node;
    }
    for (const fn of fns) if (!tgt.has(fn.id.name)) rep(fn.body);
    for (const r of extraRoots) rep(r);
    return new Set(tgt.keys());
  }

  // --- purity check (no calls / assignments / updates) --------------------
  function isPureExpr(n) {
    let pure = true;
    (function w(x) {
      if (!pure || !x || typeof x.type !== "string") return;
      if (t.isCallExpression(x) || t.isNewExpression(x) || t.isUpdateExpression(x) ||
        t.isAssignmentExpression(x) || t.isAwaitExpression(x) || t.isYieldExpression(x)) { pure = false; return; }
      for (const k of t.VISITOR_KEYS[x.type] || []) { const c = x[k]; if (Array.isArray(c)) c.forEach(w); else w(c); }
    })(n);
    return pure;
  }

  // --- variable usage analysis (distinguishes value-reads from writes) ----
  function analyzeUsage(roots, candidates) {
    const u = new Map();
    const get = (n) => { if (!u.has(n)) u.set(n, { liveReads: 0, assigns: [], otherWrites: 0 }); return u.get(n); };
    function readExpr(n) {
      if (!n || typeof n.type !== "string") return;
      if (t.isIdentifier(n)) { if (candidates.has(n.name)) get(n.name).liveReads++; return; }
      if (t.isAssignmentExpression(n)) {
        if (n.operator === "=" && t.isIdentifier(n.left)) {
          if (candidates.has(n.left.name)) get(n.left.name).assigns.push(n);
        } else targetExpr(n.left, n.operator !== "=");
        readExpr(n.right); return;
      }
      if (t.isUpdateExpression(n)) { targetExpr(n.argument, true); return; }
      if (t.isMemberExpression(n)) { readExpr(n.object); if (n.computed) readExpr(n.property); return; }
      if (t.isObjectProperty(n)) { if (n.computed) readExpr(n.key); readExpr(n.value); return; }
      for (const key of t.VISITOR_KEYS[n.type] || []) { const c = n[key]; if (Array.isArray(c)) c.forEach(readExpr); else readExpr(c); }
    }
    function targetExpr(n, compound) {
      if (!n || typeof n.type !== "string") return;
      if (t.isIdentifier(n)) { if (candidates.has(n.name)) { const g = get(n.name); g.otherWrites++; if (compound) g.liveReads++; } return; }
      if (t.isMemberExpression(n)) {
        let b = n; while (t.isMemberExpression(b)) { if (b.computed) readExpr(b.property); b = b.object; }
        if (t.isIdentifier(b)) { if (candidates.has(b.name)) get(b.name).otherWrites++; } else readExpr(b);
        return;
      }
      if (t.isArrayPattern(n)) { for (const el of n.elements) if (el) targetExpr(el, false); return; }
      if (t.isObjectPattern(n)) { for (const p of n.properties) { if (t.isRestElement(p)) targetExpr(p.argument, false); else { if (p.computed) readExpr(p.key); targetExpr(p.value, false); } } return; }
      if (t.isAssignmentPattern(n)) { targetExpr(n.left, false); readExpr(n.right); return; }
      if (t.isRestElement(n)) { targetExpr(n.argument, false); return; }
      readExpr(n);
    }
    roots.forEach(readExpr);
    return u;
  }

  // --- propagate `X = undefined` (only ever undefined) to its reads -------
  function propagateConstUndefined(roots, candidates) {
    const usage = analyzeUsage(roots, candidates);
    const isUndef = (e) => t.isIdentifier(e, { name: "undefined" }) || t.isUnaryExpression(e, { operator: "void" });
    const targets = new Set();
    for (const n of candidates) {
      const u = usage.get(n);
      if (u && u.assigns.length && u.otherWrites === 0 && u.assigns.every((a) => isUndef(a.right))) targets.add(n);
    }
    if (!targets.size) return false;
    let changed = false;
    function rep(node) {
      if (!node || typeof node.type !== "string") return node;
      if (t.isAssignmentExpression(node, { operator: "=" }) && t.isIdentifier(node.left) && targets.has(node.left.name)) {
        node.right = rep(node.right); return node; // keep the LHS binding
      }
      if (t.isIdentifier(node) && targets.has(node.name)) { changed = true; return t.identifier("undefined"); }
      for (const key of t.VISITOR_KEYS[node.type] || []) {
        if (t.isMemberExpression(node) && key === "property" && !node.computed) continue;
        if ((t.isObjectProperty(node) || t.isObjectMethod(node)) && key === "key" && !node.computed) continue;
        const child = node[key];
        if (Array.isArray(child)) { for (let i = 0; i < child.length; i++) child[i] = rep(child[i]); }
        else node[key] = rep(child);
      }
      return node;
    }
    roots.forEach(rep);
    return changed;
  }

  // --- fold `if (<constant>) {..} else {..}` to the taken branch ----------
  function foldConstantIfs(roots) {
    let changed = false;
    const truth = (n) =>
      t.isBooleanLiteral(n) ? n.value
      : t.isNumericLiteral(n) ? !!n.value
      : t.isStringLiteral(n) ? !!n.value
      : t.isNullLiteral(n) ? false
      : t.isIdentifier(n, { name: "undefined" }) ? false
      : t.isUnaryExpression(n, { operator: "void" }) ? false
      : undefined;
    function processBody(arr) {
      const out = [];
      for (const st of arr) {
        if (t.isIfStatement(st)) {
          const v = truth(st.test);
          if (v !== undefined) {
            changed = true;
            const branch = v ? st.consequent : st.alternate;
            if (branch) { if (t.isBlockStatement(branch)) out.push(...branch.body); else out.push(branch); }
            continue;
          }
        }
        out.push(st);
      }
      return out;
    }
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isBlockStatement(node) || t.isProgram(node)) node.body = processBody(node.body);
      for (const key of t.VISITOR_KEYS[node.type] || []) { const c = node[key]; if (Array.isArray(c)) c.forEach(walk); else walk(c); }
    }
    roots.forEach(walk);
    return changed;
  }

  // --- eliminate writes to variables that are never read ------------------
  function deadStoreElim(roots, candidates) {
    const usage = analyzeUsage(roots, candidates);
    const dead = new Set([...candidates].filter((n) => (usage.get(n) ? usage.get(n).liveReads : 0) === 0));
    if (!dead.size) return false;
    let changed = false;
    function lhsAllDead(left) {
      if (t.isIdentifier(left)) return dead.has(left.name);
      if (t.isMemberExpression(left)) { let b = left; while (t.isMemberExpression(b)) b = b.object; return t.isIdentifier(b) && dead.has(b.name); }
      if (t.isArrayPattern(left)) return left.elements.every((el) => el == null || lhsAllDead(el));
      if (t.isObjectPattern(left)) return left.properties.every((p) => t.isRestElement(p) ? lhsAllDead(p.argument) : lhsAllDead(p.value));
      if (t.isAssignmentPattern(left)) return lhsAllDead(left.left);
      if (t.isRestElement(left)) return lhsAllDead(left.argument);
      return false;
    }
    function processBody(arr) {
      const out = [];
      for (const st of arr) {
        if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression) && lhsAllDead(st.expression.left)) {
          changed = true;
          if (!isPureExpr(st.expression.right)) out.push(t.expressionStatement(st.expression.right));
          continue;
        }
        out.push(st);
      }
      return out;
    }
    function walk(node) {
      if (!node || typeof node.type !== "string") return;
      if (t.isBlockStatement(node) || t.isProgram(node)) node.body = processBody(node.body);
      for (const key of t.VISITOR_KEYS[node.type] || []) { const c = node[key]; if (Array.isArray(c)) c.forEach(walk); else walk(c); }
    }
    roots.forEach(walk);
    return changed;
  }

  // --- prefer dot notation for identifier-like string keys ----------------
  function bracketsToDots(node) {
    const idRe = /^[A-Za-z_$][\w$]*$/;
    if (!node || typeof node.type !== "string") return;
    if (t.isMemberExpression(node) && node.computed && t.isStringLiteral(node.property) && idRe.test(node.property.value)) {
      node.property = t.identifier(node.property.value);
      node.computed = false;
    }
    if (t.isObjectProperty(node) && t.isStringLiteral(node.key) && idRe.test(node.key.value)) {
      node.key = t.identifier(node.key.value);
      node.computed = false;
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(bracketsToDots);
      else bracketsToDots(child);
    }
  }

  // --- drop a redundant trailing `return undefined;` / `return;` ----------
  function stripTrailingVoidReturns(fns) {
    let changed = false;
    for (const fn of fns) {
      const body = fn.body.body;
      const last = body[body.length - 1];
      if (last && t.isReturnStatement(last) && (last.argument == null || t.isIdentifier(last.argument, { name: "undefined" }))) {
        body.pop();
        changed = true;
      }
    }
    return changed;
  }

  // --- run the de-scoping pipeline ----------------------------------------
  const scopeKeys = discoverScopes();
  const scopeProps = {};
  for (const s of scopeKeys) scopeProps[s] = promoteScope(s);
  for (const s of scopeKeys) stripScopeThreading(s);
  removeWholeScopeAssigns(scopeKeys);
  const { decls: hoistedFns, names: hoistedNames } = hoistClosures();
  const allTopFns = emittedFns.concat(hoistedFns);
  // include the trailing `f_main()` call as a fixup root too
  const mainName = functions.get(mainEntry.join(",")).name;
  const mainCallStmt = t.expressionStatement(t.callExpression(t.identifier(mainName), []));
  simplifySeqCallees(allTopFns.map((f) => f.body).concat([mainCallStmt]));

  // candidates for DCE / const-propagation: the flattened scope variables that
  // are plain data (not the hoisted closure functions).
  const candidates = new Set();
  for (const s of scopeKeys)
    for (const p of scopeProps[s]) { const nm = s + "_" + p; if (!hoistedNames.has(nm)) candidates.add(nm); }

  // run cleanup passes to a fixpoint: const-undefined propagation, constant-if
  // folding, dead-store elimination, redundant-return stripping, unused-param
  // removal, trivial-forwarder inlining, and single-use void-helper inlining.
  let keptFns = allTopFns.slice();
  for (let i = 0; i < 100; i++) {
    const rts = keptFns.map((f) => f.body).concat([mainCallStmt]);
    let changed = false;
    if (propagateConstUndefined(rts, candidates)) changed = true;
    if (foldConstantIfs(rts)) changed = true;
    if (deadStoreElim(rts, candidates)) changed = true;
    if (stripTrailingVoidReturns(keptFns)) changed = true;
    const sig = keptFns.map((f) => f.id.name + ":" + f.params.length).join(",");
    removeUnusedParams(keptFns, rts);
    const fwd = inlineTrivialForwarders(keptFns, [mainCallStmt]);
    if (fwd.size) keptFns = keptFns.filter((f) => !fwd.has(f.id.name));
    if (keptFns.map((f) => f.id.name + ":" + f.params.length).join(",") !== sig) changed = true;
    if (!changed) break;
  }

  // --- declare the scope variables that survived --------------------------
  const stillUsed = new Set();
  (function collect(node) {
    if (!node || typeof node.type !== "string") return;
    if (t.isIdentifier(node)) stillUsed.add(node.name);
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      if (t.isMemberExpression(node) && key === "property" && !node.computed) continue;
      const c = node[key];
      if (Array.isArray(c)) c.forEach(collect); else collect(c);
    }
  })(t.program(keptFns.map((f) => f.body)));
  const scopeDecls = [];
  const varNames = [...candidates].filter((n) => stillUsed.has(n)).sort();
  if (varNames.length)
    scopeDecls.push(
      t.variableDeclaration("var", varNames.map((n) => t.variableDeclarator(t.identifier(n))))
    );

  // ---- detect residual decoder/sum usage ---------------------------------
  let needsDecoder = false, needsSum = false;
  for (const fn of keptFns) {
    const code = generate(fn).code;
    if (det.decoderName && new RegExp("\\b" + det.decoderName + "\\s*\\(").test(code)) needsDecoder = true;
    if (det.sumName && new RegExp("\\b" + det.sumName + "\\s*\\(").test(code)) needsSum = true;
  }

  // ---- assemble the new program ------------------------------------------
  const out = [];
  out.push(...scopeDecls);
  if (needsDecoder && det.funcs[det.decoderName]) out.push(t.cloneNode(det.funcs[det.decoderName], true));
  if (needsSum && det.funcs[det.sumName]) out.push(t.cloneNode(det.funcs[det.sumName], true));
  out.push(...keptFns);
  out.push(mainCallStmt);

  const program = t.program(out);
  bracketsToDots(program);
  const result = generate(program, { comments: true, jsescOption: { minimal: true } });
  return {
    code: result.code,
    changed: true,
    info: { functions: [...functions.values()].map((f) => f.name + " (" + f.order.length + " blocks)") },
  };
}

module.exports = { deobfuscate, detect, memberKey };
