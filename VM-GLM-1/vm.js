"use strict";
/**
 * vm.js — AST devirtualizer for JS-Confuser-VM 0.1.5 obfuscation.
 *
 * Usage:  node vm.js input.js output.js
 * API:    require('./vm.js')(inputPath [, outputPath]) -> deobfuscated code string
 *
 * Pipeline:
 *   1. Extract the VM from the AST (dispatcher, handler table, constants pool,
 *      bytecode, entry function metadata) — structurally, not by names.
 *   2. Classify every numbered opcode handler into a semantic archetype via a
 *      symbolic interpreter (immune to randomized opcode numbers, decoy
 *      operands, operand shuffles, specialized/aliased variants).
 *   3. Disassemble the bytecode (emulating the runtime self-decode opcode).
 *   4. Lift each VM function back to JavaScript with CFG reconstruction
 *      (undoes control-flow flattening state machines), closures, try/catch,
 *      for-in, calls, spreads, getters/setters.
 *   5. Generate the output program.
 */

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverseMod = require("@babel/traverse");
const traverse = traverseMod.default || traverseMod;
const generatorMod = require("@babel/generator");
const generate = generatorMod.default || generatorMod;
const t = require("@babel/types");

const DEBUG = !!process.env.VM_DEBUG;
function dbg(...args) {
  if (DEBUG) console.error("[vm]", ...args);
}

/* ================================================================== */
/* SECTION 1 — VM extraction from the AST                              */
/* ================================================================== */

function extractVM(ast) {
  // dispatcher: `<X>.<m> = function(){ ... this[<k>]() ... try/catch ... }`
  let dispatcher = null;
  traverse(ast, {
    AssignmentExpression(p) {
      const n = p.node;
      if (
        !dispatcher &&
        n.left.type === "MemberExpression" &&
        !n.left.computed &&
        n.right.type === "FunctionExpression"
      ) {
        let hasDispatch = false;
        let hasCatch = false;
        p.get("right").traverse({
          CallExpression(cp) {
            const c = cp.node.callee;
            if (c.type === "MemberExpression" && c.object.type === "ThisExpression" && c.computed) hasDispatch = true;
          },
          CatchClause() { hasCatch = true; },
        });
        if (hasDispatch && hasCatch) dispatcher = p;
      }
    },
  });
  if (!dispatcher) return null;

  const protoOwner = dispatcher.node.left.object; // q.prototype
  const protoOwnerCode = generate(protoOwner).code;
  const vmCtorName = (/^(.*)\.prototype$/.exec(protoOwnerCode) || [])[1] || null;

  // handler alias: `var z = q.prototype`
  let handlerVar = null;
  traverse(ast, {
    VariableDeclarator(p) {
      if (!handlerVar && p.node.init && generate(p.node.init).code === protoOwnerCode) {
        handlerVar = p.node.id.name;
      }
    },
  });
  if (!handlerVar) return null;

  // handler table: z[NUMBER] = function(){}
  const handlers = new Map();
  traverse(ast, {
    AssignmentExpression(p) {
      const n = p.node;
      if (
        n.left.type === "MemberExpression" &&
        n.left.computed &&
        n.left.object.type === "Identifier" &&
        n.left.object.name === handlerVar &&
        n.left.property.type === "NumericLiteral" &&
        n.right.type === "FunctionExpression" &&
        n.right.params.length === 0
      ) {
        handlers.set(n.left.property.value, n.right);
      }
    },
  });
  if (!handlers.size) return null;

  // WeakMap var
  let weakMapVar = null;
  traverse(ast, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!weakMapVar && n.init && n.init.type === "NewExpression" && n.init.callee.type === "Identifier" && n.init.callee.name === "WeakMap" && !n.init.arguments.length) {
        weakMapVar = n.id.name;
      }
    },
  });

  // constants decoder member (y): rolling XOR with fromCharCode
  let decoderMult = 2654435769;
  traverse(ast, {
    AssignmentExpression(p) {
      const n = p.node;
      if (
        n.right.type === "FunctionExpression" &&
        n.left.type === "MemberExpression" &&
        !n.left.computed &&
        generate(n.left.object).code === protoOwnerCode
      ) {
        const code = generate(n.right).code;
        if (code.includes("fromCharCode")) {
          const mMult = /\+ ?(\d{7,12})/.exec(code);
          if (mMult) decoderMult = Number(mMult[1]);
        }
      }
    },
  });

  // entry: `(new q(<consts>, <globals>, <bcVar>)).r(_, _, new u({m,b,v[,a]}), _)`
  let constants = null;
  let bytecode = null;
  let entryMeta = null;
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (
        !entryMeta &&
        n.callee.type === "MemberExpression" &&
        n.callee.object.type === "NewExpression" &&
        n.callee.object.callee.type === "Identifier" &&
        n.callee.object.callee.name === vmCtorName &&
        n.arguments.length >= 3 &&
        n.arguments[2].type === "NewExpression"
      ) {
        const ne = n.callee.object;
        if (ne.arguments.length >= 3 && ne.arguments[0].type === "ArrayExpression") {
          constants = ne.arguments[0].elements.map(literalValue);
          const metaArg = n.arguments[2].arguments[0];
          if (metaArg && metaArg.type === "ObjectExpression") {
            const meta = {};
            for (const pr of metaArg.properties) meta[pr.key.name ?? pr.key.value] = literalValue(pr.value);
            entryMeta = meta;
          }
        }
      }
    },
  });
  if (!constants) return null;

  // bytecode: giant base64 string -> LE u32[]
  traverse(ast, {
    StringLiteral(p) {
      if (!bytecode && p.node.value.length > 256) {
        const buf = Buffer.from(p.node.value, "base64");
        const u32 = new Uint32Array(Math.floor(buf.length / 4));
        for (let i = 0; i < u32.length; i++) u32[i] = buf.readUInt32LE(i * 4);
        bytecode = u32;
      }
    },
  });
  if (!bytecode) return null;

  // helper names: cell-read fn (w), frame-push fn (x), meta ctor (u)
  // heuristics: single-letter identifiers called with 1 arg inside handlers
  // where the body matches known helper shapes.
  let cellReadFn = null;
  let framePushFn = null;
  let metaCtor = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      const n = p.node;
      if (!n.id) return;
      const code = generate(n).code.replace(/\s+/g, " ");
      if (!metaCtor && n.params.length === 2 && /this\.j\s*=\s*\[\]/.test(code)) metaCtor = n.id.name;
      if (!framePushFn && n.params.length >= 5 && /\w\.i\s*=/.test(code) && /\+ ?14\b|14 ?\+|\+14,/.test(code) && /\w\.c\s*=/.test(code)) framePushFn = n.id.name;
      if (!cellReadFn && n.params.length === 1 && /\.l\s*\?\s*\w+\.u\s*:\s*\w+\.g\[/.test(code)) cellReadFn = n.id.name;
    },
  });

  return {
    vmCtorName, handlerVar, handlers, weakMapVar,
    constants, bytecode, entryMeta, decoderMult,
    cellReadFn, framePushFn, metaCtor,
  };
}

function literalValue(node) {
  if (!node) return undefined;
  switch (node.type) {
    case "NumericLiteral": return node.value;
    case "StringLiteral": return node.value;
    case "BooleanLiteral": return node.value;
    case "NullLiteral": return null;
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "NumericLiteral") return -node.argument.value;
      if (node.operator === "+" && node.argument.type === "NumericLiteral") return node.argument.value;
      if (node.operator === "!" && (node.argument.type === "BooleanLiteral" || node.argument.type === "NumericLiteral")) return !node.argument.value;
      return undefined;
    case "Identifier":
    case "VoidExpression":
      return undefined;
    default: return undefined;
  }
}

/* ================================================================== */
/* SECTION 2 — Symbolic handler interpretation + canonical record      */
/* ================================================================== */

const VM_PROPS = { g: "stack", c: "frame", h: "globals", n: "code", F: "consts", i: "stackTop", A: "cells" };

/**
 * Interpret one handler function. Produces a record:
 *   { effects: [...], opsRead }
 * Terms:
 *   num{v} opnd{n} regbase frame stack globals code consts
 *   reg{x}          — register cell (x: num|opnd) as read-value term
 *   fslot{n}        — frame slot read
 *   bin{op,l,r} un{op,a} log{op,l,r} cond{test,cons,alt}
 *   yload{idx,key} gread{key} nread{key}
 *   jref{idx}       — closure cell list element (fnMeta.j[i])
 *   cellread{x} cellstore{cell,val} mkcell{src}
 *   applycall{fn,th,args} newarr{n} objlit arr either{a,b} delete{obj,key}
 *   newmeta{meta} weakget{x} weakset framepush{args} unwind
 *   reflectset{x,y,z} reflectconstruct{x,y} defprop owndesc hasown
 *   errnew objcreate ownnames getproto argsslice
 * Effects:
 *   streg{reg,val} setip{val,cond?} fslotw{n,val} stackwrite{idx,val}
 *   setglobal{key,val} codewrite{idx,val,roll?} elemstore{arr,idx,val}
 *   throw{val} return debugger opaque
 *   forloop{test,body} counted{countOpnd, perIter:[...]} phi-effects
 */
function interpretHandler(fn, vm) {
  const st = { env: new Map(), ops: 0, effects: [], condStack: [], regReads: [] };
  const TRACE = !!process.env.VM_TRACE;
  const KNOWN = {
    weakMap: vm.weakMapVar,
    cellRead: vm.cellReadFn,
    framePush: vm.framePushFn,
    metaCtor: vm.metaCtor,
    vmCtor: vm.vmCtorName,
  };

  const push = (eff) => {
    if (st.condStack.length) eff.cond = st.condStack[st.condStack.length - 1];
    st.effects.push(eff);
    return eff;
  };
  const opnd = () => ({ t: "opnd", n: st.ops++ });

  function evalExpr(node) {
    switch (node.type) {
      case "NumericLiteral": return { t: "num", v: node.value };
      case "StringLiteral": return { t: "str", v: node.value };
      case "BooleanLiteral": return { t: "num", v: node.value ? 1 : 0 };
      case "NullLiteral": return { t: "null" };
      case "Identifier":
        if (node.name === "undefined") return { t: "undef" };
        return st.env.has(node.name) ? st.env.get(node.name) : { t: "freevar", name: node.name };
      case "ThisExpression": return { t: "vm" };
      case "MemberExpression": {
        const obj = evalExpr(node.object);
        const key = node.computed
          ? evalExpr(node.property)
          : { t: "pn", v: node.property.name ?? node.property.value };
        return mkMember(obj, key);
      }
      case "BinaryExpression": {
        const l = evalExpr(node.left);
        const r = evalExpr(node.right);
        if (l.t === "num" && r.t === "num") {
          const v = numBin(node.operator, l.v, r.v);
          if (v !== undefined) return { t: "num", v };
        }
        return { t: "bin", op: node.operator, l, r };
      }
      case "UnaryExpression": {
        if (node.operator === "delete") {
          const arg = node.argument;
          if (arg.type === "MemberExpression") {
            return { t: "delete", obj: evalExpr(arg.object), key: arg.computed ? evalExpr(arg.property) : { t: "pn", v: arg.property.name } };
          }
          return { t: "un", op: "delete", a: evalExpr(arg) };
        }
        const a = evalExpr(node.argument);
        if (a.t === "num" && ["-", "+", "~"].includes(node.operator)) {
          return { t: "num", v: node.operator === "-" ? -a.v : node.operator === "+" ? +a.v : ~a.v };
        }
        return { t: "un", op: node.operator, a };
      }
      case "LogicalExpression": {
        const l = evalExpr(node.left);
        // `a && b` -> b runs when a truthy; `a || b` -> b runs when a falsy
        const guard = node.operator === "&&" ? l : { t: "un", op: "!", a: l };
        st.condStack.push(guard);
        const r = evalExpr(node.right);
        st.condStack.pop();
        return { t: "log", op: node.operator, l, r };
      }
      case "ConditionalExpression": {
        const test = evalExpr(node.test);
        st.condStack.push(test);
        const cons = evalExpr(node.consequent);
        st.condStack.pop();
        st.condStack.push({ t: "un", op: "!", a: test });
        const alt = evalExpr(node.alternate);
        st.condStack.pop();
        return { t: "either", a: cons, b: alt, test };
      }
      case "ArrayExpression":
        return { t: "arr", elems: node.elements.map((el) => (el ? evalExpr(el) : { t: "undef" })) };
      case "ObjectExpression":
        return { t: "objlit", props: node.properties.map((pr) => ({ key: pr.key.name ?? pr.key.value, val: evalExpr(pr.value) })) };
      case "SequenceExpression": {
        let last = { t: "undef" };
        for (const ex of node.expressions) last = evalExpr(ex);
        return last;
      }
      case "AssignmentExpression":
        if (TRACE) console.error("assign case:", node.left.type, node.operator, node.left.start);
        return evalAssign(node);
      case "UpdateExpression": return { t: "upd", a: evalExpr(node.argument) };
      case "TemplateLiteral": return { t: "tpl" };
      case "CallExpression": return evalCall(node);
      case "NewExpression": return evalNew(node);
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return { t: "fnexpr" };
      default:
        return { t: "opaque", kind: node.type };
    }
  }

  function numBin(op, a, b) {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "&": return a & b;
      case "|": return a | b;
      case "^": return a ^ b;
      case "<<": return a << b;
      case ">>": return a >> b;
      case ">>>": return a >>> b;
      default: return undefined;
    }
  }

  function mkMember(obj, key) {
    if (obj.t === "vm" && key.t === "pn" && VM_PROPS[key.v]) return { t: VM_PROPS[key.v] };
    if (obj.t === "vm" && key.t === "pn") return { t: "vmprop", name: key.v };
    // array element resolution: arr[num] -> element term
    if (obj.t === "arr" && key.t === "num" && Number.isInteger(key.v) && key.v >= 0 && key.v < obj.elems.length) return obj.elems[key.v];
    // this.g[this.c + 10] -> regbase
    if (obj.t === "stack" && key.t === "bin" && key.op === "+" && key.l.t === "frame" && key.r.t === "num" && key.r.v === 10) return { t: "regbase" };
    if (obj.t === "stack" && key.t === "bin" && key.op === "+" && key.l.t === "frame" && key.r.t === "num") return { t: "fslot", n: key.r.v };
    if (obj.t === "stack" && key.t === "bin" && key.op === "+" && key.l.t === "regbase") { st.regReads.push(key.r); return { t: "reg", x: key.r }; }
    if (obj.t === "regbase") return { t: "reg", x: key };
    if (obj.t === "stack") return { t: "stackidx", x: key };
    if (obj.t === "frame") return { t: "fslotx", x: key };
    if (obj.t === "globals") return { t: "gread", key };
    if (obj.t === "code") return { t: "nread", key };
    if (obj.t === "consts") return { t: "fread", key };
    // fnMeta (frame slot 2) .j[i] -> jref
    if (obj.t === "fslot" && obj.n === 2 && key.t === "pn" && key.v === "j") return { t: "jlist" };
    if (obj.t === "jlist") return { t: "jref", idx: key };
    if (obj.t === "mem" && obj.key.t === "pn" && obj.key.v === "j" && obj.obj.t === "fslot" && obj.obj.n === 2) return { t: "jlist" };
    // weakmap var .get/.set
    if (obj.t === "freevar" && KNOWN.weakMap && obj.name === KNOWN.weakMap && key.t === "pn" && (key.v === "get" || key.v === "set")) return { t: "wmfn", which: key.v };
    // Array.prototype.slice
    if (obj.t === "mem" && obj.obj.t === "freevar" && obj.obj.name === "Array" && obj.key.t === "pn" && obj.key.v === "prototype" && key.t === "pn" && key.v === "slice") return { t: "slicefn" };
    return { t: "mem", obj, key };
  }

  function evalCall(node) {
    const callee = node.callee;
    if (callee.type === "MemberExpression" && callee.object.type === "ThisExpression" && !callee.computed) {
      const name = callee.property.name ?? callee.property.value;
      const args = node.arguments;
      if (name === "e") return opnd();
      if (name === "y") {
        const a = args.map((x) => (x.type === "Identifier" && x.name === "undefined" ? { t: "undef" } : evalExpr(x)));
        while (a.length < 6) a.push({ t: "undef" });
        const idx = a[1].t === "undef" ? opnd() : a[1];
        const key = a[5].t === "undef" ? opnd() : a[5];
        return { t: "yload", idx, key };
      }
      if (name === "z") return push({ eff: "unwind", args: args.map(evalExpr) });
      if (name === "t") {
        // this.t(frame, _, _, srcIdx, _, _) — src is args[3]
        return { t: "mkcell", src: args.length > 3 ? evalExpr(args[3]) : { t: "undef" } };
      }
      return { t: "vmcall", name, args: args.map(evalExpr) };
    }
    if (callee.type === "Identifier") {
      if (KNOWN.cellRead && callee.name === KNOWN.cellRead) return { t: "cellread", x: evalExpr(node.arguments[0]) };
      if (KNOWN.framePush && callee.name === KNOWN.framePush) return { t: "framepush", args: node.arguments.map(evalExpr) };
      if (KNOWN.metaCtor && callee.name === KNOWN.metaCtor) return { t: "metacall" };
      if (callee.name === "Array" && node.arguments.length <= 1) return { t: "newarr", n: node.arguments[0] ? evalExpr(node.arguments[0]) : { t: "num", v: 0 } };
    }
    if (callee.type === "MemberExpression") {
      const objT = evalExpr(callee.object);
      const prop = callee.computed ? evalExpr(callee.property) : { t: "pn", v: callee.property.name ?? callee.property.value };
      const args = node.arguments.map(evalExpr);
      if (objT.t === "wmfn" && objT.which === "get") return { t: "weakget", x: args[0] };
      if (objT.t === "wmfn" && objT.which === "set") return { t: "weakset", args };
      if (objT.t === "slicefn" && prop.t === "pn" && prop.v === "call") return { t: "argsslice" };
      if (objT.t === "freevar") {
        const p = prop.t === "pn" ? prop.v : null;
        const owner = objT.name;
        if (owner === "Object" && p === "create") return { t: "objcreate", x: args[0] };
        if (owner === "Object" && p === "getOwnPropertyNames") return { t: "ownnames", x: args[0] };
        if (owner === "Object" && p === "getOwnPropertyDescriptor") return { t: "owndesc", x: args[0], y: args[1] };
        if (owner === "Object" && p === "getPrototypeOf") return { t: "getproto", x: args[0] };
        if (owner === "Object" && p === "defineProperty") { const e2 = { t: "defprop", x: args[0], y: args[1], z: args[2] }; push({ eff: "defprop", x: args[0], y: args[1], z: args[2] }); return e2; }
        if (owner === "Reflect" && p === "set") { const e2 = { t: "reflectset", x: args[0], y: args[1], z: args[2] }; push({ eff: "rset", x: args[0], y: args[1], z: args[2] }); return e2; }
        if (owner === "Reflect" && p === "construct") return { t: "reflectconstruct", x: args[0], y: args[1] };
        if (owner === "Math" && p === "pow") return { t: "bin", op: "**", l: args[0], r: args[1] };
        if (owner === "Array" && p === "isArray") return { t: "opaque" };
      }
      // handler-stack push/pop: <FS11 var>.push({...}) / .pop()
      const maybeFS11 = (x) => x && (x.t === "fslot" && x.n === 11 || (x.t === "either" && (maybeFS11(x.a) || maybeFS11(x.b))));
      if (maybeFS11(objT) && prop.t === "pn" && prop.v === "push" && args[0] && args[0].t === "objlit") {
        const props = {};
        for (const pr of args[0].props) props[pr.key] = pr.val;
        if (props.K !== undefined && props.B !== undefined) push({ eff: "pushcatch", K: props.K, B: props.B });
        else if (props.I !== undefined) push({ eff: "pushfinally", I: props.I, H: props.H, L: props.L, G: props.G });
        return { t: "opaque" };
      }
      if (maybeFS11(objT) && prop.t === "pn" && prop.v === "pop") {
        push({ eff: "pophandler" });
        return { t: "opaque" };
      }
      if (objT.t === "mem") {
        // Object.prototype.hasOwnProperty.call(this.h, d)
        const code = generate(callee.object).code;
        if (code === "Object.prototype.hasOwnProperty" && prop.t === "pn" && prop.v === "call") return { t: "hasown", x: args[0], y: args[1] };
      }
      if (prop.t === "pn" && prop.v === "apply" && objT.t !== "freevar") {
        return { t: "applycall", fn: objT, th: args[0], args: args[1] };
      }
      if (prop.t === "pn" && prop.v === "apply" && objT.t === "freevar") {
        return { t: "applycall", fn: objT, th: args[0], args: args[1] };
      }
      if (prop.t === "pn" && prop.v === "call" && objT.t === "mem") {
        const code = generate(callee.object).code;
        if (code === "Array.prototype.slice") return { t: "argsslice" };
      }
      if (objT.t === "newmeta" || objT.t === "metacall" || (objT.t === "mem")) {
        // meta.prototype etc
      }
      if (prop.t === "pn" && prop.v === "apply") {
        return { t: "applycall", fn: objT, th: args[0], args: args[1] };
      }
      // fn.apply(...)
      if (prop.t === "pn" && prop.v === "apply") return { t: "applycall", fn: objT, th: args[0], args: args[1] };
      return { t: "call", obj: objT, prop, args };
    }
    return { t: "call", args: node.arguments.map(evalExpr) };
  }

  function evalNew(node) {
    if (node.callee.type === "Identifier") {
      const name = node.callee.name;
      if (KNOWN.metaCtor && name === KNOWN.metaCtor) {
        const meta = {};
        const arg0 = node.arguments[0];
        if (arg0 && arg0.type === "ObjectExpression") {
          for (const pr of arg0.properties) meta[pr.key.name ?? pr.key.value] = evalExpr(pr.value);
        }
        return { t: "newmeta", meta };
      }
      if (name === "Array" && node.arguments.length <= 1) return { t: "newarr", n: node.arguments[0] ? evalExpr(node.arguments[0]) : { t: "num", v: 0 } };
      if (name === "ReferenceError" || name === "TypeError" || name === "RangeError") return { t: "errnew" };
      if (KNOWN.vmCtor && name === KNOWN.vmCtor) return { t: "newvm", args: node.arguments.map(evalExpr) };
      return { t: "new", callee: name };
    }
    return { t: "new", callee: evalExpr(node.callee) };
  }

  function readMember(objT, keyT) {
    return mkMember(objT, keyT);
  }

  function evalAssign(node) {
    const target = node.left;
    const operator = node.operator;
    if (TRACE) console.error("evalAssign", target && target.type, operator, target && target.start);
    const isPlain = operator === "=";
    const opName = isPlain ? null : operator.slice(0, -1);

    if (target.type === "Identifier") {
      const cur = st.env.get(target.name);
      let v = evalExpr(node.right);
      if (!isPlain) v = { t: "bin", op: opName, l: cur || { t: "freevar", name: target.name }, r: v };
      // conditional rebind -> either (preserves both values for matchers)
      if (st.condStack.length && cur !== undefined && cur.t !== "either") {
        v = { t: "either", a: cur, b: v, cond: st.condStack[st.condStack.length - 1] };
      }
      st.env.set(target.name, v);
      return v;
    }
    if (target.type !== "MemberExpression") { evalExpr(node.right); return { t: "opaque" }; }

    const objT = evalExpr(target.object);
    const keyT = target.computed ? evalExpr(target.property) : { t: "pn", v: target.property.name ?? target.property.value };

    // normalize `this.h` object through vm mapping
    let objN = objT;
    if (objN.t === "vm" && keyT.t === "pn" && VM_PROPS[keyT.v]) objN = { t: VM_PROPS[keyT.v] };

    let val = evalExpr(node.right);
    if (!isPlain) {
      val = { t: "bin", op: opName, l: mkMember(objN, keyT), r: val };
    }

    // writes to VM state (this.c, this.i, ...) — ignored by matchers
    if (objN.t === "vmprop" || objN.t === "frame" || objN.t === "stackTop" || objN.t === "cells") {
      push({ eff: "vmstate", name: objN.t === "vmprop" ? objN.name : objN.t + "." + (keyT.t === "pn" ? keyT.v : "?"), val });
      return val;
    }
    // REG store: stack[regbase + X]
    if (objN.t === "stack" && keyT.t === "bin" && keyT.op === "+" && keyT.l.t === "regbase") {
      push({ eff: "streg", reg: keyT.r, val });
      return val;
    }
    // frame slot write
    if (objN.t === "stack" && keyT.t === "bin" && keyT.op === "+" && keyT.l.t === "frame" && keyT.r.t === "num") {
      const n = keyT.r.v;
      if (n === 6) push({ eff: "setip", val });
      else push({ eff: "fslotw", n, val });
      return val;
    }
    if (objN.t === "stack" || objN.t === "regbase") {
      push({ eff: "stackwrite", idx: keyT, val });
      return val;
    }
    if (objN.t === "globals") {
      push({ eff: "setglobal", key: keyT, val });
      return val;
    }
    if (objN.t === "code") {
      push({ eff: "codewrite", idx: keyT, val });
      return val;
    }
    // closure cell store: <jref-var>.g[.o] = v / .u = v — find jref at base of member chain
    {
      const cell = findBaseJref(objN);
      if (cell) {
        push({ eff: "cellstore", idx: cell.idx, val });
        return val;
      }
    }
    // element store (array/object building)
    push({ eff: "elemstore", arr: objN, idx: keyT, val });
    return val;
  }

  function findBaseJref(term, depth = 0) {
    if (!term || depth > 4) return null;
    if (term.t === "jref") return term;
    if (term.t === "mem") return findBaseJref(term.obj, depth + 1);
    return null;
  }

  function execStmt(node) {
    switch (node.type) {
      case "VariableDeclaration":
        for (const d of node.declarations) st.env.set(d.id.name, d.init ? evalExpr(d.init) : { t: "undef" });
        return;
      case "ExpressionStatement":
        evalExpr(node.expression);
        return;
      case "IfStatement": {
        const test = evalExpr(node.test);
        const branchWith = (blk, condTerm) => {
          const envSnap = new Map(st.env);
          const mark = st.effects.length;
          st.condStack.push(condTerm);
          if (blk) {
            if (blk.type === "BlockStatement") blk.body.forEach(execStmt);
            else execStmt(blk);
          }
          st.condStack.pop();
          const effs = st.effects.slice(mark);
          const finalEnv = new Map(st.env);
          st.effects.length = mark;
          st.env = envSnap;
          return { env: finalEnv, effs };
        };
        const a = branchWith(node.consequent, test);
        const b = branchWith(node.alternate, { t: "un", op: "!", a: test });
        for (const eff of a.effs) { eff.cond = eff.cond || test; st.effects.push(eff); }
        for (const eff of b.effs) { eff.cond = eff.cond || { t: "un", op: "!", a: test }; st.effects.push(eff); }
        const names = new Set([...a.env.keys(), ...(b.env?.keys() || [])]);
        for (const name of names) {
          const av = a.env.get(name);
          const bv = b.env ? b.env.get(name) : undefined;
          const avDefined = a.env.has(name);
          const bvDefined = b.env && b.env.has(name);
          if (avDefined && bvDefined) {
            if (av !== bv) st.env.set(name, { t: "either", a: av, b: bv });
          } else if (avDefined) st.env.set(name, av);
          else if (bvDefined) st.env.set(name, bv);
        }
        return;
      }
      case "ForStatement": {
        if (node.init) {
          if (node.init.type === "VariableDeclaration") execStmt(node.init);
          else evalExpr(node.init);
        }
        const test = node.test ? evalExpr(node.test) : null;
        const envSnap = new Map(st.env);
        const mark = st.effects.length;
        if (node.body) {
          if (node.body.type === "BlockStatement") node.body.body.forEach(execStmt);
          else execStmt(node.body);
        }
        if (node.update) evalExpr(node.update);
        const bodyEffs = st.effects.slice(mark);
        st.effects.length = mark;
        st.env = envSnap;
        push({ eff: "forloop", test, body: bodyEffs });
        return;
      }
      case "ReturnStatement":
        if (node.argument) evalExpr(node.argument);
        push({ eff: "return" });
        return;
      case "ThrowStatement":
        push({ eff: "throw", val: evalExpr(node.argument) });
        return;
      case "DebuggerStatement":
        push({ eff: "debugger" });
        return;
      case "BlockStatement":
        node.body.forEach(execStmt);
        return;
      case "TryStatement":
        node.block.body.forEach(execStmt);
        return;
      case "EmptyStatement":
        return;
      default:
        push({ eff: "opaque", kind: node.type });
    }
  }

  for (const stmt of fn.body.body) execStmt(stmt);
  return { effects: st.effects, env: st.env, opsRead: st.ops, regReads: st.regReads };
}

/* ---------------- canonical serialization ---------------- */

function serTerm(x, top) {
  if (!x) return "?";
  switch (x.t) {
    case "num": return "#" + x.v;
    case "opnd": return "o" + x.n;
    case "regbase": return "RB";
    case "frame": return "FR";
    case "stack": return "ST";
    case "globals": return "GL";
    case "code": return "CD";
    case "consts": return "CT";
    case "reg": return "R(" + serTerm(x.x) + ")";
    case "fslot": return "FS" + x.n;
    case "fslotx": return "FS(" + serTerm(x.x) + ")";
    case "stackidx": return "ST[" + serTerm(x.x) + "]";
    case "bin": return `(${x.op} ${serTerm(x.l)} ${serTerm(x.r)})`;
    case "un": return `(${x.op} ${serTerm(x.a)})`;
    case "log": return `(${x.op} ${serTerm(x.l)} ${serTerm(x.r)})`;
    case "either": return serEither(x);
    case "yload": return `Y[${serTerm(x.idx)},${serTerm(x.key)}]`;
    case "gread": return `GL[${serTerm(x.key)}]`;
    case "nread": return `CD[${serTerm(x.key)}]`;
    case "jref": return `J[${serTerm(x.idx)}]`;
    case "jlist": return "J";
    case "cellread": return `CR(${serTerm(x.x)})`;
    case "mkcell": return `MKCELL(${serTerm(x.src)})`;
    case "applycall": return `APPLY(${serTerm(x.fn)},${serTerm(x.th)},${serTerm(x.args)})`;
    case "newarr": return `ARR(${serTerm(x.n)})`;
    case "objlit": return "OBJLIT{" + x.props.map((p) => `${p.key}:${serTerm(p.val)}`).join(",") + "}";
    case "arr": return "[" + x.elems.map(serTerm).join(",") + "]";
    case "delete": return `(del ${serTerm(x.obj)} ${serTerm(x.key)})`;
    case "newmeta": {
      const m = x.meta;
      return `META(m=${serTerm(m.m)},b=${serTerm(m.b)},v=${serTerm(m.v)},a=${serTerm(m.a)})`;
    }
    case "weakget": return `WMGET(${serTerm(x.x)})`;
    case "weakset": return "WMSET";
    case "framepush": return `XPUSH(${x.args.map(serTerm).join(",")})`;
    case "unwind": return "UNWIND";
    case "reflectset": return `RSET(${serTerm(x.x)},${serTerm(x.y)},${serTerm(x.z)})`;
    case "reflectconstruct": return `RCON(${serTerm(x.x)},${serTerm(x.y)})`;
    case "defprop": return `DEFP(${serTerm(x.x)},${serTerm(x.y)},${serTerm(x.z)})`;
    case "owndesc": return `OWNDESC(${serTerm(x.x)},${serTerm(x.y)})`;
    case "hasown": return `HASOWN(${serTerm(x.x)},${serTerm(x.y)})`;
    case "errnew": return "ERRNEW";
    case "objcreate": return `OBJCREATE(${serTerm(x.x)})`;
    case "ownnames": return `OWNNAMES(${serTerm(x.x)})`;
    case "getproto": return "GETPROTO";
    case "argsslice": return "ARGS";
    case "vmcall": return `VMCALL:${x.name}`;
    case "vmprop": return `vm.${x.name}`;
    case "freevar": return x.name;
    case "undef": return "_";
    case "null": return "null";
    case "str": return JSON.stringify(x.v);
    case "mem": return `(${serTerm(x.obj)}.${serTerm(x.key)})`;
    case "call": return `(call ${serTerm(x.obj)} ${serTerm(x.prop)} ${x.args.map(serTerm).join(" ")})`;
    case "upd": return `(upd ${serTerm(x.a)})`;
    case "tpl": return "TPL";
    case "fnexpr": return "FN";
    case "new": return `(new ${typeof x.callee === "string" ? x.callee : serTerm(x.callee)})`;
    case "newvm": return "NEWVM";
    case "metacall": return "METACALL";
    case "slicefn": return "SLICEFN";
    case "wmfn": return `WM.${x.which}`;
    case "vm": return "vm";
    case "opaque": return "OPAQUE";
    default: return x.t;
  }
}
function serEither(x) {
  return `(${serTerm(x.a)}|${serTerm(x.b)})`;
}
function serEff(e) {
  switch (e.eff) {
    case "streg": return `R${serTerm(e.reg)} <- ${serTerm(e.val)}`;
    case "setip": return `IP <- ${serTerm(e.val)}` + (e.cond ? ` IF ${serTerm(e.cond)}` : "");
    case "fslotw": return `FS${e.n} <- ${serTerm(e.val)}`;
    case "stackwrite": return `ST[${serTerm(e.idx)}] <- ${serTerm(e.val)}`;
    case "setglobal": return `GL[${serTerm(e.key)}] <- ${serTerm(e.val)}`;
    case "codewrite": return `CD[${serTerm(e.idx)}] <- ${serTerm(e.val)}`;
    case "elemstore": return `${serTerm(e.arr)}[${serTerm(e.idx)}] <- ${serTerm(e.val)}`;
    case "cellstore": return `CELL[${serTerm(e.idx)}] <- ${serTerm(e.val)}`;
    case "rset": return `RSET(${serTerm(e.x)},${serTerm(e.y)},${serTerm(e.z)})`;
    case "defprop": return `DEFP(${serTerm(e.x)},${serTerm(e.y)},${serTerm(e.z)})`;
    case "pushcatch": return `PUSHCATCH(K=${serTerm(e.K)},B=${serTerm(e.B)})`;
    case "pushfinally": return `PUSHFINALLY(I=${serTerm(e.I)},H=${serTerm(e.H)},L=${serTerm(e.L)},G=${serTerm(e.G)})`;
    case "pophandler": return "POPHANDLER";
    case "vmstate": return `vmstate(${e.name})`;
    case "throw": return `THROW ${serTerm(e.val)}`;
    case "return": return "RET0";
    case "debugger": return "DBG";
    case "unwind": return "UNWIND";
    case "forloop": {
      const body = e.body.map(serEff).join("; ");
      return `FOR(${serTerm(e.test)}) { ${body} }`;
    }
    case "opaque": return `OPQ(${e.kind})`;
    default: return e.eff;
  }
}
function serRecord(rec) {
  return rec.effects.map(serEff).join("\n");
}

/* ================================================================== */
/* SECTION 3 — Archetype matching: record -> semantic opcode decoder   */
/* ================================================================== */

const SPREAD_SENTINEL = 36020178;

/** reg-ref: {t:"num",v} (immediate) or {t:"opnd",n} (from operand stream) */
function regRef(term) {
  if (!term) return null;
  if (term.t === "num") return { imm: term.v };
  if (term.t === "opnd") return { op: term.n };
  return null;
}

function flattenEither(term) {
  if (term && term.t === "either") return [...flattenEither(term.a), ...flattenEither(term.b)];
  return [term];
}

/**
 * Match a record to a semantic opcode with a decode plan.
 * decode(ops: number[], ctx) -> instruction object (registers resolved).
 */
function matchArchetype(rec) {
  const effs = rec.effects;
  const has = (t) => effs.some((e) => e.eff === t);
  const stregs = effs.filter((e) => e.eff === "streg" && !e.cond);
  const setips = effs.filter((e) => e.eff === "setip");

  const fail = (why) => ({ __fail: why });

  // DEBUGGER
  if (has("debugger")) return { op: "DEBUGGER", decode: () => ({ op: "DEBUGGER", len: 1 }) };

  // POPHANDLER
  if (has("pophandler")) return { op: "POPH", decode: () => ({ op: "POPH", len: 1 }) };

  // PUSH_CATCH / PUSH_FINALLY
  {
    const pc = effs.find((e) => e.eff === "pushcatch");
    if (pc) {
      const K = pc.K.t === "opnd" ? { op: pc.K.n } : { imm: pc.K.v };
      const B = pc.B.t === "opnd" ? { op: pc.B.n } : { imm: pc.B.v };
      return {
        op: "PUSHCATCH",
        decode: (ops) => ({ op: "PUSHCATCH", catchIP: val(K, ops), exReg: val(B, ops), len: 1 + countRefs([K, B]) }),
      };
    }
  }
  {
    const pf = effs.find((e) => e.eff === "pushfinally");
    if (pf) {
      const r = (x) => (x.t === "opnd" ? { op: x.n } : { imm: x.v });
      const I = r(pf.I), H = r(pf.H), L = r(pf.L), G = r(pf.G);
      return {
        op: "PUSHFIN",
        decode: (ops) => ({ op: "PUSHFIN", finIP: val(I, ops), retReg: val(H, ops), exReg: val(L, ops), retVal: val(G, ops), len: 1 + countRefs([I, H, L, G]) }),
      };
    }
  }

  // RETURN family: unwind + stackwrite to caller
  if (has("unwind")) {
    const sw = effs.find((e) => e.eff === "stackwrite");
    let valueRef = null;
    const cands = flattenEither(sw ? sw.val : null);
    for (const c of cands) {
      const r = c && c.t === "reg" ? regRef(c.x) : null;
      if (r) { valueRef = r; break; }
    }
    if (!valueRef) {
      const rr = rec.regReads.length ? rec.regReads[0] : null;
      valueRef = rr ? regRef(rr) : { imm: 0 };
    }
    return {
      op: "RET",
      decode: (ops) => ({ op: "RET", value: val(valueRef, ops), len: 1 + countRefs([valueRef]) }),
    };
  }

  // DECODE: forloop writing CD[...] with rolling constant
  for (const e of effs) {
    if (e.eff === "forloop") {
      const cw = e.body.find((b) => b.eff === "codewrite");
      if (cw) {
        // operands from the codewrite index/key terms
        const idx = cw.idx; // bin(+, oA, (- o1 o1))
        const keyTerm = cw.val; // un/bins containing o0..o3 + mult
        const opnds = [];
        const walk = (x) => {
          if (!x) return;
          if (x.t === "opnd") opnds.push(x.n);
          else { walk(x.l); walk(x.r); walk(x.a); walk(x.b); }
        };
        walk(idx); walk(keyTerm); walk(e.test);
        const uniq = [...new Set(opnds)].sort((a, b) => a - b);
        // expected order: o0 dstOff, o1 start, o2 end, o3 key
        if (uniq.length >= 4) {
          const mult = findMult(keyTerm);
          return {
            op: "DECODE",
            decode: (ops) => ({
              op: "DECODE",
              dstOff: ops[uniq[0]], start: ops[uniq[1]], end: ops[uniq[2]], key: ops[uniq[3]],
              mult, len: 5,
            }),
          };
        }
      }
    }
  }

  // THROW
  {
    const th = effs.find((e) => e.eff === "throw" && e.val && e.val.t === "reg");
    if (th && !stregs.length) {
      const r = regRef(th.val.x);
      return { op: "THROW", decode: (ops) => ({ op: "THROW", src: val(r, ops), len: 1 + countRefs([r]) }) };
    }
  }

  // SETPROP: rset effect
  {
    const rs = effs.find((e) => e.eff === "rset");
    if (rs) {
      const obj = regRefOfTerm(rs.x), key = regRefOfTerm(rs.y), v = regRefOfTerm(rs.z);
      return {
        op: "SETPROP",
        decode: (ops) => ({ op: "SETPROP", obj: val(obj, ops), key: val(key, ops), value: val(v, ops), len: 1 + countRefs([obj, key, v]) }),
      };
    }
  }

  // DEFINE_GETTER / DEFINE_SETTER
  {
    const dp = effs.find((e) => e.eff === "defprop");
    if (dp) {
      const desc = dp.z;
      const getter = desc.props.find((p) => p.key === "get" && p.val.t === "reg");
      const setter = desc.props.find((p) => p.key === "set" && p.val.t === "reg");
      const obj = regRefOfTerm(dp.x), key = regRefOfTerm(dp.y);
      const fn = getter ? getter : setter;
      const fnRef = regRefOfTerm(fn.val);
      return {
        op: getter ? "DEFGET" : "DEFSET",
        decode: (ops) => ({
          op: getter ? "DEFGET" : "DEFSET",
          obj: val(obj, ops), key: val(key, ops), fn: val(fnRef, ops),
          len: 1 + countRefs([obj, key, fnRef]),
        }),
      };
    }
  }

  // cellstore: CLOSURE_SET
  {
    const cs = effs.find((e) => e.eff === "cellstore");
    if (cs) {
      const idx = regRef(cs.idx), v = regRefOfTerm(cs.val);
      return {
        op: "CSET",
        decode: (ops) => ({ op: "CSET", cell: val(idx, ops), src: val(v, ops), len: 1 + countRefs([idx, v]) }),
      };
    }
  }

  // MAKE_CLOSURE: forloop with OBJLIT{Q,d} body + newmeta
  {
    const fl = effs.find((e) => e.eff === "forloop" && e.body.some((b) => b.eff === "elemstore" && b.val && b.val.t === "objlit" && b.val.props.some((p) => p.key === "Q")));
    if (fl && containsNewMeta(effs)) {
      // find META(m=?,b=?,v=?,a=?) term anywhere in the record
      const meta = findNewMeta(effs);
      // count operand: the loop test `p < l`
      const countRef = fl.test && fl.test.t === "bin" ? regRef(fl.test.r) : null;
      // dst: final streg into a register
      const st = effs.find((e) => e.eff === "streg");
      const dst = st ? regRef(st.reg) : { imm: 0 };
      const caps = [];
      {
        const es = fl.body.find((b) => b.eff === "elemstore");
        const q = es.val.props.find((p) => p.key === "Q").val;
        const d = es.val.props.find((p) => p.key === "d").val;
        caps.push(regRef(q), regRef(d));
      }
      const m = meta || {};
      const mr = (x) => regRef(x) || { imm: 0 };
      const refs = [dst, mr(m.v), mr(m.m), mr(m.b), countRef, mr(m.a)];
      return {
        op: "MKFUNC",
        decode: (ops) => {
          // operand order: dst, entryIP, params, regs, capCount, rest, then pairs
          const dstV = val(dst, ops);
          const entry = val(mr(m.v), ops);
          const params = val(mr(m.m), ops);
          const regsN = val(mr(m.b), ops);
          const capCount = val(countRef, ops);
          const rest = val(mr(m.a), ops);
          const fixedLen = 1 + countRefs(refs);
          const pairs = [];
          let p = fixedLen - 1; // operand index of first pair
          for (let i = 0; i < capCount; i++) {
            pairs.push({ newCell: ops[p] ? true : false, src: ops[p + 1] });
            p += 2;
          }
          return { op: "MKFUNC", dst: dstV, entry, params, regs: regsN, rest, captures: pairs, len: 1 + p };
        },
      };
    }
  }

  // CALL / CALLI / CONSTRUCT: forloop building args + apply/rcon
  {
    const fl = effs.find((e) => e.eff === "forloop" && e.body.some((b) => b.eff === "elemstore"));
    const st = effs.find((e) => e.eff === "streg" && e.val && (e.val.t === "applycall" || e.val.t === "reflectconstruct"));
    if (fl && st) {
      const isC = st.val.t === "reflectconstruct";
      const argcRef = fl.test && fl.test.t === "bin" ? regRef(fl.test.r) : null;
      const elem = fl.body.find((b) => b.eff === "elemstore");
      const argRef = regRefOfTerm(elem.val);
      // spread alternative: either term with reg read
      let spreadRef = null;
      for (const c of flattenEither(st.val.args)) if (c && c.t === "reg") spreadRef = regRef(c.x) || spreadRef;
      const fnRef = regRefOfTerm(st.val.fn || st.val.x);
      const thRef = st.val.th !== undefined ? (st.val.th === null || (st.val.th && st.val.th.t === "null") ? null : (st.val.th && st.val.th.t === "globals" ? "GLOBAL" : regRefOfTerm(st.val.th))) : null;
      const dstRef = regRef(st.reg);
      const isIndirect = !isC && thRef === null;
      return {
        op: isC ? "CONSTRUCT" : isIndirect ? "CALLI" : "CALL",
        decode: (ops) => {
          const dst = val(dstRef, ops);
          const argc = val(argcRef, ops);
          const fixedRefs = isC ? [dstRef, fnRef, argcRef] : [dstRef, fnRef, thRef, argcRef];
          const consumed = 1 + countRefs(fixedRefs.filter(Boolean));
          // first arg operand index: where the arg-building reads begin at
          // runtime (== the symbolic spread-branch read index when present)
          const firstArgIdx = spreadRef && spreadRef.op !== undefined ? spreadRef.op : consumed;
          let args;
          if (argc === SPREAD_SENTINEL) {
            args = { spread: val(spreadRef, ops) };
          } else {
            const list = [];
            for (let i = 0; i < argc; i++) list.push(ops[firstArgIdx + i]);
            args = { list };
          }
          const len = argc === SPREAD_SENTINEL
            ? 1 + countRefs(fixedRefs.concat([spreadRef]).filter(Boolean))
            : 1 + firstArgIdx + argc;
          return {
            op: isC ? "CONSTRUCT" : isIndirect ? "CALLI" : "CALL",
            dst,
            fn: val(fnRef, ops),
            thisArg: isC ? undefined : isIndirect ? undefined : val(thRef, ops),
            args,
            len,
          };
        },
      };
    }
  }

  // ARR_LIT / OBJ_LIT
  {
    const fl = effs.find((e) => e.eff === "forloop" && e.body.some((b) => b.eff === "elemstore"));
    const st = stregs.find((e) => e.val && (e.val.t === "newarr" || e.val.t === "objlit"));
    if (fl && st) {
      const countRef = fl.test && fl.test.t === "bin" ? regRef(fl.test.r) : null;
      const dstRef = regRef(st.reg);
      const isObj = st.val.t === "objlit";
      const elem = fl.body.find((b) => b.eff === "elemstore");
      const firstRef = regRefOfTerm(elem.val);
      // object literal reads two regs per iteration: key and value
      let secondRef = null;
      if (isObj) {
        const keyTerm = elem.idx;
        secondRef = regRefOfTerm(keyTerm);
      }
      const fixed = [dstRef, countRef, firstRef, ...(secondRef ? [secondRef] : [])].filter(Boolean);
      return {
        op: isObj ? "OBJLIT" : "ARRLIT",
        decode: (ops) => {
          const count = val(countRef, ops);
          const firstIdx = firstRef && firstRef.op !== undefined ? firstRef.op : 1 + countRefs(fixed);
          const parts = [];
          let p = firstIdx;
          const per = isObj ? 2 : 1;
          for (let i = 0; i < count; i++) {
            if (isObj) parts.push({ key: ops[p], value: ops[p + 1] });
            else parts.push(ops[p]);
            p += per;
          }
          return { op: isObj ? "OBJLIT" : "ARRLIT", dst: val(dstRef, ops), parts, len: 1 + p };
        },
      };
    }
  }

  // FOR_IN_INIT: streg(R <- OBJLIT{C..,D:0})
  {
    const st = stregs.find((e) => e.val && e.val.t === "objlit" && e.val.props.some((p) => p.key === "C") && e.val.props.some((p) => p.key === "D"));
    if (st) {
      const dst = regRef(st.reg);
      const srcRef = regRefOfTerm(firstRegRead(rec, 0));
      return { op: "FORIN_INIT", decode: (ops) => ({ op: "FORIN_INIT", dst: val(dst, ops), src: val(srcRef, ops), len: 1 + countRefs([dst, srcRef]) }) };
    }
  }

  // FOR_IN_NEXT: setip(o) IF <iter cond> + streg
  {
    const ip = setips[0];
    const st = effs.find((e) => e.eff === "streg" && e.val && e.val.t === "mem");
    if (ip && st && !effs.some((e) => e.eff === "streg" && e.val && (e.val.t === "bin" || e.val.t === "yload"))) {
      const dst = regRef(st.reg);
      const iterRef = firstRegRead(rec, 0);
      const tgt = ip.val.t === "opnd" ? { op: ip.val.n } : { imm: ip.val.v };
      return {
        op: "FORIN_NEXT",
        decode: (ops) => ({ op: "FORIN_NEXT", dst: val(dst, ops), iter: val(regRefOfTerm(iterRef), ops), exit: val(tgt, ops), len: 1 + countRefs([dst, regRefOfTerm(iterRef), tgt]) }),
      };
    }
  }

  // JMP variants
  {
    const ip = setips.find((e) => !e.cond);
    if (ip && !stregs.length && !has("setglobal")) {
      if (ip.val.t === "reg") {
        const r = regRef(ip.val.x);
        return { op: "JMPR", decode: (ops) => ({ op: "JMPR", src: val(r, ops), len: 1 + countRefs([r]) }) };
      }
      const tgt = ip.val.t === "opnd" ? { op: ip.val.n } : { imm: ip.val.v };
      return { op: "JMP", decode: (ops) => ({ op: "JMP", target: val(tgt, ops), len: 1 + countRefs([tgt]) }) };
    }
  }
  {
    const ip = setips.find((e) => e.cond);
    if (ip && !stregs.length) {
      const cond = ip.cond;
      let regTerm = null;
      if (cond.t === "reg") regTerm = cond;
      else if (cond.t === "un" && cond.op === "!" && cond.a.t === "reg") regTerm = null; // JMPF
      else if (cond.t === "reg") regTerm = cond;
      const isTrue = !(cond.t === "un" && cond.op === "!");
      const srcTerm = isTrue ? cond : cond.a;
      if (srcTerm && srcTerm.t === "reg") {
        const r = regRef(srcTerm.x);
        const tgt = ip.val.t === "opnd" ? { op: ip.val.n } : { imm: ip.val.v };
        return {
          op: isTrue ? "JMPT" : "JMPF",
          decode: (ops) => ({ op: isTrue ? "JMPT" : "JMPF", cond: val(r, ops), target: val(tgt, ops), len: 1 + countRefs([r, tgt]) }),
        };
      }
    }
  }

  // SET_GLOBAL
  {
    const sg = effs.find((e) => e.eff === "setglobal");
    if (sg) {
      const key = sg.key && sg.key.t === "yload" ? sg.key : (sg.key && sg.key.t === "freevar" ? findYInEnv(rec, sg.key) : null);
      const idxR = key ? regRef(key.idx) : null;
      const keyR = key ? regRef(key.key) : null;
      const v = regRefOfTerm(sg.val);
      return {
        op: "STG",
        decode: (ops) => ({ op: "STG", name: { idx: val(idxR, ops), key: val(keyR, ops) }, value: val(v, ops), len: 1 + countRefs([idxR, keyR, v]) }),
      };
    }
  }

  // simple streg archetypes
  if (stregs.length === 1 && !has("setglobal") && !setips.length) {
    const e = stregs[0];
    const dst = regRef(e.reg);
    const v = e.val;
    const R = (term) => regRefOfTerm(term);
    const valR = (term) => val(R(term), ops);

    if (v.t === "bin") {
      const opMap = { "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "&": "BAND", "|": "BOR", "^": "BXOR", "<<": "SHL", ">>": "SHR", ">>>": "USHR", "<": "LT", "<=": "LE", ">": "GT", ">=": "GE", "==": "EQ", "!=": "NE", "===": "SEQ", "!==": "SNE", in: "INOP", instanceof: "INSTANCEOF", "**": "POW" };
      const mn = opMap[v.op];
      if (mn) {
        const l = R(v.l), r = R(v.r);
        return {
          op: mn,
          decode: (ops) => ({ op: mn, dst: val(dst, ops), l: val(l, ops), r: val(r, ops), len: 1 + countRefs([dst, l, r]) }),
        };
      }
    }
    if (v.t === "un" && ["-", "!", "~", "+", "typeof"].includes(v.op)) {
      const mn = { "-": "NEG", "!": "NOT", "~": "BNOT", "+": "TONUM", typeof: "TYPEOF" }[v.op];
      const s = R(v.a);
      return { op: mn, decode: (ops) => ({ op: mn, dst: val(dst, ops), src: val(s, ops), len: 1 + countRefs([dst, s]) }) };
    }
    if (v.t === "reg") {
      const s = R(v);
      return { op: "MOV", decode: (ops) => ({ op: "MOV", dst: val(dst, ops), src: val(s, ops), len: 1 + countRefs([dst, s]) }) };
    }
    if (v.t === "num" || v.t === "opnd") {
      const r = regRef(v);
      return { op: "LDI", decode: (ops) => ({ op: "LDI", dst: val(dst, ops), imm: val(r, ops), len: 1 + countRefs([dst, r]) }) };
    }
    if (v.t === "undef" || v.t === "null" || (v.t === "un" && v.op === "void")) {
      return { op: "UNDEF", decode: (ops) => ({ op: "UNDEF", dst: val(dst, ops), kind: v.t === "null" ? "null" : "undefined", len: 1 + countRefs([dst]) }) };
    }
    if (v.t === "yload") {
      const i = regRef(v.idx), k = regRef(v.key);
      return { op: "LDC", decode: (ops) => ({ op: "LDC", dst: val(dst, ops), idx: val(i, ops), key: val(k, ops), len: 1 + countRefs([dst, i, k]) }) };
    }
    if (v.t === "gread" && v.key && v.key.t === "yload") {
      const i = regRef(v.key.idx), k = regRef(v.key.key);
      return { op: "LDG", decode: (ops) => ({ op: "LDG", dst: val(dst, ops), idx: val(i, ops), key: val(k, ops), len: 1 + countRefs([dst, i, k]) }) };
    }
    if (v.t === "un" && v.op === "typeof" && v.a.t === "either") {
      const g = flattenEither(v.a).find((x) => x.t === "gread");
      if (g && g.key.t === "yload") {
        const i = regRef(g.key.idx), k = regRef(g.key.key);
        return { op: "TYPEOF_G", decode: (ops) => ({ op: "TYPEOF_G", dst: val(dst, ops), idx: val(i, ops), key: val(k, ops), len: 1 + countRefs([dst, i, k]) }) };
      }
    }
    if (v.t === "fslot" && v.n === 8) {
      return { op: "THIS", decode: (ops) => ({ op: "THIS", dst: val(dst, ops), len: 1 + countRefs([dst]) }) };
    }
    if (v.t === "cellread" && v.x && v.x.t === "jref") {
      const i = regRef(v.x.idx);
      return { op: "CGET", decode: (ops) => ({ op: "CGET", dst: val(dst, ops), cell: val(i, ops), len: 1 + countRefs([dst, i]) }) };
    }
    if (v.t === "mem" && v.obj && v.obj.t === "reg") {
      const obj = R(v.obj), key = R(v.key);
      return { op: "GETPROP", decode: (ops) => ({ op: "GETPROP", dst: val(dst, ops), obj: val(obj, ops), key: val(key, ops), len: 1 + countRefs([dst, obj, key]) }) };
    }
    if (v.t === "delete" && v.obj && v.obj.t === "reg") {
      const obj = R(v.obj), key = R(v.key);
      return { op: "DELPROP", decode: (ops) => ({ op: "DELPROP", dst: val(dst, ops), obj: val(obj, ops), key: val(key, ops), len: 1 + countRefs([dst, obj, key]) }) };
    }
  }

  return null;
}

function findMult(term, depth = 0) {
  if (!term || depth > 8) return null;
  if (term.t === "num" && term.v > 1000000) return term.v;
  return findMult(term.l, depth + 1) || findMult(term.r, depth + 1) || findMult(term.a, depth + 1) || findMult(term.b, depth + 1);
}
/** deep-collect the first newmeta term inside an effect list */
function findNewMeta(effs) {
  const seen = new Set();
  let found = null;
  const walk = (x, depth) => {
    if (!x || typeof x !== "object" || found || depth > 12 || seen.has(x)) return;
    seen.add(x);
    if (x.t === "newmeta") { found = x.meta; return; }
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (Array.isArray(v)) v.forEach((y) => walk(y, depth + 1));
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, depth + 1);
    }
  };
  for (const e of effs) { walk(e, 0); if (found) break; }
  if (!found) return null;
  // meta values may be wrapped; return raw map
  return found;
}
function containsNewMeta(effs) {
  return !!findNewMeta(effs);
}
function findYInEnv(rec, term) {
  return term && term.t === "freevar" ? rec.env.get(term.name) : null;
}
function firstRegRead(rec, skip = 0) {
  const r = rec.regReads[skip];
  return r !== undefined ? { t: "reg", x: r } : null;
}
function regRefOfTerm(term) {
  if (!term) return null;
  if (term.t === "reg") return regRef(term.x);
  if (term.t === "num") return { imm: term.v };
  if (term.t === "opnd") return { op: term.n };
  return null;
}
function val(ref, ops) {
  if (!ref) return undefined;
  if (ref.imm !== undefined) return ref.imm;
  if (ref.op !== undefined) return ops[ref.op];
  return undefined;
}
function countRefs(refs) {
  // only refs bound to operand-stream slots consume bytecode words
  return refs.filter((r) => r && r.op !== undefined).length;
}

/** classify all handlers; returns Map opcode -> {op, decode} */
function classifyHandlers(vm) {
  const table = new Map();
  const failures = [];
  for (const [opcode, fn] of vm.handlers) {
    let sem = null;
    try {
      const rec = interpretHandler(fn, vm);
      sem = matchArchetype(rec);
      if (sem && !sem.decode) sem = null;
    } catch (e) {
      sem = null;
    }
    if (!sem) failures.push(opcode);
    else table.set(opcode, sem);
  }
  return { table, failures };
}

/* ================================================================== */
/* SECTION 4 — Constants decoder + bytecode disassembler               */
/* ================================================================== */

function makeConstDecoder(vm) {
  const F = vm.constants;
  const MULT = vm.decoderMult;
  return function decodeConst(idx, key) {
    const v = F[idx];
    if (!key) return v;
    if (typeof v === "number") return v ^ key;
    if (typeof v !== "string") return v;
    const buf = Buffer.from(v, "base64");
    let a = key;
    let out = "";
    for (let i = 0; i < buf.length / 2; i++) {
      a = (a + MULT) | 0;
      const w = buf[i * 2] | (buf[i * 2 + 1] << 8);
      out += String.fromCharCode(w ^ ((a ^ (a >>> 13)) & 0xffff));
    }
    return out;
  };
}

/**
 * Program analysis: path-sensitive abstract execution over the bytecode.
 *
 * - decodes instructions on demand (DECODE ops mutate a shared bytecode copy)
 * - constant-propagates registers per path so that CFF dispatcher jumps
 *   (JMPR through runtime hash functions like Math.imul mixers) resolve to
 *   concrete targets; pure leaf VM functions are concretely evaluated
 * - records true CFG edges per function, bypassing dispatcher machinery
 */
function analyze(vm, table, opts = {}) {
  const n = vm.bytecode;
  const decodeConst = makeConstDecoder(vm);
  const instrs = new Map();
  const functions = new Map();

  const maxSteps = opts.maxSteps || 400000;
  let steps = 0;
  const unknownRegions = [];
  const unresolvedJumps = [];

  const GLOBAL_WHITELIST = {
    Math, JSON, undefined: undefined, NaN: NaN, Infinity: Infinity,
    Object, Array, String, Number, Boolean, RegExp, Date, parseInt, parseFloat,
    isNaN, isFinite, encodeURIComponent, decodeURIComponent, Error, TypeError,
    RangeError, Symbol, Map, Set, WeakMap, Promise, Reflect, Proxy, ArrayBuffer,
    Uint8Array, Uint32Array,
  };

  function decodeAt(ip) {
    const opcode = n[ip];
    const sem = table.get(opcode);
    if (!sem) return null;
    const ops = [];
    for (let i = 1; i <= 32; i++) ops.push(n[ip + i]);
    let instr;
    try {
      instr = sem.decode(ops, {});
    } catch (e) {
      return null;
    }
    instr.ip = ip;
    instr.opcode = opcode;
    if (!instr.len || instr.len < 1) instr.len = 1;
    return instr;
  }

  const appliedDecodes = new Set();

  function getInstr(ip) {
    if (instrs.has(ip)) return instrs.get(ip);
    const instr = decodeAt(ip);
    if (instr) instrs.set(ip, instr);
    return instr;
  }

  function ensureFunction(entry, meta) {
    if (!functions.has(entry)) {
      functions.set(entry, {
        entry,
        params: meta.params || 0,
        regs: meta.regs || 0,
        rest: !!meta.rest,
        captures: meta.captures || [],
        ips: new Set(),
        edges: new Map(), // fromIp -> [{to, kind, cond, sense, origin}]
        blocks: null,
      });
    }
    return functions.get(entry);
  }

  // ---------------- concrete evaluator for pure VM leaf functions --------
  const evalCache = new Map();

  function concreteEval2(entry, args, budget) {
    const fn = functions.get(entry);
    if (!fn) return { fail: "unknown function" };
    const cacheKey = entry + "|" + args.map((a) => String(a) + "," + typeof a).join("|");
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey);
    if (budget <= 0) return { fail: "budget" };
    const regs = [];
    for (let i = 0; i < fn.params; i++) regs[i] = args[i];
    let ip = entry;
    let localSteps = 0;
    while (true) {
      if (++localSteps > 50000) return { fail: "step budget" };
      const instr = getInstr(ip);
      if (!instr) return { fail: "undecodable @" + ip };
      const r = (i) => regs[i];
      let jump = null; // "next" | target number
      switch (instr.op) {
        case "LDI": regs[instr.dst] = instr.imm; break;
        case "LDC": regs[instr.dst] = decodeConst(instr.idx, instr.key); break;
        case "UNDEF": regs[instr.dst] = instr.kind === "null" ? null : undefined; break;
        case "LDG": {
          const name = decodeConst(instr.idx, instr.key);
          if (!Object.prototype.hasOwnProperty.call(GLOBAL_WHITELIST, name)) return { fail: "global " + name };
          regs[instr.dst] = GLOBAL_WHITELIST[name];
          break;
        }
        case "TYPEOF_G": {
          const name = decodeConst(instr.idx, instr.key);
          if (!Object.prototype.hasOwnProperty.call(GLOBAL_WHITELIST, name)) return { fail: "global " + name };
          regs[instr.dst] = typeof GLOBAL_WHITELIST[name];
          break;
        }
        case "THIS": regs[instr.dst] = undefined; break;
        case "MOV": regs[instr.dst] = r(instr.src); break;
        case "ADD": regs[instr.dst] = r(instr.l) + r(instr.r); break;
        case "SUB": regs[instr.dst] = r(instr.l) - r(instr.r); break;
        case "MUL": regs[instr.dst] = r(instr.l) * r(instr.r); break;
        case "DIV": regs[instr.dst] = r(instr.l) / r(instr.r); break;
        case "MOD": regs[instr.dst] = r(instr.l) % r(instr.r); break;
        case "BAND": regs[instr.dst] = r(instr.l) & r(instr.r); break;
        case "BOR": regs[instr.dst] = r(instr.l) | r(instr.r); break;
        case "BXOR": regs[instr.dst] = r(instr.l) ^ r(instr.r); break;
        case "SHL": regs[instr.dst] = r(instr.l) << r(instr.r); break;
        case "SHR": regs[instr.dst] = r(instr.l) >> r(instr.r); break;
        case "USHR": regs[instr.dst] = r(instr.l) >>> r(instr.r); break;
        case "LT": regs[instr.dst] = r(instr.l) < r(instr.r); break;
        case "LE": regs[instr.dst] = r(instr.l) <= r(instr.r); break;
        case "GT": regs[instr.dst] = r(instr.l) > r(instr.r); break;
        case "GE": regs[instr.dst] = r(instr.l) >= r(instr.r); break;
        case "EQ": regs[instr.dst] = r(instr.l) == r(instr.r); break;
        case "NE": regs[instr.dst] = r(instr.l) != r(instr.r); break;
        case "SEQ": regs[instr.dst] = r(instr.l) === r(instr.r); break;
        case "SNE": regs[instr.dst] = r(instr.l) !== r(instr.r); break;
        case "INOP": {
          const o = r(instr.r);
          if (typeof o !== "object" || o === null) return { fail: "in-op" };
          regs[instr.dst] = r(instr.l) in o;
          break;
        }
        case "INSTANCEOF": {
          const c = r(instr.r);
          if (typeof c !== "function") return { fail: "instanceof" };
          regs[instr.dst] = r(instr.l) instanceof c;
          break;
        }
        case "POW": regs[instr.dst] = Math.pow(r(instr.l), r(instr.r)); break;
        case "NEG": regs[instr.dst] = -r(instr.src); break;
        case "NOT": regs[instr.dst] = !r(instr.src); break;
        case "BNOT": regs[instr.dst] = ~r(instr.src); break;
        case "TONUM": regs[instr.dst] = +r(instr.src); break;
        case "TYPEOF": regs[instr.dst] = typeof r(instr.src); break;
        case "ARRLIT": regs[instr.dst] = instr.parts.map((p) => r(p)); break;
        case "OBJLIT": {
          const o = {};
          for (const p of instr.parts) o[r(p.key)] = r(p.value);
          regs[instr.dst] = o;
          break;
        }
        case "GETPROP": {
          const obj = r(instr.obj), key = r(instr.key);
          if (obj === null || obj === undefined) return { fail: "getprop null" };
          try { regs[instr.dst] = obj[key]; } catch (e) { return { fail: "getprop" }; }
          break;
        }
        case "CALL":
        case "CALLI": {
          const fnV = r(instr.fn);
          const argv = instr.args.spread !== undefined ? r(instr.args.spread) : instr.args.list.map((x) => r(x));
          if (!Array.isArray(argv)) return { fail: "spread" };
          if (fnV && fnV.__vmfn) {
            const sub = concreteEval2(fnV.__vmfn, argv, budget - 1);
            if (sub.fail) return sub;
            regs[instr.dst] = sub.value;
          } else if (typeof fnV === "function") {
            try {
              const th = instr.op === "CALL" ? r(instr.thisArg) : undefined;
              regs[instr.dst] = fnV.apply(th, argv);
            } catch (e) { return { fail: "native call: " + e.message }; }
          } else return { fail: "call non-fn" };
          break;
        }
        case "CONSTRUCT": {
          const fnV = r(instr.fn);
          const argv = instr.args.spread !== undefined ? r(instr.args.spread) : instr.args.list.map((x) => r(x));
          if (fnV && fnV.__vmfn) return { fail: "construct vmfn" };
          if (typeof fnV !== "function") return { fail: "construct" };
          try { regs[instr.dst] = Reflect.construct(fnV, argv); } catch (e) { return { fail: "construct" }; }
          break;
        }
        case "JMP": jump = instr.target; break;
        case "JMPT": jump = r(instr.cond) ? instr.target : ip + instr.len; break;
        case "JMPF": jump = r(instr.cond) ? ip + instr.len : instr.target; break;
        case "JMPR": {
          const t = r(instr.src);
          if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t >= n.length) return { fail: "jmpr " + t };
          jump = t;
          break;
        }
        case "RET": {
          const out = { fail: null, value: r(instr.value) };
          evalCache.set(cacheKey, out);
          return out;
        }
        case "THROW": return { fail: "throw" };
        default:
          return { fail: "non-foldable op " + instr.op };
      }
      if (jump !== null) ip = jump;
      else ip += instr.len;
    }
  }

  // ---------------- abstract path exploration ----------------
  const entryMeta = vm.entryMeta || { m: 0, b: 0, v: 0 };
  ensureFunction(entryMeta.v || 0, entryMeta);

  const fnWork = [entryMeta.v || 0];

  // widening maps shared across exploration passes (ips never overlap fns)
  const stableV = new Map(); // ip -> Map(reg -> valKey | false)
  const stableB = new Map(); // ip -> Map(reg -> pairKey | false)

  function envKey(env) {
    const ks = Object.keys(env.v).sort((a, b) => a - b);
    const bs = Object.keys(env.b).sort((a, b) => a - b);
    return "v" + ks.map((k) => k + ":" + valKey(env.v[k])).join(";") + "|b" + bs.map((k) => k + ":" + pairKey(env.b[k])).join(";");
  }
  function pairKey(p) {
    return p ? p.condReg + "," + p.hi + "," + p.lo : String(p);
  }
  function valKey(v) {
    if (v && v.__sel) return "sel(" + v.__sel.condReg + "," + valKey(v.__sel.tv) + "," + valKey(v.__sel.fv) + ")";
    if (v && v.__vmfn) return "fn" + v.__vmfn;
    if (Array.isArray(v)) return "[" + v.map((x) => valKey(x)).join(",") + "]";
    if (typeof v === "object" && v !== null) return "{" + Object.keys(v).join(",") + "}";
    return typeof v + ":" + String(v);
  }
  function isComparison(op) {
    return op === "LT" || op === "LE" || op === "GT" || op === "GE" || op === "EQ" || op === "NE" || op === "SEQ" || op === "SNE";
  }

  function tryFoldBinop(op, a, b) {
    try {
      switch (op) {
        case "ADD": return a + b;
        case "SUB": return a - b;
        case "MUL": return a * b;
        case "DIV": return a / b;
        case "MOD": return a % b;
        case "BAND": return a & b;
        case "BOR": return a | b;
        case "BXOR": return a ^ b;
        case "SHL": return a << b;
        case "SHR": return a >> b;
        case "USHR": return a >>> b;
        case "LT": return a < b;
        case "LE": return a <= b;
        case "GT": return a > b;
        case "GE": return a >= b;
        case "EQ": return a == b;
        case "NE": return a != b;
        case "SEQ": return a === b;
        case "SNE": return a !== b;
        case "POW": return Math.pow(a, b);
        default: return undefined;
      }
    } catch (e) {
      return undefined;
    }
  }

  // ops that terminate a straight-line run (control-transfer / region markers)
  const CONTROL_OPS = new Set(["JMP", "JMPT", "JMPF", "JMPR", "RET", "THROW", "PUSHCATCH", "PUSHFIN", "POPH", "FORIN_NEXT"]);

  function exploreFunction(fnEntry) {
    const fn = functions.get(fnEntry);
    const visited = new Set();
    // env: { v: {reg-> value}, b: {reg-> invert(0|1)} }
    // value: concrete JS value | {__sel:{condReg, invert, tv, fv}} | absent = symbolic
    const newEnv = () => ({ v: {}, b: {} });
    const isSel = (x) => x && typeof x === "object" && x.__sel;
    const copyEnv = (e) => ({ v: { ...e.v }, b: { ...e.b } });
    const work = [{ ip: fnEntry, env: newEnv(), origin: null, trail: [] }];
    while (work.length) {
      if (++steps > maxSteps) { unresolvedJumps.push("step limit in fn@" + fnEntry); return false; }
      const item = work.pop();
      const { ip: curIp, env, origin } = item;
      const trail = item.trail;
      // Widen: drop facts that have differed across visits of curIp so path
      // exploration stays finite. __sel values are exempt while they are in
      // flight (dispatcher chains are inlined into one run, so a select only
      // needs to survive until the JMPR at the end of that run).
      {
        let pv = stableV.get(curIp);
        if (!pv) { pv = new Map(); stableV.set(curIp, pv); }
        for (const k of Object.keys(env.v)) {
          const kk = valKey(env.v[k]);
          const prev = pv.get(k);
          if (prev === undefined) pv.set(k, kk);
          else if (prev !== kk && prev !== false) pv.set(k, false);
        }
        // absence contradicts presence: converge to the intersection of facts
        for (const k of pv.keys()) if (!Object.prototype.hasOwnProperty.call(env.v, k)) pv.set(k, false);
        for (const k of Object.keys(env.v)) {
          if (pv.get(k) === false && !isSel(env.v[k])) delete env.v[k];
        }
        let pb = stableB.get(curIp);
        if (!pb) { pb = new Map(); stableB.set(curIp, pb); }
        for (const k of Object.keys(env.b)) {
          const kk = pairKey(env.b[k]);
          const prev = pb.get(k);
          if (prev === undefined) pb.set(k, kk);
          else if (prev !== kk && prev !== false) pb.set(k, false);
        }
        for (const k of pb.keys()) if (!Object.prototype.hasOwnProperty.call(env.b, k)) pb.set(k, false);
        for (const k of Object.keys(env.b)) if (pb.get(k) === false) delete env.b[k];
      }
      const key = curIp + "|" + envKey(env);
      if (visited.has(key)) continue;
      visited.add(key);
      if (opts.traceHot) opts.traceHot(curIp, env, origin);
      let ip = curIp;
      let myEnv = env;
      let myOrigin = origin;
      const runStart = curIp; // first ip of this straight-line run (case block leader)
      // memoized: does a fall-chain from `target` reach a JMPR (dispatcher entry)?
      const dispEntryCache = new Map();
      const isDispatcherEntry = (target) => {
        if (dispEntryCache.has(target)) return dispEntryCache.get(target);
        let ok = false;
        let p = target;
        for (let i = 0; i < 16; i++) {
          if (p < 0 || p >= n.length) break;
          const gi = getInstr(p);
          if (!gi) break;
          if (gi.op === "JMPR") { ok = true; break; }
          if (CONTROL_OPS.has(gi.op)) break; // control op interrupts the chain
          p += gi.len;
        }
        dispEntryCache.set(target, ok);
        return ok;
      };
      // straight-line run until a control instruction
      while (true) {
        if (++steps > maxSteps) { unresolvedJumps.push("step limit (inner) in fn@" + fnEntry); return false; }
        if (ip < 0 || ip >= n.length) break;
        const instr = getInstr(ip);
        if (!instr) { unknownRegions.push(ip); break; }
        fn.ips.add(ip);
        const next = ip + instr.len;
        const C = (x) => (x === undefined ? undefined : Object.prototype.hasOwnProperty.call(myEnv.v, x) ? myEnv.v[x] : undefined);
        const setR = (val, boolishInvert) => {
          if (instr.dst === undefined) return;
          if (val === undefined) delete myEnv.v[instr.dst];
          else myEnv.v[instr.dst] = val;
          if (val !== undefined || boolishInvert === undefined) delete myEnv.b[instr.dst];
          else myEnv.b[instr.dst] = boolishInvert;
        };
        const B = (x) => (Object.prototype.hasOwnProperty.call(myEnv.b, x) ? myEnv.b[x] : undefined);

        switch (instr.op) {
          case "DECODE": {
            if (!appliedDecodes.has(ip)) {
              appliedDecodes.add(ip);
              let k = (instr.key ^ instr.dstOff) | 0;
              for (let f = instr.start; f < instr.end; f++) {
                k = (k + instr.mult) | 0;
                n[instr.dstOff + (f - instr.start)] = (n[f] ^ (k ^ (k >>> 13))) >>> 0;
              }
              // after mutating bytecode, previously decoded instructions in the
              // affected range are stale
              for (const [k2] of instrs) {
                if (k2 >= instr.dstOff && k2 < instr.dstOff + (instr.end - instr.start)) instrs.delete(k2);
              }
            }
            ip = next;
            continue;
          }
          case "LDI": setR(instr.imm); ip = next; continue;
          case "LDC": setR(decodeConst(instr.idx, instr.key)); ip = next; continue;
          case "UNDEF": setR(instr.kind === "null" ? null : undefined); ip = next; continue;
          case "LDG": {
            const name = decodeConst(instr.idx, instr.key);
            setR(Object.prototype.hasOwnProperty.call(GLOBAL_WHITELIST, name) ? GLOBAL_WHITELIST[name] : undefined);
            ip = next; continue;
          }
          case "TYPEOF_G": {
            const name = decodeConst(instr.idx, instr.key);
            setR(Object.prototype.hasOwnProperty.call(GLOBAL_WHITELIST, name) ? typeof GLOBAL_WHITELIST[name] : undefined);
            ip = next; continue;
          }
          case "THIS": setR(undefined); ip = next; continue;
          case "MOV": {
            const srcV = C(instr.src);
            setR(srcV, srcV === undefined ? B(instr.src) : undefined);
            ip = next; continue;
          }
          case "NEG": case "NOT": case "BNOT": case "TONUM": case "TYPEOF": {
            const a = C(instr.src);
            const bb = B(instr.src);
            let v;
            if (a !== undefined) {
              try {
                if (instr.op === "NEG") v = -a;
                else if (instr.op === "NOT") v = !a;
                else if (instr.op === "BNOT") v = ~a;
                else if (instr.op === "TONUM") v = +a;
                else v = typeof a;
              } catch (e) { v = undefined; }
            }
            if (v === undefined && bb && instr.op !== "TYPEOF") {
              // boolean-pair propagation through a pure unop
              if (instr.op === "NOT") setR(undefined, { condReg: bb.condReg, hi: bb.lo, lo: bb.hi });
              else if (instr.op === "NEG") setR(undefined, { condReg: bb.condReg, hi: -bb.hi, lo: -bb.lo });
              else if (instr.op === "BNOT") setR(undefined, { condReg: bb.condReg, hi: ~bb.hi, lo: ~bb.lo });
              else setR(undefined, bb);
            } else setR(v);
            ip = next; continue;
          }
          case "ADD": case "SUB": case "MUL": case "DIV": case "MOD":
          case "BAND": case "BOR": case "BXOR": case "SHL": case "SHR": case "USHR":
          case "LT": case "LE": case "GT": case "GE": case "EQ": case "NE":
          case "SEQ": case "SNE": case "POW": {
            const a = C(instr.l), b = C(instr.r);
            if (a !== undefined && b !== undefined && !isSel(a) && !isSel(b)) {
              setR(tryFoldBinop(instr.op, a, b));
              ip = next; continue;
            }
            // select algebra: {__sel} combined with a constant
            const aSel = isSel(a), bSel = isSel(b);
            const konst = aSel ? b : bSel ? a : undefined;
            if ((aSel || bSel) && konst !== undefined && typeof konst === "number") {
              const sel = aSel ? a.__sel : b.__sel;
              const map = (x) => tryFoldBinop(instr.op, aSel ? x : konst, aSel ? konst : x);
              const tv = map(sel.tv), fv = map(sel.fv);
              if (tv !== undefined && fv !== undefined) {
                setR({ __sel: { condReg: sel.condReg, tv, fv } });
                ip = next; continue;
              }
            }
            // branchless CFF select creation: <const> OP <boolean pair> or
            // <boolean pair> OP <const>  (e.g. K1 + (K2-K1)*b, diff & -b)
            {
              const bl = B(instr.l), br = B(instr.r);
              const tryMake = (pair, k, pairLeft) => {
                if (!pair || typeof k !== "number") return undefined;
                const f = (x) => tryFoldBinop(instr.op, pairLeft ? x : k, pairLeft ? k : x);
                const tv = f(pair.hi), fv = f(pair.lo);
                if (tv === undefined || fv === undefined || tv === fv) return undefined;
                return { __sel: { condReg: pair.condReg, tv, fv } };
              };
              const made = a === undefined && b !== undefined ? tryMake(bl, b, true) : b === undefined && a !== undefined ? tryMake(br, a, false) : undefined;
              if (made) {
                setR(made);
                ip = next; continue;
              }
            }
            setR(undefined, (isComparison(instr.op) || instr.op === "INOP" || instr.op === "INSTANCEOF") ? { condReg: instr.dst, hi: 1, lo: 0 } : undefined);
            ip = next; continue;
          }
          case "INOP": case "INSTANCEOF": setR(undefined, { condReg: instr.dst, hi: 1, lo: 0 }); ip = next; continue;
          case "GETPROP": case "DELPROP": {
            const obj = C(instr.obj), key = C(instr.key);
            if (instr.op === "GETPROP" && isSel(obj) && key !== undefined && !isSel(key)) {
              // project through a branchless select: sel.tv[key] / sel.fv[key]
              let tv, fv;
              try { tv = obj.__sel.tv[key]; } catch (e) { tv = undefined; }
              try { fv = obj.__sel.fv[key]; } catch (e) { fv = undefined; }
              if (tv !== undefined && fv !== undefined && !isSel(tv) && !isSel(fv)) {
                setR({ __sel: { condReg: obj.__sel.condReg, tv, fv } });
                ip = next; continue;
              }
            }
            let v;
            if (obj !== undefined && key !== undefined && obj !== null && instr.op === "GETPROP") {
              try {
                if ((typeof obj === "object" && (Array.isArray(obj) || obj === Math || obj === JSON)) || typeof obj === "string" || typeof obj === "number") {
                  v = obj[key];
                  if (typeof v === "function") v = v; // keep native fn consts (e.g. Math.imul)
                  else if (v && typeof v === "object") v = v;
                  else if (typeof v === "object") v = undefined;
                }
              } catch (e) { v = undefined; }
            }
            setR(v);
            ip = next; continue;
          }
          case "ARRLIT": {
            const parts = instr.parts.map((p) => C(p));
            setR(parts.every((p) => p !== undefined && !isSel(p)) ? parts : undefined);
            ip = next; continue;
          }
          case "OBJLIT": setR(undefined); ip = next; continue;
          case "CGET": setR(undefined, { condReg: instr.dst, hi: 1, lo: 0 }); ip = next; continue;
          case "CSET": ip = next; continue;
          case "SETPROP": case "STG": case "FORIN_INIT": ip = next; continue;
          case "MKFUNC": {
            setR({ __vmfn: instr.entry, params: instr.params, regs: instr.regs, captures: instr.captures });
            const sub = ensureFunction(instr.entry, instr);
            if (!fnWork.includes(instr.entry) && !functions.get(instr.entry)._queued) {
              functions.get(instr.entry)._queued = true;
              fnWork.push(instr.entry);
            }
            ip = next; continue;
          }
          case "CALL":
          case "CALLI":
          case "CONSTRUCT": {
            const fnV = C(instr.fn);
            const argv = instr.args.spread !== undefined ? C(instr.args.spread) : instr.args.list.map((x) => C(x));
            let v;
            if (instr.op !== "CONSTRUCT" && fnV && fnV.__vmfn && (!fnV.captures || fnV.captures.length === 0) && Array.isArray(argv)) {
              const selIdx = argv.findIndex((x) => isSel(x));
              if (selIdx >= 0 && argv.every((x, i) => i === selIdx || (x !== undefined && !isSel(x)))) {
                // dual-evaluate a pure leaf VM function with tv / fv arguments
                const sel = argv[selIdx].__sel;
                const rt = concreteEval2(fnV.__vmfn, argv.map((x, i) => (i === selIdx ? sel.tv : x)), 8);
                const rf = concreteEval2(fnV.__vmfn, argv.map((x, i) => (i === selIdx ? sel.fv : x)), 8);
                if (!rt.fail && !rf.fail) v = { __sel: { condReg: sel.condReg, tv: rt.value, fv: rf.value } };
              } else if (selIdx < 0 && argv.every((x) => x !== undefined)) {
                const sub = concreteEval2(fnV.__vmfn, argv, 8);
                if (!sub.fail) v = sub.value;
              }
            } else if (fnV !== undefined && !isSel(fnV) && typeof fnV === "function" && Array.isArray(argv) && argv.every((x) => x !== undefined && !isSel(x))) {
              try { v = fnV.apply(null, argv); } catch (e) { v = undefined; }
            }
            setR(v);
            ip = next; continue;
          }
          case "DEFGET": case "DEFSET": case "POPH": case "PUSHCATCH": case "PUSHFIN":
          case "FORIN_NEXT": {
            // FORIN_NEXT handled at edge level below
            break;
          }
          case "JMP": {
            // A jump whose target falls through into a JMPR is a CFF
            // dispatcher entry — inline the chain into this run so the
            // state-select algebra (salt + select) is never split by a
            // widening point.
            if (isDispatcherEntry(instr.target)) {
              fn.dispEntries = fn.dispEntries || new Set();
              fn.dispEntries.add(instr.target);
              ip = instr.target;
              continue;
            }
            break;
          }
        }
        break; // reached a control/side-effect instruction that ends the run
      }
      trail.push(ip);
      if (trail.length > 24) trail.shift();

      // control-flow edge handling for the instruction at `ip`
      const instr = getInstr(ip);
      if (!instr) continue;
      const next = ip + instr.len;
      const mkEdge = (to, kind, cond, sense, extra) => {
        if (to === undefined || to === null || to < 0 || to >= n.length) return;
        if (!fn.edges.has(ip)) fn.edges.set(ip, []);
        fn.edges.get(ip).push({ to, kind, cond, sense, origin: myOrigin, ...(extra || {}) });
      };
      const fork = (to, kind, cond, sense) => {
        work.push({ ip: to, env: copyEnv(myEnv), origin: kind && kind !== "fall" ? ip : myOrigin, trail: [...trail] });
      };
      const condV = (i) => (i === undefined ? undefined : Object.prototype.hasOwnProperty.call(myEnv.v, i) ? myEnv.v[i] : undefined);

      switch (instr.op) {
        case "JMP": {
          mkEdge(instr.target, "jump");
          fork(instr.target, "jump");
          break;
        }
        case "JMPR": {
          const t = condV(instr.src);
          const sel = t && t.__sel;
          if (
            sel && Number.isInteger(sel.tv) && Number.isInteger(sel.fv) &&
            sel.tv >= 0 && sel.tv < n.length && sel.fv >= 0 && sel.fv < n.length
          ) {
            // branchless CFF dispatch through a select value:
            // the tv side is taken when the condition register is truthy
            mkEdge(sel.tv, "dispatch", sel.condReg, true, { blockStart: runStart });
            mkEdge(sel.fv, "dispatch", sel.condReg, false, { blockStart: runStart });
            const envT = copyEnv(myEnv);
            envT.v[sel.condReg] = true; delete envT.b[sel.condReg]; delete envT.v[instr.src];
            const envF = copyEnv(myEnv);
            envF.v[sel.condReg] = false; delete envF.b[sel.condReg]; delete envF.v[instr.src];
            work.push({ ip: sel.tv, env: envT, origin: ip, trail: [...trail] });
            work.push({ ip: sel.fv, env: envF, origin: ip, trail: [...trail] });
          } else if (typeof t === "number" && Number.isInteger(t) && t >= 0 && t < n.length) {
            mkEdge(t, "dispatch", undefined, undefined, { blockStart: runStart });
            const envD = copyEnv(myEnv);
            delete envD.v[instr.src];
            work.push({ ip: t, env: envD, origin: ip, trail: [...trail] });
          } else {
            unresolvedJumps.push({ fn: fnEntry, ip, trail: [...trail], env: myEnv });
          }
          break;
        }
        case "JMPT":
        case "JMPF": {
          const cv = condV(instr.cond);
          const taken = instr.op === "JMPT" ? cv : cv === undefined ? undefined : !cv;
          if (taken !== undefined) {
            const to = taken ? instr.target : next;
            mkEdge(to, "branch", instr.cond, taken);
            fork(to, "branch");
          } else {
            // fork with the condition register bound per path so conditional
            // state-transition chains (CFF) fold on each side
            mkEdge(instr.target, instr.op === "JMPT" ? "true" : "false", instr.cond, true);
            mkEdge(next, instr.op === "JMPT" ? "false" : "true", instr.cond, false);
            const tv = instr.op === "JMPT";
            const envT = copyEnv(myEnv);
            envT.v[instr.cond] = tv; delete envT.b[instr.cond];
            const envF = copyEnv(myEnv);
            envF.v[instr.cond] = !tv; delete envF.b[instr.cond];
            work.push({ ip: instr.target, env: envT, origin: ip, trail: [...trail] });
            work.push({ ip: next, env: envF, origin: ip, trail: [...trail] });
          }
          break;
        }
        case "FORIN_NEXT": {
          mkEdge(next, "loop-next");
          mkEdge(instr.exit, "loop-exit");
          fork(next, "loop");
          fork(instr.exit, "loop");
          break;
        }
        case "RET":
        case "THROW":
          break;
        case "PUSHCATCH": {
          mkEdge(next, "fall");
          fork(next, "fall");
          // exceptional edge into catch handler
          const catchIp = instr.catchIP;
          if (catchIp !== undefined) {
            mkEdge(catchIp, "catch");
            work.push({ ip: catchIp, env: newEnv(), origin: ip, trail: [...trail] });
          }
          break;
        }
        case "PUSHFIN": {
          mkEdge(next, "fall");
          fork(next, "fall");
          const finIp = instr.finIP;
          if (finIp !== undefined) {
            mkEdge(finIp, "finally");
            work.push({ ip: finIp, env: newEnv(), origin: ip, trail: [...trail] });
          }
          break;
        }
        case "POPH": {
          mkEdge(next, "fall");
          fork(next, "fall");
          break;
        }
        default: {
          mkEdge(next, "fall");
          fork(next, "fall");
        }
      }
    }
    return true;
  }

  // Multi-pass exploration: each pass learns more about which register facts
  // are stable at a given ip (widening); later passes prune early and
  // converge. Runs until a pass completes within the step budget.
  let completed = false;
  for (let pass = 0; pass < 12 && !completed; pass++) {
    steps = 0;
    unresolvedJumps.length = 0;
    for (const fn of functions.values()) fn._queued = false;
    fnWork.length = 0;
    fnWork.push(entryMeta.v || 0);
    completed = true;
    while (fnWork.length) {
      const e = fnWork.shift();
      if (!exploreFunction(e)) completed = false;
    }
    if (opts.tracePass) opts.tracePass(pass, completed);
  }

  for (const fn of functions.values()) delete fn._queued;
  return { instrs, functions, unknownRegions, unresolvedJumps, decodeConst, n };
}

/* ================================================================== */
/* SECTION 5 — Lifter: CFG reconstruction + JavaScript emission        */
/* ================================================================== */

const LIFT_BINOPS = new Set(["ADD", "SUB", "MUL", "DIV", "MOD", "BAND", "BOR", "BXOR", "SHL", "SHR", "USHR", "LT", "LE", "GT", "GE", "EQ", "NE", "SEQ", "SNE", "INOP", "INSTANCEOF", "POW"]);
const LIFT_BINOP_SYM = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%", BAND: "&", BOR: "|", BXOR: "^", SHL: "<<", SHR: ">>", USHR: ">>>", LT: "<", LE: "<=", GT: ">", GE: ">=", EQ: "==", NE: "!=", SEQ: "===", SNE: "!==", INOP: "in", INSTANCEOF: "instanceof", POW: "**" };
const LIFT_UNOP_SYM = { NEG: "-", NOT: "!", BNOT: "~", TONUM: "+", TYPEOF: "typeof" };
const LIFT_PURE = new Set(["LDI", "LDC", "UNDEF", "MOV", "THIS", "CGET", "NEG", "NOT", "BNOT", "TONUM", "TYPEOF", "GETPROP", "ARRLIT", "LDG", "TYPEOF_G", ...LIFT_BINOPS]);
const LIFT_TERMINATORS = new Set(["RET", "THROW", "JMP", "JMPT", "JMPF", "FORIN_NEXT", "POPH", "PUSHCATCH", "PUSHFIN"]);
// pure ops whose dead defs may be removed (GETPROP/LDG kept: getters may fire)
const LIFT_DSE_SAFE = new Set([...LIFT_PURE].filter((op) => op !== "GETPROP" && op !== "LDG"));

function binopConst(op, a, b) {
  switch (op) {
    case "ADD": return a + b;
    case "SUB": return a - b;
    case "MUL": return a * b;
    case "DIV": return b === 0 ? undefined : a / b;
    case "MOD": return b === 0 ? undefined : a % b;
    case "BAND": return a & b;
    case "BOR": return a | b;
    case "BXOR": return a ^ b;
    case "SHL": return a << b;
    case "SHR": return a >> b;
    case "USHR": return a >>> b;
    case "LT": return a < b;
    case "LE": return a <= b;
    case "GT": return a > b;
    case "GE": return a >= b;
    case "EQ": return a == b;
    case "NE": return a != b;
    case "SEQ": return a === b;
    case "SNE": return a !== b;
    case "INOP": return undefined;
    case "INSTANCEOF": return undefined;
    case "POW": return a ** b;
    default: return undefined;
  }
}
function unopConst(op, v) {
  switch (op) {
    case "NEG": return -v;
    case "NOT": return !v;
    case "BNOT": return ~v;
    case "TONUM": return +v;
    case "TYPEOF": return typeof v;
    default: return undefined;
  }
}

/** per-block constant evaluator over scalar registers (shared by the
 *  case-dispatch dissolution and block-local constant folding) */
function makeConstEval(getInstr, decodeConst) {
  return function evalBlock(env, ips) {
    const e = new Map(env);
    for (const ip of ips) {
      const gi = getInstr(ip);
      if (!gi) continue;
      if (LIFT_BINOPS.has(gi.op)) {
        const a = e.get(gi.l), b = e.get(gi.r);
        const v = a !== undefined && b !== undefined ? binopConst(gi.op, a, b) : undefined;
        if (v === undefined) e.delete(gi.dst); else e.set(gi.dst, v);
      } else if (gi.op === "LDI") e.set(gi.dst, gi.imm);
      else if (gi.op === "LDC") {
        try { const v = decodeConst(gi.idx, gi.key); if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") e.set(gi.dst, v); else e.delete(gi.dst); } catch (err) { e.delete(gi.dst); }
      } else if (gi.op === "MOV") {
        const v = e.get(gi.src);
        if (v === undefined) e.delete(gi.dst); else e.set(gi.dst, v);
      } else if (LIFT_UNOP_SYM[gi.op]) {
        const v = e.get(gi.src);
        const r = v === undefined ? undefined : unopConst(gi.op, v);
        if (r === undefined) e.delete(gi.dst); else e.set(gi.dst, r);
      } else e.delete(gi.dst);
    }
    return e;
  };
}

function readsOf(i) {
  const r = [];
  const push = (x) => { if (x !== undefined) r.push(x); };
  if (LIFT_BINOPS.has(i.op)) { push(i.l); push(i.r); }
  else
    switch (i.op) {
      case "NEG": case "NOT": case "BNOT": case "TONUM": case "TYPEOF": push(i.src); break;
      case "MOV": push(i.src); break;
      case "GETPROP": case "DELPROP": push(i.obj); push(i.key); break;
      case "SETPROP": push(i.obj); push(i.key); push(i.value); break;
      case "STG": push(i.value); break;
      case "CSET": push(i.src); break;
      case "ARRLIT": i.parts.forEach(push); break;
      case "OBJLIT": i.parts.forEach((p) => { push(p.key); push(p.value); }); break;
      case "DEFGET": case "DEFSET": push(i.obj); push(i.key); push(i.fn); break;
      case "FORIN_INIT": push(i.src); break;
      case "FORIN_NEXT": push(i.iter); break;
      case "CALL": push(i.fn); if (i.thisArg !== undefined) push(i.thisArg); if (i.args.spread !== undefined) push(i.args.spread); else i.args.list.forEach(push); break;
      case "CALLI": case "CONSTRUCT": push(i.fn); if (i.args.spread !== undefined) push(i.args.spread); else i.args.list.forEach(push); break;
      case "THROW": push(i.src); break;
      case "RET": push(i.value); break;
      case "MKFUNC": if (i.captures) for (const c of i.captures) if (c.newCell && c.src !== undefined) push(c.src); break; // live-box capture reads the parent reg
      case "JMPT": case "JMPF": push(i.cond); break;
      case "JMPR": push(i.src); break;
    }
  return r;
}

function writesOf(i) {
  if (["SETPROP", "STG", "CSET", "THROW", "JMP", "JMPT", "JMPF", "JMPR", "DECODE", "DEBUGGER", "POPH", "PUSHCATCH", "PUSHFIN"].includes(i.op)) return [];
  return i.dst === undefined ? [] : [i.dst];
}

function literalAst(v) {
  if (v === undefined) return t.identifier("undefined");
  if (v === null) return t.nullLiteral();
  if (typeof v === "number") return Number.isFinite(v) ? t.numericLiteral(v) : t.identifier(String(v));
  if (typeof v === "string") return t.stringLiteral(v);
  if (typeof v === "boolean") return t.booleanLiteral(v);
  if (Array.isArray(v)) return t.arrayExpression(v.map(literalAst));
  if (typeof v === "object") {
    return t.objectExpression(Object.keys(v).map((k) => t.objectProperty(t.isValidIdentifier(k) ? t.identifier(k) : t.stringLiteral(k), literalAst(v[k]))));
  }
  return t.identifier("undefined");
}

/** Build the deobfuscated program AST from an analysis result. */
function liftProgram(analysis) {
  const { functions, instrs, decodeConst } = analysis;
  const getInstr = (ip) => instrs.get(ip) || null;

  // fn linkage: parent + captures (from real MKFUNC instrs anywhere)
  const fnParents = new Map();
  for (const fn of functions.values()) {
    for (const ip of fn.ips) {
      const gi = getInstr(ip);
      if (gi && gi.op === "MKFUNC" && functions.has(gi.entry)) {
        fnParents.set(gi.entry, { parent: fn.entry });
      }
    }
  }

  function cellVarName(fnEntry, cellIdx) {
    const fn = functions.get(fnEntry);
    const caps = fn.captures || [];
    const cap = caps[cellIdx];
    if (!cap) return "cell" + cellIdx;
    if (cap.newCell) return "c" + cap.src;
    const par = fnParents.get(fnEntry);
    if (par && functions.has(par.parent)) return cellVarName(par.parent, cap.src);
    return "c" + cap.src;
  }

  function maxLE(set, ip) {
    let best;
    for (const x of set) if (x <= ip && (best === undefined || x > best)) best = x;
    return best;
  }

  // ---------------- per-function block CFG ----------------
  function prepareFn(fn) {
    const info = { fn, blocks: new Map(), entryBlock: null, scheduled: new Set(), ok: false };

    // deduped dispatch edges keyed by the originating case block
    const byBlk = new Map();
    for (const eds of fn.edges.values()) {
      for (const e of eds) {
        if (e.kind !== "dispatch" || e.blockStart === undefined) continue;
        if (!byBlk.has(e.blockStart)) byBlk.set(e.blockStart, new Map());
        byBlk.get(e.blockStart).set(e.to + "|" + (e.cond === undefined ? "-" : e.cond + ":" + e.sense), e);
      }
    }
    const dispatch = new Map();
    for (const [blk, m] of byBlk) {
      const eds = [...m.values()];
      const withCond = eds.filter((e) => e.cond !== undefined);
      const use = withCond.length ? withCond : eds;
      if (use.length === 2 && use[0].cond === use[1].cond && use[0].sense !== use[1].sense) {
        const tt = use.find((e) => e.sense === true), ff = use.find((e) => e.sense === false);
        dispatch.set(blk, { kind: "cond", condReg: tt.cond, t: tt.to, f: ff.to });
      } else if (use.length === 1) dispatch.set(blk, { kind: "goto", to: use[0].to });
      else dispatch.set(blk, { kind: "multi", edges: use });
    }

    // dispatcher chain machinery
    const dispEntries = fn.dispEntries || new Set();
    const mach = new Set();
    const chainReads = new Set();
    const chainWrites = new Set();
    for (const D of dispEntries) {
      let ip = D;
      for (let guard = 0; guard < 48; guard++) {
        const gi = getInstr(ip);
        if (!gi || !fn.ips.has(ip)) break;
        mach.add(ip);
        readsOf(gi).forEach((r) => chainReads.add(r));
        writesOf(gi).forEach((r) => chainWrites.add(r));
        if (gi.op === "JMPR") break;
        const nx = ip + gi.len;
        if (!fn.ips.has(nx)) break;
        ip = nx;
      }
    }
    for (const w of chainWrites) chainReads.delete(w);

    const leaders = new Set([fn.entry]);
    for (const [blk, d] of dispatch) {
      leaders.add(blk);
      if (d.kind === "goto") leaders.add(d.to);
      else if (d.kind === "cond") { leaders.add(d.t); leaders.add(d.f); }
      else for (const e of d.edges) leaders.add(e.to);
    }

    const predOf = new Map();
    for (const ip of fn.ips) {
      const gi = getInstr(ip);
      if (!gi) continue;
      const nx = ip + gi.len;
      if (fn.ips.has(nx) && !predOf.has(nx)) predOf.set(nx, ip);
    }

    // backward slice of each case block's state-select code; recovers the
    // original condition register when the entry dispatch folded to a const
    const blockCondReg = new Map();
    for (const ip of fn.ips) {
      const gi = getInstr(ip);
      if (!(gi && gi.op === "JMP" && dispEntries.has(gi.target))) continue;
      mach.add(ip);
      const blkStart = maxLE(leaders, ip);
      if (blkStart === undefined) continue;
      const live = new Set(chainReads);
      let cur = ip;
      let boundary;
      for (let guard = 0; guard < 96; guard++) {
        const p = predOf.get(cur);
        if (p === undefined || mach.has(p) || !fn.ips.has(p) || leaders.has(p)) break;
        const pi = getInstr(p);
        const wr = writesOf(pi);
        if (wr.some((r) => live.has(r))) {
          mach.add(p);
          wr.forEach((r) => live.delete(r));
          if (pi.op === "NOT" || pi.op === "TONUM") {
            if (boundary === undefined) boundary = pi.src;
          } else readsOf(pi).forEach((r) => live.add(r));
          cur = p;
        } else break;
      }
      if (boundary !== undefined) blockCondReg.set(blkStart, boundary);
    }

    const realIps = new Set([...fn.ips].filter((ip) => !mach.has(ip)));

    const termOf = (start, list) => {
      const d = dispatch.get(start);
      if (d) return d;
      const last = getInstr(list[list.length - 1]);
      if (last && last.op === "RET") return { kind: "ret", value: last.value };
      if (last && last.op === "THROW") return { kind: "throw", src: last.src };
      if (last && (last.op === "JMPT" || last.op === "JMPF")) {
        const eds = (fn.edges.get(list[list.length - 1]) || []).filter((e) => ["true", "false", "branch"].includes(e.kind));
        const tT = eds.find((e) => e.kind === "true" || (e.kind === "branch" && e.sense === true));
        const tF = eds.find((e) => e.kind === "false" || (e.kind === "branch" && e.sense === false));
        if (tT && tF) return { kind: "cond", condReg: last.cond, t: tT.to, f: tF.to };
        if (tT) return { kind: "goto", to: tT.to };
        if (tF) return { kind: "goto", to: tF.to };
      }
      if (last && last.op === "JMP") return { kind: "goto", to: last.target };
      return { kind: "dead" };
    };

    for (const L of leaders) {
      if (!realIps.has(L)) continue;
      const list = [];
      let ip = L;
      while (ip !== undefined && realIps.has(ip)) {
        list.push(ip);
        const gi = getInstr(ip);
        if (LIFT_TERMINATORS.has(gi.op)) break;
        const nx = ip + gi.len;
        if (leaders.has(nx)) break;
        ip = realIps.has(nx) ? nx : undefined;
      }
      if (list.length) info.blocks.set(L, { start: L, ips: list, term: termOf(L, list) });
    }

    // entry block (+ CFF folded-entry repair): when the entry's dispatch was
    // const-folded, the VM jumped straight to the folded target, bypassing the
    // loop head's condition block (which still ran as dispatch machinery on
    // the entry's original straight-line path). Redirect the entry edge back
    // to that head so the loop closes; the head re-derives the same condition.
    let entry = fn.entry;
    if (info.blocks.has(entry)) {
      const eb = info.blocks.get(entry);
      if (eb.term.kind === "goto") {
        const T = eb.term.to;
        if (T !== entry && info.blocks.has(T)) {
          // follow the entry's fall chain to its dispatcher JMP
          let ip = eb.ips[eb.ips.length - 1];
          let jmpIp;
          for (let g = 0; g < 96; g++) {
            const gi = getInstr(ip);
            if (!gi) break;
            if (gi.op === "JMP") { jmpIp = ip; break; }
            const nx = ip + gi.len;
            if (!fn.ips.has(nx)) break;
            ip = nx;
          }
          if (jmpIp !== undefined) {
            // block whose leader range contains that JMP = the folded head
            let P = -1;
            for (const bs of info.blocks.keys()) if (bs <= jmpIp && bs > P) P = bs;
            const pb = info.blocks.get(P);
            if (
              P > 0 && P !== entry && pb && pb.term.kind === "cond" &&
              pb.ips[pb.ips.length - 1] < jmpIp &&
              P > eb.ips[eb.ips.length - 1] &&
              (pb.term.t === T || pb.term.f === T)
            ) {
              eb.term = { kind: "goto", to: P };
            }
          }
        }
      }
    }
    // ---- CFF case-dispatch dissolution ----
    // The payload's own control-flow flattening lowered the original control
    // flow to a `switch(state)` machine: a dispatch-loop header (hub of many
    // back edges) testing `state SEQ/SNE EXIT`, a comparison ladder, and case
    // bodies that update `state = state ± K` and jump back. Because ladder
    // matches are exact (===), every body runs with a known constant state, so
    // each back edge's true successor is statically computable: rewire bodies
    // to their successors directly and let the dead dispatch become
    // unreachable. State-variable arithmetic itself stays (it is real code).
    for (let round = 0; round < (process.env.VM_NODISSOLVE ? 0 : 4); round++) {
      const gotoPredCounts = new Map();
      for (const b of info.blocks.values()) {
        if (b.term.kind === "goto" && info.blocks.has(b.term.to)) {
          gotoPredCounts.set(b.term.to, (gotoPredCounts.get(b.term.to) || 0) + 1);
        }
      }
      let H = null;
      for (const [t, n] of gotoPredCounts) if (n >= 3 && info.blocks.get(t).term.kind === "cond") { H = t; break; }
      if (H === null) break;
      const Hb = info.blocks.get(H);

      // evaluate a block's scalar registers over a carried constant env
      const evalBlock = makeConstEval(getInstr, decodeConst);
      const defOf = (ips, reg) => {
        for (let i = ips.length - 1; i >= 0; i--) {
          const gi = getInstr(ips[i]);
          if (gi && writesOf(gi).includes(reg)) return gi;
        }
        return null;
      };

      // state reg + exit constant from the header's condition
      let stateReg, exitConst, equalSide;
      {
        const gi = defOf(Hb.ips, Hb.term.condReg);
        if (!gi || (gi.op !== "SEQ" && gi.op !== "SNE")) break;
        const env = evalBlock(new Map(), Hb.ips);
        const lv = env.get(gi.l), rv = env.get(gi.r);
        if (lv !== undefined && rv === undefined) { stateReg = gi.r; exitConst = lv; }
        else if (rv !== undefined && lv === undefined) { stateReg = gi.l; exitConst = rv; }
        else break;
        if (typeof exitConst !== "number") break;
        equalSide = gi.op === "SEQ" ? Hb.term.t : Hb.term.f;
        if (!info.blocks.has(equalSide)) break;
      }
      const ladderSide = equalSide === Hb.term.t ? Hb.term.f : Hb.term.t;
      if (!info.blocks.has(ladderSide)) break;

      // comparison ladder: chain of cond blocks comparing state to a
      // running-constant ladder variable
      const links = []; // { C, target, block }
      const linkBlocks = new Set([H]);
      let ok = true;
      let fallback = null; // ladder end: no-link-matched block (gotos back to H)
      let Lb = info.blocks.get(ladderSide);
      let lEnv = new Map();
      while (ok) {
        if (!Lb || Lb.term.kind !== "cond" || links.length > 300) { ok = false; break; }
        lEnv = evalBlock(lEnv, Lb.ips);
        const gi = defOf(Lb.ips, Lb.term.condReg);
        if (!gi || (gi.op !== "SEQ" && gi.op !== "SNE")) { ok = false; break; }
        let C, matchSide;
        if (gi.l === stateReg && lEnv.get(gi.r) !== undefined && lEnv.get(gi.l) === undefined) { C = lEnv.get(gi.r); matchSide = gi.op === "SEQ"; }
        else if (gi.r === stateReg && lEnv.get(gi.l) !== undefined && lEnv.get(gi.r) === undefined) { C = lEnv.get(gi.l); matchSide = gi.op === "SEQ"; }
        else { ok = false; break; }
        const target = matchSide ? Lb.term.t : Lb.term.f;
        const next = matchSide ? Lb.term.f : Lb.term.t;
        if (!info.blocks.has(target)) { ok = false; break; }
        if (C === exitConst) { ok = false; break; } // ambiguous with header exit
        links.push({ C, target, block: Lb.start });
        linkBlocks.add(Lb.start);
        const nb = info.blocks.get(next);
        if (!nb) { ok = false; break; }
        if (nb.term.kind === "goto" && nb.term.to === H) { fallback = next; break; } // ladder exhausted
        if (nb.term.kind !== "cond") { ok = false; break; }
        Lb = nb;
      }
      if (!ok || !links.length) { dbg("dissolve fn%s: hub=%s bail ok=%s links=%d state=r%s exit=%s", fn.entry, H, ok, links.length, stateReg, exitConst); break; }
      if (DEBUG) dbg("dissolve fn%s: hub=%s state=r%s exit=%s links=%d [%s]", fn.entry, H, stateReg, exitConst, links.length, links.map((l) => l.C).join(","));

      // propagate constant envs from the entry + every case head; ladder and
      // header blocks never propagate (injections replace their edges). When a
      // block is reached with two different states (a shared case body), clone
      // it per state so each copy rewires to its own successor.
      const blockEnv = new Map();
      const joinEnv = (a, b) => {
        const j = new Map();
        for (const [k, v] of a) if (b.has(k) && b.get(k) === v) j.set(k, v);
        return j;
      };
      const envEqual = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
      const queue = []; // [block, env, applyRedirect(newTarget)]
      const conflicts = [];
      const seenConflict = new Set();
      let qHead = 0;
      const drain = () => {
        for (; qHead < queue.length && qHead < 50000; qHead++) {
          const [bs, env] = queue[qHead];
          if (linkBlocks.has(bs) || bs === H) continue;
          const b = info.blocks.get(bs);
          const out = evalBlock(env, b.ips);
          const tm = b.term;
          for (const s of succsTerm(tm)) {
            if (!info.blocks.has(s)) continue;
            if (s === H || linkBlocks.has(s)) continue; // dispatch blocks: edges replaced by rewires
            const applyS = (n) => {
              const t2 = info.blocks.get(bs).term;
              if (t2.kind === "goto") { if (t2.to === s) t2.to = n; }
              else if (t2.kind === "cond") { if (t2.t === s) t2.t = n; if (t2.f === s) t2.f = n; }
              else if (t2.kind === "multi") for (const e of t2.edges) if (e.to === s) e.to = n;
            };
            const cur = blockEnv.get(s);
            if (!cur) {
              blockEnv.set(s, out);
              queue.push([s, out, applyS]);
            } else if (cur.get(stateReg) !== undefined && out.get(stateReg) !== undefined && cur.get(stateReg) !== out.get(stateReg)) {
              const ck = s + "|" + out.get(stateReg);
              if (!seenConflict.has(ck)) { seenConflict.add(ck); conflicts.push({ bs: s, env: out, apply: applyS }); }
            } else {
              const j = joinEnv(cur, out);
              if (!envEqual(j, cur)) {
                blockEnv.set(s, j);
                queue.push([s, j, applyS]);
              }
            }
          }
        }
      };
      const succsTerm = (tm) => (tm.kind === "cond" ? [tm.t, tm.f] : tm.kind === "goto" ? [tm.to] : tm.kind === "multi" ? tm.edges.map((e) => e.to) : []);
      {
        const eb = info.blocks.get(entry);
        const env = evalBlock(new Map(), eb.ips);
        if (env.get(stateReg) === undefined) break;
        blockEnv.set(entry, env);
        queue.push([entry, env, (n) => { info.blocks.get(entry).term = { kind: "goto", to: n }; }]);
      }
      let ok2 = true;
      const inject = (bs, v, blockBs, sideTarget) => {
        if (!info.blocks.has(bs)) { ok2 = false; return; }
        const env = new Map(blockEnv.get(bs) || new Map());
        env.set(stateReg, v);
        const cur = blockEnv.get(bs);
        if (cur && cur.get(stateReg) !== undefined && cur.get(stateReg) !== v) {
          // shared case head reached with different states: record for splitting
          const ck = bs + "|" + v;
          if (!seenConflict.has(ck)) {
            seenConflict.add(ck);
            conflicts.push({ bs, env, apply: (n) => { const t2 = info.blocks.get(blockBs).term; if (t2.t === sideTarget) t2.t = n; if (t2.f === sideTarget) t2.f = n; } });
          }
          return;
        }
        blockEnv.set(bs, cur ? joinEnv(cur, env) : env);
        queue.push([bs, blockEnv.get(bs), (n) => { const t2 = info.blocks.get(blockBs).term; if (t2.t === sideTarget) t2.t = n; if (t2.f === sideTarget) t2.f = n; }]);
      };
      for (const lk of links) inject(lk.target, lk.C, lk.block, lk.target);
      if (!ok2) break;
      inject(equalSide, exitConst, H, equalSide);
      if (!ok2) break;
      drain();
      for (let split = 0; split < 12 && conflicts.length; split++) {
        const cfs = conflicts.splice(0);
        let cloneKey = -1 - split * 1000;
        for (const cf of cfs) {
          const src = info.blocks.get(cf.bs);
          if (!src) continue;
          const key = cloneKey--;
          info.blocks.set(key, { start: key, ips: [...src.ips], term: { ...src.term } });
          cf.apply(key);
          blockEnv.set(key, cf.env);
          queue.push([key, cf.env, null]);
        }
        drain();
      }
      if (conflicts.length) break; // too many splits — give up on this hub

      // resolve rewiring targets: follow state-preserving pure trampolines
      // only. A pure goto block that CHANGES the state register is a "salt"
      // body — it may carry real (pure) side effects and is itself a back-edge
      // block that the scan rewires separately, so it becomes the successor.
      // Results: {kind:"block", bs} | {kind:"dead"} (original loops forever in
      // pure dispatch: no link / same-state re-dispatch) | {kind:"unknown"}
      // (cannot resolve statically — the ladder must stay).
      const resolveTarget = (C0) => {
        const seen = new Set();
        let C = C0;
        for (let g = 0; g < 64; g++) {
          if (C === undefined) return { kind: "unknown" };
          if (seen.has(C)) return { kind: "dead" };
          seen.add(C);
          let tb;
          if (C === exitConst) tb = equalSide;
          else {
            const lk = links.find((x) => x.C === C);
            if (!lk) return { kind: "dead" };
            tb = lk.target;
          }
          for (let h = 0; h < 64; h++) {
            const b = info.blocks.get(tb);
            if (!b || !b.ips.length) return { kind: "unknown" };
            if (b.term.kind !== "goto") return { kind: "block", bs: tb }; // cond/multi/ret: this IS the successor
            const pure = b.ips.every((ip) => { const gi = getInstr(ip); return gi && LIFT_DSE_SAFE.has(gi.op); });
            if (!pure) return { kind: "block", bs: tb };
            const C2 = evalBlock(new Map([[stateReg, C]]), b.ips).get(stateReg);
            if (C2 === undefined) return { kind: "unknown" };
            if (C2 !== C) return { kind: "block", bs: tb }; // salt body: successor; scan rewires its own back edge
            if (b.term.to === H) return { kind: "dead" }; // same-state re-dispatch: infinite
            if (!info.blocks.has(b.term.to)) return { kind: "unknown" };
            tb = b.term.to; // state-preserving pure trampoline
          }
          return { kind: "unknown" };
        }
        return { kind: "dead" };
      };

      // back edges with a constant exit state rewire to that state's case;
      // constant states matching nothing are dead terminals (the original
      // machine loops forever in the pure dispatch) — route everything that
      // could reach the ladder to its fallback block, which reproduces exactly
      // that infinite pure loop while making the dead paths CFG-dead.
      // Variable (non-constant) exit states need the real ladder: bail.
      const rewires = [];
      const deadEdges = [];
      for (const [bs, b] of info.blocks) {
        if (b.term.kind !== "goto" || b.term.to !== H) continue;
        const env = blockEnv.get(bs);
        if (!env) continue; // only reachable through the dispatch
        const C = evalBlock(env, b.ips).get(stateReg);
        if (C === undefined) { ok = false; break; } // variable state: ladder must stay
        const succ = resolveTarget(C);
        dbg("fn%s round%s backedge B%s C=%s -> %s", fn.entry, round, bs, C, succ.kind === "block" ? "B" + succ.bs : succ.kind);
        if (succ.kind === "unknown") { ok = false; break; }
        if (succ.kind === "dead") {
          if (fallback === null) { ok = false; break; }
          deadEdges.push(bs);
        } else rewires.push([bs, succ.bs]);
      }
      if (!ok) break;
      const entryEnv2 = evalBlock(new Map(), info.blocks.get(entry).ips);
      const entrySucc = resolveTarget(entryEnv2.get(stateReg));
      if (entrySucc.kind !== "block") break;
      if (!rewires.length) break;
      for (const [bs, succ] of rewires) info.blocks.get(bs).term = { kind: "goto", to: succ };
      info.blocks.get(entry).term = { kind: "goto", to: entrySucc.bs };
      if (deadEdges.length) {
        // no live state can match a ladder link any more (all live dispatches
        // were rewired): point the link match-edges and dead terminals at the
        // fallback, preserving the original infinite pure-dispatch loop
        for (const lk of links) {
          const t2 = info.blocks.get(lk.block).term;
          if (t2.kind !== "cond") continue;
          if (t2.t === lk.target) t2.t = fallback;
          if (t2.f === lk.target) t2.f = fallback;
        }
        for (const bs of deadEdges) info.blocks.get(bs).term = { kind: "goto", to: fallback };
        break; // dispatch skeleton stays for the dead states
      }
      // restart: more state machines may have been exposed
    }

    if (!info.blocks.has(entry)) return info;
    info.entryBlock = entry;

    // reachability
    const reach = new Set();
    const wl = [entry];
    while (wl.length) {
      const b = wl.pop();
      if (reach.has(b) || !info.blocks.has(b)) continue;
      reach.add(b);
      const term = info.blocks.get(b).term;
      const outs = term.kind === "cond" ? [term.t, term.f] : term.kind === "goto" ? [term.to] : term.kind === "multi" ? term.edges.map((e) => e.to) : [];
      for (const o of outs) if (info.blocks.has(o)) wl.push(o);
    }
    for (const k of [...info.blocks.keys()]) if (!reach.has(k)) info.blocks.delete(k);

    info.dispatch = dispatch;
    info.blockCondReg = blockCondReg;
    info.realIps = realIps;
    info.ok = true;
    return info;

    function condKey(inf, blockStart, reg) {
      const seen = new Set();
      const walk = (r, depth) => {
        if (depth > 8 || seen.has(r)) return "r" + r;
        seen.add(r);
        const b = inf.blocks.get(blockStart);
        if (!b) return "r" + r;
        for (let i = b.ips.length - 1; i >= 0; i--) {
          const gi = getInstr(b.ips[i]);
          if (writesOf(gi).includes(r)) {
            if (gi.op === "MOV") return walk(gi.src, depth + 1);
            if (LIFT_BINOPS.has(gi.op)) return "(" + walk(gi.l, depth + 1) + (LIFT_BINOP_SYM[gi.op] || "?") + walk(gi.r, depth + 1) + ")";
            if (LIFT_UNOP_SYM[gi.op]) return "(" + LIFT_UNOP_SYM[gi.op] + walk(gi.src, depth + 1) + ")";
            if (gi.op === "LDC") return "#" + JSON.stringify(decodeConst(gi.idx, gi.key));
            if (gi.op === "LDI") return "#" + gi.imm;
            return "r" + r + ":" + gi.op;
          }
        }
        return "r" + r;
      };
      return walk(reg, 0);
    }
  }

  // ---------------- function emission ----------------
  const builtFns = new Map();
  let cloneBudget = 128;

  function buildFunction(fnEntry, name, depth) {
    const fn = functions.get(fnEntry);
    const info = prepareFn(fn);
    if (!info.ok) return t.functionExpression(name ? t.identifier(name) : null, [], t.blockStatement([]));

    // captured-source registers use c-names (shared with child scopes): regs
    // of THIS function captured into new cells by MKFUNC instrs located here
    // (creating child closures) — the cell is a live box over the parent reg,
    // so parent and child must reference the same variable name.
    const capRegs = new Set();
    for (const ip of fn.ips) {
      const gi = getInstr(ip);
      if (gi && gi.op === "MKFUNC" && functions.has(gi.entry) && gi.entry !== fnEntry) {
        for (const c of gi.captures) if (c.newCell) capRegs.add(c.src);
      }
    }
    const regName = (r) => (capRegs.has(r) ? "c" + r : "v" + r);

    if (process.env.VM_BLOCKS) {
      const lines = ["== fn@" + fnEntry + " entry=" + info.entryBlock + " blocks=" + info.blocks.size];
      for (const [bs, b] of [...info.blocks].sort((a, b) => a[0] - b[0])) {
        const tm = b.term;
        const ts = tm.kind === "cond" ? `cond(r${tm.condReg}) -> ${tm.t}/${tm.f}` : tm.kind === "goto" ? `goto ${tm.to}` : tm.kind === "multi" ? "multi " + tm.edges.map((e) => e.to + (e.cond !== undefined ? "@" + e.cond : "")).join(",") : tm.kind;
        lines.push(`  B${bs} [${b.ips[0]}..${b.ips[b.ips.length - 1]}] ${ts}`);
      }
      console.error(lines.join("\n"));
    }

    const paramNames = [];
    for (let i = 0; i < fn.params; i++) paramNames.push(regName(i));
    const restName = fn.rest ? regName(fn.params) : null;

    // transitive dead-store elimination: pure defs whose results never feed
    // an essential read (calls, stores, terminators, impure ops) are dropped.
    // Kills the CFF salt arithmetic (self-feeding const chains).
    const deadIps = new Set();
    {
      const live = new Set();
      const kept = new Set();
      const termReads = (tm, add) => {
        if (tm.kind === "cond") add(tm.condReg);
        if (tm.kind === "ret" && tm.value !== undefined) add(tm.value);
        if (tm.kind === "throw") add(tm.src);
        if (tm.kind === "multi") for (const e of tm.edges) if (e.cond !== undefined) add(e.cond);
      };
      for (const b of info.blocks.values()) {
        for (const ip of b.ips) {
          const gi = getInstr(ip);
          if (!LIFT_DSE_SAFE.has(gi.op)) readsOf(gi).forEach((r) => live.add(r));
        }
        termReads(b.term, (r) => live.add(r));
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const b of info.blocks.values()) {
          for (const ip of b.ips) {
            if (kept.has(ip)) continue;
            const gi = getInstr(ip);
            if (!LIFT_DSE_SAFE.has(gi.op) || live.has(gi.dst)) {
              kept.add(ip);
              readsOf(gi).forEach((r) => {
                if (!live.has(r)) { live.add(r); changed = true; }
              });
            }
          }
        }
      }
      for (const b of info.blocks.values()) for (const ip of b.ips) { const gi = getInstr(ip); if (LIFT_DSE_SAFE.has(gi.op) && !live.has(gi.dst)) deadIps.add(ip); }
    }

    // read positions for dead-store elimination + use counts
    const blockOfIp = new Map();
    for (const [bs, b] of info.blocks) for (const ip of b.ips) blockOfIp.set(ip, bs);
    const useCount = new Map();
    const readPositions = new Map();
    const addRead = (r, pos) => {
      useCount.set(r, (useCount.get(r) || 0) + 1);
      if (!readPositions.has(r)) readPositions.set(r, []);
      readPositions.get(r).push(pos);
    };
    for (const [bs, b] of info.blocks) {
      for (const ip of b.ips) for (const r of readsOf(getInstr(ip))) addRead(r, ip);
      const term = b.term;
      const termEnd = b.ips[b.ips.length - 1] + 0.5;
      if (term.kind === "cond") addRead(term.condReg, termEnd);
      if (term.kind === "ret" && term.value !== undefined) addRead(term.value, termEnd);
      if (term.kind === "throw") addRead(term.src, termEnd);
      if (term.kind === "multi") for (const e of term.edges) if (e.cond !== undefined) addRead(e.cond, termEnd);
    }

    // block-local constant folding: registers whose every read is preceded by
    // a same-block, const-resolvable def never escape their block — their defs
    // are skipped and their uses folded to literals (kills the CFF state-delta
    // salt like `v153 = K; v50 = v50 + v153`).
    const blockLocalReg = new Set();
    const constAt = new Map(); // ip -> Map(reg -> const before that ip)
    {
      const evalBlock = makeConstEval(getInstr, decodeConst);
      const candidates = new Set();
      for (const [r, poss] of readPositions) {
        let ok = poss.length > 0;
        for (const p of poss) {
          if (blockOfIp.get(p) === undefined) { ok = false; break; } // terminator reads must stay visible
        }
        if (ok) candidates.add(r);
      }
      for (const b of info.blocks.values()) {
        let env = new Map();
        for (const ip of b.ips) {
          constAt.set(ip, env);
          const gi = getInstr(ip);
          for (const r of readsOf(gi)) {
            if (candidates.has(r) && env.get(r) === undefined) candidates.delete(r);
          }
          env = evalBlock(env, [ip]);
        }
        // regs read after their last def still qualified here keep values only
        // within this block; cross-block escapes were ruled out above
      }
      for (const r of candidates) {
        // every read must have a preceding same-block def (checked via constAt:
        // the env only holds consts from same-block defs or carried-ins; a
        // carried-in value would fold incorrectly) — verify explicitly
        let ok = true;
        for (const p of readPositions.get(r)) {
          const pb = blockOfIp.get(p);
          if (pb === undefined) { ok = false; break; }
          let hasLocalDef = false;
          for (const q of info.blocks.get(pb).ips) {
            if (q >= p) break;
            if (writesOf(getInstr(q)).includes(r)) { hasLocalDef = true; break; }
          }
          if (!hasLocalDef) { ok = false; break; }
        }
        if (ok) blockLocalReg.add(r);
      }
    }

    let out = [];
    const emit = (s) => out.push(s);
    const pending = new Map(); // reg -> folded AST (single same-block use)
    const flushPending = () => {
      for (const [reg, expr] of pending) emit(t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(reg)), expr)));
      pending.clear();
    };
    const exprOf = (reg) => {
      if (reg === undefined) return t.identifier("undefined");
      if (pending.has(reg)) {
        const e = pending.get(reg);
        pending.delete(reg);
        return e;
      }
      return t.identifier(regName(reg));
    };
    const valOf = (reg, ip) => {
      if (reg !== undefined && blockLocalReg.has(reg)) {
        const e = constAt.get(ip);
        const v = e && e.get(reg);
        if (v !== undefined) return literalAst(v);
      }
      return exprOf(reg);
    };

    const isValidIdentName = (s) => typeof s === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) && !RESERVED_WORDS.has(s);
    const memberAst = (objExpr, keyExpr) => {
      if (keyExpr.type === "StringLiteral" && isValidIdentName(keyExpr.value)) return t.memberExpression(objExpr, t.identifier(keyExpr.value), false);
      return t.memberExpression(objExpr, keyExpr, true);
    };

    function sameBlockUse(bs, reg, defIp) {
      const b = info.blocks.get(bs);
      if (!b) return false;
      for (const ip of b.ips) if (ip > defIp && readsOf(getInstr(ip)).includes(reg)) return true;
      const term = b.term;
      const termReads = term.kind === "cond" ? [term.condReg] : term.kind === "ret" ? [term.value] : term.kind === "throw" ? [term.src] : [];
      return termReads.includes(reg);
    }

    function assignAst(reg, expr, ip) {
      if (reg === undefined) { flushPending(); emit(t.expressionStatement(expr)); return; }
      if (blockLocalReg.has(reg) && LIFT_PURE.has(getInstr(ip).op)) return; // consumed via block-local folding
      const gi = getInstr(ip);
      const defBlock = blockOfIp.get(ip);
      const later = (readPositions.get(reg) || []).some((p) => {
        const pb = blockOfIp.get(p);
        if (pb === undefined) return true; // terminator pseudo-read
        return pb !== defBlock || p > ip;
      });
      if (!later && LIFT_PURE.has(gi.op)) return; // dead pure def
      if ((useCount.get(reg) || 0) === 1 && LIFT_PURE.has(gi.op) && sameBlockUse(defBlock, reg, ip)) {
        pending.set(reg, expr);
        return;
      }
      flushPending();
      emit(t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(reg)), expr)));
    }

    function defInstrInBlock(reg, bs) {
      const b = info.blocks.get(bs);
      if (!b) return null;
      for (let i = b.ips.length - 1; i >= 0; i--) {
        const gi = getInstr(b.ips[i]);
        if (writesOf(gi).includes(reg)) return gi;
      }
      return null;
    }

    function callAst(instr, curBlock, ip) {
      const args = instr.args.spread !== undefined
        ? [t.spreadElement(valOf(instr.args.spread, ip))]
        : instr.args.list.map((x) => valOf(x, ip));
      const fnExpr = valOf(instr.fn, ip);
      if (instr.op === "CALLI" || instr.thisArg === undefined) return t.callExpression(fnExpr, args);
      const th = valOf(instr.thisArg, ip);
      const fd = defInstrInBlock(instr.fn, curBlock);
      if (fd && fd.op === "GETPROP") {
        const objE = valOf(fd.obj, ip);
        if (generate(objE).code === generate(th).code) return t.callExpression(memberAst(objE, valOf(fd.key, ip)), args);
      }
      return t.callExpression(t.memberExpression(fnExpr, t.identifier("call"), false), [th, ...args]);
    }

    let currentBlock = null;

    function emitBlockStmts(bs) {
      const b = info.blocks.get(bs);
      currentBlock = bs;
      pending.clear();
      for (const ip of b.ips) {
        const gi = getInstr(ip);
        if (deadIps.has(ip)) continue;
        if (LIFT_BINOPS.has(gi.op)) {
          assignAst(gi.dst, t.binaryExpression(LIFT_BINOP_SYM[gi.op], valOf(gi.l, ip), valOf(gi.r, ip)), ip);
        } else if (LIFT_UNOP_SYM[gi.op]) {
          assignAst(gi.dst, t.unaryExpression(LIFT_UNOP_SYM[gi.op], valOf(gi.src, ip)), ip);
        } else
          switch (gi.op) {
            case "LDI": assignAst(gi.dst, t.numericLiteral(gi.imm), ip); break;
            case "LDC": assignAst(gi.dst, literalAst(decodeConst(gi.idx, gi.key)), ip); break;
            case "UNDEF": assignAst(gi.dst, gi.kind === "null" ? t.nullLiteral() : t.identifier("undefined"), ip); break;
            case "LDG": {
              const nm = decodeConst(gi.idx, gi.key);
              flushPending();
              emit(t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(gi.dst)), t.identifier(nm))));
              break;
            }
            case "TYPEOF_G": {
              const nm = decodeConst(gi.idx, gi.key);
              flushPending();
              emit(t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(gi.dst)), t.unaryExpression("typeof", t.identifier(nm)))));
              break;
            }
            case "THIS": assignAst(gi.dst, t.thisExpression(), ip); break;
            case "MOV": assignAst(gi.dst, valOf(gi.src, ip), ip); break;
            case "GETPROP": assignAst(gi.dst, memberAst(valOf(gi.obj, ip), valOf(gi.key, ip)), ip); break;
            case "SETPROP":
              flushPending();
              emit(t.expressionStatement(t.assignmentExpression("=", memberAst(valOf(gi.obj, ip), valOf(gi.key, ip)), valOf(gi.value, ip))));
              break;
            case "DELPROP":
              flushPending();
              emit(t.expressionStatement(t.unaryExpression("delete", memberAst(valOf(gi.obj, ip), valOf(gi.key, ip)))));
              break;
            case "CGET": assignAst(gi.dst, t.identifier(cellVarName(fnEntry, gi.cell)), ip); break;
            case "CSET":
              flushPending();
              emit(t.expressionStatement(t.assignmentExpression("=", t.identifier(cellVarName(fnEntry, gi.cell)), valOf(gi.src, ip))));
              break;
            case "ARRLIT": assignAst(gi.dst, t.arrayExpression(gi.parts.map((p) => valOf(p, ip))), ip); break;
            case "OBJLIT": {
              const props = gi.parts.map((p) => {
                const kAst = valOf(p.key, ip);
                const key = kAst.type === "StringLiteral" && isValidIdentName(kAst.value) ? t.identifier(kAst.value) : kAst;
                return t.objectProperty(key, valOf(p.value, ip), key.type !== "Identifier");
              });
              assignAst(gi.dst, t.objectExpression(props), ip);
              break;
            }
            case "MKFUNC": {
              flushPending();
              const subName = "fn" + gi.entry;
              let subNode = builtFns.get(gi.entry);
              if (!subNode) {
                subNode = depth >= 8 ? t.functionExpression(t.identifier(subName), [], t.blockStatement([])) : buildFunction(gi.entry, subName, depth + 1);
                builtFns.set(gi.entry, subNode);
              }
              emit(t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(gi.dst)), subNode)));
              break;
            }
            case "CALL": case "CALLI": case "CONSTRUCT": {
              flushPending();
              const ce = gi.op === "CONSTRUCT"
                ? t.newExpression(valOf(gi.fn, ip), gi.args.spread !== undefined ? [t.spreadElement(valOf(gi.args.spread, ip))] : gi.args.list.map((x) => valOf(x, ip)))
                : callAst(gi, currentBlock, ip);
              if (gi.dst === undefined) emit(t.expressionStatement(ce));
              else emit(t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(gi.dst)), ce)));
              break;
            }
            case "THROW":
              flushPending();
              emit(t.throwStatement(valOf(gi.src, ip)));
              break;
            case "RET":
              flushPending();
              emit(t.returnStatement(gi.value === undefined ? t.identifier("undefined") : exprOf(gi.value)));
              break;
            case "DEBUGGER": emit(t.debuggerStatement()); break;
            case "DECODE": case "FORIN_INIT": break; // applied during analysis / structural
            case "DEFGET": case "DEFSET": {
              flushPending();
              const desc = t.objectExpression([t.objectProperty(t.identifier(gi.op === "DEFGET" ? "get" : "set"), valOf(gi.fn, ip))]);
              emit(t.expressionStatement(t.callExpression(t.memberExpression(t.identifier("Object"), t.identifier("defineProperty")), [valOf(gi.obj, ip), valOf(gi.key, ip), desc])));
              break;
            }
            default: break; // terminators handled by the structurer
          }
      }
      flushPending();
    }

    // ---- CFG structuring ----
    const succsOf = (bs) => {
      const b = info.blocks.get(bs);
      if (!b) return [];
      const term = b.term;
      if (term.kind === "cond") return [term.t, term.f];
      if (term.kind === "goto") return [term.to];
      if (term.kind === "multi") return term.edges.map((e) => e.to);
      return [];
    };
    const predsOf = (bs) => [...info.blocks.keys()].filter((x) => succsOf(x).includes(bs));

    const EXIT = Symbol("exit");
    const dom = (() => {
      const d = new Map();
      for (const b of info.blocks.keys()) d.set(b, new Set(info.blocks.keys()));
      d.set(info.entryBlock, new Set([info.entryBlock]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const b of info.blocks.keys()) {
          if (b === info.entryBlock) continue;
          const ps = predsOf(b);
          let m;
          if (!ps.length) m = new Set();
          else {
            m = new Set(info.blocks.keys());
            for (const p of ps) for (const x of [...m]) if (!d.get(p).has(x)) m.delete(x);
          }
          m.add(b);
          const prev = d.get(b);
          let diff = m.size !== prev.size;
          if (!diff) for (const x of m) if (!prev.has(x)) { diff = true; break; }
          if (diff) { d.set(b, m); changed = true; }
        }
      }
      return d;
    })();
    const domSet = (x, a) => (dom.get(x) || new Set()).has(a);

    const pdom = (() => {
      const p = new Map();
      const isExit = (b) => ["ret", "throw"].includes(info.blocks.get(b).term.kind);
      for (const b of info.blocks.keys()) p.set(b, new Set([...info.blocks.keys(), EXIT]));
      p.set(EXIT, new Set([EXIT]));
      for (const b of info.blocks.keys()) if (isExit(b)) p.set(b, new Set([b, EXIT]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const b of info.blocks.keys()) {
          if (isExit(b)) continue;
          const ss = succsOf(b).filter((x) => info.blocks.has(x));
          let m;
          if (!ss.length) m = new Set([EXIT]);
          else {
            m = new Set([...info.blocks.keys(), EXIT]);
            for (const s of ss) for (const x of [...m]) if (!p.get(s).has(x)) m.delete(x);
          }
          m.add(b);
          const prev = p.get(b);
          let diff = m.size !== prev.size;
          if (!diff) for (const x of m) if (!prev.has(x)) { diff = true; break; }
          if (diff) { p.set(b, m); changed = true; }
        }
      }
      return p;
    })();
    const ipdom = (b) => {
      const pd = pdom.get(b);
      if (!pd) return EXIT;
      const cands = [...pd].filter((x) => x !== b && x !== EXIT);
      for (const x of cands) if (cands.every((y) => y === x || pdom.get(x).has(y))) return x;
      return EXIT;
    };

    const loops = new Map(); // header -> Set(body)
    for (const u of info.blocks.keys()) {
      for (const v of succsOf(u)) {
        if (info.blocks.has(v) && domSet(u, v)) { // v dominates u: u->v is a back edge
          if (!loops.has(v)) loops.set(v, new Set([v]));
          const L = loops.get(v);
          const stack = [u];
          while (stack.length) {
            const x = stack.pop();
            if (L.has(x) || !info.blocks.has(x)) continue;
            L.add(x);
            for (const pp of predsOf(x)) stack.push(pp);
          }
        }
      }
    }

    const ctxStack = [];
    let currentNodes = new Set();
    let labelCounter = 0;
    const innermostLoopIdx = () => {
      for (let i = ctxStack.length - 1; i >= 0; i--) if (ctxStack[i].type === "loop") return i;
      return -1;
    };
    const loopLabelFor = (i) => {
      if (i === innermostLoopIdx()) return null; // plain continue/break binds to innermost
      const c = ctxStack[i];
      c.labelUsed = true;
      return c.label;
    };

    function resolveCtx(T) {
      // loop headers at any depth: continue (labeled when not innermost loop)
      for (let i = ctxStack.length - 1; i >= 0; i--) {
        const c = ctxStack[i];
        if (c.type === "loop" && T === c.header) return { stmt: "continue", label: loopLabelFor(i) };
      }
      // enclosing if-joins: natural fall-through, or labeled break past inner loops
      for (let i = ctxStack.length - 1; i >= 0; i--) {
        const c = ctxStack[i];
        if (c.type === "ifjoin" && T === c.join) {
          for (let j = ctxStack.length - 1; j > i; j--)
            if (ctxStack[j].type === "loop") {
              c.labelUsed = true;
              return { stmt: "break", label: c.label };
            }
          return { stmt: null };
        }
      }
      // innermost enclosing loop that T exits: break — but only when the loop
      // has a single after-loop continuation (otherwise breaks would fall into
      // nothing; callers then tail-clone the exit path instead)
      for (let i = ctxStack.length - 1; i >= 0; i--) {
        const c = ctxStack[i];
        if (c.type === "loop" && c.exits.has(T) && c.breakOk) return { stmt: "break", label: loopLabelFor(i) };
      }
      return { unknown: true };
    }
    function jumpStmt(r) {
      const lbl = r.label ? t.identifier(r.label) : null;
      return r.stmt === "continue" ? t.continueStatement(lbl) : t.breakStatement(lbl);
    }

    const cloneActive = new Set();
    function cloneSeq(bs, depth) {
      if (depth > 24 || cloneBudget <= 0) throw new Error("clone budget exhausted");
      if (cloneActive.has(bs)) throw new Error("clone cycle at " + bs);
      cloneBudget--;
      cloneActive.add(bs);
      try {
        emitBlockStmts(bs);
        info.scheduled.add(bs); // fully emitted via cloning (a later throw resets)
        const term = info.blocks.get(bs).term;
        if (term.kind === "ret") { emit(t.returnStatement(term.value === undefined ? t.identifier("undefined") : exprOf(term.value))); return; }
        if (term.kind === "throw") { emit(t.throwStatement(exprOf(term.src))); return; }
        if (term.kind === "goto") {
          const T = term.to;
          if (info.blocks.has(T) && !info.scheduled.has(T) && currentNodes.has(T)) { cloneSeq(T, depth + 1); return; }
          const r = resolveCtx(T);
          if (r.stmt === "continue" || r.stmt === "break") { emit(jumpStmt(r)); return; }
          if (r.stmt === null) return;
          if (info.blocks.has(T)) { cloneSeq(T, depth + 1); return; }
          throw new Error("bad clone target");
        }
        if (term.kind === "cond") {
          const ce = exprOf(term.condReg);
          emit(t.ifStatement(ce, cloneArm(term.t, depth), cloneArm(term.f, depth)));
          return;
        }
        throw new Error("bad clone term");
      } finally {
        cloneActive.delete(bs);
      }
    }
    function cloneArm(T, depth) {
      const saved = out;
      out = [];
      try {
        cloneSeq(T, depth + 1);
      } catch (e) {
        out = saved;
        throw e;
      }
      const mine = out;
      out = saved;
      return t.blockStatement(mine);
    }

    function regionNodes(A, join, nodes) {
      const res = new Set();
      const stack = [A];
      while (stack.length) {
        const x = stack.pop();
        if (x === join || res.has(x) || !nodes.has(x) || !info.blocks.has(x)) continue;
        if (A !== x && !domSet(x, A)) continue;
        res.add(x);
        for (const s of succsOf(x)) stack.push(s);
      }
      return res;
    }

    function emitSub(nodes, entryB) {
      const saved = out;
      out = [];
      structure(nodes, entryB);
      const res = out;
      out = saved;
      return res;
    }
    // single-if arms print as `else if` chains instead of nested blocks
    const armAst = (stmts) => (stmts.length === 1 && stmts[0].type === "IfStatement" ? stmts[0] : t.blockStatement(stmts));

    function structure(nodes, entryB) {
      const prevNodes = currentNodes;
      currentNodes = nodes;
      let cur = entryB;
      while (cur !== null && cur !== undefined && nodes.has(cur) && info.blocks.has(cur)) {
        if (loops.has(cur) && !ctxStack.some((c) => c.type === "loop" && c.header === cur)) {
          const L = loops.get(cur);
          let allIn = true;
          for (const x of L) if (!nodes.has(x)) { allIn = false; break; }
          if (allIn) {
            const exits = new Set();
            for (const x of L) for (const s of succsOf(x)) if (!L.has(s)) exits.add(s);
            const saved = out;
            out = [];
            const frame = { type: "loop", header: cur, exits, label: "L" + ++labelCounter, labelUsed: false, breakOk: false };
            ctxStack.push(frame);
            try {
              const exitTargets = [...exits].filter((x) => nodes.has(x) && info.blocks.has(x) && !info.scheduled.has(x));
              frame.breakOk = exitTargets.length === 1;
              structure(L, cur);
            } finally {
              ctxStack.pop();
            }
            const bodyStmts = out;
            out = saved;
            const w = t.whileStatement(t.booleanLiteral(true), t.blockStatement(bodyStmts));
            emit(frame.labelUsed ? t.labeledStatement(t.identifier(frame.label), w) : w);
            const exitTargets = [...exits].filter((x) => nodes.has(x) && info.blocks.has(x) && !info.scheduled.has(x));
            cur = exitTargets.length === 1 ? exitTargets[0] : null;
            continue;
          }
        }
        if (info.scheduled.has(cur)) {
          cloneSeq(cur, 0);
          cur = null;
          continue;
        }
        info.scheduled.add(cur);
        emitBlockStmts(cur);
        const term = info.blocks.get(cur).term;
        if (term.kind === "ret" || term.kind === "throw") { cur = null; continue; }
        if (term.kind === "goto") {
          const T = term.to;
          const r = resolveCtx(T);
          if (r.stmt === "continue" || r.stmt === "break") emit(jumpStmt(r));
          else if (r.stmt === null) { /* falls to enclosing join */ }
          else if (nodes.has(T) && !info.scheduled.has(T)) { cur = T; continue; }
          else if (info.blocks.has(T)) cloneSeq(T, 0);
          cur = null;
          continue;
        }
        if (term.kind === "cond") {
          const { condReg, t: T, f: F } = term;
          const condExpr = exprOf(condReg); // consume any pending fold before arms run
          if (T === F) {
            emit(t.ifStatement(condExpr, t.emptyStatement(), null));
            const r = resolveCtx(T);
            if (r.stmt === "continue" || r.stmt === "break") emit(jumpStmt(r));
            else if (r.stmt === null) { /* falls to join */ }
            else if (nodes.has(T) && !info.scheduled.has(T)) { cur = T; continue; }
            else if (info.blocks.has(T)) cloneSeq(T, 0);
            cur = null;
            continue;
          }
          const join = ipdom(cur);
          const inT = nodes.has(T), inF = nodes.has(F);
          const rT = inT ? null : resolveCtx(T);
          const rF = inF ? null : resolveCtx(F);
          if (inT && inF) {
            const hasJoin = join !== EXIT && nodes.has(join) && join !== T && join !== F && !info.scheduled.has(join);
            const nT = regionNodes(T, hasJoin ? join : EXIT, nodes);
            const nF = regionNodes(F, hasJoin ? join : EXIT, nodes);
            const jf = { type: "ifjoin", join: hasJoin ? join : EXIT, label: "J" + ++labelCounter, labelUsed: false };
            ctxStack.push(jf);
            let sT, sF;
            try {
              sT = emitSub(nT, T);
              sF = emitSub(nF, F);
            } finally {
              ctxStack.pop();
            }
            const ifS = t.ifStatement(condExpr, armAst(sT), armAst(sF));
            emit(jf.labelUsed ? t.labeledStatement(t.identifier(jf.label), t.blockStatement([ifS])) : ifS);
            cur = hasJoin ? join : null;
          } else if (inT && !inF) {
            const sT = emitSub(regionNodes(T, EXIT, nodes), T);
            emitArmWith(F, rF, false, condExpr, sT);
            cur = null;
          } else if (!inT && inF) {
            const sF = emitSub(regionNodes(F, EXIT, nodes), F);
            emitArmWith(T, rT, true, condExpr, sF);
            cur = null;
          } else {
            emitBothOut(rT, rF, condExpr, T, F);
            cur = null;
          }
          continue;
        }
        if (term.kind === "multi") throw new Error("multi terminator unsupported");
        throw new Error("dead terminator at " + cur);
      }
      currentNodes = prevNodes;
    }

    function emitArmWith(outTarget, rOut, outIsTrueSide, condExpr, armStmts) {
      // one arm stays in-region; the other side leaves via jump / fall / clone
      const outCond = outIsTrueSide ? condExpr : t.unaryExpression("!", condExpr);
      if (!rOut || rOut.stmt === null) {
        // leaving side falls through to a join: guard the arm with the inverse condition
        const inCond = outIsTrueSide ? t.unaryExpression("!", condExpr) : condExpr;
        emit(t.ifStatement(inCond, armAst(armStmts), null));
      } else if (rOut.stmt) {
        emit(t.ifStatement(outCond, t.blockStatement([jumpStmt(rOut)])));
        for (const s of armStmts) emit(s);
      } else {
        // leaving side target is outside every context: tail-clone it
        emit(t.ifStatement(outCond, cloneArm(outTarget, 0), t.blockStatement(armStmts)));
      }
    }
    function emitBothOut(rT, rF, condExpr, T, F) {
      const armOf = (r, target) =>
        r && r.stmt ? t.blockStatement([jumpStmt(r)]) : r && r.stmt === null ? t.blockStatement([]) : cloneArm(target, 0);
      emit(t.ifStatement(condExpr, armOf(rT, T), armOf(rF, F)));
    }

    try {
      structure(new Set(info.blocks.keys()), info.entryBlock);
      {
        const un = [...info.blocks.keys()].filter((bs) => !info.scheduled.has(bs));
        if (un.length) throw new Error("unscheduled block " + un.slice(0, 8).join(",") + (un.length > 8 ? "..." : ""));
      }
    } catch (e) {
      dbg("structure(%s) failed: %s — falling back to switch machine", fnEntry, e.message);
      dbg(e.stack && e.stack.split("\n").slice(1, 8).join("\n"));
      // fallback: switch state machine (always faithful to the block CFG)
      out = [];
      info.scheduled.clear();
      const blocks = [...info.blocks.keys()].sort((a, b) => a - b);
      const idOf = new Map(blocks.map((b, i) => [b, i]));
      const cases = [];
      for (const bs of blocks) {
        const stmts = [];
        const saved = out;
        out = stmts;
        emitBlockStmts(bs);
        out = saved;
        const term = info.blocks.get(bs).term;
        const setSt = (target) => t.expressionStatement(t.assignmentExpression("=", t.identifier("st"), t.numericLiteral(idOf.get(target))));
        if (term.kind === "goto" && idOf.has(term.to)) { stmts.push(setSt(term.to)); stmts.push(t.continueStatement()); }
        else if (term.kind === "cond" && idOf.has(term.t) && idOf.has(term.f)) {
          stmts.push(t.expressionStatement(t.assignmentExpression("=", t.identifier("st"), t.conditionalExpression(exprOf(term.condReg), t.numericLiteral(idOf.get(term.t)), t.numericLiteral(idOf.get(term.f))))));
          stmts.push(t.continueStatement());
        } else if (term.kind === "multi") {
          for (const e of term.edges) {
            if (e.cond === undefined) { stmts.push(setSt(e.to)); stmts.push(t.continueStatement()); }
            else stmts.push(t.ifStatement(exprOf(e.cond), t.blockStatement([setSt(e.to), t.continueStatement()])));
          }
        } else if (term.kind === "dead") throw e; // cannot recover
        cases.push(t.switchCase(t.numericLiteral(idOf.get(bs)), stmts));
      }
      out.push(t.variableDeclaration("let", [t.variableDeclarator(t.identifier("st"), t.numericLiteral(idOf.get(info.entryBlock)))]));
      out.push(t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.switchStatement(t.identifier("st"), cases)])));
    }

    // hoisted declarations
    const written = new Set();
    for (const b of info.blocks.values()) for (const ip of b.ips) for (const r of writesOf(getInstr(ip))) written.add(r);
    const decls = [...new Set([...written].filter((r) => r >= fn.params && !paramNames.includes(regName(r))).map(regName))].sort();
    const stmts = [];
    if (decls.length) stmts.push(t.variableDeclaration("let", decls.map((nm) => t.variableDeclarator(t.identifier(nm)))));
    if (fn.params < fn.regs && readPositions.has(fn.params)) {
      stmts.push(t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(fn.params)), t.identifier("arguments"))));
    }
    stmts.push(...out);
    const paramAsts = paramNames.map((nm) => t.identifier(nm));
    if (restName) paramAsts.push(t.restElement(t.identifier(restName)));
    return t.functionExpression(name ? t.identifier(name) : null, paramAsts, t.blockStatement(stmts));
  }

  // ---- program assembly: lift the top-level (parentless) function ----
  let top;
  {
    let e0 = (analysis.entryMeta ? analysis.entryMeta.v || 0 : 0);
    if (!functions.has(e0)) e0 = [...functions.keys()][0];
    top = functions.get(e0);
    while (fnParents.has(top.entry)) top = functions.get(fnParents.get(top.entry).parent);
  }
  const progFn = buildFunction(top.entry, null, 0);
  // top-level returns are illegal in scripts: unwrap to expression statements
  const body = [];
  for (const s of progFn.body.body) {
    if (s.type !== "ReturnStatement") { body.push(s); continue; }
    const a = s.argument;
    if (!a || (a.type === "Identifier" && a.name === "undefined")) continue;
    body.push(t.expressionStatement(a));
  }
  return t.program(body);
}

const RESERVED_WORDS = new Set(["var", "let", "const", "if", "else", "while", "for", "do", "return", "function", "class", "new", "delete", "typeof", "instanceof", "in", "of", "switch", "case", "default", "break", "continue", "true", "false", "null", "undefined", "this", "void", "yield", "await", "async", "static", "import", "export", "try", "catch", "finally", "throw", "with", "debugger", "extends", "super", "arguments", "eval"]);

/* ================================================================== */

/** formatting helper for debug dumps */
function formatInstr(instr, decodeConst) {
  const R = (x) => (x === undefined ? "?" : typeof x === "object" ? JSON.stringify(x) : "R" + x);
  const C = (idx, key) => {
    try {
      const v = decodeConst(idx, key);
      return typeof v === "string" ? JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v) : String(v);
    } catch (e) { return "?"; }
  };
  switch (instr.op) {
    case "ADD": case "SUB": case "MUL": case "DIV": case "MOD":
    case "BAND": case "BOR": case "BXOR": case "SHL": case "SHR": case "USHR":
    case "LT": case "LE": case "GT": case "GE": case "EQ": case "NE":
    case "SEQ": case "SNE": case "INOP": case "INSTANCEOF": case "POW":
      return `R${instr.dst} = R${instr.l} ${instr.op} R${instr.r}`;
    case "NEG": case "NOT": case "BNOT": case "TONUM": case "TYPEOF":
      return `R${instr.dst} = ${instr.op} R${instr.src}`;
    case "MOV": return `R${instr.dst} = R${instr.src}`;
    case "LDI": return `R${instr.dst} = ${instr.imm}`;
    case "UNDEF": return `R${instr.dst} = ${instr.kind === "null" ? "null" : "undefined"}`;
    case "LDC": return `R${instr.dst} = CONST[${instr.idx}]${instr.key ? "^" + instr.key : ""}  // ${C(instr.idx, instr.key)}`;
    case "LDG": return `R${instr.dst} = GLOBAL[${C(instr.idx, instr.key)}]`;
    case "TYPEOF_G": return `R${instr.dst} = typeof GLOBAL[${C(instr.idx, instr.key)}]`;
    case "STG": return `GLOBAL[${C(instr.name.idx, instr.name.key)}] = R${instr.value}`;
    case "GETPROP": return `R${instr.dst} = R${instr.obj}[R${instr.key}]`;
    case "SETPROP": return `R${instr.obj}[R${instr.key}] = R${instr.value}`;
    case "DELPROP": return `R${instr.dst} = delete R${instr.obj}[R${instr.key}]`;
    case "THIS": return `R${instr.dst} = this`;
    case "CGET": return `R${instr.dst} = cell${instr.cell}`;
    case "CSET": return `cell${instr.cell} = R${instr.src}`;
    case "MKFUNC": {
      const caps = instr.captures.map((c) => `${c.newCell ? "new" : "rebind"}:R${c.src}`).join(", ");
      return `R${instr.dst} = FUNC(entry=${instr.entry}, params=${instr.params}, regs=${instr.regs}, rest=${instr.rest}) [${caps}]`;
    }
    case "CALL": {
      const a = instr.args.spread !== undefined ? `...R${instr.args.spread}` : instr.args.list.map((r) => "R" + r).join(", ");
      return `R${instr.dst} = R${instr.fn}.call(R${instr.thisArg}, ${a})`;
    }
    case "CALLI": {
      const a = instr.args.spread !== undefined ? `...R${instr.args.spread}` : instr.args.list.map((r) => "R" + r).join(", ");
      return `R${instr.dst} = R${instr.fn}(${a})  // indirect`;
    }
    case "CONSTRUCT": {
      const a = instr.args.spread !== undefined ? `...R${instr.args.spread}` : instr.args.list.map((r) => "R" + r).join(", ");
      return `R${instr.dst} = new R${instr.fn}(${a})`;
    }
    case "ARRLIT": return `R${instr.dst} = [${instr.parts.map((r) => "R" + r).join(", ")}]`;
    case "OBJLIT": return `R${instr.dst} = {${instr.parts.map((p) => `R${p.key}: R${p.value}`).join(", ")}}`;
    case "DEFGET": return `DEFGET R${instr.obj}[R${instr.key}] = R${instr.fn}`;
    case "DEFSET": return `DEFSET R${instr.obj}[R${instr.key}] = R${instr.fn}`;
    case "FORIN_INIT": return `R${instr.dst} = forin(R${instr.src})`;
    case "FORIN_NEXT": return `R${instr.dst} = forin_next(R${instr.iter}) || JMP ${instr.exit}`;
    case "JMP": return `JMP ${instr.target}`;
    case "JMPR": return `JMPR R${instr.src}`;
    case "JMPT": return `IF R${instr.cond} JMP ${instr.target}`;
    case "JMPF": return `IF !R${instr.cond} JMP ${instr.target}`;
    case "THROW": return `THROW R${instr.src}`;
    case "RET": return `RET R${instr.value}`;
    case "PUSHCATCH": return `TRY { } CATCH -> IP ${instr.catchIP} (ex -> R${instr.exReg})`;
    case "PUSHFIN": return `TRY { } FINALLY -> IP ${instr.finIP} (G->R${instr.retVal}, L->R${instr.exReg})`;
    case "POPH": return "POPHANDLER";
    case "DEBUGGER": return "debugger";
    case "DECODE": return `DECODE(dst=${instr.dstOff}, [${instr.start},${instr.end}), key=${instr.key})`;
    default: return JSON.stringify(instr);
  }
}

/* ================================================================== */
/* SECTION 6 — Public API + CLI                                        */
/* ================================================================== */

/**
 * Deobfuscate a JS-Confuser-VM 0.1.5 source string.
 * Returns the original source unchanged when no VM is detected.
 */
function deobfuscateSource(source) {
  let ast;
  try {
    ast = parser.parse(source, { allowReturnOutsideFunction: true });
  } catch (e) {
    return source;
  }
  const vm = extractVM(ast);
  if (!vm) return source; // passthrough: not a VM sample
  const { table, failures } = classifyHandlers(vm);
  if (!table.size) return source;
  const analysis = analyze(vm, table);
  if (analysis.unresolvedJumps && analysis.unresolvedJumps.length) {
    dbg("warning: %d unresolved dispatches; output may be partial", analysis.unresolvedJumps.length);
  }
  let program;
  try {
    program = liftProgram(analysis);
  } catch (e) {
    dbg("lift failed: %s", e.stack || e);
    return source;
  }
  const out = generate(program, { retainLines: false, concise: false, comments: false });
  const header = "// Reconstructed from JS-Confuser-VM 0.1.5 bytecode by vm.js\n";
  return header + out.code + "\n";
}

/** API: require('./vm.js')(inputPath [, outputPath]) -> code string */
function runFile(inputPath, outputPath) {
  const source = fs.readFileSync(path.resolve(inputPath), "utf8");
  const result = deobfuscateSource(source);
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), result, "utf8");
  return result;
}

if (require.main === module) {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath) {
    console.error("usage: node vm.js input.js [output.js]");
    process.exit(1);
  }
  const result = runFile(inputPath, outputPath);
  if (!outputPath) process.stdout.write(result);
  else console.error("wrote " + outputPath + " (" + result.length + " bytes)");
}

module.exports = runFile;
module.exports.deobfuscateSource = deobfuscateSource;
module.exports.runFile = runFile;
module.exports.extractVM = extractVM;
module.exports.interpretHandler = interpretHandler;
module.exports.literalValue = literalValue;
module.exports.serRecord = serRecord;
module.exports.serTerm = serTerm;
module.exports.serEff = serEff;
module.exports.classifyHandlers = classifyHandlers;
module.exports.analyze = analyze;
module.exports.liftProgram = liftProgram;
module.exports.formatInstr = formatInstr;
module.exports.makeConstDecoder = makeConstDecoder;
module.exports.matchArchetype = matchArchetype;
module.exports.DEBUG = DEBUG;
