#!/usr/bin/env node
/**
 * vm.js â€” AST deobfuscator for JS-Confuser-VM protected files.
 *
 * Usage:   node vm.js input.js output.js
 * Module:  require('./vm.js')('input.js')  ->  deobfuscated source string
 *
 * The technique it undoes: the original program is compiled to bytecode for a
 * register machine and shipped together with the interpreter.  Opcodes are
 * randomised, most handlers are *specialised* (operands baked into the handler
 * body instead of read from the bytecode) and the arithmetic handlers are hidden
 * behind mixed boolean-arithmetic.  Constants live in a pool and are decrypted
 * with a per-use key.
 *
 * Nothing about the opcode numbering is hard-coded: the handler table is
 * recovered from the AST and every handler is *probed* with a tiny purpose-built
 * AST interpreter to learn what it does.  See NOTES.md.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const _traverse = require("@babel/traverse");
const traverse = _traverse.default || _traverse;
const _generate = require("@babel/generator");
const generate = _generate.default || _generate;
const t = require("@babel/types");

/* ------------------------------------------------------------------ *
 * 0.  small helpers
 * ------------------------------------------------------------------ */

const isNum = (n) => n && n.type === "NumericLiteral";
const num = (n) =>
  isNum(n)
    ? n.value
    : n && n.type === "UnaryExpression" && n.operator === "-" && isNum(n.argument)
      ? -n.argument.value
      : undefined;

function fail(msg) {
  const e = new Error(msg);
  e.deobfuscator = true;
  throw e;
}

/* ------------------------------------------------------------------ *
 * 1.  Locate the VM inside the AST
 * ------------------------------------------------------------------ */

/**
 * Returns null when the file does not look like a JS-Confuser VM bundle, so the
 * caller can pass the program through untouched.
 */
function locateVM(ast) {
  const vm = {
    handlers: new Map(), // opcode -> FunctionExpression
    tableName: null, // `C`
    fetchName: null, // `x`
    fetchFn: null,
    constFn: null, // `z`
    constFnName: null,
    constKeyParams: null, // param indices of (constIndex, key) inside `z`
    upvalFnName: null, // `w`
    frameFnName: null, // `y`
    weakMapName: null, // `t`
    field: {}, // stack / fp / bytecode / consts
    pcSlot: null,
    bytecode: null,
    pool: null,
    entrySpec: null,
    specProps: null,
    globalsName: null,
  };

  // --- 1a. handler table: X[<number>] = function(){...}
  const tableCounts = new Map();
  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right } = p.node;
      if (
        left.type === "MemberExpression" &&
        left.computed &&
        left.object.type === "Identifier" &&
        isNum(left.property) &&
        right.type === "FunctionExpression"
      ) {
        const n = left.object.name;
        tableCounts.set(n, (tableCounts.get(n) || 0) + 1);
      }
    },
  });
  let best = null;
  for (const [n, c] of tableCounts) if (!best || c > best[1]) best = [n, c];
  if (!best || best[1] < 10) return null;
  vm.tableName = best[0];

  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right } = p.node;
      if (
        left.type === "MemberExpression" &&
        left.computed &&
        left.object.type === "Identifier" &&
        left.object.name === vm.tableName &&
        isNum(left.property) &&
        right.type === "FunctionExpression"
      ) {
        vm.handlers.set(left.property.value, right);
      }
    },
  });

  // --- 1b. the operand fetcher:  function x(a){ return a.J[a.C[a.G + N]++] }
  traverse(ast, {
    FunctionDeclaration(p) {
      if (vm.fetchName) return;
      const fn = p.node;
      if (fn.params.length !== 1 || fn.params[0].type !== "Identifier") return;
      const body = fn.body.body;
      if (body.length !== 1 || body[0].type !== "ReturnStatement") return;
      const r = body[0].argument;
      if (!r || r.type !== "MemberExpression" || !r.computed) return;
      if (r.object.type !== "MemberExpression" || r.object.computed) return;
      const upd = r.property;
      if (upd.type !== "UpdateExpression" || upd.operator !== "++") return;
      const m = upd.argument; //  a.C[a.G + N]
      if (m.type !== "MemberExpression" || !m.computed) return;
      if (m.object.type !== "MemberExpression" || m.object.computed) return;
      const add = m.property;
      if (add.type !== "BinaryExpression" || add.operator !== "+" || !isNum(add.right)) return;
      if (add.left.type !== "MemberExpression" || add.left.computed) return;
      vm.fetchName = fn.id.name;
      vm.fetchFn = fn;
      vm.field.bytecode = r.object.property.name;
      vm.field.stack = m.object.property.name;
      vm.field.fp = add.left.property.name;
      vm.pcSlot = add.right.value;
    },
  });
  if (!vm.fetchName) return null;

  // --- 1c. the constant decoder: the fn containing `P = P ?? x(a)` twice
  traverse(ast, {
    FunctionDeclaration(p) {
      if (vm.constFnName) return;
      const fn = p.node;
      const names = fn.params.map((q) => (q.type === "Identifier" ? q.name : null));
      const found = [];
      let poolField = null;
      p.traverse({
        LogicalExpression(q) {
          if (q.node.operator !== "??") return;
          const a = q.node.left,
            b = q.node.right;
          if (a.type !== "Identifier") return;
          if (b.type !== "CallExpression" || b.callee.type !== "Identifier") return;
          if (b.callee.name !== vm.fetchName) return;
          const idx = names.indexOf(a.name);
          if (idx >= 0 && !found.includes(idx)) found.push(idx);
        },
        MemberExpression(q) {
          const m = q.node;
          if (!m.computed) return;
          if (m.object.type !== "MemberExpression" || m.object.computed) return;
          if (m.object.object.type !== "Identifier") return;
          if (names.indexOf(m.object.object.name) !== 0) return;
          poolField = m.object.property.name;
        },
      });
      if (found.length === 2 && poolField) {
        vm.constFnName = fn.id.name;
        vm.constFn = fn;
        vm.constKeyParams = found;
        vm.field.consts = poolField;
      }
    },
  });

  // --- 1d. `w` (make upvalue) and `y` (push frame) and the WeakMap
  traverse(ast, {
    VariableDeclarator(p) {
      const n = p.node;
      if (
        n.id.type === "Identifier" &&
        n.init &&
        n.init.type === "NewExpression" &&
        n.init.callee.type === "Identifier" &&
        n.init.callee.name === "WeakMap"
      )
        vm.weakMapName = n.id.name;
    },
  });

  // `y` is the frame pusher: it contains `<num> + <ident>.<prop>` (13 + spec.regs)
  traverse(ast, {
    FunctionDeclaration(p) {
      if (vm.frameFnName) return;
      let hit = null;
      p.traverse({
        BinaryExpression(q) {
          if (hit) return;
          const b = q.node;
          if (b.operator !== "+" || !isNum(b.left)) return;
          if (b.right.type !== "MemberExpression" || b.right.computed) return;
          if (b.right.property.type !== "Identifier") return;
          hit = { header: b.left.value, regsProp: b.right.property.name };
        },
      });
      if (hit && p.node.params.length >= 6) {
        vm.frameFnName = p.node.id.name;
        vm.frameFn = p.node;
        vm.headerSize = hit.header;
        vm.specProps = { regs: hit.regsProp };
      }
    },
  });

  // remaining spec property roles, read out of `y`
  if (vm.frameFn) {
    const regsProp = vm.specProps.regs;
    const propOf = (n) =>
      n && n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier"
        ? n.property.name
        : null;
    traverse(
      t.file(t.program([t.expressionStatement(t.functionExpression(null, [], vm.frameFn.body))])),
      {
        BinaryExpression(q) {
          const b = q.node;
          if (b.operator !== "<") return;
          const l = propOf(b.left),
            r = propOf(b.right);
          if (l && r === regsProp && l !== regsProp && !vm.specProps.params)
            vm.specProps.params = l;
        },
        IfStatement(q) {
          const p2 = propOf(q.node.test);
          if (p2 && p2 !== regsProp && !vm.specProps.rest) vm.specProps.rest = p2;
        },
      }
    );
  }

  // --- 1e. bytecode blob (longest string literal) + constant pool + entry spec
  let longest = null;
  traverse(ast, {
    StringLiteral(p) {
      if (!longest || p.node.value.length > longest.length) longest = p.node.value;
    },
    ArrayExpression(p) {
      if (p.node.elements.length > 5 && !vm.pool) {
        const par = p.parentPath.node;
        if (par.type === "NewExpression" || par.type === "CallExpression")
          vm.pool = p.node.elements;
      }
    },
  });
  if (!longest) return null;
  const bytes = Buffer.from(longest, "base64");
  const words = new Uint32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < words.length; i++) words[i] = bytes.readUInt32LE(i * 4);
  vm.bytecode = words;

  // entry spec: `new K({ ... })` sitting in the bootstrap call expression
  traverse(ast, {
    NewExpression(p) {
      if (vm.entrySpec) return;
      if (p.node.arguments.length !== 1) return;
      const o = p.node.arguments[0];
      if (o.type !== "ObjectExpression") return;
      const spec = {};
      for (const pr of o.properties) {
        if (pr.type !== "ObjectProperty") return;
        const key = pr.key.type === "Identifier" ? pr.key.name : pr.key.value;
        const v = num(pr.value);
        if (v === undefined) return;
        spec[key] = v;
      }
      // must be at statement level (the bootstrap), not inside a handler
      if (p.getFunctionParent()) return;
      vm.entrySpec = spec;
    },
  });

  // the object the payload treats as `globalThis`
  traverse(ast, {
    VariableDeclarator(p) {
      const n = p.node;
      if (n.id.type === "Identifier" && n.init && n.init.type === "Identifier" && n.init.name === "globalThis")
        vm.globalsName = n.id.name;
    },
  });

  if (!vm.constFnName || !vm.entrySpec || !vm.specProps) return null;
  return vm;
}

/* ------------------------------------------------------------------ *
 * 2.  Constant pool decoding (mirrors `z`)
 * ------------------------------------------------------------------ */

function poolValue(el) {
  if (el === null) return { kind: "hole" };
  if (el.type === "StringLiteral") return { kind: "str", v: el.value };
  if (el.type === "NumericLiteral") return { kind: "num", v: el.value };
  if (el.type === "UnaryExpression" && el.operator === "-" && isNum(el.argument))
    return { kind: "num", v: -el.argument.value };
  if (el.type === "BooleanLiteral") return { kind: "bool", v: el.value };
  if (el.type === "NullLiteral") return { kind: "null", v: null };
  if (el.type === "Identifier" && el.name === "undefined") return { kind: "undef", v: undefined };
  return { kind: "other", v: undefined, code: generate(el).code };
}

function decodeConst(pool, index, key) {
  const cell = pool[index];
  if (!cell) return { kind: "undef", v: undefined };
  if (!key) return cell;
  if (cell.kind === "num") return { kind: "num", v: cell.v ^ key };
  if (cell.kind !== "str") return cell;
  const bytes = Buffer.from(cell.v, "base64");
  let out = "";
  let k = key;
  for (let i = 0; i < bytes.length / 2; i++) {
    k = (k + 2654435769) | 0;
    out += String.fromCharCode((bytes[i * 2] | (bytes[i * 2 + 1] << 8)) ^ ((k ^ (k >>> 13)) & 0xffff));
  }
  return { kind: "str", v: out };
}

/* ------------------------------------------------------------------ *
 * 3.  A tiny AST interpreter used to *probe* opcode handlers
 *
 *  Handlers are run against a synthetic frame.  Operands are concrete
 *  (supplied by the caller), registers are either symbolic markers â€” which makes
 *  the handler's effect fall out as an expression tree â€” or concrete numbers,
 *  which is how the MBA-obfuscated arithmetic handlers get fitted.
 * ------------------------------------------------------------------ */

const MK = Symbol("mk");
function M(kind, data) {
  const o = Object.create(null);
  Object.defineProperty(o, MK, { value: Object.assign({ kind }, data) });
  return o;
}
const isM = (v) => v !== null && typeof v === "object" && MK in v;
const mk = (v) => v[MK];

const SYMBOLIC = Symbol("symbolic");
const MAGIC = 1e9;
const STRIDE = 1e6;

class Signal {
  constructor(type, value) {
    this.type = type;
    this.value = value;
  }
}

/**
 * @param {object} vm      result of locateVM
 * @param {object} fnNode  the handler FunctionExpression
 * @param {object} cfg     { operand(n), regValue(i), frameValue(slot), regBaseSlot }
 */
function runHandler(vm, fnNode, cfg) {
  const F = vm.field;
  const st = {
    nops: 0,
    events: [], // chronological { t:'operand'|'regread', ... }
    effects: [],
    regReads: [],
    bail: null,
    steps: 0,
  };
  let effects = st.effects;

  const STACK = { __stack: true };
  const VMOBJ = { __vm: true };
  const WEAK = new WeakMap();

  const GLOBALS = {
    Math,
    Object,
    Reflect,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Date,
    RegExp,
    Error,
    TypeError,
    ReferenceError,
    Symbol,
    isNaN,
    parseInt,
    parseFloat,
    undefined: undefined,
    NaN,
    Infinity,
  };
  if (vm.weakMapName) GLOBALS[vm.weakMapName] = WEAK;

  const step = () => {
    if (++st.steps > 400000) throw new Signal("bail", "step limit");
  };

  /* ---- stack access ---- */
  function splitIndex(idx) {
    if (typeof idx !== "number" || idx < MAGIC) return null;
    const off = idx - MAGIC;
    const slot = Math.floor(off / STRIDE);
    const reg = off - slot * STRIDE;
    if (reg < 0 || reg >= STRIDE) return null;
    return { slot, reg };
  }
  function readStack(idx) {
    const s = splitIndex(idx);
    if (s) {
      st.events.push({ t: "regread", i: s.reg, base: s.slot });
      st.regReads.push(s.reg);
      return cfg.regValue(s.reg);
    }
    if (isM(idx)) return M("stackref", { idx });
    return cfg.frameValue(idx); // frame pointer is 0, so idx === slot
  }
  function writeStack(idx, val) {
    const s = splitIndex(idx);
    if (s) {
      effects.push({ t: "setreg", i: s.reg, v: val });
      return;
    }
    if (isM(idx)) {
      effects.push({ t: "setstack", idx, v: val });
      return;
    }
    if (idx === vm.pcSlot) effects.push({ t: "setpc", v: val });
    else effects.push({ t: "setframe", slot: idx, v: val });
  }

  /* ---- member access ---- */
  function getMember(obj, key) {
    if (obj === STACK) return readStack(key);
    if (obj === VMOBJ) {
      if (key === F.stack) return STACK;
      if (key === F.fp) return 0;
      if (key === F.bytecode) return M("bytecode", {});
      if (key === F.consts) return M("pool", {});
      return M("vmfield", { name: key });
    }
    if (isM(obj)) return M("member", { obj, prop: key });
    if (obj === null || obj === undefined) return M("opaque", {});
    try {
      const v = obj[key];
      return typeof v === "function" ? v.bind(obj) : v;
    } catch (e) {
      return M("opaque", {});
    }
  }
  function setMember(obj, key, val) {
    if (obj === STACK) return writeStack(key, val);
    if (obj === VMOBJ) {
      effects.push({ t: "setvm", field: key, v: val });
      return val;
    }
    if (isM(obj)) {
      effects.push({ t: "setmember", obj, key, v: val });
      return val;
    }
    try {
      obj[key] = val;
    } catch (e) {
      /* ignore */
    }
    return val;
  }

  /* ---- operators ---- */
  function bin(op, l, r) {
    if (isM(l) || isM(r)) return M("bin", { op, l, r });
    switch (op) {
      case "+": return l + r;
      case "-": return l - r;
      case "*": return l * r;
      case "/": return l / r;
      case "%": return l % r;
      case "**": return l ** r;
      case "&": return l & r;
      case "|": return l | r;
      case "^": return l ^ r;
      case "<<": return l << r;
      case ">>": return l >> r;
      case ">>>": return l >>> r;
      case "<": return l < r;
      case ">": return l > r;
      case "<=": return l <= r;
      case ">=": return l >= r;
      case "==": return l == r;
      case "!=": return l != r;
      case "===": return l === r;
      case "!==": return l !== r;
      case "in":
        try { return l in r; } catch (e) { return true; }
      case "instanceof":
        try { return l instanceof r; } catch (e) { return false; }
      default: throw new Signal("bail", "binop " + op);
    }
  }
  function un(op, a) {
    if (isM(a)) return M("un", { op, a });
    switch (op) {
      case "-": return -a;
      case "+": return +a;
      case "~": return ~a;
      case "!": return !a;
      case "typeof": return typeof a;
      case "void": return undefined;
      default: throw new Signal("bail", "unop " + op);
    }
  }
  const truthy = (v) => (isM(v) ? SYMBOLIC : !!v);

  /* ---- environment ---- */
  const cloneEnv = (e) => new Map(e);

  function lookup(env, name) {
    if (env.has(name)) return env.get(name);
    if (name in GLOBALS) return GLOBALS[name];
    return M("free", { name });
  }

  /* ---- expressions ---- */
  function evalExpr(n, env) {
    step();
    switch (n.type) {
      case "NumericLiteral":
      case "StringLiteral":
      case "BooleanLiteral":
        return n.value;
      case "NullLiteral":
        return null;
      case "RegExpLiteral":
        return M("opaque", {});
      case "Identifier":
        if (n.name === "undefined") return undefined;
        return lookup(env, n.name);
      case "ThisExpression":
        return VMOBJ;
      case "TemplateLiteral":
        return M("opaque", {});
      case "ArrayExpression":
        return n.elements.map((e) => (e === null ? undefined : evalExpr(e, env)));
      case "ObjectExpression": {
        const o = {};
        for (const p of n.properties) {
          if (p.type !== "ObjectProperty") continue;
          const key = p.computed ? evalExpr(p.key, env) : p.key.name ?? p.key.value;
          o[key] = evalExpr(p.value, env);
        }
        return o;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return M("func", { node: n, env: cloneEnv(env) });
      case "SequenceExpression": {
        let v;
        for (const e of n.expressions) v = evalExpr(e, env);
        return v;
      }
      case "UnaryExpression": {
        if (n.operator === "delete") {
          const arg = n.argument;
          if (arg.type === "MemberExpression") {
            const o = evalExpr(arg.object, env);
            const k = arg.computed ? evalExpr(arg.property, env) : arg.property.name;
            return M("delete", { obj: o, key: k });
          }
          return true;
        }
        if (n.operator === "void") {
          evalExpr(n.argument, env);
          return undefined;
        }
        return un(n.operator, evalExpr(n.argument, env));
      }
      case "BinaryExpression":
        return bin(n.operator, evalExpr(n.left, env), evalExpr(n.right, env));
      case "LogicalExpression": {
        const l = evalExpr(n.left, env);
        const tv = truthy(l);
        if (tv === SYMBOLIC || n.operator === "??") {
          // Evaluate the RHS in an isolated effect scope. If it does something
          // observable it is a *guarded* effect (this is how `cond && (pc = x)`
          // conditional jumps are encoded); otherwise assume the LHS is truthy.
          const saved = effects;
          const nested = [];
          effects = nested;
          let r;
          try {
            r = evalExpr(n.right, env);
          } finally {
            effects = saved;
          }
          if (nested.length) {
            effects.push({
              t: "if",
              test: n.operator === "||" ? M("un", { op: "!", a: l }) : l,
              then: nested,
              else: [],
            });
            return M("logic", { op: n.operator, l, r });
          }
          return n.operator === "&&" ? r : l;
        }
        if (n.operator === "&&") return tv ? evalExpr(n.right, env) : l;
        return tv ? l : evalExpr(n.right, env);
      }
      case "ConditionalExpression": {
        const tv = truthy(evalExpr(n.test, env));
        if (tv === SYMBOLIC) {
          const saved = effects;
          const a = [];
          const b = [];
          effects = a;
          const cons = evalExpr(n.consequent, env);
          effects = b;
          const alt = evalExpr(n.alternate, env);
          effects = saved;
          if (a.length || b.length) effects.push({ t: "if", test: null, then: a, else: b });
          return M("cond", { cons, alt });
        }
        return tv ? evalExpr(n.consequent, env) : evalExpr(n.alternate, env);
      }
      case "MemberExpression": {
        const o = evalExpr(n.object, env);
        const k = n.computed ? evalExpr(n.property, env) : n.property.name;
        return getMember(o, k);
      }
      case "AssignmentExpression":
        return doAssign(n, env);
      case "UpdateExpression": {
        const old = evalExpr(n.argument, env);
        const nv = bin(n.operator === "++" ? "+" : "-", old, 1);
        assignTo(n.argument, nv, env);
        return n.prefix ? nv : old;
      }
      case "NewExpression": {
        const args = n.arguments.map((a) => evalExpr(a, env));
        const name = n.callee.type === "Identifier" ? n.callee.name : null;
        if (name && name in GLOBALS) {
          try {
            return new GLOBALS[name](...args);
          } catch (e) {
            return M("opaque", {});
          }
        }
        effects.push({ t: "new", name, args });
        return M("instance", { name, args });
      }
      case "CallExpression":
        return doCall(n, env);
      default:
        throw new Signal("bail", "expr " + n.type);
    }
  }

  function assignTo(target, value, env) {
    if (target.type === "Identifier") {
      env.set(target.name, value);
      return value;
    }
    if (target.type === "MemberExpression") {
      const o = evalExpr(target.object, env);
      const k = target.computed ? evalExpr(target.property, env) : target.property.name;
      return setMember(o, k, value);
    }
    throw new Signal("bail", "assign target " + target.type);
  }

  function doAssign(n, env) {
    if (n.operator === "=") {
      // NB: JS evaluates the member target *before* the right-hand side, and the
      // handlers rely on that ordering to pull their operands in the right order.
      if (n.left.type === "MemberExpression") {
        const o = evalExpr(n.left.object, env);
        const k = n.left.computed ? evalExpr(n.left.property, env) : n.left.property.name;
        return setMember(o, k, evalExpr(n.right, env));
      }
      const v = evalExpr(n.right, env);
      return assignTo(n.left, v, env);
    }
    const op = n.operator.slice(0, -1);
    const cur = evalExpr(n.left, env);
    const v = op === "||" || op === "&&" || op === "??" ? evalExpr(n.right, env) : bin(op, cur, evalExpr(n.right, env));
    return assignTo(n.left, v, env);
  }

  function callUser(fnMarker, args) {
    const info = mk(fnMarker);
    const env = cloneEnv(info.env);
    info.node.params.forEach((p, i) => {
      if (p.type === "Identifier") env.set(p.name, args[i]);
    });
    try {
      execBlock(info.node.body.body, env);
    } catch (e) {
      if (e instanceof Signal && e.type === "return") return e.value;
      throw e;
    }
    return undefined;
  }

  function doCall(n, env) {
    const callee = n.callee;
    if (callee.type === "Identifier") {
      const name = callee.name;
      if (name === vm.fetchName) {
        n.arguments.forEach((a) => evalExpr(a, env));
        const v = cfg.operand(st.nops);
        st.events.push({ t: "operand", n: st.nops, v });
        st.nops++;
        return v;
      }
      if (name === vm.constFnName) {
        const args = n.arguments.map((a) => evalExpr(a, env));
        const [pi, pk] = vm.constKeyParams;
        let index = args[pi];
        let key = args[pk];
        if (index === undefined) {
          index = cfg.operand(st.nops);
          st.events.push({ t: "operand", n: st.nops, v: index, role: "constIndex" });
          st.nops++;
        }
        if (key === undefined) {
          key = cfg.operand(st.nops);
          st.events.push({ t: "operand", n: st.nops, v: key, role: "constKey" });
          st.nops++;
        }
        return M("const", { index, key });
      }
      const f = lookup(env, name);
      const args = n.arguments.map((a) => evalExpr(a, env));
      if (isM(f) && mk(f).kind === "func") return callUser(f, args);
      if (typeof f === "function") {
        try {
          return f(...args);
        } catch (e) {
          return M("opaque", {});
        }
      }
      effects.push({ t: "call", name, args });
      return M("callres", { name, args });
    }
    if (callee.type === "MemberExpression") {
      const o = evalExpr(callee.object, env);
      const k = callee.computed ? evalExpr(callee.property, env) : callee.property.name;
      const args = n.arguments.map((a) => evalExpr(a, env));
      if (isM(o) || o === VMOBJ) {
        const target = o === VMOBJ ? M("vmself", {}) : o;
        effects.push({ t: "invoke", obj: target, key: k, args });
        return M("invoke", { obj: target, key: k, args });
      }
      const objName = callee.object.type === "Identifier" ? callee.object.name : null;
      // Anything with a symbolic argument stays symbolic â€” `Reflect.set(<reg>, â€¦)`
      // and friends are effects we want to see, not things to actually perform.
      if (o !== WEAK && args.some(isM)) {
        const node = M("native", { objName, key: k, args });
        effects.push({ t: "nativecall", objName, key: k, args, node });
        return node;
      }
      const f = getMember(o, k);
      if (isM(f) && mk(f).kind === "func") return callUser(f, args);
      if (typeof f === "function") {
        try {
          return f(...args);
        } catch (e) {
          const node = M("native", { objName, key: k, args });
          effects.push({ t: "nativecall", objName, key: k, args, node });
          return node;
        }
      }
      return M("opaque", {});
    }
    // IIFE:  (function(){...})(args)
    const f = evalExpr(callee, env);
    const args = n.arguments.map((a) => evalExpr(a, env));
    if (isM(f) && mk(f).kind === "func") return callUser(f, args);
    return M("opaque", {});
  }

  /* ---- statements ---- */
  function execBlock(stmts, env) {
    for (const s of stmts) execStmt(s, env);
  }

  function execStmt(n, env) {
    step();
    switch (n.type) {
      case "VariableDeclaration":
        for (const d of n.declarations) {
          const v = d.init ? evalExpr(d.init, env) : undefined;
          env.set(d.id.name, v);
        }
        return;
      case "ExpressionStatement":
        evalExpr(n.expression, env);
        return;
      case "BlockStatement":
        return execBlock(n.body, env);
      case "EmptyStatement":
      case "DebuggerStatement":
        if (n.type === "DebuggerStatement") effects.push({ t: "debugger" });
        return;
      case "ReturnStatement":
        throw new Signal("return", n.argument ? evalExpr(n.argument, env) : undefined);
      case "BreakStatement":
        throw new Signal("break");
      case "ContinueStatement":
        throw new Signal("continue");
      case "ThrowStatement":
        effects.push({ t: "throw", v: evalExpr(n.argument, env) });
        throw new Signal("return", undefined);
      case "IfStatement": {
        const tv = truthy(evalExpr(n.test, env));
        if (tv !== SYMBOLIC) {
          if (tv) execStmt(n.consequent, env);
          else if (n.alternate) execStmt(n.alternate, env);
          return;
        }
        const saved = effects;
        const a = [];
        const b = [];
        const envA = cloneEnv(env);
        const envB = cloneEnv(env);
        effects = a;
        try { execStmt(n.consequent, envA); } catch (e) { if (!(e instanceof Signal)) throw e; }
        effects = b;
        if (n.alternate) {
          try { execStmt(n.alternate, envB); } catch (e) { if (!(e instanceof Signal)) throw e; }
        }
        effects = saved;
        effects.push({ t: "if", test: null, then: a, else: b });
        return;
      }
      case "ForStatement": {
        if (n.init) {
          if (n.init.type === "VariableDeclaration") execStmt(n.init, env);
          else evalExpr(n.init, env);
        }
        let guard = 0;
        for (;;) {
          if (++guard > 100000) throw new Signal("bail", "loop");
          if (n.test) {
            const tv = truthy(evalExpr(n.test, env));
            if (tv === SYMBOLIC) {
              effects.push({ t: "symbolicloop" });
              break;
            }
            if (!tv) break;
          }
          try {
            execStmt(n.body, env);
          } catch (e) {
            if (e instanceof Signal && e.type === "break") break;
            if (e instanceof Signal && e.type === "continue") {
              /* fall through to update */
            } else throw e;
          }
          if (n.update) evalExpr(n.update, env);
        }
        return;
      }
      case "WhileStatement": {
        let guard = 0;
        for (;;) {
          if (++guard > 100000) throw new Signal("bail", "loop");
          const tv = truthy(evalExpr(n.test, env));
          if (tv === SYMBOLIC) {
            effects.push({ t: "symbolicloop" });
            break;
          }
          if (!tv) break;
          try {
            execStmt(n.body, env);
          } catch (e) {
            if (e instanceof Signal && e.type === "break") break;
            if (!(e instanceof Signal && e.type === "continue")) throw e;
          }
        }
        return;
      }
      case "TryStatement":
        try {
          execStmt(n.block, env);
        } catch (e) {
          if (e instanceof Signal) throw e;
          if (n.handler) execStmt(n.handler.body, env);
        }
        return;
      case "FunctionDeclaration":
        env.set(n.id.name, M("func", { node: n, env: cloneEnv(env) }));
        return;
      default:
        throw new Signal("bail", "stmt " + n.type);
    }
  }

  const env = new Map();
  try {
    execBlock(fnNode.body.body, env);
  } catch (e) {
    if (e instanceof Signal) {
      if (e.type === "bail") st.bail = e.value;
    } else st.bail = e.message;
  }
  return st;
}

/* ------------------------------------------------------------------ *
 * 4.  Opcode classification
 * ------------------------------------------------------------------ */

const OPBASE = 5000;
const OPBASE2 = 5040;

const symCfg = (vm, operand) => ({
  operand,
  regValue: (i) => M("reg", { i }),
  frameValue: (slot) => (slot === vm.regBaseSlot ? MAGIC + slot * STRIDE : M("frame", { slot })),
});

/** which frame slot holds the register base â€” derived, not assumed */
function findRegBaseSlot(vm) {
  const counts = new Map();
  for (const fn of vm.handlers.values()) {
    const st = runHandler(vm, fn, {
      operand: (n) => OPBASE + n,
      regValue: () => 0,
      frameValue: (slot) => MAGIC + slot * STRIDE,
    });
    for (const e of st.events) if (e.t === "regread") counts.set(e.base, (counts.get(e.base) || 0) + 1);
  }
  let best = null;
  for (const [slot, c] of counts) if (!best || c > best[1]) best = [slot, c];
  return best ? best[0] : 6;
}

/** flatten effects, descending into `if` branches */
function flat(effects, out = []) {
  for (const e of effects) {
    out.push(e);
    if (e.t === "if") {
      flat(e.then || [], out);
      flat(e.else || [], out);
    }
  }
  return out;
}

function findSpreadMarker(fnNode) {
  let marker = null;
  const walk = (n) => {
    if (!n || typeof n !== "object" || marker !== null) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "BinaryExpression" && (n.operator === "===" || n.operator === "==")) {
      for (const side of [n.left, n.right]) {
        const v = num(side);
        if (v !== undefined && v > 0x7fffffff) marker = v;
      }
    }
    for (const k in n) if (k !== "loc") walk(n[k]);
  };
  walk(fnNode.body);
  return marker;
}

/**
 * Structural probe of one handler: operand count / layout, and the symbolic
 * effect it produces.  Independent of the enclosing function's register count.
 */
function probeStructure(vm, op) {
  const fn = vm.handlers.get(op);
  const a = runHandler(vm, fn, symCfg(vm, (n) => OPBASE + n));
  const b = runHandler(vm, fn, symCfg(vm, (n) => OPBASE2 + n));

  const res = { op, fn, varLen: false, nops: a.nops, group: 0, countSlot: null, st: a };
  if (a.nops !== b.nops) {
    res.varLen = true;
    res.group = (b.nops - a.nops) / (OPBASE2 - OPBASE);
    for (let s = 0; s < Math.min(a.nops, 12); s++) {
      const c = runHandler(vm, fn, symCfg(vm, (n) => (n === s ? 2 : OPBASE + n)));
      if (c.nops === a.nops - res.group * (OPBASE + s) + res.group * 2) {
        res.countSlot = s;
        break;
      }
    }
    res.st = runHandler(vm, fn, symCfg(vm, (n) => (n === res.countSlot ? 2 : OPBASE + n)));
    // operands consumed before the repeated group starts
    res.fixed = res.st.nops - res.group * 2;
    res.nops = null; // computed per instruction
    res.spread = findSpreadMarker(fn);
  }
  return res;
}

/* --- turning a symbolic value into an operand role --- */
const slotOf = (v) => (typeof v === "number" && v >= OPBASE && v < OPBASE + 4096 ? v - OPBASE : null);

function srcOf(v) {
  if (isM(v)) {
    const i = mk(v);
    if (i.kind === "reg") {
      const s = slotOf(i.i);
      return s === null ? { k: "reg", fixed: i.i } : { k: "reg", slot: s };
    }
    if (i.kind === "const") {
      const si = slotOf(i.index),
        sk = slotOf(i.key);
      return {
        k: "const",
        index: si === null ? i.index : undefined,
        indexSlot: si === null ? undefined : si,
        key: sk === null ? i.key : undefined,
        keySlot: sk === null ? undefined : sk,
      };
    }
    if (i.kind === "frame") return { k: "frame", slot: i.slot };
    return null;
  }
  const s = slotOf(v);
  if (s !== null) return { k: "imm", slot: s };
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v === null || v === undefined)
    return { k: "lit", v };
  return null;
}

const isReg = (s) => s && s.k === "reg";
const isSimple = (s) => s && (s.k === "reg" || s.k === "imm" || s.k === "lit" || s.k === "const");

/** `frame[4].l[idx]` â€” an upvalue reference */
function upvalRef(v) {
  if (!isM(v)) return null;
  const a = mk(v);
  if (a.kind !== "member") return null;
  const b = isM(a.obj) ? mk(a.obj) : null;
  if (!b || b.kind !== "member") return null;
  const c = isM(b.obj) ? mk(b.obj) : null;
  if (!c || c.kind !== "frame") return null;
  const s = slotOf(a.prop);
  return s === null ? { fixed: a.prop } : { slot: s };
}

const JS_BINOPS = new Set([
  "+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>",
  "<", ">", "<=", ">=", "==", "!=", "===", "!==", "in", "instanceof",
]);
const JS_UNOPS = new Set(["-", "+", "~", "!", "typeof", "void"]);

function classify(vm, probe) {
  const st = probe.st;
  const eff = st.effects;
  const all = flat(eff);
  const F = vm.field;
  const d = {
    op: probe.op, nops: probe.nops, varLen: probe.varLen, group: probe.group,
    countSlot: probe.countSlot, fixed: probe.fixed, spread: probe.spread,
  };

  const setRegs = all.filter((e) => e.t === "setreg");
  const setPCs = all.filter((e) => e.t === "setpc");
  const dstOf = (e) => {
    const s = slotOf(e.i);
    return s === null ? { fixed: e.i } : { slot: s };
  };

  /* --- return: the only handler that reassigns the frame pointer --- */
  if (all.some((e) => e.t === "setvm" && e.field === F.fp)) {
    d.kind = "RET";
    const first = st.regReads[0];
    const s = slotOf(first);
    d.src = s === null ? { k: "reg", fixed: first } : { k: "reg", slot: s };
    return d;
  }

  /* --- throw --- */
  const thrown = all.find((e) => e.t === "throw" && isReg(srcOf(e.v)));
  if (thrown) {
    d.kind = "THROW";
    d.src = srcOf(thrown.v);
    return d;
  }

  /* --- try-handler bookkeeping --- */
  const pushObj = (() => {
    const found = [];
    const scan = (v, depth = 0) => {
      if (depth > 4 || !v || typeof v !== "object" || isM(v)) return;
      if (Array.isArray(v)) return v.forEach((x) => scan(x, depth + 1));
      const ks = Object.keys(v);
      if (ks.length && ks.every((k) => typeof v[k] === "number")) found.push(v);
    };
    for (const e of all) {
      if (e.t === "setframe") scan(e.v);
      if (e.t === "invoke") e.args.forEach((a) => scan(a));
    }
    return found[0];
  })();
  if (pushObj) {
    const vals = Object.values(pushObj);
    const role = (v) => {
      const s = slotOf(v);
      return s === null ? { k: "lit", v } : { k: "imm", slot: s };
    };
    if (vals.length === 2) {
      d.kind = "TRY_CATCH";
      d.target = role(vals[0]);
      d.reg = role(vals[1]);
    } else {
      d.kind = "TRY_FINALLY";
      d.target = role(vals[0]);
      d.flagReg = role(vals[1]);
      d.excReg = role(vals[2]);
      d.flagVal = role(vals[3]);
    }
    return d;
  }
  if (all.some((e) => e.t === "invoke" && e.key === "pop")) {
    d.kind = "TRY_POP";
    return d;
  }

  if (all.some((e) => e.t === "debugger")) {
    d.kind = "DEBUGGER";
    return d;
  }

  /* --- bytecode self-decryption --- */
  if (all.some((e) => e.t === "setmember" && isM(e.obj) && mk(e.obj).kind === "bytecode")) {
    d.kind = "DECRYPT";
    return d;
  }

  /* --- for-in --- */
  if (setPCs.length === 1 && setRegs.length === 1 && all.some((e) => e.t === "setmember")) {
    d.kind = "FORIN_NEXT";
    d.dst = dstOf(setRegs[0]);
    const it = st.regReads[0];
    const s = slotOf(it);
    d.src = s === null ? { k: "reg", fixed: it } : { k: "reg", slot: s };
    d.target = srcOf(setPCs[0].v);
    return d;
  }

  /* --- jumps --- */
  if (setPCs.length) {
    const guarded = eff.find((e) => e.t === "if" && flat([e]).some((x) => x.t === "setpc"));
    if (guarded) {
      const test = guarded.test;
      let neg = false;
      let tv = test;
      if (isM(test) && mk(test).kind === "un" && mk(test).op === "!") {
        neg = true;
        tv = mk(test).a;
      }
      d.kind = neg ? "JMP_FALSE" : "JMP_TRUE";
      d.src = srcOf(tv);
      d.target = srcOf(setPCs[0].v);
      return d;
    }
    const tgt = srcOf(setPCs[0].v);
    d.kind = isReg(tgt) ? "JMP_REG" : "JMP";
    d.target = tgt;
    return d;
  }

  /* --- property store: Reflect.set(obj, key, value) --- */
  const rset = all.find((e) => e.t === "nativecall" && e.key === "set" && e.args.length === 3);
  if (rset && !setRegs.length) {
    d.kind = "SET_PROP";
    d.obj = srcOf(rset.args[0]);
    d.key = srcOf(rset.args[1]);
    d.value = srcOf(rset.args[2]);
    return d;
  }
  /* --- accessor definition --- */
  const defp = all.find((e) => e.t === "nativecall" && e.key === "defineProperty");
  if (defp) {
    const desc = defp.args[2];
    d.kind = desc && typeof desc === "object" && "get" in desc ? "DEF_GETTER" : "DEF_SETTER";
    d.obj = srcOf(defp.args[0]);
    d.key = srcOf(defp.args[1]);
    d.value = srcOf(d.kind === "DEF_GETTER" ? desc.get : desc.set);
    return d;
  }

  /* --- global store --- */
  const gset = all.find(
    (e) => e.t === "setmember" && isM(e.obj) && mk(e.obj).kind === "vmfield" && isM(e.key) && mk(e.key).kind === "const"
  );
  if (gset) {
    d.kind = "SET_GLOBAL";
    d.name = srcOf(gset.key);
    d.value = srcOf(gset.v);
    return d;
  }

  /* --- upvalue store --- */
  const uset = all.find((e) => e.t === "setmember" && upvalDeep(e.obj));
  if (uset) {
    d.kind = "SET_UPVAL";
    d.index = upvalDeep(uset.obj);
    d.value = srcOf(uset.v);
    return d;
  }

  /* --- everything that produces a value in a register --- */
  if (setRegs.length === 1) {
    const w = setRegs[0];
    d.dst = dstOf(w);
    const v = w.v;
    const info = isM(v) ? mk(v) : null;

    if (Array.isArray(v)) {
      d.kind = "ARRAY";
      d.elements = v.map(srcOf);
      return d;
    }
    if (!info && v && typeof v === "object") {
      // `{ keys: [...], index: 0 }` â€” the iterator object a for-in loop walks
      if (!probe.varLen && Object.values(v).some((x) => Array.isArray(x))) {
        d.kind = "FORIN_INIT";
        const s0 = st.regReads[0];
        d.src = slotOf(s0) === null ? { k: "reg", fixed: s0 } : { k: "reg", slot: slotOf(s0) };
        return d;
      }
      d.kind = "OBJECT";
      d.pairs = [];
      for (let i = 0; i + 1 < st.regReads.length; i += 2) {
        const a = st.regReads[i],
          b = st.regReads[i + 1];
        const rs = (x) => (slotOf(x) === null ? { k: "reg", fixed: x } : { k: "reg", slot: slotOf(x) });
        d.pairs.push([rs(a), rs(b)]);
      }
      return d;
    }
    if (info && info.kind === "func") {
      d.kind = "MAKE_FN";
      const nw = all.find((e) => e.t === "new");
      d.spec = {};
      if (nw && nw.args[0]) for (const k in nw.args[0]) d.spec[k] = slotOf(nw.args[0][k]);
      return d;
    }
    const up = upvalRef(info && info.kind === "invoke" ? mk(v).obj : null);
    if (info && info.kind === "invoke" && up) {
      d.kind = "GET_UPVAL";
      d.index = up;
      return d;
    }
    if (info && info.kind === "invoke" && info.key === "apply") {
      const thisArg = info.args[0];
      d.kind = thisArg === null ? "CALL" : "METHOD_CALL";
      d.callee = srcOf(info.obj);
      if (thisArg !== null) d.thisArg = srcOf(thisArg);
      return d;
    }
    if (info && info.kind === "native" && info.key === "construct") {
      d.kind = "NEW";
      d.callee = srcOf(info.args[0]);
      return d;
    }
    if (info && info.kind === "native" && info.key === "pow") {
      d.kind = "BIN";
      d.operator = "**";
      d.srcs = [srcOf(info.args[0]), srcOf(info.args[1])];
      return d;
    }
    if (info && info.kind === "delete") {
      d.kind = "DEL_PROP";
      d.obj = srcOf(info.obj);
      d.key = srcOf(info.key);
      return d;
    }
    if (info && info.kind === "member") {
      const o = isM(info.obj) ? mk(info.obj) : null;
      if (o && o.kind === "vmfield") {
        d.kind = "GET_GLOBAL";
        d.name = srcOf(info.prop);
        d.throws = all.some((e) => e.t === "throw");
        return d;
      }
      const os = srcOf(info.obj),
        ks = srcOf(info.prop);
      if (isSimple(os) && isSimple(ks)) {
        d.kind = "GET_PROP";
        d.obj = os;
        d.key = ks;
        return d;
      }
    }
    if (info && info.kind === "un" && info.op === "typeof") {
      const a = srcOf(info.a);
      if (isSimple(a)) {
        d.kind = "UN";
        d.operator = "typeof";
        d.srcs = [a];
        return d;
      }
      // typeof <global> â€” the "safe" form that does not throw on undeclared names
      const cnd = isM(info.a) ? mk(info.a) : null;
      if (cnd && cnd.kind === "cond") {
        const m = isM(cnd.cons) ? mk(cnd.cons) : null;
        if (m && m.kind === "member") {
          d.kind = "TYPEOF_GLOBAL";
          d.name = srcOf(m.prop);
          return d;
        }
      }
    }
    if (info && info.kind === "bin" && JS_BINOPS.has(info.op)) {
      const l = srcOf(info.l),
        r = srcOf(info.r);
      if (isSimple(l) && isSimple(r)) {
        d.kind = "BIN";
        d.operator = info.op;
        d.srcs = [l, r];
        return d;
      }
    }
    if (info && info.kind === "un" && JS_UNOPS.has(info.op)) {
      const a = srcOf(info.a);
      if (isSimple(a)) {
        d.kind = "UN";
        d.operator = info.op;
        d.srcs = [a];
        return d;
      }
    }
    const plain = srcOf(v);
    if (plain) {
      if (plain.k === "reg") {
        d.kind = "MOV";
        d.src = plain;
        return d;
      }
      if (plain.k === "imm" || plain.k === "lit") {
        d.kind = "LOAD_IMM";
        d.src = plain;
        return d;
      }
      if (plain.k === "const") {
        d.kind = "LOAD_CONST";
        d.src = plain;
        return d;
      }
      if (plain.k === "frame") {
        d.kind = "LOAD_THIS";
        return d;
      }
    }
    // Anything left over is an MBA-obfuscated arithmetic op: fit it numerically.
    d.kind = "ARITH";
    d.inputs = arithInputs(st);
    return d;
  }

  d.kind = "UNKNOWN";
  return d;
}

/** `frame[4].l[i][field]` â€” set-upvalue writes through one more member hop */
function upvalDeep(v) {
  if (!isM(v)) return null;
  const a = mk(v);
  if (a.kind === "member") {
    const direct = upvalRef(v);
    if (direct) return direct;
    return upvalDeep(a.obj);
  }
  return null;
}

/** chronological list of value inputs for an MBA handler */
function arithInputs(st) {
  const regIdxSlots = new Set();
  for (const e of st.events) if (e.t === "regread" && slotOf(e.i) !== null) regIdxSlots.add(slotOf(e.i));
  const dstSlots = new Set();
  for (const e of flat(st.effects)) if (e.t === "setreg" && slotOf(e.i) !== null) dstSlots.add(slotOf(e.i));
  const inputs = [];
  const seenReg = new Set();
  for (const e of st.events) {
    if (e.t === "regread") {
      if (seenReg.has(e.i)) continue;
      seenReg.add(e.i);
      const s = slotOf(e.i);
      inputs.push(s === null ? { k: "reg", fixed: e.i } : { k: "reg", slot: s });
    } else if (e.t === "operand") {
      if (regIdxSlots.has(e.n) || dstSlots.has(e.n)) continue;
      inputs.push({ k: "imm", slot: e.n });
    }
  }
  return inputs;
}

/* ------------------------------------------------------------------ *
 * 5.  Numeric fitting â€” recovering the operator hidden behind the MBA
 *
 *  The MBA identities are *keyed on the frame size*, i.e. the same opcode means
 *  different things inside functions with different register counts.  So a fit
 *  is always (opcode, registerCount).
 * ------------------------------------------------------------------ */

const BIN_FITS = [
  ["+", (a, b) => a + b], ["-", (a, b) => a - b], ["*", (a, b) => a * b],
  ["/", (a, b) => a / b], ["%", (a, b) => a % b], ["**", (a, b) => a ** b],
  ["&", (a, b) => a & b], ["|", (a, b) => a | b], ["^", (a, b) => a ^ b],
  ["<<", (a, b) => a << b], [">>", (a, b) => a >> b], [">>>", (a, b) => a >>> b],
  ["<", (a, b) => a < b], [">", (a, b) => a > b], ["<=", (a, b) => a <= b], [">=", (a, b) => a >= b],
  ["==", (a, b) => a == b], ["!=", (a, b) => a != b],
  ["===", (a, b) => a === b], ["!==", (a, b) => a !== b],
];
const UN_FITS = [
  ["-", (a) => -a], ["+", (a) => +a], ["~", (a) => ~a], ["!", (a) => !a],
];
/** operators worth trying for fused three-input handlers */
const ARITH_FITS = BIN_FITS.filter(([n]) => ["+", "-", "*", "&", "|", "^", "<<", ">>", ">>>"].includes(n));

/**
 * Deterministic probe values.  The fixed head covers the boundaries that tell
 * `a + b` apart from `(a + b) | 0`; the tail is a fixed xorshift sequence so a
 * given input always deobfuscates to the same output.
 */
const PROBE_SEEDS = [
  0, 1, -1, 2, -2, 2147483647, -2147483648, 2147483646, 65535, 65536,
  -65536, 1073741824, -1073741825, 255, 4096,
];
let rngState = 0x2545f491;
const rnd32 = () => {
  rngState ^= rngState << 13; rngState |= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState |= 0;
  return rngState;
};
const resetRng = () => { rngState = 0x2545f491; };
const TRIALS = 40;
const probeValue = (i) => (i < PROBE_SEEDS.length ? PROBE_SEEDS[i] : rnd32());

/* ------------------------------------------------------------------ *
 * 6.  Disassembler
 * ------------------------------------------------------------------ */

function instrLength(desc, code, pc) {
  if (!desc.varLen) return 1 + desc.nops;
  const count = code[pc + 1 + desc.countSlot];
  if (desc.spread != null && count === desc.spread) return 1 + desc.fixed + 1;
  return 1 + desc.fixed + desc.group * count;
}

/** resolve an operand role against a concrete instruction */
function value(role, ops) {
  if (!role) return null;
  switch (role.k) {
    case "reg":
      return { k: "reg", i: role.slot === undefined ? role.fixed : ops[role.slot] };
    case "imm":
      return { k: "imm", v: ops[role.slot] };
    case "lit":
      return { k: "imm", v: role.v };
    case "const":
      return {
        k: "const",
        index: role.indexSlot === undefined ? role.index : ops[role.indexSlot],
        key: role.keySlot === undefined ? role.key : ops[role.keySlot],
      };
    case "frame":
      return { k: "this" };
    default:
      return null;
  }
}
const regIdx = (role, ops) => (role.slot === undefined ? role.fixed : ops[role.slot]);

function disassemble(vm, descs) {
  const code = vm.bytecode;
  const funcs = new Map(); // entry -> function record
  const pending = [];

  const addFunc = (entry, params, regs, rest) => {
    if (funcs.has(entry)) return funcs.get(entry);
    const f = {
      entry, params, regs, rest,
      id: funcs.size,
      instrs: new Map(),
      blocks: null,
      upvals: [],
    };
    funcs.set(entry, f);
    pending.push(f);
    return f;
  };

  const sp = vm.entrySpec;
  const P = vm.specProps;
  const entryProp = Object.keys(sp).find((k) => k !== P.regs && k !== P.params && k !== P.rest);
  vm.specProps.entry = entryProp;
  addFunc(sp[entryProp] || 0, sp[P.params] || 0, sp[P.regs] || 0, !!sp[P.rest]);

  const walk = (f, startPcs) => {
    const work = [...startPcs];
    while (work.length) {
      const pc = work.pop();
      if (f.instrs.has(pc) || pc >= code.length) continue;
      const op = code[pc];
      const desc = descs.get(op);
      if (!desc) fail(`unknown opcode ${op} at pc ${pc} (function @${f.entry})`);
      const len = instrLength(desc, code, pc);
      const ops = [];
      for (let i = 1; i < len; i++) ops.push(code[pc + i]);
      const ins = { pc, len, op, desc, ops, fn: f };
      f.instrs.set(pc, ins);

      const next = pc + len;
      switch (desc.kind) {
        case "RET":
        case "THROW":
          break;
        case "JMP":
          work.push(value(desc.target, ops).v);
          break;
        case "JMP_TRUE":
        case "JMP_FALSE":
        case "FORIN_NEXT":
          work.push(value(desc.target, ops).v);
          work.push(next);
          break;
        case "JMP_REG":
          ins.indirect = true;
          break;
        case "TRY_CATCH":
          work.push(value(desc.target, ops).v);
          work.push(next);
          break;
        case "TRY_FINALLY":
          work.push(value(desc.target, ops).v);
          work.push(next);
          break;
        case "MAKE_FN": {
          const s = desc.spec;
          const g = addFunc(ops[s[entryProp]], ops[s[P.params]], ops[s[P.regs]], !!ops[s[P.rest]]);
          if (g.parent === undefined) {
            g.parent = f;
            g.upvals = [];
            for (let j = desc.fixed; j + 1 < ops.length; j += 2)
              g.upvals.push({ local: !!ops[j], index: ops[j + 1] });
          }
          work.push(next);
          break;
        }
        default:
          work.push(next);
      }
    }
    f.order = [...f.instrs.keys()].sort((a, b) => a - b);
  };

  // Alternate between plain reachability and constant-propagation, because the
  // flattened dispatcher only reveals its successors once its inputs are known.
  for (let round = 0; round < 64; round++) {
    while (pending.length) {
      const f = pending.shift();
      walk(f, [f.entry]);
    }
    let grew = false;
    for (const f of [...funcs.values()]) {
      const indirect = f.order.filter((pc) => f.instrs.get(pc).desc.kind === "JMP_REG");
      if (!indirect.length) continue;
      if (f.trace && f.trace.instrCount === f.instrs.size) continue; // nothing new to see
      const resolved = resolveIndirect(vm, funcs, descs, vm.pool.map(poolValue), f);
      for (const [pc, targets] of resolved) {
        const ins = f.instrs.get(pc);
        const before = ins.targets ? ins.targets.length : -1;
        ins.targets = [...targets].sort((a, b) => a - b);
        if (ins.targets.length !== before) grew = true;
        walk(f, ins.targets);
      }
    }
    if (!grew && !pending.length) break;
  }

  return funcs;
}

/* ------------------------------------------------------------------ *
 * 7.  Per-instruction fitting of the MBA arithmetic
 *
 *  Some handlers carry an *opaque predicate* immediate that selects between two
 *  branches, so the operand values from the real instruction have to be kept â€”
 *  only the register inputs get randomised.
 * ------------------------------------------------------------------ */

const fitCache = new Map();

function fitInstr(vm, desc, regCount, ops) {
  const key = desc.op + "|" + regCount + "|" + ops.join(",");
  if (fitCache.has(key)) return fitCache.get(key);
  const res = fitInstrUncached(vm, desc, regCount, ops);
  fitCache.set(key, res);
  return res;
}

function fitInstrUncached(vm, desc, regCount, ops) {
  const fn = vm.handlers.get(desc.op);
  const inputs = desc.inputs || [];
  if (!inputs.length || inputs.length > 6) return null;

  const dstSlot = desc.dst && desc.dst.slot;
  const dstReg = desc.dst ? (desc.dst.slot === undefined ? desc.dst.fixed : ops[desc.dst.slot]) : null;
  // resolve each input to a concrete register index / immediate value
  const resolved = inputs.map((inp) =>
    inp.k === "reg"
      ? { k: "reg", i: inp.slot === undefined ? inp.fixed : ops[inp.slot] }
      : { k: "imm", v: ops[inp.slot] }
  );

  const vectors = [];
  const results = [];
  resetRng();
  for (let trial = 0; trial < TRIALS; trial++) {
    const regVals = new Map();
    let slot = 0;
    const vec = resolved.map((r) => {
      if (r.k === "imm") return r.v;
      if (!regVals.has(r.i)) regVals.set(r.i, probeValue(trial + 7 * slot++));
      return regVals.get(r.i);
    });
    const st = runHandler(vm, fn, {
      operand: (n) => ops[n],
      regValue: (i) => (regVals.has(i) ? regVals.get(i) : 0),
      frameValue: (slot) => (slot === vm.regBaseSlot ? MAGIC + slot * STRIDE : vm.headerSize + regCount),
    });
    const w = flat(st.effects).find(
      (e) => e.t === "setreg" && (dstReg === null || e.i === dstReg)
    );
    if (!w || isM(w.v)) return null;
    vectors.push(vec);
    results.push(w.v);
  }

  const check = (f, pick) => {
    for (let i = 0; i < TRIALS; i++) {
      const got = f(...pick.map((p) => vectors[i][p]));
      const want = results[i];
      if (got !== want && !(Number.isNaN(got) && Number.isNaN(want))) return false;
    }
    return true;
  };
  const src = (i) => (resolved[i].k === "reg" ? { k: "reg", i: resolved[i].i } : { k: "imm", v: resolved[i].v });

  for (const [wrap, int32] of [[(f) => f, false], [(f) => (...a) => f(...a) | 0, true]]) {
    for (let i = 0; i < resolved.length; i++)
      for (let j = 0; j < resolved.length; j++) {
        if (i === j) continue;
        for (const [name, f] of BIN_FITS)
          if (check(wrap(f), [i, j]))
            return { operator: name, int32: int32 && typeof results[0] === "number", a: src(i), b: src(j), arity: 2 };
      }
    for (let i = 0; i < resolved.length; i++) {
      for (const [name, f] of UN_FITS)
        if (check(wrap(f), [i]))
          return { operator: name, int32: int32 && typeof results[0] === "number", a: src(i), arity: 1 };
      if (check(wrap((a) => a), [i]))
        return { operator: null, int32: int32 && typeof results[0] === "number", a: src(i), arity: 1 };
    }
    // three-input forms â€” the obfuscator emits fused ops such as `(a + k) - b`
    if (resolved.length >= 3) {
      for (let i = 0; i < resolved.length; i++)
        for (let j = 0; j < resolved.length; j++)
          for (let k2 = 0; k2 < resolved.length; k2++) {
            if (i === j || j === k2 || i === k2) continue;
            for (const [n1, f1] of ARITH_FITS)
              for (const [n2, f2] of ARITH_FITS) {
                if (check(wrap((a, b, c) => f2(f1(a, b), c)), [i, j, k2]))
                  return {
                    arity: 3, shape: "left", operator: n1, operator2: n2,
                    int32: int32 && typeof results[0] === "number",
                    a: src(i), b: src(j), c: src(k2),
                  };
                if (check(wrap((a, b, c) => f1(a, f2(b, c))), [i, j, k2]))
                  return {
                    arity: 3, shape: "right", operator: n1, operator2: n2,
                    int32: int32 && typeof results[0] === "number",
                    a: src(i), b: src(j), c: src(k2),
                  };
              }
          }
    }
  }
  // constant result?
  if (results.every((r) => r === results[0]))
    return { operator: null, constant: results[0], arity: 0 };
  return null;
}

/* ------------------------------------------------------------------ *
 * 8.  Constant propagation â€” undoes the control-flow flattening
 *
 *  fn#2 in the sample ends every block with `jmp *r34`, where r34 comes out of a
 *  hash function applied to a per-block constant.  Propagating constants through
 *  the recovered IR (and interpreting the pure hash function) turns those
 *  indirect jumps back into ordinary edges.
 * ------------------------------------------------------------------ */

const UNK = Symbol("unknown");
const CMP_OPS = new Set(["<", ">", "<=", ">=", "==", "!=", "===", "!==", "in", "instanceof"]);
const PURE_GLOBALS = { Math, String, Number, Boolean, JSON, isNaN, parseInt, parseFloat, Array, Object };

function makeEngine(vm, funcs, descs, pool) {
  const P = vm.specProps;
  const entryProp = P.entry;
  const self = { impure: 0 };

  const constOf = (v) => {
    const c = decodeConst(pool, v.index, v.key);
    return c.kind === "other" ? UNK : c.v;
  };

  const read = (R, v) => {
    if (!v) return UNK;
    if (v.k === "reg") return R.has(v.i) ? R.get(v.i) : UNK;
    if (v.k === "imm") return v.v;
    if (v.k === "const") return constOf(v);
    return UNK;
  };

  const applyBin = (op, a, b) => {
    switch (op) {
      case "+": return a + b; case "-": return a - b; case "*": return a * b;
      case "/": return a / b; case "%": return a % b; case "**": return a ** b;
      case "&": return a & b; case "|": return a | b; case "^": return a ^ b;
      case "<<": return a << b; case ">>": return a >> b; case ">>>": return a >>> b;
      case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b;
      case "==": return a == b; case "!=": return a != b;
      case "===": return a === b; case "!==": return a !== b;
      case "in": return a in b; case "instanceof": return a instanceof b;
      default: return UNK;
    }
  };
  const applyUn = (op, a) => {
    switch (op) {
      case "-": return -a; case "+": return +a; case "~": return ~a;
      case "!": return !a; case "typeof": return typeof a; case "void": return undefined;
      default: return UNK;
    }
  };

  /** run a VM function on constant arguments (used for the dispatcher's hash fn) */
  function callVMFunction(entry, args, depth) {
    if (depth > 4) return UNK;
    const f = funcs.get(entry);
    if (!f) return UNK;
    const R = new Map();
    for (let i = 0; i < f.regs; i++) R.set(i, undefined);
    for (let i = 0; i < f.params; i++) R.set(i, i < args.length ? args[i] : undefined);
    if (f.params < f.regs) R.set(f.params, args);
    let pc = f.entry;
    for (let steps = 0; steps < 20000; steps++) {
      const ins = f.instrs.get(pc);
      if (!ins) return UNK;
      const r = stepInstr(ins, R, depth + 1);
      if (r.kind === "return") return r.value;
      if (r.kind === "next") pc = r.pc;
      else return UNK;
    }
    return UNK;
  }

  /**
   * Execute one instruction against a constant map.
   * @returns {{kind:'next',pc}|{kind:'branch',pcs}|{kind:'return',value}|{kind:'stop'}}
   */
  function stepInstr(ins, R, depth = 0) {
    const d = ins.desc;
    const o = ins.ops;
    const next = ins.pc + ins.len;
    const set = (val) => {
      if (d.dst) R.set(regIdx(d.dst, o), val);
    };
    switch (d.kind) {
      case "LOAD_IMM": set(value(d.src, o).v); return { kind: "next", pc: next };
      case "LOAD_CONST": set(constOf(value(d.src, o))); return { kind: "next", pc: next };
      case "MOV": set(read(R, value(d.src, o))); return { kind: "next", pc: next };
      case "LOAD_THIS": set(UNK); return { kind: "next", pc: next };
      case "BIN": {
        const a = read(R, value(d.srcs[0], o));
        const b = read(R, value(d.srcs[1], o));
        if ((a === UNK || b === UNK) && CMP_OPS.has(d.operator) && d.dst)
          return { kind: "fork", pc: next, reg: regIdx(d.dst, o), values: [true, false] };
        set(a === UNK || b === UNK ? UNK : applyBin(d.operator, a, b));
        return { kind: "next", pc: next };
      }
      case "UN": {
        const a = read(R, value(d.srcs[0], o));
        if (a === UNK && d.operator === "!" && d.dst)
          return { kind: "fork", pc: next, reg: regIdx(d.dst, o), values: [true, false] };
        set(a === UNK ? UNK : applyUn(d.operator, a));
        return { kind: "next", pc: next };
      }
      case "ARITH": {
        const fit = fitInstr(vm, d, ins.fn.regs, o);
        if (!fit) { set(UNK); return { kind: "next", pc: next }; }
        if (fit.arity === 0) { set(fit.constant); return { kind: "next", pc: next }; }
        const a = read(R, fit.a);
        if (a === UNK) { set(UNK); return { kind: "next", pc: next }; }
        let v;
        if (fit.arity === 3) {
          const b = read(R, fit.b);
          const c = read(R, fit.c);
          if (b === UNK || c === UNK) { set(UNK); return { kind: "next", pc: next }; }
          v = fit.shape === "left"
            ? applyBin(fit.operator2, applyBin(fit.operator, a, b), c)
            : applyBin(fit.operator, a, applyBin(fit.operator2, b, c));
        } else if (fit.arity === 2) {
          const b = read(R, fit.b);
          if (b === UNK) { set(UNK); return { kind: "next", pc: next }; }
          v = applyBin(fit.operator, a, b);
        } else v = fit.operator ? applyUn(fit.operator, a) : a;
        set(fit.int32 && typeof v === "number" ? v | 0 : v);
        return { kind: "next", pc: next };
      }
      case "GET_GLOBAL":
      case "TYPEOF_GLOBAL": {
        const name = read(R, value(d.name, o));
        const has = typeof name === "string" && Object.prototype.hasOwnProperty.call(PURE_GLOBALS, name);
        if (d.kind === "TYPEOF_GLOBAL") set(has ? typeof PURE_GLOBALS[name] : UNK);
        else set(has ? PURE_GLOBALS[name] : UNK);
        return { kind: "next", pc: next };
      }
      case "GET_PROP": {
        const obj = read(R, value(d.obj, o));
        const key = read(R, value(d.key, o));
        if (obj === UNK || key === UNK || obj === null || obj === undefined) set(UNK);
        else {
          try {
            const v = obj[key];
            set(typeof v === "function" || typeof v === "object" || typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === undefined ? v : UNK);
          } catch (e) { set(UNK); }
        }
        return { kind: "next", pc: next };
      }
      case "ARRAY": {
        const els = [];
        let ok = true;
        for (let j = d.fixed; j < o.length; j++) {
          const v = R.has(o[j]) ? R.get(o[j]) : UNK;
          if (v === UNK) ok = false;
          els.push(v);
        }
        set(ok ? els : UNK);
        return { kind: "next", pc: next };
      }
      case "MAKE_FN": {
        set({ __vmfn: o[d.spec[entryProp]] });
        return { kind: "next", pc: next };
      }
      case "CALL":
      case "METHOD_CALL": {
        const callee = read(R, value(d.callee, o));
        const thisV = d.kind === "METHOD_CALL" ? read(R, value(d.thisArg, o)) : undefined;
        const count = o[d.countSlot];
        let args = [];
        let ok = true;
        if (d.spread != null && count === d.spread) ok = false;
        else
          for (let j = d.fixed; j < o.length; j++) {
            const v = R.has(o[j]) ? R.get(o[j]) : UNK;
            if (v === UNK) ok = false;
            args.push(v);
          }
        if (!ok || callee === UNK) { self.impure++; set(UNK); return { kind: "next", pc: next }; }
        if (callee && callee.__vmfn !== undefined) {
          set(callVMFunction(callee.__vmfn, args, depth));
          return { kind: "next", pc: next };
        }
        if (typeof callee === "function" && isPureNative(callee)) {
          try { set(callee.apply(thisV === UNK ? undefined : thisV, args)); }
          catch (e) { set(UNK); }
          return { kind: "next", pc: next };
        }
        self.impure++;
        set(UNK);
        return { kind: "next", pc: next };
      }
      case "JMP":
        return { kind: "next", pc: value(d.target, o).v };
      case "JMP_TRUE":
      case "JMP_FALSE": {
        const c = read(R, value(d.src, o));
        const tgt = value(d.target, o).v;
        if (c === UNK) return { kind: "branch", pcs: [tgt, next] };
        const take = d.kind === "JMP_TRUE" ? !!c : !c;
        return { kind: "next", pc: take ? tgt : next };
      }
      case "JMP_REG": {
        const v = R.has(regIdx(d.target, o)) ? R.get(regIdx(d.target, o)) : UNK;
        if (v === UNK || typeof v !== "number") return { kind: "stop" };
        return { kind: "next", pc: v, indirect: v };
      }
      case "RET":
        return { kind: "return", value: read(R, value(d.src, o)) };
      case "THROW":
      case "DEBUGGER":
        return { kind: "stop" };
      default:
        // anything with side effects or an unknown result kills the destination
        self.impure++;
        if (d.dst) R.set(regIdx(d.dst, o), UNK);
        if (d.kind === "FORIN_NEXT") return { kind: "branch", pcs: [value(d.target, o).v, next] };
        // installing an exception handler is not a branch: control falls
        // through, and the handler is a separate entry point
        if (d.kind === "TRY_CATCH" || d.kind === "TRY_FINALLY")
          return { kind: "try", pc: next, handler: value(d.target, o).v };
        return { kind: "next", pc: next };
    }
  }

  self.stepInstr = stepInstr;
  self.callVMFunction = callVMFunction;
  self.read = read;
  self.constOf = constOf;
  return self;
}

const PURE_NATIVES = new Set();
for (const k of Object.getOwnPropertyNames(Math)) if (typeof Math[k] === "function") PURE_NATIVES.add(Math[k]);
for (const k of ["fromCharCode", "fromCodePoint", "raw"]) if (String[k]) PURE_NATIVES.add(String[k]);
for (const k of Object.getOwnPropertyNames(String.prototype)) {
  try { if (typeof String.prototype[k] === "function") PURE_NATIVES.add(String.prototype[k]); } catch (e) {}
}
const isPureNative = (f) => PURE_NATIVES.has(f);

const keyOfState = (pc, R) => {
  let s = pc + "|";
  for (const [k, v] of R) {
    if (v === UNK) continue;
    s += k + "=" + (typeof v === "object" && v !== null ? (v.__vmfn !== undefined ? "fn" + v.__vmfn : "o") : String(v)) + ";";
  }
  return s;
};

/**
 * Path-sensitive constant propagation over one function.  Builds a *trace CFG*
 * whose nodes are (pc, constant-state) pairs â€” that graph is already the
 * de-flattened program: the dispatcher's indirect jump becomes an ordinary edge
 * and the state bookkeeping becomes dead code.
 *
 * `volatileRegs` are registers whose value is deliberately forgotten: a loop
 * counter propagated as a constant would unroll the loop forever, so a register
 * that takes too many distinct values gets abstracted away and the exploration
 * retried.  Dispatcher state registers never take that many values.
 */
function explorePaths(vm, funcs, descs, pool, f, volatileRegs, budget) {
  const eng = makeEngine(vm, funcs, descs, pool);
  const seen = new Set();
  const start = new Map();
  for (let i = 0; i < f.regs; i++) start.set(i, undefined);
  for (let i = 0; i < f.params; i++) start.set(i, UNK);
  if (f.params < f.regs) start.set(f.params, UNK);

  const scrub = (R) => {
    for (const r of volatileRegs) if (R.has(r)) R.set(r, UNK);
    return R;
  };
  const counts = new Map();
  const note = (R) => {
    for (const [k, v] of R) {
      if (v === UNK) continue;
      if (!counts.has(k)) counts.set(k, new Set());
      const s = counts.get(k);
      if (s.size < 4096) s.add(typeof v === "object" && v !== null ? "o" : String(v));
    }
  };

  const resolved = new Map();
  const nodes = new Map();
  const nodeFor = (pc, key) => {
    if (!nodes.has(key)) nodes.set(key, { pc, key, succs: [], cond: null, kind: null });
    return nodes.get(key);
  };

  scrub(start);
  const entryKey = keyOfState(f.entry, start);
  const work = [{ pc: f.entry, R: start, from: null }];
  let steps = 0;
  let exhausted = false;

  while (work.length) {
    if (++steps > budget) { exhausted = true; break; }
    const { pc, R, from } = work.pop();
    const key = keyOfState(pc, R);
    if (from) from.node.succs[from.i] = key;
    if (seen.has(key)) continue;
    seen.add(key);
    const ins = f.instrs.get(pc);
    if (!ins) continue;
    const node = nodeFor(pc, key);
    note(R);
    const impureBefore = eng.impure;
    const r = eng.stepInstr(ins, R);
    // remember a provably-constant result so the lifter can fold it away
    // (never for a fork/branch node â€” its destination *is* the condition)
    node.pure = eng.impure === impureBefore;
    if (ins.desc.dst && node.pure && r.kind !== "fork" && r.kind !== "branch") {
      const v = R.get(regIdx(ins.desc.dst, ins.ops));
      if (v !== UNK && (v === null || typeof v !== "object") && typeof v !== "function")
        node.fold = v;
    }
    scrub(R);
    if (r.kind === "return" || r.kind === "stop") { node.kind = "end"; continue; }
    if (r.kind === "branch") {
      node.kind = "branch";
      node.cond =
        ins.desc.kind === "JMP_TRUE" || ins.desc.kind === "JMP_FALSE"
          ? { reg: regIdx(ins.desc.src, ins.ops), negate: ins.desc.kind === "JMP_FALSE" }
          : null;
      r.pcs.forEach((p, i) => work.push({ pc: p, R: scrub(new Map(R)), from: { node, i } }));
      continue;
    }
    if (r.kind === "try") {
      // succs[0] = protected region, succs[1] = the handler
      node.kind = "try";
      work.push({ pc: r.pc, R, from: { node, i: 0 } });
      work.push({ pc: r.handler, R: scrub(new Map(R)), from: { node, i: 1 } });
      continue;
    }
    if (r.kind === "fork") {
      // an opaque comparison over runtime data â€” follow both outcomes
      node.kind = "fork";
      node.cond = { reg: r.reg, negate: false };
      r.values.forEach((v, i) => {
        const R2 = scrub(new Map(R));
        R2.set(r.reg, v);
        work.push({ pc: r.pc, R: R2, from: { node, i } });
      });
      continue;
    }
    node.kind = "next";
    if (ins.desc.kind === "JMP_REG") {
      if (!resolved.has(pc)) resolved.set(pc, new Set());
      resolved.get(pc).add(r.pc);
    }
    work.push({ pc: r.pc, R, from: { node, i: 0 } });
  }
  return { resolved, nodes, counts, exhausted, entryKey };
}

/** run explorePaths, widening until it terminates inside the budget */
function resolveIndirect(vm, funcs, descs, pool, f, out) {
  // reuse whatever widening a previous round already discovered
  const volatileRegs = new Set(f.volatileRegs || []);
  let res = null;
  for (let attempt = 0; attempt < 32; attempt++) {
    res = explorePaths(vm, funcs, descs, pool, f, volatileRegs, 300000);
    if (!res.exhausted) break;
    let worst = null;
    for (const [reg, set] of res.counts)
      if (!volatileRegs.has(reg) && set.size > 8 && (worst === null || set.size > res.counts.get(worst).size))
        worst = reg;
    if (worst === null) break;
    volatileRegs.add(worst);
  }
  f.volatileRegs = volatileRegs;
  f.trace = { nodes: res.nodes, entryKey: res.entryKey, instrCount: f.instrs.size };
  if (out) {
    out.nodes = res.nodes;
    out.entryKey = res.entryKey;
    out.volatileRegs = volatileRegs;
    out.exhausted = res.exhausted;
  }
  return res.resolved;
}

/* ------------------------------------------------------------------ *
 * 9.  Lifting the recovered CFG back to JavaScript
 * ------------------------------------------------------------------ */

const PURE_KINDS = new Set([
  "LOAD_IMM", "LOAD_CONST", "MOV", "BIN", "UN", "ARITH", "LOAD_THIS",
  "ARRAY", "OBJECT", "GET_UPVAL", "TYPEOF_GLOBAL", "MAKE_FN",
]);

const lit = (v) => {
  if (v === null) return t.nullLiteral();
  if (v === undefined) return t.identifier("undefined");
  if (typeof v === "string") return t.stringLiteral(v);
  if (typeof v === "boolean") return t.booleanLiteral(v);
  if (typeof v === "number")
    return v < 0 || Object.is(v, -0)
      ? t.unaryExpression("-", t.numericLiteral(Math.abs(v)))
      : Number.isNaN(v)
        ? t.binaryExpression("/", t.numericLiteral(0), t.numericLiteral(0))
        : t.numericLiteral(v);
  return t.identifier("undefined");
};

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const member = (obj, key) =>
  key.type === "StringLiteral" && IDENT_RE.test(key.value) && !RESERVED.has(key.value)
    ? t.memberExpression(obj, t.identifier(key.value), false)
    : t.memberExpression(obj, key, true);
const RESERVED = new Set([
  "break","case","catch","class","const","continue","debugger","default","delete","do","else","export",
  "extends","finally","for","function","if","import","in","instanceof","new","return","super","switch",
  "this","throw","try","typeof","var","void","while","with","yield","let","static","enum","await","implements",
  "package","protected","interface","private","public","null","true","false",
]);

function buildProgram(vm, funcs, descs, pool, opts = {}) {
  const warnings = [];

  /* --- naming --- */
  for (const f of funcs.values()) if (!f.capturedRegs) f.capturedRegs = new Set();
  for (const f of funcs.values())
    for (const u of f.upvals || []) if (u.local && f.parent) f.parent.capturedRegs.add(u.index);

  const regName = (f, i) => {
    if (f.capturedRegs.has(i)) return `c${f.id}_${i}`;
    if (i < f.params) return `a${i}`;
    if (i === f.params && f.params < f.regs) return `args${f.id}`;
    return `r${i}`;
  };
  const upvalName = (f, j) => {
    let cur = f;
    let k = j;
    for (let depth = 0; depth < 32; depth++) {
      const u = (cur.upvals || [])[k];
      if (!u || !cur.parent) break;
      if (u.local) return regName(cur.parent, u.index);
      cur = cur.parent;
      k = u.index;
    }
    warnings.push(`unresolved upvalue ${j} in function @${f.entry}`);
    return `__upval${j}`;
  };

  const constVal = (v) => {
    const c = decodeConst(pool, v.index, v.key);
    return c.kind === "other" ? undefined : c.v;
  };

  /* ---- one instruction -> IR statement ---- */
  function liftInstr(f, ins, node) {
    const d = ins.desc;
    const o = ins.ops;
    const R = (i) => t.identifier(regName(f, i));
    const rd = () => (d.dst ? regIdx(d.dst, o) : null);
    const src = (role) => {
      const v = value(role, o);
      if (!v) return { node: t.identifier("undefined"), uses: [] };
      if (v.k === "reg") return { node: R(v.i), uses: [v.i] };
      if (v.k === "imm") return { node: lit(v.v), uses: [] };
      if (v.k === "const") return { node: lit(constVal(v)), uses: [] };
      if (v.k === "this") return { node: t.thisExpression(), uses: [] };
      return { node: t.identifier("undefined"), uses: [] };
    };
    const varArgs = () => {
      const out = [];
      for (let j = d.fixed; j < o.length; j++) out.push(o[j]);
      return out;
    };
    const assign = (dst, expr, uses, pure) => ({
      dst, uses, pure, expr,
      node: t.expressionStatement(t.assignmentExpression("=", R(dst), expr)),
    });
    const effect = (expr, uses) => ({
      dst: null, uses, pure: false,
      node: t.expressionStatement(expr),
    });

    switch (d.kind) {
      case "LOAD_IMM":
      case "LOAD_CONST": {
        const s = src(d.src);
        return assign(rd(), s.node, [], true);
      }
      case "MOV": {
        const s = src(d.src);
        return assign(rd(), s.node, s.uses, true);
      }
      case "LOAD_THIS":
        return assign(rd(), t.thisExpression(), [], true);
      case "BIN": {
        const a = src(d.srcs[0]);
        const b = src(d.srcs[1]);
        const e = ["==", "!=", "===", "!==", "<", ">", "<=", ">=", "instanceof", "in"].includes(d.operator)
          ? t.binaryExpression(d.operator, a.node, b.node)
          : t.binaryExpression(d.operator, a.node, b.node);
        return assign(rd(), e, [...a.uses, ...b.uses], true);
      }
      case "UN": {
        const a = src(d.srcs[0]);
        return assign(rd(), t.unaryExpression(d.operator, a.node, true), a.uses, true);
      }
      case "ARITH": {
        const fit = fitInstr(vm, d, f.regs, o);
        if (!fit) {
          warnings.push(`could not recover arithmetic for opcode ${ins.op} at pc ${ins.pc}`);
          return assign(rd(), t.identifier("undefined"), [], true);
        }
        const mk1 = (v) => (v.k === "reg" ? { node: R(v.i), uses: [v.i] } : { node: lit(v.v), uses: [] });
        let expr, uses;
        if (fit.arity === 0) { expr = lit(fit.constant); uses = []; }
        else if (fit.arity === 1) {
          const a = mk1(fit.a);
          expr = fit.operator ? t.unaryExpression(fit.operator, a.node, true) : a.node;
          uses = a.uses;
        } else if (fit.arity === 2) {
          const a = mk1(fit.a), b = mk1(fit.b);
          expr = t.binaryExpression(fit.operator, a.node, b.node);
          uses = [...a.uses, ...b.uses];
        } else {
          const a = mk1(fit.a), b = mk1(fit.b), c = mk1(fit.c);
          expr = fit.shape === "left"
            ? t.binaryExpression(fit.operator2, t.binaryExpression(fit.operator, a.node, b.node), c.node)
            : t.binaryExpression(fit.operator, a.node, t.binaryExpression(fit.operator2, b.node, c.node));
          uses = [...a.uses, ...b.uses, ...c.uses];
        }
        if (fit.int32) expr = t.binaryExpression("|", expr, t.numericLiteral(0));
        return assign(rd(), expr, uses, true);
      }
      case "GET_GLOBAL": {
        const name = constVal(value(d.name, o));
        // a plain global read can throw ReferenceError, so it is not pure â€”
        // except for the three names that are literally values
        const harmless = name === "undefined" || name === "NaN" || name === "Infinity";
        return assign(rd(), t.identifier(String(name)), [], harmless);
      }
      case "TYPEOF_GLOBAL": {
        const name = constVal(value(d.name, o));
        return assign(rd(), t.unaryExpression("typeof", t.identifier(String(name)), true), [], true);
      }
      case "SET_GLOBAL": {
        const name = constVal(value(d.name, o));
        const v = src(d.value);
        return effect(t.assignmentExpression("=", t.identifier(String(name)), v.node), v.uses);
      }
      case "GET_PROP": {
        const ob = src(d.obj), k = src(d.key);
        return assign(rd(), member(ob.node, k.node), [...ob.uses, ...k.uses], false);
      }
      case "SET_PROP": {
        const ob = src(d.obj), k = src(d.key), v = src(d.value);
        return effect(
          t.assignmentExpression("=", member(ob.node, k.node), v.node),
          [...ob.uses, ...k.uses, ...v.uses]
        );
      }
      case "DEL_PROP": {
        const ob = src(d.obj), k = src(d.key);
        return {
          dst: rd(), uses: [...ob.uses, ...k.uses], pure: false,
          expr: t.unaryExpression("delete", member(ob.node, k.node), true),
          node: t.expressionStatement(
            t.assignmentExpression("=", R(rd()), t.unaryExpression("delete", member(ob.node, k.node), true))
          ),
        };
      }
      case "ARRAY": {
        const regs = varArgs();
        return assign(rd(), t.arrayExpression(regs.map((x) => R(x))), regs, true);
      }
      case "OBJECT": {
        const regs = varArgs();
        const props = [];
        for (let i = 0; i + 1 < regs.length; i += 2)
          props.push(t.objectProperty(R(regs[i]), R(regs[i + 1]), true));
        return assign(rd(), t.objectExpression(props), regs, true);
      }
      case "CALL":
      case "METHOD_CALL":
      case "NEW": {
        const callee = src(d.callee);
        const count = o[d.countSlot];
        let args, uses = [...callee.uses];
        if (d.spread != null && count === d.spread) {
          args = [t.spreadElement(R(o[d.fixed]))];
          uses.push(o[d.fixed]);
        } else {
          const regs = varArgs();
          args = regs.map((x) => R(x));
          uses.push(...regs);
        }
        let expr;
        if (d.kind === "NEW") expr = t.newExpression(callee.node, args);
        else if (d.kind === "CALL") expr = t.callExpression(callee.node, args);
        else {
          const th = src(d.thisArg);
          uses.push(...th.uses);
          expr = t.callExpression(t.memberExpression(callee.node, t.identifier("call")), [th.node, ...args]);
        }
        return {
          dst: rd(), uses, pure: !!(node && node.pure), expr,
          node: t.expressionStatement(t.assignmentExpression("=", R(rd()), expr)),
        };
      }
      case "MAKE_FN": {
        const entry = o[d.spec[vm.specProps.entry]];
        const fnExpr = emitFunction(funcs.get(entry));
        return {
          dst: rd(), uses: [], pure: true, makeFn: entry, expr: fnExpr,
          node: t.expressionStatement(t.assignmentExpression("=", R(rd()), fnExpr)),
        };
      }
      case "GET_UPVAL":
        return assign(rd(), t.identifier(upvalName(f, d.index.slot === undefined ? d.index.fixed : o[d.index.slot])), [], true);
      case "SET_UPVAL": {
        const v = src(d.value);
        const nm = upvalName(f, d.index.slot === undefined ? d.index.fixed : o[d.index.slot]);
        return effect(t.assignmentExpression("=", t.identifier(nm), v.node), v.uses);
      }
      case "DEF_GETTER":
      case "DEF_SETTER": {
        const ob = src(d.obj), k = src(d.key), v = src(d.value);
        return effect(
          t.callExpression(t.memberExpression(t.identifier("Object"), t.identifier("defineProperty")), [
            ob.node, k.node,
            t.objectExpression([
              t.objectProperty(t.identifier(d.kind === "DEF_GETTER" ? "get" : "set"), v.node),
              t.objectProperty(t.identifier("configurable"), t.booleanLiteral(true)),
              t.objectProperty(t.identifier("enumerable"), t.booleanLiteral(true)),
            ]),
          ]),
          [...ob.uses, ...k.uses, ...v.uses]
        );
      }
      case "FORIN_INIT": {
        const s = src(d.src);
        return assign(
          rd(),
          t.objectExpression([
            t.objectProperty(t.identifier("keys"),
              t.callExpression(t.memberExpression(t.identifier("Object"), t.identifier("keys")), [s.node])),
            t.objectProperty(t.identifier("i"), t.numericLiteral(0)),
          ]),
          s.uses, true
        );
      }
      case "FORIN_NEXT": {
        const s = src(d.src);
        const e = t.memberExpression(
          t.memberExpression(s.node, t.identifier("keys"), false),
          t.updateExpression("++", t.memberExpression(s.node, t.identifier("i"), false), false),
          true
        );
        return {
          dst: rd(), uses: s.uses, pure: false, expr: e,
          node: t.expressionStatement(t.assignmentExpression("=", R(rd()), e)),
        };
      }
      case "THROW": {
        const s = src(d.src);
        return { dst: null, uses: s.uses, pure: false, terminator: true, node: t.throwStatement(s.node) };
      }
      case "RET": {
        const s = src(d.src);
        return { dst: null, uses: s.uses, pure: false, terminator: true, node: t.returnStatement(s.node) };
      }
      case "DEBUGGER":
        return { dst: null, uses: [], pure: false, node: t.debuggerStatement() };
      case "JMP":
      case "JMP_TRUE":
      case "JMP_FALSE":
      case "JMP_REG":
        return { dst: null, uses: d.src ? [regIdx(d.src, o)] : [], pure: true, nop: true, node: null };
      case "TRY_POP":
        return { dst: null, uses: [], pure: true, nop: true, node: null, tryPop: true };
      case "TRY_CATCH":
        return {
          dst: null, uses: [], pure: true, nop: true, node: null,
          tryInfo: { excReg: value(d.reg, o).v, extra: [] },
        };
      case "TRY_FINALLY":
        return {
          dst: null, uses: [], pure: true, nop: true, node: null,
          tryInfo: {
            excReg: value(d.excReg, o).v,
            extra: [[value(d.flagReg, o).v, value(d.flagVal, o).v]],
          },
        };
      case "DECRYPT":
        warnings.push(`self-decrypting bytecode at pc ${ins.pc} was not emulated`);
        return { dst: null, uses: [], pure: true, nop: true, node: null };
      default:
        warnings.push(`unhandled opcode kind ${d.kind} at pc ${ins.pc}`);
        return { dst: null, uses: [], pure: true, nop: true, node: null };
    }
  }

  /* ---- per-function code generation ---- */
  const emitted = new Map();

  function emitFunction(f) {
    if (emitted.has(f)) return emitted.get(f);
    let body;
    try {
      body = generateBody(f);
    } catch (e) {
      // one broken function must not sink the whole file
      warnings.push(`function @${f.entry} could not be lifted: ${e.message}`);
      body = [
        t.throwStatement(
          t.newExpression(t.identifier("Error"), [t.stringLiteral(`vm.js: function @${f.entry} not recovered`)])
        ),
      ];
    }
    const params = [];
    for (let i = 0; i < f.params; i++) params.push(t.identifier(regName(f, i)));
    if (f.rest && params.length) params[params.length - 1] = t.restElement(params[params.length - 1]);
    const fn = t.functionExpression(null, params, t.blockStatement(body));
    emitted.set(f, fn);
    return fn;
  }

  function generateBody(f) {
    /* 1. trace the function, folding constants */
    const hasIndirect = f.order.some((pc) => f.instrs.get(pc).desc.kind === "JMP_REG");
    const out = {};
    if (hasIndirect) {
      // the disassembler already traced this function; reuse it if nothing moved
      if (f.trace && f.trace.instrCount === f.instrs.size) {
        out.nodes = f.trace.nodes;
        out.entryKey = f.trace.entryKey;
      } else resolveIndirect(vm, funcs, descs, pool, f, out);
    } else {
      const allVolatile = new Set();
      for (let i = 0; i < f.regs; i++) allVolatile.add(i);
      const r = explorePaths(vm, funcs, descs, pool, f, allVolatile, 300000);
      out.nodes = r.nodes;
      out.entryKey = r.entryKey;
    }
    const nodes = out.nodes;

    /* 2. lift each node */
    for (const n of nodes.values()) {
      const ins = f.instrs.get(n.pc);
      n.ir = ins ? liftInstr(f, ins, n) : { dst: null, uses: [], pure: true, nop: true, node: null };
      n.ins = ins;
    }

    /* 3. constant folding of instructions whose result the engine proved constant */
    for (const n of nodes.values()) {
      if (!n.ins || n.fold === undefined || !n.pure) continue;
      const kind = n.ins.desc.kind;
      if (kind === "MAKE_FN" || kind === "GET_GLOBAL") continue;
      if (!PURE_KINDS.has(kind) && !["CALL", "METHOD_CALL", "GET_PROP", "NEW"].includes(kind)) continue;
      const dst = n.ir.dst;
      if (dst === null || dst === undefined) continue;
      const e = lit(n.fold);
      n.ir = {
        dst, uses: [], pure: true, expr: e,
        node: t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(f, dst)), e)),
      };
    }
    // calls the engine proved side-effect-free may still be dropped by DCE
    for (const n of nodes.values())
      if (n.pure && n.ins && ["CALL", "METHOD_CALL", "GET_PROP"].includes(n.ins.desc.kind)) n.ir.pure = true;

    /* 4. splice out no-ops, dead-store elimination, then merge cloned nodes */
    const graph = buildGraph(nodes, out.entryKey);
    deadStoreElim(graph, f);
    minimise(graph);
    const liveOut = deadStoreElim(graph, f);
    const blocks = collapse(graph);

    if (process.env.VMDEBUG) dumpBlocks(f, blocks, "before-subst");
    /* 4b. forward-substitute single-use temporaries (liveness-driven) */
    substituteTemporaries(blocks, liveOut, f);
    if (process.env.VMDEBUG) dumpBlocks(f, blocks, "after-subst");

    /* 5. structure */
    const stmts = structure(blocks, graph.entry, f);

    /* 6. declarations */
    const used = new Set();
    for (const b of blocks.values())
      for (const n of b.nodes) {
        if (n.ir.dst !== null && n.ir.dst !== undefined) used.add(n.ir.dst);
        for (const u of n.ir.uses) used.add(u);
        if (n.cond) used.add(n.cond.reg);
      }
    const decls = [];
    const argReg = f.params < f.regs ? f.params : -1;
    for (const i of [...used].sort((a, b) => a - b)) {
      if (i < f.params) continue;
      if (i === argReg && liveAtEntry(blocks, graph.entry, i))
        decls.push(t.variableDeclarator(t.identifier(regName(f, i)), t.identifier("arguments")));
      else decls.push(t.variableDeclarator(t.identifier(regName(f, i))));
    }
    return decls.length ? [t.variableDeclaration("var", decls), ...stmts] : stmts;
  }

  return { emitFunction, generateBody, warnings, regName };

  /* ================= helpers used above ================= */

  function buildGraph(nodes, entryKey) {
    // drop nodes that produce nothing, rewiring their single successor
    const alive = new Map();
    for (const [k, n] of nodes) alive.set(k, n);
    const resolveSucc = (k, guard = new Set()) => {
      while (k != null && alive.has(k)) {
        const n = alive.get(k);
        const dead =
          n.ir.nop && n.kind === "next" && n.succs.length === 1 && n.succs[0] != null &&
          !n.ir.tryInfo && !n.ir.tryPop;
        if (!dead || guard.has(k)) break;
        guard.add(k);
        k = n.succs[0];
      }
      return k;
    };
    let entry = resolveSucc(entryKey);
    for (const n of alive.values()) n.succs = n.succs.map((s) => resolveSucc(s));
    // prune unreachable
    const keep = new Set();
    const stack = [entry];
    while (stack.length) {
      const k = stack.pop();
      if (k == null || keep.has(k) || !alive.has(k)) continue;
      keep.add(k);
      for (const s of alive.get(k).succs) stack.push(s);
    }
    for (const k of [...alive.keys()]) if (!keep.has(k)) alive.delete(k);
    return { nodes: alive, entry };
  }

  /** classic backward liveness; removes stores whose value is never read */
  function deadStoreElim(graph, f) {
    for (let pass = 0; pass < 8; pass++) {
      const liveOut = new Map();
      for (const k of graph.nodes.keys()) liveOut.set(k, new Set());
      let changed = true;
      let rounds = 0;
      while (changed && rounds++ < 400) {
        changed = false;
        for (const [k, n] of graph.nodes) {
          const out = new Set();
          for (const s of n.succs) {
            if (s == null || !graph.nodes.has(s)) continue;
            const sn = graph.nodes.get(s);
            const sIn = new Set(liveOut.get(s));
            if (sn.ir.dst !== null && sn.ir.dst !== undefined) sIn.delete(sn.ir.dst);
            for (const u of sn.ir.uses) sIn.add(u);
            // a node whose own instruction computes its branch test does not
            // make that register live on entry
            if (sn.cond && sn.cond.reg !== sn.ir.dst) sIn.add(sn.cond.reg);
            for (const x of sIn) out.add(x);
          }
          const prev = liveOut.get(k);
          if (out.size !== prev.size || [...out].some((x) => !prev.has(x))) {
            liveOut.set(k, out);
            changed = true;
          }
        }
      }
      let removed = 0;
      for (const [k, n] of graph.nodes) {
        if (n.ir.nop) continue;
        if (n.ir.dst === null || n.ir.dst === undefined) continue;
        if (f.capturedRegs.has(n.ir.dst)) continue;
        if (n.cond && n.cond.reg === n.ir.dst) continue; // it is this node's own branch test
        if (liveOut.get(k).has(n.ir.dst)) continue;
        if (n.ir.pure) {
          n.ir = { dst: null, uses: [], pure: true, nop: true, node: null };
          removed++;
        } else if (n.ir.expr && t.isExpressionStatement(n.ir.node)) {
          // the result is unused but the call still has to happen
          n.ir = { dst: null, uses: n.ir.uses, pure: false, expr: n.ir.expr, node: t.expressionStatement(n.ir.expr) };
          removed++;
        }
      }
      if (!removed) { graph.liveOut = liveOut; return liveOut; }
      const g2 = buildGraph(graph.nodes, graph.entry);
      graph.nodes = g2.nodes;
      graph.entry = g2.entry;
      graph.liveOut = liveOut;
    }
    return graph.liveOut || new Map();
  }

  /**
   * Fold a register that is written once and read once (and dead afterwards)
   * into its single use.  This is what turns
   *   r11 = document; r12 = "createElement"; r13 = r11[r12]; â€¦
   * back into `document.createElement(â€¦)`.
   */
  function substituteTemporaries(blocks, liveOut, f) {
    const usesOf = (n) => {
      const list = [...n.ir.uses];
      if (n.cond) list.push(n.cond.reg);
      return list;
    };
    for (const b of blocks.values()) {
      for (let pass = 0; pass < 6; pass++) {
        let changed = false;
        for (let i = 0; i < b.nodes.length; i++) {
          const def = b.nodes[i];
          if (!def.ir || def.ir.dst === null || def.ir.dst === undefined) continue;
          if (!def.ir.expr || !def.ir.node) continue;
          if (f.capturedRegs.has(def.ir.dst)) continue;
          const reg = def.ir.dst;

          // locate the single consumer inside this block
          let j = -1;
          let total = 0;
          for (let k = i + 1; k < b.nodes.length; k++) {
            const c = usesOf(b.nodes[k]).filter((x) => x === reg).length;
            if (c) { if (j < 0) j = k; total += c; }
            if (b.nodes[k].ir.dst === reg) break;
          }
          if (j < 0 || total !== 1) continue;
          if (liveOut.has(b.nodes[j].key) && liveOut.get(b.nodes[j].key).has(reg)) continue;
          if (b.nodes[j].cond && b.nodes[j].cond.reg === reg) continue; // keep branch conditions readable

          // nothing in between may disturb the value we are moving
          const deps = new Set(def.ir.uses);
          let ok = true;
          for (let k = i + 1; k < j; k++) {
            const mid = b.nodes[k];
            if (mid.ir.dst !== null && mid.ir.dst !== undefined && deps.has(mid.ir.dst)) { ok = false; break; }
            if (!def.ir.pure && !mid.ir.pure) { ok = false; break; }
            if (!mid.ir.pure && deps.size && !def.ir.pure) { ok = false; break; }
            if (!mid.ir.pure && !def.ir.pure) { ok = false; break; }
          }
          if (!ok) continue;
          // an impure definition may only move across pure statements
          if (!def.ir.pure)
            for (let k = i + 1; k < j; k++) if (!b.nodes[k].ir.pure) { ok = false; break; }
          if (!ok) continue;

          const name = regName(f, reg);
          const consumer = b.nodes[j];
          if (replaceIdentifier(consumer.ir.node, name, def.ir.expr)) {
            consumer.ir.uses = consumer.ir.uses.filter((x) => x !== reg).concat(def.ir.uses);
            if (!def.ir.pure) consumer.ir.pure = false;
            // `expr` may have *been* the identifier we just replaced â€” re-anchor it
            if (t.isExpressionStatement(consumer.ir.node) && t.isAssignmentExpression(consumer.ir.node.expression))
              consumer.ir.expr = consumer.ir.node.expression.right;
            // `obj[k].call(obj, â€¦)` -> `obj[k](â€¦)`, which frees up another temp
            for (const dropped of unwrapDotCall(consumer.ir.node)) {
              const idx = consumer.ir.uses.indexOf(dropped);
              if (idx >= 0) consumer.ir.uses.splice(idx, 1);
            }
            if (t.isExpressionStatement(consumer.ir.node) && t.isAssignmentExpression(consumer.ir.node.expression))
              consumer.ir.expr = consumer.ir.node.expression.right;
            b.nodes.splice(i, 1);
            i--;
            changed = true;
          }
        }
        if (!changed) break;
      }
    }
  }

  /**
   * Rewrite `X[k].call(X, â€¦)` to `X[k](â€¦)` everywhere inside `root`.
   * Returns the register numbers whose duplicated reference disappeared, so the
   * caller can keep its `uses` list honest.
   */
  function unwrapDotCall(root) {
    const dropped = [];
    const regOf = (node) => {
      if (!t.isIdentifier(node)) return null;
      const m = /^r(\d+)$/.exec(node.name) || /^a(\d+)$/.exec(node.name);
      return m ? Number(m[1]) : null;
    };
    const rec = (n) => {
      if (!n || typeof n !== "object") return n;
      if (Array.isArray(n)) return n.map(rec);
      if (!n.type) return n;
      for (const k in n) {
        if (["loc", "start", "end", "type", "leadingComments", "trailingComments", "innerComments", "extra"].includes(k))
          continue;
        n[k] = rec(n[k]);
      }
      if (
        t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
        t.isIdentifier(n.callee.property, { name: "call" }) && t.isMemberExpression(n.callee.object) &&
        n.arguments.length
      ) {
        const base = n.callee.object.object;
        const thisArg = n.arguments[0];
        const sameIdent = t.isIdentifier(base) && t.isIdentifier(thisArg) && base.name === thisArg.name;
        const sameThis = t.isThisExpression(base) && t.isThisExpression(thisArg);
        if (sameIdent || sameThis) {
          if (sameIdent) {
            const r = regOf(thisArg);
            if (r !== null) dropped.push(r);
          }
          return t.callExpression(n.callee.object, n.arguments.slice(1));
        }
      }
      return n;
    };
    if (t.isExpressionStatement(root)) root.expression = rec(root.expression);
    else if (t.isReturnStatement(root) && root.argument) root.argument = rec(root.argument);
    else if (t.isThrowStatement(root)) root.argument = rec(root.argument);
    return dropped;
  }

  function dumpBlocks(f, blocks, tag) {
    const lines = [`===== fn@${f.entry} ${tag} =====`];
    for (const b of blocks.values()) {
      lines.push(` block ${b.key.slice(0, 40)}  -> ${b.succs.map((s) => s.slice(0, 20)).join(" | ")}`);
      for (const n of b.nodes)
        lines.push(
          `   ${String(n.pc).padStart(5)} ${n.ir.node ? generate(n.ir.node).code.replace(/\n/g, " ").slice(0, 140) : "(nop)"}` +
            `   [dst=${n.ir.dst} uses=${n.ir.uses} pure=${n.ir.pure}]`
        );
    }
    fs.appendFileSync(process.env.VMDEBUG, lines.join("\n") + "\n");
  }

  function replaceIdentifier(root, name, expr) {
    let done = false;
    const rec = (n, set) => {
      if (done || !n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) {
          if (n[i] && n[i].type === "Identifier" && n[i].name === name) { n[i] = expr; done = true; return; }
          rec(n[i]);
          if (done) return;
        }
        return;
      }
      if (!n.type) return;
      const keys =
        n.type === "MemberExpression" ? (n.computed ? ["object", "property"] : ["object"])
        : n.type === "AssignmentExpression" ? ["left", "right"]
        : n.type === "ObjectProperty" ? (n.computed ? ["key", "value"] : ["value"])
        : Object.keys(n).filter((k) => !["loc", "start", "end", "type", "leadingComments", "trailingComments", "innerComments", "extra"].includes(k));
      for (const k of keys) {
        const v = n[k];
        if (v && v.type === "Identifier" && v.name === name) {
          // never rewrite an assignment target
          if (n.type === "AssignmentExpression" && k === "left") continue;
          n[k] = expr;
          done = true;
          return;
        }
        rec(v);
        if (done) return;
      }
    };
    rec(root);
    return done;
  }

  /**
   * The trace CFG clones a block once per dispatcher state.  Once the state
   * bookkeeping is gone most clones are literally identical, so fold them back
   * together with Moore's partition refinement (DFA minimisation).
   */
  function minimise(graph) {
    const sigOf = (n) =>
      n.pc + " " + (n.ir.node ? generate(n.ir.node).code : "") + " " +
      (n.kind || "") + " " + (n.cond ? n.cond.reg + ":" + n.cond.negate : "");
    let cls = new Map();
    let next = new Map();
    const nodes = [...graph.nodes.values()];
    for (const n of nodes) {
      const s = sigOf(n);
      if (!next.has(s)) next.set(s, next.size);
      cls.set(n.key, next.get(s));
    }
    for (let round = 0; round < 60; round++) {
      const sig = new Map();
      const fresh = new Map();
      for (const n of nodes) {
        const s =
          cls.get(n.key) + "|" + n.succs.map((x) => (x == null || !graph.nodes.has(x) ? "-" : cls.get(x))).join(",");
        if (!sig.has(s)) sig.set(s, sig.size);
        fresh.set(n.key, sig.get(s));
      }
      let same = true;
      for (const n of nodes) if (fresh.get(n.key) !== cls.get(n.key)) { same = false; break; }
      const distinct = new Set(fresh.values()).size;
      cls = fresh;
      if (same || distinct === nodes.length) break;
    }
    // pick one representative per class
    const rep = new Map();
    for (const n of nodes) if (!rep.has(cls.get(n.key))) rep.set(cls.get(n.key), n.key);
    const map = (k) => (k != null && graph.nodes.has(k) ? rep.get(cls.get(k)) : k);
    for (const n of nodes) n.succs = n.succs.map(map);
    graph.entry = map(graph.entry);
    const keep = new Set(rep.values());
    for (const k of [...graph.nodes.keys()]) if (!keep.has(k)) graph.nodes.delete(k);
    // prune anything that became unreachable
    const g2 = buildGraph(graph.nodes, graph.entry);
    graph.nodes = g2.nodes;
    graph.entry = g2.entry;
  }

  /** merge straight-line chains into basic blocks */
  function collapse(graph) {
    const preds = new Map();
    for (const k of graph.nodes.keys()) preds.set(k, 0);
    for (const n of graph.nodes.values())
      for (const s of n.succs) if (s != null && preds.has(s)) preds.set(s, preds.get(s) + 1);

    const leaders = new Set([graph.entry]);
    for (const [k, n] of graph.nodes) {
      if (n.succs.length > 1) for (const s of n.succs) if (s != null) leaders.add(s);
      for (const s of n.succs) if (s != null && preds.get(s) > 1) leaders.add(s);
      // try/catch markers delimit regions, so they must start their own block
      if (n.ir.tryInfo || n.ir.tryPop) leaders.add(k);
    }
    const blocks = new Map();
    for (const L of leaders) {
      const list = [];
      let cur = L;
      for (let i = 0; i < 100000; i++) {
        const n = graph.nodes.get(cur);
        if (!n) break;
        list.push(n);
        if (n.ir.terminator || n.kind === "end") break;
        if (n.succs.length !== 1 || n.succs[0] == null || !graph.nodes.has(n.succs[0])) break;
        if (leaders.has(n.succs[0])) break; // block ends; that node is the successor
        cur = n.succs[0];
      }
      const last = list[list.length - 1];
      const terminated = list.some((n) => n.ir.terminator);
      const succs =
        !last || terminated || last.kind === "end"
          ? []
          : last.succs.filter((s) => s != null && graph.nodes.has(s));
      blocks.set(L, { key: L, nodes: list, succs, cond: last ? last.cond : null, terminated });
    }
    for (const b of blocks.values()) b.succs = b.succs.filter((s) => blocks.has(s));
    return blocks;
  }

  function liveAtEntry(blocks, entry, reg) {
    const seen = new Set();
    const stack = [entry];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k) || !blocks.has(k)) continue;
      seen.add(k);
      const b = blocks.get(k);
      for (const n of b.nodes) {
        if (n.ir.uses.includes(reg) || (n.cond && n.cond.reg === reg)) return true;
        if (n.ir.dst === reg) return false;
      }
      for (const s of b.succs) stack.push(s);
    }
    return false;
  }

  /* ---------- structuring ---------- */
  function structure(blocks, entry, f) {
    if (!blocks.has(entry)) return [];
    const order = [];
    const seen = new Set();
    (function dfs(k) {
      if (seen.has(k) || !blocks.has(k)) return;
      seen.add(k);
      for (const s of blocks.get(k).succs) dfs(s);
      order.push(k);
    })(entry);
    const rpo = order.slice().reverse();
    const pos = new Map(rpo.map((k, i) => [k, i]));
    const preds = new Map(rpo.map((k) => [k, []]));
    for (const k of rpo) for (const s of blocks.get(k).succs) if (pos.has(s)) preds.get(s).push(k);

    const idom = new Map([[entry, entry]]);
    const inter = (a, b) => {
      while (a !== b) {
        while (pos.get(a) > pos.get(b)) a = idom.get(a);
        while (pos.get(b) > pos.get(a)) b = idom.get(b);
      }
      return a;
    };
    for (let ch = true, guard = 0; ch && guard < 200; guard++) {
      ch = false;
      for (const k of rpo) {
        if (k === entry) continue;
        let nd = null;
        for (const p of preds.get(k)) {
          if (!idom.has(p)) continue;
          nd = nd === null ? p : inter(p, nd);
        }
        if (nd !== null && idom.get(k) !== nd) { idom.set(k, nd); ch = true; }
      }
    }
    const dominates = (a, b) => {
      let x = b;
      for (let i = 0; i < 10000; i++) {
        if (x === a) return true;
        const n = idom.get(x);
        if (n === undefined || n === x) return false;
        x = n;
      }
      return false;
    };

    // post-dominators (reverse graph + virtual exit)
    const EXIT = " exit";
    const rsucc = new Map([[EXIT, []]]);
    for (const k of rpo) rsucc.set(k, []);
    for (const k of rpo) {
      const s = blocks.get(k).succs.filter((x) => pos.has(x));
      if (!s.length) rsucc.get(EXIT).push(k);
      for (const x of s) rsucc.get(x).push(k);
    }
    const rorder = [];
    const rseen = new Set();
    (function rdfs(k) {
      if (rseen.has(k)) return;
      rseen.add(k);
      for (const s of rsucc.get(k) || []) rdfs(s);
      rorder.push(k);
    })(EXIT);
    const rpos = new Map(rorder.slice().reverse().map((k, i) => [k, i]));
    const ipdom = new Map([[EXIT, EXIT]]);
    const rpreds = new Map([...rpos.keys()].map((k) => [k, []]));
    for (const k of rpos.keys()) for (const s of rsucc.get(k) || []) if (rpos.has(s)) rpreds.get(s).push(k);
    const rinter = (a, b) => {
      while (a !== b) {
        while (rpos.get(a) > rpos.get(b)) a = ipdom.get(a);
        while (rpos.get(b) > rpos.get(a)) b = ipdom.get(b);
      }
      return a;
    };
    for (let ch = true, guard = 0; ch && guard < 200; guard++) {
      ch = false;
      for (const k of [...rpos.keys()].sort((a, b) => rpos.get(a) - rpos.get(b))) {
        if (k === EXIT) continue;
        let nd = null;
        for (const p of rpreds.get(k)) {
          if (!ipdom.has(p)) continue;
          nd = nd === null ? p : rinter(p, nd);
        }
        if (nd !== null && ipdom.get(k) !== nd) { ipdom.set(k, nd); ch = true; }
      }
    }

    // natural loops
    const loops = new Map();
    for (const k of rpo)
      for (const s of blocks.get(k).succs)
        if (pos.has(s) && dominates(s, k)) {
          if (!loops.has(s)) loops.set(s, new Set([s]));
          const body = loops.get(s);
          const st = [k];
          while (st.length) {
            const n = st.pop();
            if (body.has(n)) continue;
            body.add(n);
            for (const p of preds.get(n) || []) st.push(p);
          }
        }

    let labelN = 0;
    const stmtsOf = (b) => {
      const out = [];
      for (const n of b.nodes) if (n.ir.node) out.push(n.ir.node);
      return out;
    };
    const condOf = (b) => {
      const last = b.nodes[b.nodes.length - 1];
      const c = last && last.cond;
      if (!c) return t.booleanLiteral(true);
      const id = t.identifier(regName(f, c.reg));
      return c.negate ? t.unaryExpression("!", id, true) : id;
    };

    function emit(start, ctx, ignoreStopOnFirst) {
      const out = [];
      let cur = start;
      let first = true;
      for (let guard = 0; guard < 100000; guard++) {
        if (cur == null || !blocks.has(cur)) return out;
        if (!(first && ignoreStopOnFirst) && ctx.stop.has(cur)) {
          const act = ctx.stop.get(cur);
          if (act.type === "break") out.push(t.breakStatement(t.identifier(act.label)));
          else if (act.type === "continue") out.push(t.continueStatement(t.identifier(act.label)));
          return out;
        }
        first = false;
        if (loops.has(cur) && !ctx.active.has(cur)) {
          const r = emitLoop(cur, ctx);
          out.push(...r.stmts);
          if (r.exit == null) return out;
          cur = r.exit;
          continue;
        }
        const b = blocks.get(cur);
        const marker = b.nodes[0];
        if (marker && marker.ir.tryInfo && b.succs.length === 2) {
          const r = emitTry(b, ctx);
          if (r) {
            out.push(...r.stmts);
            if (r.next == null) return out;
            cur = r.next;
            continue;
          }
        }
        out.push(...stmtsOf(b));
        if (b.terminated || b.succs.length === 0) return out;
        if (b.succs.length === 1) { cur = b.succs[0]; continue; }
        let join = ipdom.get(cur);
        if (join === EXIT || join === undefined || !blocks.has(join)) join = null;
        const sub = { ...ctx, stop: new Map(ctx.stop) };
        if (join != null && !sub.stop.has(join)) sub.stop.set(join, { type: "fall" });
        const thenS = emit(b.succs[0], sub);
        const elseS = emit(b.succs[1], sub);
        out.push(
          t.ifStatement(condOf(b), t.blockStatement(thenS), elseS.length ? t.blockStatement(elseS) : null)
        );
        if (join == null) return out;
        cur = join;
      }
      return out;
    }

    /**
     * `TRY_CATCH target, excReg` installs a handler; `TRY_POP` removes it again.
     * The protected region is everything from here to the matching pop, and the
     * VM's own recovery path (`reg[excReg] = e; goto target`) is exactly what a
     * JavaScript `catch` clause does.
     */
    function emitTry(b, ctx) {
      const info = b.nodes[0].ir.tryInfo;
      const bodyStart = b.succs[0];
      const handler = b.succs[1];
      // walk forward for the matching TRY_POP
      const popBlocks = new Set();
      const seenDepth = new Set();
      const stack = [[bodyStart, 0]];
      let bail = false;
      while (stack.length) {
        const [k, d] = stack.pop();
        if (!blocks.has(k)) continue;
        const id = k + "#" + d;
        if (seenDepth.has(id)) continue;
        seenDepth.add(id);
        const bb = blocks.get(k);
        let depth = d;
        let closed = false;
        for (const n of bb.nodes) {
          if (n.ir.tryInfo) depth++;
          else if (n.ir.tryPop) {
            if (depth === 0) { popBlocks.add(k); closed = true; break; }
            depth--;
          }
        }
        if (closed) continue;
        for (const s of bb.succs) stack.push([s, depth]);
      }
      if (popBlocks.size !== 1) {
        warnings.push(
          `could not delimit the try region at pc ${b.nodes[0].pc} (${popBlocks.size} exits) â€” emitted unprotected`
        );
        return null;
      }
      const pop = [...popBlocks][0];
      const sub = { ...ctx, stop: new Map(ctx.stop) };
      if (!sub.stop.has(pop)) sub.stop.set(pop, { type: "fall" });
      const tryBody = emit(bodyStart, sub);
      const excName = "__e" + labelN++;
      const catchBody = [];
      for (const [reg, val] of info.extra)
        catchBody.push(
          t.expressionStatement(t.assignmentExpression("=", t.identifier(regName(f, reg)), lit(val)))
        );
      catchBody.push(
        t.expressionStatement(
          t.assignmentExpression("=", t.identifier(regName(f, info.excReg)), t.identifier(excName))
        )
      );
      catchBody.push(...emit(handler, sub));
      const stmts = [
        t.tryStatement(
          t.blockStatement(tryBody),
          t.catchClause(t.identifier(excName), t.blockStatement(catchBody))
        ),
      ];
      // the TRY_POP marker itself emits nothing, so just carry on from there
      return { stmts, next: pop };
    }

    function emitLoop(header, ctx) {
      const body = loops.get(header);
      const label = "L" + labelN++;
      const exits = new Set();
      for (const k of body)
        for (const s of blocks.get(k).succs) if (!body.has(s) && blocks.has(s)) exits.add(s);
      // prefer the exit that post-dominates the header
      let primary = null;
      const ip = ipdom.get(header);
      if (ip && exits.has(ip)) primary = ip;
      else if (exits.size) primary = [...exits][0];

      const sub = {
        stop: new Map(ctx.stop),
        active: new Set(ctx.active).add(header),
      };
      sub.stop.set(header, { type: "continue", label });
      if (primary != null) sub.stop.set(primary, { type: "break", label });
      const bodyStmts = emit(header, sub, true);
      const loop = t.labeledStatement(
        t.identifier(label),
        t.whileStatement(t.booleanLiteral(true), t.blockStatement(bodyStmts))
      );
      return { stmts: [loop], exit: primary };
    }

    return emit(entry, { stop: new Map(), active: new Set() }, false);
  }
}

/* ------------------------------------------------------------------ *
 * 10.  Readability passes (pure Babel AST work)
 * ------------------------------------------------------------------ */

const SIDE_EFFECT_FREE = new Set([
  "Identifier", "NumericLiteral", "StringLiteral", "BooleanLiteral", "NullLiteral",
  "ThisExpression", "FunctionExpression", "ArrowFunctionExpression",
]);

function isPureExpr(node) {
  let pure = true;
  const walk = (n) => {
    if (!n || !pure) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object" || !n.type) return;
    if (n.type === "CallExpression" || n.type === "NewExpression" || n.type === "MemberExpression" ||
        n.type === "AssignmentExpression" || n.type === "UpdateExpression" || n.type === "TaggedTemplateExpression") {
      pure = false;
      return;
    }
    if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") return; // opaque but pure to create
    for (const k of ["left","right","argument","arguments","callee","object","property","elements","properties","expressions","test","consequent","alternate","value","key"])
      if (k in n) walk(n[k]);
  };
  walk(node);
  return pure;
}

function readsIdentifiers(node, out = new Set()) {
  const walk = (n, parent, key) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, parent, key));
    if (typeof n !== "object" || !n.type) return;
    if (n.type === "Identifier") { out.add(n.name); return; }
    if (n.type === "MemberExpression") {
      walk(n.object);
      if (n.computed) walk(n.property);
      return;
    }
    if (n.type === "ObjectProperty") { if (n.computed) walk(n.key); walk(n.value); return; }
    for (const k in n) {
      if (k === "loc" || k === "start" || k === "end" || k === "type" || k === "leadingComments" || k === "trailingComments") continue;
      walk(n[k], n, k);
    }
  };
  walk(node);
  return out;
}

/** local forward substitution: fold write-once/read-once temporaries into their use */
function inlineTemporaries(programAst) {
  const counts = new Map();

  // count reads / writes per (function scope, name)
  const scopeOf = (p) => {
    const fp = p.getFunctionParent();
    return fp ? fp.node : programAst.program;
  };
  traverse(programAst, {
    Identifier(p) {
      if (p.parentPath.isMemberExpression() && p.parent.property === p.node && !p.parent.computed) return;
      if (p.parentPath.isObjectProperty() && p.parent.key === p.node && !p.parent.computed) return;
      if (p.parentPath.isVariableDeclarator() && p.parent.id === p.node) return;
      if (p.parentPath.isFunction() && p.listKey === "params") return;
      const isWrite = p.parentPath.isAssignmentExpression() && p.parent.left === p.node;
      const key = { s: scopeOf(p), n: p.node.name };
      const id = key.n;
      let m = counts.get(key.s);
      if (!m) counts.set(key.s, (m = new Map()));
      if (!m.has(id)) m.set(id, { reads: 0, writes: 0 });
      if (isWrite) m.get(id).writes++;
      else m.get(id).reads++;
    },
  });

  const substituteIn = (body, scopeNode) => {
    const m = counts.get(scopeNode) || new Map();
    for (let i = 0; i < body.length; i++) {
      const st = body[i];
      if (!t.isExpressionStatement(st)) continue;
      const asg = st.expression;
      if (!t.isAssignmentExpression(asg) || asg.operator !== "=" || !t.isIdentifier(asg.left)) continue;
      const name = asg.left.name;
      const info = m.get(name);
      if (!info || info.writes !== 1 || info.reads !== 1) continue;
      const rhs = asg.right;
      if (t.isFunctionExpression(rhs)) continue;
      const deps = readsIdentifiers(rhs);
      const rhsPure = isPureExpr(rhs);

      // find the single use in a later statement of this same list
      let target = null;
      for (let j = i + 1; j < body.length; j++) {
        const uses = readsIdentifiers(body[j]);
        if (uses.has(name)) { target = j; break; }
        // any statement in between must not disturb the value
        const writes = new Set();
        traverseStatement(body[j], (n) => {
          if (t.isAssignmentExpression(n) && t.isIdentifier(n.left)) writes.add(n.left.name);
          if (t.isUpdateExpression(n) && t.isIdentifier(n.argument)) writes.add(n.argument.name);
        });
        if ([...deps].some((d) => writes.has(d))) { target = null; break; }
        if (!rhsPure && !isPureExpr(body[j])) { target = null; break; }
      }
      if (target === null) continue;
      // only substitute into a statement where the use is evaluated unconditionally
      let replaced = false;
      const rep = (n) => {
        if (!n || typeof n !== "object" || replaced) return n;
        if (Array.isArray(n)) { n.forEach((x, idx) => (n[idx] = rep(x))); return n; }
        if (!n.type) return n;
        if (n.type === "Identifier" && n.name === name) { replaced = true; return rhs; }
        if (n.type === "MemberExpression") {
          n.object = rep(n.object);
          if (n.computed) n.property = rep(n.property);
          return n;
        }
        for (const k in n) {
          if (k === "loc" || k === "start" || k === "end" || k === "type") continue;
          if (k === "leadingComments" || k === "trailingComments" || k === "innerComments") continue;
          n[k] = rep(n[k]);
        }
        return n;
      };
      rep(body[target]);
      if (replaced) {
        body.splice(i, 1);
        i--;
      }
    }
  };
  const traverseStatement = (node, cb) => {
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n.type) return;
      cb(n);
      for (const k in n) {
        if (k === "loc" || k === "start" || k === "end" || k === "type") continue;
        walk(n[k]);
      }
    };
    walk(node);
  };

  // apply to every statement list, innermost first
  const lists = [];
  traverse(programAst, {
    Program(p) { lists.push([p.node.body, p.node]); },
    BlockStatement(p) {
      const fp = p.getFunctionParent();
      lists.push([p.node.body, fp ? fp.node : programAst.program]);
    },
  });
  for (const [body, scopeNode] of lists) substituteIn(body, scopeNode);
}

/** `obj[k].call(obj, ...)` back to `obj[k](...)` */
function simplifyMethodCalls(programAst) {
  traverse(programAst, {
    CallExpression(p) {
      const c = p.node;
      if (!t.isMemberExpression(c.callee) || c.callee.computed) return;
      if (!t.isIdentifier(c.callee.property, { name: "call" })) return;
      const target = c.callee.object;
      if (!t.isMemberExpression(target)) return;
      if (!c.arguments.length) return;
      const thisArg = c.arguments[0];
      const same =
        (t.isIdentifier(target.object) && t.isIdentifier(thisArg) && target.object.name === thisArg.name) ||
        (t.isThisExpression(target.object) && t.isThisExpression(thisArg));
      if (!same) return;
      p.replaceWith(t.callExpression(target, c.arguments.slice(1)));
    },
  });
}

/** `obj["name"]` back to `obj.name` where the key is a valid identifier */
function dotProperties(programAst) {
  traverse(programAst, {
    MemberExpression(p) {
      const n = p.node;
      if (!n.computed || !t.isStringLiteral(n.property)) return;
      if (!IDENT_RE.test(n.property.value) || RESERVED.has(n.property.value)) return;
      n.computed = false;
      n.property = t.identifier(n.property.value);
    },
  });
}

/**
 * Turn the leading `var a, b, c;` block into `var a = â€¦` at each variable's
 * first assignment.  A name whose first assignment is not in this statement
 * list (or that is read before it) keeps its bare declaration.
 */
function mergeDeclarations(programAst) {
  const fixList = (body) => {
    for (let i = 0; i < body.length; i++) {
      const decl = body[i];
      if (!t.isVariableDeclaration(decl) || decl.kind !== "var") continue;
      if (decl.declarations.some((d) => d.init)) continue;
      const names = decl.declarations.map((d) => d.id.name);
      const leftover = [];
      for (const name of names) {
        let merged = false;
        for (let j = i + 1; j < body.length; j++) {
          const s = body[j];
          if (
            t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression, { operator: "=" }) &&
            t.isIdentifier(s.expression.left, { name }) &&
            !readsIdentifiers(s.expression.right).has(name)
          ) {
            body[j] = t.variableDeclaration("var", [t.variableDeclarator(t.identifier(name), s.expression.right)]);
            merged = true;
            break;
          }
          if (readsIdentifiers(s).has(name)) break;
        }
        if (!merged) leftover.push(name);
      }
      if (leftover.length)
        decl.declarations = leftover.map((n) => t.variableDeclarator(t.identifier(n)));
      else { body.splice(i, 1); i--; }
    }
  };
  traverse(programAst, {
    Program(p) { fixList(p.node.body); },
    BlockStatement(p) { fixList(p.node.body); },
  });
}

/** `return undefined;` -> `return;` */
function simplifyReturns(programAst) {
  traverse(programAst, {
    ReturnStatement(p) {
      if (p.node.argument && t.isIdentifier(p.node.argument, { name: "undefined" })) p.node.argument = null;
    },
  });
}

/** drop `var x;` declarations for names that are never mentioned again */
function pruneDeclarations(programAst) {
  traverse(programAst, {
    VariableDeclaration(p) {
      if (p.node.kind !== "var") return;
      const keep = p.node.declarations.filter((d) => {
        if (d.init) return true;
        const name = d.id.name;
        let used = false;
        const fn = p.getFunctionParent();
        const root = fn ? fn : p.findParent((x) => x.isProgram());
        root.traverse({
          Identifier(q) {
            if (q.node.name !== name) return;
            if (q.parentPath.isVariableDeclarator() && q.parent.id === q.node) return;
            if (q.parentPath.isMemberExpression() && q.parent.property === q.node && !q.parent.computed) return;
            used = true;
          },
        });
        return used;
      });
      if (!keep.length) p.remove();
      else p.node.declarations = keep;
    },
  });
}

const TERMINATORS = ["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"];
const endsHard = (s) =>
  TERMINATORS.includes(s.type) ||
  (t.isBlockStatement(s) && s.body.length && endsHard(s.body[s.body.length - 1])) ||
  (t.isIfStatement(s) && s.alternate && endsHard(s.consequent) && endsHard(s.alternate));

/** structural tidy-ups that make the recovered control flow read naturally */
function tidyControlFlow(programAst) {
  const negate = (e) =>
    t.isUnaryExpression(e) && e.operator === "!" ? e.argument : t.unaryExpression("!", e, true);

  const fixList = (body) => {
    // statements after an unconditional jump can never run
    for (let i = 0; i < body.length; i++)
      if (endsHard(body[i]) && TERMINATORS.includes(body[i].type)) {
        body.length = i + 1;
        break;
      }
    // `if (c) { â€¦return } else { X }`  ->  `if (c) { â€¦return } X`
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      if (!t.isIfStatement(s) || !s.alternate) continue;
      if (!endsHard(s.consequent)) continue;
      const tail = t.isBlockStatement(s.alternate) ? s.alternate.body : [s.alternate];
      s.alternate = null;
      body.splice(i + 1, 0, ...tail);
    }
  };

  const pass = () => {
  traverse(programAst, {
    Program(p) { fixList(p.node.body); },
    BlockStatement(p) { fixList(p.node.body); },
  });

  // `while (true) { if (c) break; REST }` -> `while (!c) { REST }`
  traverse(programAst, {
    WhileStatement(p) {
      const w = p.node;
      if (!t.isBooleanLiteral(w.test, { value: true })) return;
      const body = t.isBlockStatement(w.body) ? w.body.body : [w.body];
      if (!body.length) return;
      const first = body[0];
      if (!t.isIfStatement(first) || first.alternate) return;
      const cons = t.isBlockStatement(first.consequent) ? first.consequent.body : [first.consequent];
      if (cons.length !== 1 || !t.isBreakStatement(cons[0])) return;
      const label = cons[0].label && cons[0].label.name;
      const owner = p.parentPath.isLabeledStatement() ? p.parent.label.name : null;
      if (label && label !== owner) return;
      w.test = negate(first.test);
      body.shift();
      // a trailing `continue` for this very loop is redundant
      const last = body[body.length - 1];
      if (last && t.isContinueStatement(last) && (!last.label || last.label.name === owner)) body.pop();
      w.body = t.blockStatement(body);
    },
  });

  // drop a trailing `continue` in any loop body
  traverse(programAst, {
    "WhileStatement|ForStatement|DoWhileStatement"(p) {
      const body = t.isBlockStatement(p.node.body) ? p.node.body.body : null;
      if (!body || !body.length) return;
      const owner = p.parentPath.isLabeledStatement() ? p.parent.label.name : null;
      const last = body[body.length - 1];
      if (t.isContinueStatement(last) && (!last.label || last.label.name === owner)) body.pop();
    },
  });

  traverse(programAst, {
    Program(p) { fixList(p.node.body); },
    BlockStatement(p) { fixList(p.node.body); },
  });
  };
  for (let i = 0; i < 4; i++) pass();
}

/** turn `L0: while (true) { â€¦ }` into `while (true) { â€¦ }` when the label is unused */
function pruneLabels(programAst) {
  traverse(programAst, {
    LabeledStatement(p) {
      const name = p.node.label.name;
      let used = false;
      p.traverse({
        "BreakStatement|ContinueStatement"(q) {
          if (q.node.label && q.node.label.name === name) used = true;
        },
      });
      if (!used) p.replaceWith(p.node.body);
    },
  });
}

/* ------------------------------------------------------------------ *
 * 11.  Driver
 * ------------------------------------------------------------------ */

function parseAny(source) {
  let firstError = null;
  for (const sourceType of ["script", "module"]) {
    try {
      return parser.parse(source, { sourceType, allowReturnOutsideFunction: true });
    } catch (e) {
      firstError = firstError || e;
    }
  }
  throw firstError;
}

function deobfuscateSource(source, opts = {}) {
  const ast = parseAny(source);
  const vm = locateVM(ast);
  if (!vm) {
    // not a JS-Confuser VM bundle â€” hand the program straight back
    return { code: generate(ast, { comments: true, retainLines: false }).code, vm: null, warnings: [] };
  }

  vm.regBaseSlot = findRegBaseSlot(vm);
  const pool = vm.pool.map(poolValue);
  const descs = new Map();
  for (const op of vm.handlers.keys()) descs.set(op, classify(vm, probeStructure(vm, op)));

  const funcs = disassemble(vm, descs);
  const P = buildProgram(vm, funcs, descs, pool, opts);
  const entryFn = funcs.get(vm.entrySpec[vm.specProps.entry] || 0);
  let body = P.generateBody(entryFn);

  // a bare `return` is illegal at program level
  const hasValueReturn = body.some(
    (s) => t.isReturnStatement(s) && s.argument && !t.isIdentifier(s.argument, { name: "undefined" })
  );
  if (hasValueReturn) {
    body = [
      t.expressionStatement(
        t.callExpression(t.functionExpression(null, [], t.blockStatement(body)), [])
      ),
    ];
  } else {
    const strip = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (t.isReturnStatement(s) && (!s.argument || t.isIdentifier(s.argument, { name: "undefined" })))
          list.splice(i, 1);
      }
      return list;
    };
    strip(body);
  }

  const out = t.file(t.program(body));
  simplifyMethodCalls(out);
  inlineTemporaries(out);
  simplifyMethodCalls(out);
  inlineTemporaries(out);
  dotProperties(out);
  tidyControlFlow(out);
  inlineTemporaries(out);
  pruneLabels(out);
  pruneDeclarations(out);
  mergeDeclarations(out);
  simplifyReturns(out);

  const header =
    "// Deobfuscated by vm.js - JS-Confuser-VM bytecode lifted back to JavaScript.\n" +
    `// ${funcs.size} function(s), ${vm.bytecode.length} bytecode words, ${pool.length} pool entries.\n` +
    (P.warnings.length ? P.warnings.map((w) => `// WARNING: ${w}\n`).join("") : "");
  const code = generate(out, { comments: true, jsescOption: { minimal: true } }).code;
  return { code: header + code + "\n", vm, funcs, descs, warnings: P.warnings };
}

/**
 * Main entry point.
 *   require('./vm.js')('input.js')             -> deobfuscated source (string)
 *   require('./vm.js')('input.js','output.js') -> also writes the file
 */
function deobfuscate(inputPath, outputPath, opts) {
  const source = fs.readFileSync(inputPath, "utf8");
  const res = deobfuscateSource(source, opts);
  if (outputPath) fs.writeFileSync(outputPath, res.code);
  return res.code;
}

module.exports = deobfuscate;
Object.assign(module.exports, {
  deobfuscate, deobfuscateSource,
  locateVM, decodeConst, poolValue, runHandler, M, isM, mk, MAGIC, STRIDE,
  findRegBaseSlot, probeStructure, classify, flat, OPBASE, slotOf, srcOf, arithInputs,
  disassemble, instrLength, value, regIdx, fitInstr, makeEngine, resolveIndirect, explorePaths, UNK,
  buildProgram,
});

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error("usage: node vm.js <input.js> [output.js]");
    process.exit(1);
  }
  try {
    const code = deobfuscate(input, output || null);
    if (!output) process.stdout.write(code);
    else console.log(`wrote ${output} (${code.length} bytes)`);
  } catch (e) {
    console.error("deobfuscation failed:", e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}
