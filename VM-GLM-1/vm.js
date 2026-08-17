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

  function envKey(env) {
    const ks = Object.keys(env).sort((a, b) => a - b);
    return ks.map((k) => k + ":" + valKey(env[k])).join(";");
  }
  function valKey(v) {
    if (v && v.__vmfn) return "fn" + v.__vmfn;
    if (typeof v === "object" && v !== null) return "{" + Object.keys(v).join(",") + "}";
    return typeof v + ":" + String(v);
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

  function exploreFunction(fnEntry) {
    const fn = functions.get(fnEntry);
    const visited = new Set();
    // env: { v: {reg-> value}, b: {reg-> invert(0|1)} }
    // value: concrete JS value | {__sel:{condReg, invert, tv, fv}} | absent = symbolic
    const newEnv = () => ({ v: {}, b: {} });
    const isSel = (x) => x && typeof x === "object" && x.__sel;
    const work = [{ ip: fnEntry, env: newEnv(), origin: null, trail: [] }];
    while (work.length) {
      if (++steps > maxSteps) { unresolvedJumps.push("step limit in fn@" + fnEntry); return; }
      const item = work.pop();
      const { ip: curIp, env, origin } = item;
      const trail = item.trail;
      const key = curIp + "|" + envKey(env);
      if (visited.has(key)) continue;
      visited.add(key);
      let ip = curIp;
      let myEnv = env;
      let myOrigin = origin;
      // straight-line run until a control instruction
      while (true) {
        if (++steps > maxSteps) { unresolvedJumps.push("step limit (inner) in fn@" + fnEntry); return; }
        if (ip < 0 || ip >= n.length) break;
        const instr = getInstr(ip);
        if (!instr) { unknownRegions.push(ip); break; }
        fn.ips.add(ip);
        const next = ip + instr.len;
        const C = (x) => (x === undefined ? undefined : Object.prototype.hasOwnProperty.call(myEnv.v, x) ? myEnv.v[x] : undefined);
        const setR = (val, boolishInvert) => {
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
          case "LDI": setR(instr.dst, instr.imm); ip = next; continue;
          case "LDC": setR(instr.dst, decodeConst(instr.idx, instr.key)); ip = next; continue;
          case "UNDEF": setR(instr.dst, instr.kind === "null" ? null : undefined); ip = next; continue;
          case "LDG": {
            const name = decodeConst(instr.idx, instr.key);
            setR(instr.dst, Object.prototype.hasOwnProperty.call(GLOBAL_WHITELIST, name) ? GLOBAL_WHITELIST[name] : undefined);
            ip = next; continue;
          }
          case "TYPEOF_G": {
            const name = decodeConst(instr.idx, instr.key);
            setR(instr.dst, Object.prototype.hasOwnProperty.call(GLOBAL_WHITELIST, name) ? typeof GLOBAL_WHITELIST[name] : undefined);
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
            if (v === undefined && (instr.op === "NOT" || instr.op === "TONUM")) {
              setR(undefined, ((B(instr.src) ?? 0) ^ (instr.op === "NOT" ? 1 : 0)));
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
                setR({ __sel: { condReg: sel.condReg, invert: sel.invert, tv, fv } });
                ip = next; continue;
              }
            }
            // branchless CFF select creation: const * boolish
            if (instr.op === "MUL") {
              const bl = B(instr.l), br = B(instr.r);
              if (typeof a === "number" && b === undefined && br !== undefined) {
                setR({ __sel: { condReg: instr.r, invert: br, tv: a, fv: 0 } });
                ip = next; continue;
              }
              if (typeof b === "number" && a === undefined && bl !== undefined) {
                setR({ __sel: { condReg: instr.l, invert: bl, tv: b, fv: 0 } });
                ip = next; continue;
              }
            }
            setR(undefined);
            ip = next; continue;
          }
          case "INOP": case "INSTANCEOF": setR(undefined, 0); ip = next; continue;
          case "GETPROP": case "DELPROP": {
            const obj = C(instr.obj), key = C(instr.key);
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
            setR(instr.dst, v);
            ip = next; continue;
          }
          case "ARRLIT": {
            const parts = instr.parts.map((p) => C(p));
            setR(instr.dst, parts.every((p) => p !== undefined) ? parts : undefined);
            ip = next; continue;
          }
          case "OBJLIT": setR(instr.dst, undefined); ip = next; continue;
          case "CGET": case "CSET": setR(instr.dst, undefined); ip = next; continue;
          case "SETPROP": case "STG": case "FORIN_INIT": ip = next; continue;
          case "MKFUNC": {
            setR(instr.dst, { __vmfn: instr.entry, params: instr.params, regs: instr.regs, captures: instr.captures });
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
            if (fnV !== undefined && Array.isArray(argv) && argv.every((x) => x !== undefined)) {
              if (fnV.__vmfn && (!fnV.captures || fnV.captures.length === 0)) {
                const sub = concreteEval2(fnV.__vmfn, argv, 8);
                if (!sub.fail) v = sub.value;
              } else if (typeof fnV === "function") {
                try { v = fnV.apply(null, argv); } catch (e) { v = undefined; }
              }
            }
            setR(instr.dst, v);
            ip = next; continue;
          }
          case "DEFGET": case "DEFSET": case "POPH": case "PUSHCATCH": case "PUSHFIN":
          case "FORIN_NEXT": {
            // FORIN_NEXT handled at edge level below
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
      const mkEdge = (to, kind, cond, sense) => {
        if (to === undefined || to === null || to < 0 || to >= n.length) return;
        if (!fn.edges.has(ip)) fn.edges.set(ip, []);
        fn.edges.get(ip).push({ to, kind, cond, sense, origin: myOrigin });
      };
      const fork = (to, kind, cond, sense) => {
        work.push({ ip: to, env: { ...myEnv }, origin: kind && kind !== "fall" ? ip : myOrigin, trail: [...trail] });
      };
      const condV = (i) => (Object.prototype.hasOwnProperty.call(myEnv, i) ? myEnv[i] : undefined);

      switch (instr.op) {
        case "JMP": {
          mkEdge(instr.target, "jump");
          fork(instr.target, "jump");
          break;
        }
        case "JMPR": {
          const t = condV(instr.src);
          if (typeof t === "number" && Number.isInteger(t) && t >= 0 && t < n.length) {
            mkEdge(t, "dispatch");
            fork(t, "dispatch");
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
            work.push({ ip: instr.target, env: { ...myEnv, [instr.cond]: tv }, origin: ip });
            work.push({ ip: next, env: { ...myEnv, [instr.cond]: !tv }, origin: ip });
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
            work.push({ ip: catchIp, env: {}, origin: ip });
          }
          break;
        }
        case "PUSHFIN": {
          mkEdge(next, "fall");
          fork(next, "fall");
          const finIp = instr.finIP;
          if (finIp !== undefined) {
            mkEdge(finIp, "finally");
            work.push({ ip: finIp, env: {}, origin: ip });
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
  }

  while (fnWork.length) {
    const e = fnWork.shift();
    exploreFunction(e);
  }

  for (const fn of functions.values()) delete fn._queued;
  return { instrs, functions, unknownRegions, unresolvedJumps, decodeConst, n };
}

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



module.exports = {
  extractVM, interpretHandler, literalValue, serRecord, serTerm, serEff,
  classifyHandlers, analyze, formatInstr, makeConstDecoder, matchArchetype, DEBUG,
};
