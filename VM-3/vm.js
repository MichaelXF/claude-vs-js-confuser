#!/usr/bin/env node
/**
 * vm.js — AST deobfuscator for JS-Confuser-VM protected files.
 *
 *   node vm.js input.js output.js
 *   require('./vm.js')('input.js')   -> deobfuscated source string
 *
 * The obfuscation replaces the whole program with a register-based bytecode VM:
 * a Uint32Array of instructions, a constant pool of XTEA-ish encrypted strings,
 * and a table of `proto[opcode] = function(){...}` handlers.  This tool
 *
 *   1. finds the VM runtime pieces structurally — no identifier names and no
 *      opcode numbers are assumed, both are randomized per build,
 *   2. learns what each opcode handler does by canonicalizing its AST, so the
 *      144 handlers collapse onto 72 shapes and 36 instruction kinds,
 *   3. disassembles the bytecode into per-function control-flow graphs,
 *   4. undoes the control-flow flattening layered on top by specializing each
 *      program point on the constants that reach it,
 *   5. re-structures each CFG into real JS control flow (relooper),
 *   6. folds the three-address code back into expressions, simplifies the
 *      mixed-boolean-arithmetic, and cleans the result up.
 *
 * Input that does not contain this VM is returned untouched.
 *
 * See NOTES.md for how the format was worked out.
 */
"use strict";

const fs = require("fs");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

/* ========================================================================== *
 * 0. small helpers
 * ========================================================================== */

const DROP_KEYS = new Set([
  "loc", "start", "end", "range", "leadingComments", "trailingComments",
  "innerComments", "comments", "extra", "_blockHoist", "errors", "tokens",
]);

function clone(node) {
  if (Array.isArray(node)) return node.map(clone);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const k of Object.keys(node)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = clone(node[k]);
  }
  return out;
}

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isThisMember(n, prop) {
  return (
    n && n.type === "MemberExpression" && !n.computed &&
    n.object.type === "ThisExpression" && n.property.type === "Identifier" &&
    (prop === undefined || n.property.name === prop)
  );
}

/* ========================================================================== *
 * 1. VM shape detection
 * ========================================================================== */

/**
 * Locate every moving part of the VM runtime by structure alone, so that the
 * minified identifier names and the randomized opcode numbers do not matter.
 * Returns null when the file does not contain this VM.
 */
function detectVM(ast) {
  const vm = {
    stackProp: null, fpProp: null, bcProp: null, poolProp: null,
    globalProp: null, spProp: null, cellsProp: null,
    pcOff: null, regBaseOff: null, slots: {},
    readFn: null, strFn: null, b64Fn: null, pushFrameFn: null,
    loopFn: null, closeFn: null, cellFn: null,
    tplCtor: null, cellCtor: null, vmCtor: null, tplMapVar: null,
    tplInfoProp: null, tplCapsProp: null,
    cellIdxProp: null, cellArrProp: null, cellMatProp: null, cellValProp: null,
    handlers: new Map(),
  };

  /* --- x(a,b){ a.Q=b; return a.BC[ a.STACK[ a.FP + PCOFF ]++ ] } ---------- */
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (body.length !== 2) return;
      if (body[0].type !== "ExpressionStatement") return;
      if (body[0].expression.type !== "AssignmentExpression") return;
      if (body[1].type !== "ReturnStatement" || !body[1].argument) return;
      const r = body[1].argument;
      if (r.type !== "MemberExpression" || !r.computed) return;
      if (r.object.type !== "MemberExpression" || r.object.computed) return;
      const upd = r.property;
      if (upd.type !== "UpdateExpression" || upd.operator !== "++") return;
      const inner = upd.argument;
      if (inner.type !== "MemberExpression" || !inner.computed) return;
      if (inner.object.type !== "MemberExpression" || inner.object.computed) return;
      const add = inner.property;
      if (add.type !== "BinaryExpression" || add.operator !== "+") return;
      if (add.left.type !== "MemberExpression" || add.left.computed) return;
      if (add.right.type !== "NumericLiteral") return;
      vm.readFn = p.node.id.name;
      vm.bcProp = r.object.property.name;
      vm.stackProp = inner.object.property.name;
      vm.fpProp = add.left.property.name;
      vm.pcOff = add.right.value;
    },
  });
  if (!vm.readFn) return null;

  /* --- y(a,b,e) — constant decoder --------------------------------------- */
  traverse(ast, {
    FunctionDeclaration(p) {
      let magic = false, fcc = false;
      p.traverse({
        NumericLiteral(q) { if (q.node.value === 2654435769) magic = true; },
        MemberExpression(q) {
          if (!q.node.computed && q.node.property.name === "fromCharCode") fcc = true;
        },
      });
      if (!magic || !fcc) return;
      vm.strFn = p.node.id.name;
      p.traverse({
        MemberExpression(q) {
          const n = q.node;
          if (!vm.poolProp && n.computed && n.object.type === "MemberExpression" &&
              !n.object.computed && n.object.object.type === "Identifier")
            vm.poolProp = n.object.property.name;
        },
      });
    },
  });
  if (!vm.strFn) return null;

  /* --- f(a) — base64 -> bytes -------------------------------------------- */
  traverse(ast, {
    FunctionDeclaration(p) {
      let found = false;
      p.traverse({ Identifier(q) { if (q.node.name === "atob") found = true; } });
      if (found) vm.b64Fn = p.node.id.name;
    },
  });

  /* --- u(...) — VM object constructor ------------------------------------ */
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (!body.length) return;
      if (!body.every((s) => s.type === "ExpressionStatement" &&
        s.expression.type === "AssignmentExpression" &&
        isThisMember(s.expression.left))) return;
      const assigns = body.map((s) => s.expression);
      if (!assigns.some((a) => a.left.property.name === vm.stackProp &&
        a.right.type === "ArrayExpression")) return;
      vm.vmCtor = p.node.id.name;
      const params = p.node.params.map((x) => x.name);
      for (const a of assigns) {
        const name = a.left.property.name;
        if (a.right.type === "Identifier") {
          const idx = params.indexOf(a.right.name);
          if (idx === 2) vm.bcProp = name;
          else if (idx === 1) vm.poolProp = name;
          else if (idx === 4) vm.globalProp = name;
        } else if (a.right.type === "NumericLiteral" && a.right.value > 0) {
          vm.spProp = name;
        } else if (a.right.type === "NullLiteral") {
          vm.cellsProp = name;
        }
      }
    },
  });

  /* --- w(...) — frame push; yields the frame slot layout ------------------ */
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.node.params.length !== 8) return;
      let pushesUndefined = false;
      p.traverse({
        CallExpression(q) {
          const n = q.node;
          if (n.callee.type === "MemberExpression" && n.callee.property.name === "push" &&
              n.arguments.length === 1 && n.arguments[0].type === "UnaryExpression" &&
              n.arguments[0].operator === "void") pushesUndefined = true;
        },
      });
      if (!pushesUndefined) return;
      vm.pushFrameFn = p.node.id.name;
      const params = p.node.params.map((x) => x.name);
      let stackLocal = null, baseLocal = null, tplLocal = null,
          frameSzLocal = null, endLocal = null;
      p.traverse({
        VariableDeclarator(q) {
          const n = q.node;
          if (!n.init || n.id.type !== "Identifier") return;
          const i = n.init;
          if (i.type === "MemberExpression" && !i.computed &&
              i.object.type === "Identifier" && i.object.name === params[0]) {
            if (i.property.name === vm.stackProp) stackLocal = n.id.name;
            if (i.property.name === vm.spProp) baseLocal = n.id.name;
          }
          if (i.type === "MemberExpression" && !i.computed &&
              i.object.type === "Identifier" && i.object.name === params[1]) tplLocal = n.id.name;
          if (i.type === "BinaryExpression" && i.operator === "+" &&
              i.left.type === "NumericLiteral") frameSzLocal = n.id.name;
          if (i.type === "BinaryExpression" && i.operator === "+" &&
              i.left.type === "Identifier" && i.left.name === baseLocal) endLocal = n.id.name;
        },
      });
      p.traverse({
        AssignmentExpression(q) {
          const n = q.node;
          const L = n.left;
          if (L.type !== "MemberExpression" || !L.computed) return;
          if (L.object.type !== "Identifier" || L.object.name !== stackLocal) return;
          const idx = L.property;
          if (idx.type !== "BinaryExpression" || idx.operator !== "+") return;
          if (idx.left.type !== "Identifier" || idx.left.name !== baseLocal) return;
          if (idx.right.type !== "NumericLiteral") return;
          const off = idx.right.value;
          const r = n.right;
          if (r.type === "MemberExpression" && !r.computed && r.object.name === tplLocal) {
            vm.slots.pc = off;
            vm.tplPcKey = r.property.name;
          } else if (r.type === "MemberExpression" && !r.computed &&
                     r.object.name === params[0] && r.property.name === vm.fpProp) {
            vm.slots.prevFp = off;
          } else if (r.type === "Identifier") {
            const nm = r.name;
            if (nm === params[2]) vm.slots.retDst = off;
            else if (nm === params[6]) vm.slots.thisVal = off;
            else if (nm === params[1]) vm.slots.template = off;
            else if (nm === frameSzLocal) vm.slots.frameSize = off;
            else if (nm === endLocal) vm.slots.frameEnd = off;
            else vm.slots.regBase = off;
          }
        },
      });
      // the try/catch handler slot is the only frame offset touched nowhere here
      vm.slots.handlers = null;
    },
  });

  /* --- v(...) — closes over live cells on frame exit ---------------------- */
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.node.params.length !== 5) return;
      const b = p.node.body.body;
      if (!b.length || b[0].type !== "VariableDeclaration") return;
      const d = b[0].declarations[0];
      if (!d || !d.init) return;
      if (d.init.type === "MemberExpression" && !d.init.computed &&
          d.init.property.name === vm.cellsProp) vm.closeFn = p.node.id.name;
    },
  });

  /* --- z(...) — the dispatch loop ---------------------------------------- */
  traverse(ast, {
    FunctionDeclaration(p) {
      let hit = false;
      p.traverse({
        TryStatement(q) {
          const b = q.node.block.body;
          if (b.length === 1 && b[0].type === "ExpressionStatement" &&
              b[0].expression.type === "CallExpression" &&
              b[0].expression.callee.type === "MemberExpression" &&
              b[0].expression.callee.computed) hit = true;
        },
      });
      if (hit) vm.loopFn = p.node.id.name;
    },
  });

  /* --- proto.c — closure cell accessor; gives the register base offset ---- */
  traverse(ast, {
    AssignmentExpression(p) {
      const n = p.node;
      if (n.right.type !== "FunctionExpression") return;
      const L = n.left;
      if (L.type !== "MemberExpression" || L.computed) return;
      if (L.object.type !== "MemberExpression" || L.object.property.name !== "prototype") return;
      const b = n.right.body.body;
      if (!b.length || b[0].type !== "ExpressionStatement") return;
      const a0 = b[0].expression;
      if (a0.type !== "AssignmentExpression") return;
      const r = a0.right;
      if (r.type !== "BinaryExpression" || r.operator !== "+") return;
      const m = r.left;
      if (m.type !== "MemberExpression" || !m.computed) return;
      if (!isThisMember(m.object, vm.stackProp)) return;
      if (m.property.type !== "BinaryExpression" || m.property.right.type !== "NumericLiteral") return;
      vm.regBaseOff = m.property.right.value;
      vm.cellFn = L.property.name;
    },
  });
  if (vm.regBaseOff == null) vm.regBaseOff = vm.slots.regBase;

  /* --- g(a) — function template ctor ------------------------------------- */
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (body.length !== 3 || p.node.params.length !== 1) return;
      let proto = false;
      for (const s of body) {
        const a = s.expression;
        if (!a || a.type !== "AssignmentExpression" || !isThisMember(a.left)) return;
        if (a.left.property.name === "prototype") proto = true;
      }
      if (!proto) return;
      vm.tplCtor = p.node.id.name;
      for (const s of body) {
        const a = s.expression;
        if (a.right.type === "Identifier") vm.tplInfoProp = a.left.property.name;
        if (a.right.type === "ArrayExpression") vm.tplCapsProp = a.left.property.name;
      }
    },
  });

  /* --- q(a,b) — closure cell ctor ---------------------------------------- */
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (body.length !== 4 || p.node.params.length !== 2) return;
      const params = p.node.params.map((x) => x.name);
      const got = {};
      for (const s of body) {
        const a = s.expression;
        if (!a || a.type !== "AssignmentExpression" || !isThisMember(a.left)) return;
        const nm = a.left.property.name;
        const r = a.right;
        if (r.type === "Identifier" && r.name === params[1]) got.arr = nm;
        else if (r.type === "Identifier" && r.name === params[0]) got.idx = nm;
        else if (r.type === "UnaryExpression" && r.operator === "!" &&
                 r.argument.type === "NumericLiteral") got.mat = nm;
        else if (r.type === "UnaryExpression" && r.operator === "void") got.val = nm;
      }
      if (got.arr && got.idx && got.mat && got.val) {
        vm.cellCtor = p.node.id.name;
        vm.cellArrProp = got.arr;
        vm.cellIdxProp = got.idx;
        vm.cellMatProp = got.mat;
        vm.cellValProp = got.val;
      }
    },
  });

  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.init && p.node.init.type === "NewExpression" &&
          p.node.init.callee.name === "WeakMap") vm.tplMapVar = p.node.id.name;
    },
  });

  /* --- opcode handler table ---------------------------------------------- */
  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right } = p.node;
      if (left.type !== "MemberExpression" || !left.computed) return;
      if (left.property.type !== "NumericLiteral") return;
      if (right.type !== "FunctionExpression") return;
      vm.handlers.set(left.property.value, right);
    },
  });
  if (vm.handlers.size < 10) return null;

  /* --- the try/catch handler slot: the frame offset used by the handler
         that does `x || (y = x = [])` and pushes catch descriptors --------- */
  const usedSlots = new Set(Object.values(vm.slots).filter((v) => v != null));
  for (const [, fn] of vm.handlers) {
    let off = null;
    traverseNode(fn, (n) => {
      if (n.type !== "MemberExpression" || !n.computed) return;
      const pr = n.property;
      if (pr.type !== "BinaryExpression" || pr.operator !== "+") return;
      if (pr.right.type !== "NumericLiteral") return;
      if (usedSlots.has(pr.right.value)) return;
      if (pr.left.type !== "Identifier" && !isThisMember(pr.left, vm.fpProp)) return;
      off = pr.right.value;
    });
    let hasPush = false;
    traverseNode(fn, (n) => {
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" &&
          n.callee.property.name === "push" && n.arguments.length === 1 &&
          n.arguments[0].type === "ObjectExpression") hasPush = true;
    });
    if (hasPush && off != null) { vm.slots.handlers = off; break; }
  }

  return vm;
}

function traverseNode(node, fn) {
  if (Array.isArray(node)) { for (const n of node) traverseNode(n, fn); return; }
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (DROP_KEYS.has(k) || k === "type") continue;
    traverseNode(node[k], fn);
  }
}

/* ========================================================================== *
 * 2. payload extraction — bytecode words, constant pool, program entry
 * ========================================================================== */

function extractPayload(ast, vm) {
  let b64 = null;
  let pool = null;
  let entry = null;

  // the bytecode blob: f("....") where the literal is a long base64 string
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (n.callee.type !== "Identifier" || n.callee.name !== vm.b64Fn) return;
      const a = n.arguments[0];
      if (a && a.type === "StringLiteral" && a.value.length > 64) b64 = a.value;
    },
  });

  // the bootstrap: z(new u(_, [pool], words, _, global), _, _, new g({p,e,v}))
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (n.callee.type !== "Identifier" || n.callee.name !== vm.loopFn) return;
      for (const arg of n.arguments) {
        if (arg.type === "NewExpression" && arg.callee.name === vm.vmCtor) {
          const arr = arg.arguments.find(
            (x) => x.type === "ArrayExpression" && x.elements.length > 0);
          if (arr) pool = arr.elements.map(literalValue);
        }
        if (arg.type === "NewExpression" && arg.callee.name === vm.tplCtor) {
          const obj = arg.arguments[0];
          if (obj && obj.type === "ObjectExpression") {
            entry = {};
            for (const pr of obj.properties)
              entry[pr.key.name || pr.key.value] = literalValue(pr.value);
          }
        }
      }
    },
  });

  if (b64 == null || pool == null || entry == null) return null;

  const bytes = Buffer.from(b64, "base64");
  const words = new Uint32Array(bytes.length >> 2);
  for (let i = 0; i < words.length; i++) words[i] = bytes.readUInt32LE(i * 4);
  return { words, pool, entry };
}

function literalValue(el) {
  if (!el) return undefined;
  switch (el.type) {
    case "StringLiteral": return el.value;
    case "NumericLiteral": return el.value;
    case "BooleanLiteral": return el.value;
    case "NullLiteral": return null;
    case "Identifier": return el.name === "undefined" ? undefined : { __id: el.name };
    case "UnaryExpression":
      if (el.operator === "-") return -literalValue(el.argument);
      if (el.operator === "void") return undefined;
      if (el.operator === "!") return !literalValue(el.argument);
      return undefined;
    default: return undefined;
  }
}

/* --- the constant decoder, reimplemented ---------------------------------- */
function makeDecoder(pool) {
  return function decode(index, key) {
    let v = pool[index];
    if (!key) return v;
    if (typeof v === "number") return v ^ key;
    if (typeof v !== "string") return v;
    const bytes = Buffer.from(v, "base64");
    let out = "";
    let b = key | 0;
    for (let c = 0; c < Math.floor(bytes.length / 2); c++) {
      b = (b + 2654435769) | 0;
      const lo = bytes[c * 2] | 0;
      const hi = bytes[c * 2 + 1] | 0;
      out += String.fromCharCode(((lo | (hi << 8)) ^ ((b ^ (b >>> 13)) & 0xffff)) & 0xffff);
    }
    return out;
  };
}

/* ========================================================================== *
 * 3. handler canonicalization
 *
 * Every opcode handler is rewritten into a tiny normalized language:
 *
 *      R[$]        register, indexed by an operand
 *      $           an operand (either read from the instruction stream or
 *                  baked into the handler as a constant)
 *      PC TH TPL HND FSZ PFP RDST      current frame slots
 *      STR($,$)    decoded constant-pool value
 *      STACK FP SP BC POOL GLOBAL CELLS
 *
 * Two handlers that do the same thing collapse onto the same string, which is
 * what the opcode table below is keyed on.  `slots` records, in printed order,
 * whether each `$` comes from the stream (and at which read position) or is a
 * constant (and its value).
 * ========================================================================== */

const SLOT_TAG = "$";

function canonicalize(fnNode, vm) {
  const fn = clone(fnNode);

  /* --- pre-pass: number the instruction-stream reads in evaluation order -- */
  let readCounter = 0;
  const readOf = new Map();
  (function order(node) {
    if (Array.isArray(node)) { for (const n of node) order(n); return; }
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      if (node.callee.name === vm.readFn) { readOf.set(node, readCounter++); return; }
      if (node.callee.name === vm.strFn && node.arguments.length <= 1) {
        // y(vm) reads the pool index first, then the key
        readOf.set(node, [readCounter++, readCounter++]);
        return;
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "type") continue;
      order(node[k]);
    }
  })(fn.body);

  const root = t.file(t.program([t.expressionStatement(
    t.functionExpression(null, [], fn.body))]));

  /* --- alias discovery: `a = this.stack`, `b = a[this.fp + regBase]` ------ */
  const aliases = new Map();
  traverse(root, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!n.init || n.id.type !== "Identifier") return;
      const i = n.init;
      if (isThisMember(i, vm.stackProp)) aliases.set(n.id.name, "STACK");
      else if (isThisMember(i, vm.fpProp)) aliases.set(n.id.name, "FP");
      else if (i.type === "MemberExpression" && i.computed) {
        const o = i.object, pr = i.property;
        const oStack = (o.type === "Identifier" && aliases.get(o.name) === "STACK") ||
          isThisMember(o, vm.stackProp);
        if (!oStack) return;
        if (pr.type !== "BinaryExpression" || pr.operator !== "+") return;
        if (pr.right.type !== "NumericLiteral" || pr.right.value !== vm.regBaseOff) return;
        const l = pr.left;
        if ((l.type === "Identifier" && aliases.get(l.name) === "FP") ||
            isThisMember(l, vm.fpProp)) aliases.set(n.id.name, "RB");
      }
    },
  });

  const nameOfSlot = {};
  for (const [k, v] of Object.entries(vm.slots)) {
    if (v == null) continue;
    nameOfSlot[v] = { pc: "PC", prevFp: "PFP", retDst: "RDST", thisVal: "TH",
      template: "TPL", frameSize: "FSZ", frameEnd: "FEND", regBase: "RBS",
      handlers: "HND" }[k] || "S" + v;
  }

  const isStack = (n) =>
    (n.type === "Identifier" && (aliases.get(n.name) === "STACK" || n.name === "STACK")) ||
    isThisMember(n, vm.stackProp);
  const isFp = (n) =>
    (n.type === "Identifier" && (aliases.get(n.name) === "FP" || n.name === "FP")) ||
    isThisMember(n, vm.fpProp);
  const isRB = (n) =>
    n.type === "Identifier" && (aliases.get(n.name) === "RB" || n.name === "RB");

  const slotMeta = new Map();
  const mkSlot = (meta) => {
    const id = t.identifier(SLOT_TAG);
    slotMeta.set(id, meta);
    return id;
  };

  const thisProps = {
    [vm.bcProp]: "BC", [vm.poolProp]: "POOL", [vm.globalProp]: "GLOBAL",
    [vm.spProp]: "SP", [vm.cellsProp]: "CELLS", [vm.stackProp]: "STACK",
    [vm.fpProp]: "FP",
  };

  traverse(root, {
    exit(p) {
      const n = p.node;

      if (n.type === "CallExpression" && n.callee.type === "Identifier") {
        const cn = n.callee.name;
        if (cn === vm.readFn) {
          p.replaceWith(mkSlot({ stream: true, read: readOf.get(n) }));
          return;
        }
        if (cn === vm.strFn) {
          if (n.arguments.length <= 1) {
            const pair = readOf.get(n) || [0, 0];
            p.replaceWith(t.callExpression(t.identifier("STR"), [
              mkSlot({ stream: true, read: pair[0] }),
              mkSlot({ stream: true, read: pair[1] }),
            ]));
          } else {
            const key = n.arguments[1], idx = n.arguments[2];
            p.replaceWith(t.callExpression(t.identifier("STR"), [
              mkSlot({ stream: false, value: literalValue(idx) }),
              mkSlot({ stream: false, value: literalValue(key) }),
            ]));
          }
          return;
        }
        const renames = {
          [vm.pushFrameFn]: "PUSHFRAME", [vm.closeFn]: "CLOSE",
          [vm.loopFn]: "RUN", [vm.b64Fn]: "B64",
        };
        if (own(renames, cn)) {
          n.callee = t.identifier(renames[cn]);
          n.arguments = stripJunkArgs(n.arguments);
          return;
        }
      }

      if (n.type === "NewExpression" && n.callee.type === "Identifier") {
        const renames = { [vm.tplCtor]: "TPLCTOR", [vm.vmCtor]: "VMCTOR",
          [vm.cellCtor]: "CELLCTOR" };
        if (own(renames, n.callee.name)) {
          n.callee = t.identifier(renames[n.callee.name]);
          if (n.callee.name === "VMCTOR")
            n.arguments = stripJunkArgs(n.arguments);
        }
      }

      if ((n.type === "CallExpression" || n.type === "NewExpression") &&
          n.callee.type === "Identifier" &&
          ["PUSHFRAME", "CLOSE", "MKCELL", "RUN", "VMCTOR"].includes(n.callee.name)) {
        n.arguments = stripJunkArgs(n.arguments);
      }

      if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
        const cellProps = {
          [vm.tplCapsProp]: "caps", [vm.cellArrProp]: "arr",
          [vm.cellIdxProp]: "idx", [vm.cellMatProp]: "mat", [vm.cellValProp]: "val",
        };
        if (own(cellProps, n.property.name) && n.object.type !== "ThisExpression")
          n.property = t.identifier(cellProps[n.property.name]);
      }

      if (n.type === "Identifier" && n.name === vm.tplMapVar &&
          !(p.parentPath.isMemberExpression({ property: n }) && !p.parent.computed)) {
        p.replaceWith(t.identifier("TPLMAP"));
        return;
      }

      if (isThisMember(n) && own(thisProps, n.property.name)) {
        p.replaceWith(t.identifier(thisProps[n.property.name]));
        return;
      }
      if (isThisMember(n, vm.cellFn)) { p.replaceWith(t.identifier("MKCELL")); return; }

      if (n.type !== "MemberExpression" || !n.computed) return;
      const pr = n.property;
      if (pr.type !== "BinaryExpression" || pr.operator !== "+") return;
      if (!isStack(n.object)) return;
      if (isFp(pr.left) && pr.right.type === "NumericLiteral") {
        const nm = own(nameOfSlot, pr.right.value) ? nameOfSlot[pr.right.value] : null;
        p.replaceWith(t.identifier(nm || "S" + pr.right.value));
        return;
      }
      if (isRB(pr.left) || (pr.left.type === "Identifier" && pr.left.name === "RBS")) {
        p.replaceWith(t.memberExpression(t.identifier("R"), pr.right, true));
      }
    },
  });

  /* --- alias variables are now redundant --------------------------------- */
  traverse(root, {
    VariableDeclarator(p) {
      const i = p.node.init;
      if (i && i.type === "Identifier" && ["STACK", "FP", "RBS"].includes(i.name)) p.remove();
    },
    Identifier(p) {
      const tag = aliases.get(p.node.name);
      if (!tag) return;
      if (p.parentPath.isVariableDeclarator({ id: p.node })) return;
      if (p.parentPath.isMemberExpression({ property: p.node }) && !p.parent.computed) return;
      if (p.parentPath.isObjectProperty({ key: p.node }) && !p.parent.computed) return;
      p.node.name = tag === "RB" ? "RBS" : tag;
    },
  });
  dropEmptyDeclarations(root);

  /* --- inline single-use temporaries so specialized and generic variants of
         the same opcode collapse onto one shape ------------------------- */
  for (let guard = 0; guard < 40; guard++) {
    const fnPath = firstFunctionPath(root);
    fnPath.scope.crawl();
    let did = false;
    for (const name of Object.keys(fnPath.scope.bindings)) {
      const b = fnPath.scope.bindings[name];
      if (!b.constant || b.references !== 1) continue;
      if (b.path.type !== "VariableDeclarator" || !b.path.node.init) continue;
      const ref = b.referencePaths[0];
      if (!ref.node || ref.removed) continue;
      let inLoop = false;
      for (let cur = ref; cur && cur.node !== fnPath.node; cur = cur.parentPath)
        if (/^(For|While|DoWhile)/.test(cur.node.type)) inLoop = true;
      if (inLoop) continue;
      const init = b.path.node.init;
      b.path.remove();
      ref.replaceWith(init);
      did = true;
      break;
    }
    if (!did) break;
  }
  dropEmptyDeclarations(root);

  /* --- remaining numeric literals become constant operand slots ---------- */
  traverse(root, {
    NumericLiteral(p) {
      p.replaceWith(mkSlot({ stream: false, value: p.node.value }));
      p.skip();
    },
  });

  /* --- normalize local names --------------------------------------------- */
  {
    const fnPath = firstFunctionPath(root);
    fnPath.scope.crawl();
    let i = 0;
    for (const name of Object.keys(fnPath.scope.bindings)) fnPath.scope.rename(name, "v" + i++);
  }

  /* --- collect slots in printed order ------------------------------------ */
  const slots = [];
  traverse(root, {
    Identifier(p) {
      if (p.node.name !== SLOT_TAG) return;
      slots.push(slotMeta.get(p.node) || { stream: false, value: 0 });
    },
  });

  const body = firstFunctionPath(root).node.body.body;
  const canon = generate(t.program(body), { compact: true, comments: false }).code;
  const streams = slots.filter((s) => s.stream).length;
  return { canon, slots, streams };
}

function stripJunkArgs(args) {
  const out = args.map((a) => (isJunkLiteral(a) ? t.identifier("_") : a));
  while (out.length && out[out.length - 1].type === "Identifier" &&
         out[out.length - 1].name === "_") out.pop();
  return out;
}

function isJunkLiteral(a) {
  return (
    a.type === "StringLiteral" || a.type === "NullLiteral" ||
    (a.type === "ArrayExpression" && a.elements.length === 0) ||
    (a.type === "ObjectExpression" && a.properties.length === 0) ||
    (a.type === "UnaryExpression" && a.operator === "void")
  );
}

function dropEmptyDeclarations(root) {
  traverse(root, {
    VariableDeclaration(p) { if (p.node.declarations.length === 0) p.remove(); },
  });
}

function firstFunctionPath(root) {
  let res = null;
  traverse(root, { FunctionExpression(p) { if (!res) res = p; p.stop(); } });
  return res;
}

/* ========================================================================== *
 * 4. opcode semantics
 *
 * Each canonical shape is mapped to an instruction descriptor.  `roles` name
 * the printed operand positions; `fixed` is how many words the instruction
 * eats before any variable-length tail.
 * ========================================================================== */

const BIN = {
  "R[$]=R[$]+R[$];": "+", "R[$]=R[$]-R[$];": "-", "R[$]=R[$]*R[$];": "*",
  "R[$]=R[$]/R[$];": "/", "R[$]=R[$]%R[$];": "%", "R[$]=R[$]&R[$];": "&",
  "R[$]=R[$]|R[$];": "|", "R[$]=R[$]^R[$];": "^", "R[$]=R[$]<<R[$];": "<<",
  "R[$]=R[$]>>R[$];": ">>", "R[$]=R[$]>>>R[$];": ">>>", "R[$]=R[$]<R[$];": "<",
  "R[$]=R[$]>R[$];": ">", "R[$]=R[$]<=R[$];": "<=", "R[$]=R[$]>=R[$];": ">=",
  "R[$]=R[$]==R[$];": "==", "R[$]=R[$]!=R[$];": "!=", "R[$]=R[$]===R[$];": "===",
  "R[$]=R[$]!==R[$];": "!==", "R[$]=R[$]in R[$];": "in",
  "R[$]=R[$]instanceof R[$];": "instanceof", "R[$]=Math.pow(R[$],R[$]);": "**",
};

const BIN_ASSIGN = {
  "R[$]+=R[$];": "+", "R[$]-=R[$];": "-", "R[$]*=R[$];": "*",
  "R[$]/=R[$];": "/", "R[$]%=R[$];": "%", "R[$]&=R[$];": "&",
  "R[$]|=R[$];": "|", "R[$]^=R[$];": "^", "R[$]<<=R[$];": "<<",
  "R[$]>>=R[$];": ">>", "R[$]>>>=R[$];": ">>>",
};

const UN = {
  "R[$]=!R[$];": "!", "R[$]=-R[$];": "-", "R[$]=+R[$];": "+",
  "R[$]=~R[$];": "~", "R[$]=typeof R[$];": "typeof",
};

/** Turn a canonical shape + its slot list into an instruction decoder. */
function specFor(canon, slots, vm, handlerNode) {
  const nStream = slots.filter((s) => s.stream).length;
  const mk = (fixed, kind, extra) => ({ kind, fixed, ...extra });

  if (own(BIN, canon)) return mk(nStream, "binop", { op: BIN[canon], roles: { dst: 0, a: 1, b: 2 } });
  if (own(BIN_ASSIGN, canon))
    return mk(nStream, "binop", { op: BIN_ASSIGN[canon], roles: { dst: 0, a: 0, b: 1 } });
  if (own(UN, canon)) return mk(nStream, "unop", { op: UN[canon], roles: { dst: 0, a: 1 } });

  switch (canon) {
    case "R[$]=R[$];":            return mk(nStream, "move",        { roles: { dst: 0, src: 1 } });
    case "R[$]=$;":               return mk(nStream, "loadImm",     { roles: { dst: 0, value: 1 } });
    case "R[$]=TH;":              return mk(nStream, "loadThis",    { roles: { dst: 0 } });
    case "$;R[$]=void $;":        return mk(nStream, "loadUndef",   { roles: { dst: 1 } });
    case "R[$]=STR($,$);":        return mk(nStream, "loadConst",   { roles: { dst: 0, index: 1, key: 2 } });
    case "R[$]=R[$][R[$]];":      return mk(nStream, "getMember",   { roles: { dst: 0, obj: 1, key: 2 } });
    case "Reflect.set(R[$],R[$],R[$]);":
      return mk(nStream, "setMember", { roles: { obj: 0, key: 1, val: 2 } });
    case "STACK=R[$];Reflect.set(R[$],R[$],STACK);":
      return mk(nStream, "setMember", { roles: { val: 0, obj: 1, key: 2 } });
    case "R[$]=delete R[$][R[$]];":
      return mk(nStream, "deleteMember", { roles: { dst: 0, obj: 1, key: 2 } });
    case "PC=$;":                 return mk(nStream, "jump",        { roles: { target: 0 } });
    case "R[$]||(PC=$);":         return mk(nStream, "branch",      { negate: true,  roles: { cond: 0, target: 1 } });
    case "R[$]&&(PC=$);":         return mk(nStream, "branch",      { negate: false, roles: { cond: 0, target: 1 } });
    case "PC=R[$];":              return mk(nStream, "jumpIndirect",{ roles: { reg: 0 } });
    case "throw R[$];":           return mk(nStream, "throw",       { roles: { src: 0 } });
    case "HND.pop();":            return mk(0, "popHandler",        { roles: {} });
    case "debugger;":             return mk(0, "debugger",          { roles: {} });
    case "var v0=HND;v0||(HND=v0=[]);v0.push({G:$,B:$});":
      return mk(nStream, "pushCatch",  { roles: { target: 0, reg: 1 } });
    case "var v0=HND;v0||(HND=v0=[]);v0.push({H:$,F:$,k:$,D:$});":
      return mk(nStream, "pushFinally", { roles: { target: 0, regKind: 1, regVal: 2, kindThrow: 3 } });
    case "GLOBAL[STR($,$)]=R[$];":
      return mk(nStream, "storeGlobal", { roles: { index: 0, key: 1, src: 2 } });
    case "FP=TPL.caps[$];R[$]=FP.mat?FP.val:FP.arr[FP.idx];":
      return mk(nStream, "loadCell",  { roles: { cell: 0, dst: 1 } });
    case "FP=TPL.caps[$];STACK=R[$];FP.mat?FP.val=STACK:FP.arr[FP.idx]=STACK;FP.f={};":
      return mk(nStream, "storeCell", { roles: { cell: 0, src: 1 } });
    case "var v0=R[$];v0.u>=v0.b.length?PC=$:R[$]=v0.b[v0.u++];":
      return mk(nStream, "forInNext", { roles: { iter: 0, target: 1, dst: 2 } });
  }

  if (/^var v0=STR\(\$,\$\);if\(!\(v0 in GLOBAL\)\)throw new ReferenceError/.test(canon))
    return mk(nStream, "loadGlobal", { roles: { index: 0, key: 1, dst: 2 } });
  if (/^var v0=STR\(\$,\$\);v0=Object\.prototype\.hasOwnProperty/.test(canon))
    return mk(nStream, "typeofGlobal", { roles: { index: 0, key: 1, dst: 3 } });
  if (/^var v0=R\[\$\];CLOSE\(/.test(canon))
    return mk(nStream, "return", { roles: { src: 0 } });
  if (/^var v0=R\[\$\],v1=\[\];if\(v0!==null/.test(canon))
    return mk(nStream, "forInInit", { roles: { obj: 0, dst: 4 } });
  if (/Object\.defineProperty\(v0,v1,RBS\);$/.test(canon))
    return mk(nStream, /\{set:RBS/.test(canon) ? "defineSetter" : "defineGetter",
      { roles: { obj: 0, key: 1, fn: 2 } });
  if (/^for\(var v0=\$,v1=\$,v2=\$,v3=\$\^v0\|\$,v4=v1;/.test(canon))
    return mk(nStream, "decrypt", { roles: { dest: 0, from: 1, to: 2, key: 3 } });
  if (/^for\(var v0=\$,v1=Array\(v0\),v2=\$;v2<v0;v2\+\+\)v1\[v2\]=R\[\$\];R\[\$\]=v1;$/.test(canon))
    return mk(2, "arrayLit", { roles: { count: 0, dst: 3 } });
  if (/^for\(var v0=\$,v1=\{\},v2=\$;v2<v0;v2\+\+\)\{var v3=R\[\$\],v4=R\[\$\];v1\[v3\]=v4;\}R\[\$\]=v1;$/.test(canon))
    return mk(2, "objectLit", { roles: { count: 0, dst: 4 } });
  if (/PUSHFRAME\(this,v\d+,v0<<\$\|\$/.test(canon))
    return mk(3, "construct", { roles: { dst: 0, callee: 1, argc: 2, spreadHint: 3 } });
  if (/PUSHFRAME\(this,v3,v0<<\$,_,_,v4,v1\)/.test(canon))
    return mk(4, "methodCall", { roles: { dst: 0, obj: 1, callee: 2, argc: 3, spreadHint: 4 } });
  if (/PUSHFRAME\(this,v2,v0<<\$,_,_,v3,GLOBAL\)/.test(canon))
    return mk(3, "call", { roles: { dst: 0, callee: 1, argc: 2, spreadHint: 3 } });
  if (/^for\(var v0=\$,v1=\$,v2=\$,v3=Array\(v2\)/.test(canon) && /TPLCTOR/.test(canon))
    return mk(6, "makeFunction",
      { roles: { entry: 0, params: 1, nCaps: 2, regs: 6, hasRest: 7, dst: 10 } });
  if (/^var v0=R\[\$\],v1=R\[\$\];v0=~~v0;v1=~~v1;R\[\$\]=/.test(canon))
    return mk(nStream, "mba", { roles: { a: 0, b: 1, dst: 2 }, node: handlerNode });

  return mk(nStream, "unknown", { roles: {}, canon });
}

/**
 * The mixed boolean-arithmetic handlers hide one plain int32 operation behind a
 * page of algebra.  Evaluate the expression on sample inputs (with a tiny
 * interpreter — never eval) and match it against the candidate operators.
 */
const MBA_CANDIDATES = [
  ["+", (a, b) => (a + b) | 0], ["-", (a, b) => (a - b) | 0],
  ["*", (a, b) => Math.imul(a, b)], ["^", (a, b) => a ^ b],
  ["&", (a, b) => a & b], ["|", (a, b) => a | b],
  ["<<", (a, b) => a << b], [">>", (a, b) => a >> b], [">>>", (a, b) => (a >>> b) | 0],
];

function identifyMBA(handlerNode, vm) {
  // last statement is `regs[base + dst] = <expr>` over the two int32 locals
  let expr = null, aName = null, bName = null;
  const body = handlerNode.body.body;
  for (const st of body) {
    if (st.type !== "ExpressionStatement") continue;
    const e = st.expression;
    if (e.type !== "AssignmentExpression") continue;
    if (e.right.type === "UnaryExpression" && e.right.operator === "~" &&
        e.right.argument.type === "UnaryExpression" && e.left.type === "Identifier") {
      if (aName === null) aName = e.left.name;
      else if (bName === null) bName = e.left.name;
      continue;
    }
    if (e.left.type === "MemberExpression") expr = e.right;
  }
  if (!expr || aName === null || bName === null) return null;

  const evalNode = (n, a, b) => {
    switch (n.type) {
      case "NumericLiteral": return n.value;
      case "Identifier":
        if (n.name === aName) return a;
        if (n.name === bName) return b;
        throw new Error("unknown identifier " + n.name);
      case "UnaryExpression": {
        const v = evalNode(n.argument, a, b);
        if (n.operator === "~") return ~v;
        if (n.operator === "-") return -v;
        if (n.operator === "+") return +v;
        throw new Error("unary " + n.operator);
      }
      case "BinaryExpression": {
        const l = evalNode(n.left, a, b), r = evalNode(n.right, a, b);
        switch (n.operator) {
          case "+": return l + r; case "-": return l - r; case "*": return l * r;
          case "/": return l / r; case "%": return l % r;
          case "&": return l & r; case "|": return l | r; case "^": return l ^ r;
          case "<<": return l << r; case ">>": return l >> r; case ">>>": return l >>> r;
          default: throw new Error("binary " + n.operator);
        }
      }
      default: throw new Error("node " + n.type);
    }
  };

  const samples = [
    [0, 0], [1, 0], [0, 1], [1, 1], [2, 3], [7, 5], [-1, 1], [123456, 789],
    [-98765, 4321], [0x7fffffff, 3], [-2147483648, 17], [65535, 65535],
    [305419896, 2271560481 | 0], [15, 4], [1000, 1000],
  ];
  let got;
  try {
    got = samples.map(([a, b]) => evalNode(expr, a | 0, b | 0) | 0);
  } catch { return null; }
  for (const [op, fn] of MBA_CANDIDATES) {
    if (samples.every(([a, b], i) => (fn(a | 0, b | 0) | 0) === got[i])) return op;
  }
  return null;
}

/* ========================================================================== *
 * 5. disassembler
 * ========================================================================== */

/** int32 ops that JS already performs int32-truncated, so the `~~` is implicit */
const INT32_NATIVE = new Set(["^", "&", "|", "<<", ">>", ">>>"]);

function buildOpcodeMap(vm) {
  const map = new Map();
  for (const [op, fn] of vm.handlers) {
    const { canon, slots } = canonicalize(fn, vm);
    const spec = specFor(canon, slots, vm, fn);
    spec.slots = slots;
    if (spec.kind === "mba") {
      const real = identifyMBA(fn, vm);
      if (real) {
        spec.kind = "binop";
        spec.op = real;
        spec.int32 = !INT32_NATIVE.has(real);
        spec.roles = { dst: spec.roles.dst, a: spec.roles.a, b: spec.roles.b };
      }
    }
    map.set(op, spec);
  }
  return map;
}

function disassemble(payload, opmap) {
  const words = Uint32Array.from(payload.words);
  const functions = new Map(); // entry pc -> function record
  const decrypted = new Set();
  const pending = [];

  function requestFunction(rec) {
    const existing = functions.get(rec.entry);
    if (existing) return existing;
    functions.set(rec.entry, rec);
    pending.push(rec);
    return rec;
  }

  const top = requestFunction({
    entry: payload.entry.v | 0,
    params: payload.entry.p | 0,
    regs: payload.entry.e | 0,
    hasRest: false,
    id: 0,
    top: true,
    insts: new Map(),
  });

  let nextId = 1;
  while (pending.length) {
    const fn = pending.shift();
    walk(fn);
  }

  function walk(fn) {
    const work = [fn.entry];
    const seen = fn.insts;
    while (work.length) {
      const pc = work.pop();
      if (seen.has(pc)) continue;
      if (pc >= words.length) continue;
      const inst = decodeAt(pc, fn);
      seen.set(pc, inst);
      for (const s of successorsOf(inst)) if (s != null && !seen.has(s)) work.push(s);
    }
  }

  function decodeAt(pc, fn) {
    const op = words[pc];
    const spec = opmap.get(op);
    if (!spec) {
      const e = new Error(`unknown opcode ${op} at pc ${pc}`);
      e.pc = pc;
      throw e;
    }
    let p = pc + 1;
    const raw = [];
    for (let i = 0; i < spec.fixed; i++) raw.push(words[p++]);
    const R = spec.roles;
    const get = (pos) => {
      const s = spec.slots[pos];
      return s.stream ? raw[s.read] : s.value;
    };
    const inst = { pc, op, kind: spec.kind, spec };

    switch (spec.kind) {
      case "binop":
        inst.dst = get(R.dst); inst.a = get(R.a); inst.b = get(R.b);
        inst.op = spec.op; inst.int32 = !!spec.int32;
        break;
      case "unop":
        inst.dst = get(R.dst); inst.a = get(R.a); inst.op = spec.op;
        break;
      case "move":       inst.dst = get(R.dst); inst.src = get(R.src); break;
      case "loadImm":    inst.dst = get(R.dst); inst.value = get(R.value); break;
      case "loadThis":
      case "loadUndef":  inst.dst = get(R.dst); break;
      case "loadConst":
        inst.dst = get(R.dst); inst.index = get(R.index); inst.key = get(R.key); break;
      case "loadGlobal":
      case "typeofGlobal":
        inst.dst = get(R.dst); inst.index = get(R.index); inst.key = get(R.key); break;
      case "storeGlobal":
        inst.src = get(R.src); inst.index = get(R.index); inst.key = get(R.key); break;
      case "getMember":
        inst.dst = get(R.dst); inst.obj = get(R.obj); inst.key = get(R.key); break;
      case "setMember":
        inst.obj = get(R.obj); inst.key = get(R.key); inst.val = get(R.val); break;
      case "deleteMember":
        inst.dst = get(R.dst); inst.obj = get(R.obj); inst.key = get(R.key); break;
      case "defineGetter":
      case "defineSetter":
        inst.obj = get(R.obj); inst.key = get(R.key); inst.fn = get(R.fn); break;
      case "jump":       inst.target = get(R.target); break;
      case "branch":
        inst.cond = get(R.cond); inst.target = get(R.target);
        inst.negate = !!spec.negate; break;
      case "jumpIndirect": inst.reg = get(R.reg); break;
      case "throw":      inst.src = get(R.src); break;
      case "return":     inst.src = get(R.src); break;
      case "popHandler":
      case "debugger":   break;
      case "pushCatch":
        inst.target = get(R.target); inst.reg = get(R.reg); break;
      case "pushFinally":
        inst.target = get(R.target); inst.regKind = get(R.regKind);
        inst.regVal = get(R.regVal); inst.kindThrow = get(R.kindThrow); break;
      case "loadCell":   inst.cell = get(R.cell); inst.dst = get(R.dst); break;
      case "storeCell":  inst.cell = get(R.cell); inst.src = get(R.src); break;
      case "forInInit":  inst.obj = get(R.obj); inst.dst = get(R.dst); break;
      case "forInNext":
        inst.iter = get(R.iter); inst.target = get(R.target); inst.dst = get(R.dst); break;
      case "arrayLit": {
        inst.dst = get(R.dst);
        const n = get(R.count);
        inst.elems = [];
        for (let i = 0; i < n; i++) inst.elems.push(words[p++]);
        break;
      }
      case "objectLit": {
        inst.dst = get(R.dst);
        const n = get(R.count);
        inst.pairs = [];
        for (let i = 0; i < n; i++) {
          const k = words[p++], v = words[p++];
          inst.pairs.push([k, v]);
        }
        break;
      }
      case "call":
      case "construct":
      case "methodCall": {
        inst.dst = get(R.dst);
        inst.callee = get(R.callee);
        if (spec.kind === "methodCall") inst.obj = get(R.obj);
        const argc = get(R.argc);
        const hint = get(R.spreadHint);
        inst.args = [];
        if (argc === hint) {
          inst.spread = true;
          inst.args.push(words[p++]);
        } else {
          for (let i = 0; i < argc; i++) inst.args.push(words[p++]);
        }
        break;
      }
      case "makeFunction": {
        inst.dst = get(R.dst);
        inst.entry = get(R.entry);
        inst.params = get(R.params);
        inst.regs = get(R.regs);
        inst.hasRest = !!get(R.hasRest);
        const n = get(R.nCaps);
        inst.captures = [];
        for (let i = 0; i < n; i++) {
          const own_ = words[p++], idx = words[p++];
          inst.captures.push({ own: !!own_, idx });
        }
        inst.fn = requestFunction({
          entry: inst.entry, params: inst.params, regs: inst.regs,
          hasRest: inst.hasRest, id: nextId++, insts: new Map(),
        });
        inst.fn.sites = (inst.fn.sites || 0) + 1;
        break;
      }
      case "decrypt": {
        inst.dest = get(R.dest); inst.from = get(R.from);
        inst.to = get(R.to); inst.keyRaw = get(R.key);
        const tag = `${inst.dest}:${inst.from}:${inst.to}:${inst.keyRaw}`;
        if (!decrypted.has(tag)) {
          decrypted.add(tag);
          let c = (inst.keyRaw ^ inst.dest) | 0;
          for (let d = inst.from; d < inst.to; d++) {
            c = (c + 2654435769) | 0;
            words[inst.dest + (d - inst.from)] = (words[d] ^ c ^ (c >>> 13)) >>> 0;
          }
        }
        break;
      }
      default:
        break;
    }
    inst.size = p - pc;
    inst.next = pc + inst.size;
    return inst;
  }

  function successorsOf(inst) {
    switch (inst.kind) {
      case "jump":   return [inst.target];
      case "branch": return [inst.target, inst.next];
      case "forInNext": return [inst.target, inst.next];
      case "return":
      case "throw":  return [];
      case "jumpIndirect": return [];       // resolved later from reaching consts
      default:       return [inst.next];
    }
  }

  return { words, functions, top, walk };
}

/* ========================================================================== *
 * 6. control-flow recovery (relooper)
 *
 * Input : blocks with `stmts` and `branches` ([{to, cond, code}], the last one
 *         being the unconditional default).
 * Output: a plain JS statement list using labelled loops, `break`/`continue`
 *         and — only where a CFG genuinely needs it — a `_lbl` dispatch var.
 *
 * This is the algorithm from Emscripten's Relooper: Simple / Loop / Multiple
 * shapes, which is correct for arbitrary (even irreducible) graphs.
 * ========================================================================== */

class Block {
  constructor(id) {
    this.id = id;
    this.stmts = [];
    this.branches = new Map();   // to -> {cond, code}
    this.processed = new Map();  // to -> {cond, code, type, ancestor}
  }
  addBranch(to, cond, code) {
    if (this.branches.has(to)) {
      // a conditional and its fallthrough can hit the same block
      const b = this.branches.get(to);
      if (b.cond && cond === null) b.cond = null;
      return;
    }
    this.branches.set(to, { cond: cond || null, code: code || null });
  }
}

function reloop(blockMap, entryId) {
  let shapeSeq = 0;
  const preds = new Map();
  for (const b of blockMap.values()) preds.set(b.id, new Set());
  for (const b of blockMap.values())
    for (const to of b.branches.keys()) preds.get(to).add(b.id);

  const inWithin = (id, blocks) => {
    const out = [];
    for (const p of preds.get(id)) if (blocks.has(p)) out.push(p);
    return out;
  };

  function solipsize(target, type, ancestor, from) {
    for (const id of [...preds.get(target)]) {
      if (!from.has(id)) continue;
      const blk = blockMap.get(id);
      const br = blk.branches.get(target);
      if (!br) continue;
      blk.branches.delete(target);
      preds.get(target).delete(id);
      blk.processed.set(target, { ...br, type, ancestor });
    }
  }

  function process(blocks, entries, prev) {
    let ret = null;
    let cur = prev;
    let curEntries = entries;

    for (;;) {
      if (curEntries.size === 0) return ret;
      const nextEntries = new Set();
      let shape = null;

      if (curEntries.size === 1) {
        const id = [...curEntries][0];
        if (inWithin(id, blocks).length === 0) {
          shape = makeSimple(blocks, id, nextEntries);
        } else {
          shape = makeLoop(blocks, curEntries, nextEntries);
        }
      } else {
        const groups = findIndependentGroups(blocks, curEntries);
        if (groups.size > 0) shape = makeMultiple(blocks, curEntries, groups, nextEntries);
        else shape = makeLoop(blocks, curEntries, nextEntries);
      }

      if (cur) cur.next = shape;
      if (!ret) ret = shape;
      if (nextEntries.size === 0) return ret;
      cur = shape;
      curEntries = nextEntries;
    }
  }

  function makeSimple(blocks, id, nextEntries) {
    const shape = { kind: "simple", id: shapeSeq++, block: blockMap.get(id), next: null };
    blocks.delete(id);
    for (const to of blockMap.get(id).branches.keys())
      if (blocks.has(to)) nextEntries.add(to);
    return shape;
  }

  function makeLoop(blocks, entries, nextEntries) {
    const inner = new Set();
    const queue = [...entries];
    while (queue.length) {
      const id = queue.pop();
      if (inner.has(id)) continue;
      if (!blocks.has(id)) continue;
      inner.add(id);
      for (const p of inWithin(id, blocks)) if (!inner.has(p)) queue.push(p);
    }
    if (inner.size === 0) for (const e of entries) inner.add(e);
    for (const id of inner) blocks.delete(id);

    for (const id of inner)
      for (const to of blockMap.get(id).branches.keys())
        if (!inner.has(to)) nextEntries.add(to);

    const shape = { kind: "loop", id: shapeSeq++, inner: null, next: null,
      label: null, needBreak: false, needContinue: false };
    for (const e of entries) solipsize(e, "continue", shape, inner);
    for (const n of nextEntries) solipsize(n, "break", shape, inner);
    shape.inner = process(inner, entries, null);
    return shape;
  }

  function findIndependentGroups(blocks, entries) {
    const owner = new Map();   // block -> entry that owns it (or null if shared)
    const queue = [];
    for (const e of entries) { owner.set(e, e); queue.push(e); }
    while (queue.length) {
      const id = queue.shift();
      const own_ = owner.get(id);
      if (own_ === null) continue;
      for (const to of blockMap.get(id).branches.keys()) {
        if (!blocks.has(to)) continue;
        if (entries.has(to)) continue;
        if (!owner.has(to)) { owner.set(to, own_); queue.push(to); }
        else if (owner.get(to) !== own_ && owner.get(to) !== null) {
          owner.set(to, null); queue.push(to);
        }
      }
    }
    // Any block (entry included) that can be reached from outside its own group
    // cannot live inside a Multiple handler — jumping back in is impossible.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, own_] of owner) {
        if (own_ === null) continue;
        for (const p of inWithin(id, blocks)) {
          if (owner.get(p) !== own_) { owner.set(id, null); changed = true; break; }
        }
      }
    }
    const groups = new Map();
    for (const e of entries) if (owner.get(e) === e) groups.set(e, new Set());
    for (const [id, own_] of owner) {
      if (own_ === null || !groups.has(own_)) continue;
      groups.get(own_).add(id);
    }
    for (const [e, g] of [...groups]) if (g.size === 0) groups.delete(e);
    return groups;
  }

  function makeMultiple(blocks, entries, groups, nextEntries) {
    const shape = { kind: "multiple", id: shapeSeq++, handled: new Map(),
      next: null, label: null, needBreak: false };
    for (const [entry, group] of groups) {
      for (const id of group) blocks.delete(id);
      for (const id of group)
        for (const to of blockMap.get(id).branches.keys())
          if (!group.has(to)) nextEntries.add(to);
      // entering the group from outside jumps straight in; leaving it exits
      for (const n of [...nextEntries]) solipsize(n, "break", shape, group);
      shape.handled.set(entry, process(group, new Set([entry]), null));
    }
    for (const e of entries) if (!groups.has(e)) nextEntries.add(e);
    return shape;
  }

  const allBlocks = new Set(blockMap.keys());
  const root = process(allBlocks, new Set([entryId]), null);
  return root;
}

/* --- rendering ------------------------------------------------------------
 *
 * Deliberately conservative: every loop / multiple gets a label and every
 * non-fallthrough edge assigns the dispatch variable.  A later pass drops the
 * labels and assignments that turn out to be unnecessary, which is far easier
 * to get right than predicting them here.
 * -------------------------------------------------------------------------- */

const LABEL_VAR = "_lbl";

function renderShape(root) {
  let labelSeq = 0;
  nameShapes(root);
  const out = [];
  render(root, out);
  return out;

  function nameShapes(shape) {
    while (shape) {
      if (shape.kind === "loop") { shape.label = "L" + labelSeq++; nameShapes(shape.inner); }
      else if (shape.kind === "multiple") {
        shape.label = "L" + labelSeq++;
        for (const sub of shape.handled.values()) nameShapes(sub);
      }
      shape = shape.next;
    }
  }

  /** the block a shape begins with, if control simply falls into it */
  function naturalEntry(shape) {
    while (shape) {
      if (shape.kind === "simple") return shape.block.id;
      if (shape.kind === "loop") { shape = shape.inner; continue; }
      return null;
    }
    return null;
  }

  function render(shape, out) {
    while (shape) {
      if (shape.kind === "simple") {
        out.push(...shape.block.stmts);
        renderBranches(shape.block, out, naturalEntry(shape.next));
        shape = shape.next;
        continue;
      }
      if (shape.kind === "loop") {
        const body = [];
        render(shape.inner, body);
        out.push(t.labeledStatement(t.identifier(shape.label),
          t.whileStatement(t.booleanLiteral(true), t.blockStatement(body))));
        shape = shape.next;
        continue;
      }
      if (shape.kind === "multiple") {
        const entries = [...shape.handled.entries()];
        let stmt = null;
        for (let i = entries.length - 1; i >= 0; i--) {
          const [id, sub] = entries[i];
          const body = [];
          render(sub, body);
          stmt = t.ifStatement(
            t.binaryExpression("===", t.identifier(LABEL_VAR), t.numericLiteral(id)),
            t.blockStatement(body), stmt);
        }
        if (stmt)
          out.push(t.labeledStatement(t.identifier(shape.label),
            t.doWhileStatement(t.booleanLiteral(false), t.blockStatement([stmt]))));
        shape = shape.next;
        continue;
      }
      throw new Error("unknown shape " + shape.kind);
    }
  }

  function edgeStmts(block, to, br, fallthrough) {
    const stmts = br.code ? [...br.code] : [];
    const proc = block.processed.get(to);
    if (proc) {
      stmts.push(t.expressionStatement(t.assignmentExpression("=",
        t.identifier(LABEL_VAR), t.numericLiteral(to))));
      stmts.push(proc.type === "continue"
        ? t.continueStatement(t.identifier(proc.ancestor.label))
        : t.breakStatement(t.identifier(proc.ancestor.label)));
    } else if (to !== fallthrough) {
      stmts.push(t.expressionStatement(t.assignmentExpression("=",
        t.identifier(LABEL_VAR), t.numericLiteral(to))));
    }
    return stmts;
  }

  // Exactly one outgoing edge is taken, so the edges must form an if/else
  // chain — emitting them as consecutive statements would let a conditional
  // edge fall into the default edge's dispatch assignment.
  function renderBranches(block, out, fallthrough) {
    const all = [...block.branches.entries(), ...block.processed.entries()];
    const conds = all.filter(([, b]) => b.cond);
    const def = all.find(([, b]) => !b.cond);
    const defBody = def ? edgeStmts(block, def[0], def[1], fallthrough) : [];
    if (!conds.length) { out.push(...defBody); return; }
    let alt = defBody.length ? t.blockStatement(defBody) : null;
    for (let i = conds.length - 1; i >= 0; i--) {
      const [to, br] = conds[i];
      const body = edgeStmts(block, to, br, fallthrough);
      alt = t.ifStatement(br.cond, t.blockStatement(body), alt);
    }
    out.push(alt);
  }
}

/** Remove labels nobody jumps to, and the dispatch variable if never read. */
function pruneLabels(bodyStatements) {
  const wrapper = t.file(t.program([t.expressionStatement(
    t.functionExpression(null, [], t.blockStatement(bodyStatements)))]));
  const used = new Set();
  let readsLabelVar = false;
  traverse(wrapper, {
    BreakStatement(p) { if (p.node.label) used.add(p.node.label.name); },
    ContinueStatement(p) { if (p.node.label) used.add(p.node.label.name); },
    Identifier(p) {
      if (p.node.name !== LABEL_VAR) return;
      if (p.parentPath.isAssignmentExpression({ left: p.node })) return;
      readsLabelVar = true;
    },
  });
  traverse(wrapper, {
    LabeledStatement(p) {
      if (used.has(p.node.label.name)) return;
      const b = p.node.body;
      if (b.type === "DoWhileStatement" && b.test.type === "BooleanLiteral" && !b.test.value) {
        p.replaceWithMultiple(b.body.body);
      } else {
        p.replaceWith(b);
      }
    },
  });
  if (!readsLabelVar) {
    traverse(wrapper, {
      ExpressionStatement(p) {
        const e = p.node.expression;
        if (e.type === "AssignmentExpression" && e.left.type === "Identifier" &&
            e.left.name === LABEL_VAR) p.remove();
      },
    });
  }
  return { body: wrapper.program.body[0].expression.body.body, usesLabelVar: readsLabelVar };
}



/* ========================================================================== *
 * 7. register dataflow helpers
 * ========================================================================== */

/**
 * Walk a statement collecting register reads in evaluation order.  Nested
 * function expressions are not entered: the registers they close over are
 * handled separately (they can never be inlined away).
 */
function collectRegRefs(stmt, isReg) {
  const reads = [];
  const writes = [];
  visit(stmt, null, null);
  return { reads, writes };

  function push(node, parent, key, index, list) {
    list.push({
      name: node.name,
      replace(next) {
        if (index === null) parent[key] = next;
        else parent[key][index] = next;
      },
    });
  }

  function visit(node, parent, key, index) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((c, i) => visit(c, parent, key, i));
      return;
    }
    if (typeof node.type !== "string") return;

    switch (node.type) {
      case "FunctionExpression":
      case "FunctionDeclaration":
      case "ArrowFunctionExpression":
        return;
      case "Identifier":
        if (isReg(node.name)) push(node, parent, key, index === undefined ? null : index, reads);
        return;
      case "MemberExpression":
        visit(node.object, node, "object");
        if (node.computed) visit(node.property, node, "property");
        return;
      case "ObjectProperty":
        if (node.computed) visit(node.key, node, "key");
        visit(node.value, node, "value");
        return;
      case "AssignmentExpression": {
        const L = node.left;
        if (L.type === "Identifier") {
          if (node.operator !== "=" && isReg(L.name))
            push(L, node, "left", null, reads);
          if (isReg(L.name)) writes.push(L.name);
        } else {
          visit(L, node, "left");
        }
        visit(node.right, node, "right");
        return;
      }
      case "UpdateExpression":
        if (node.argument.type === "Identifier") {
          if (isReg(node.argument.name)) {
            push(node.argument, node, "argument", null, reads);
            writes.push(node.argument.name);
          }
        } else visit(node.argument, node, "argument");
        return;
      case "VariableDeclarator":
        if (node.id.type === "Identifier" && isReg(node.id.name)) writes.push(node.id.name);
        visit(node.init, node, "init");
        return;
      default: break;
    }
    for (const k of (t.VISITOR_KEYS[node.type] || [])) {
      const child = node[k];
      if (Array.isArray(child)) child.forEach((c, i) => visit(c, node, k, i));
      else visit(child, node, k);
    }
  }
}

/** Backward liveness over the block graph; returns liveOut per block id. */
function computeLiveness(blockMap, isReg, alwaysLive) {
  const use = new Map(), def = new Map(), succ = new Map();
  for (const blk of blockMap.values()) {
    const u = new Set(), d = new Set();
    for (const st of blk.stmts) {
      const { reads, writes } = collectRegRefs(st, isReg);
      for (const r of reads) if (!d.has(r.name)) u.add(r.name);
      for (const w of writes) d.add(w);
    }
    for (const br of blk.branches.values()) {
      if (br.cond) for (const r of collectRegRefs(t.expressionStatement(br.cond), isReg).reads)
        if (!d.has(r.name)) u.add(r.name);
      if (br.code) for (const st of br.code) {
        const { reads } = collectRegRefs(st, isReg);
        for (const r of reads) if (!d.has(r.name)) u.add(r.name);
      }
    }
    use.set(blk.id, u); def.set(blk.id, d);
    succ.set(blk.id, [...blk.branches.keys()]);
  }
  const liveIn = new Map(), liveOut = new Map();
  for (const id of blockMap.keys()) { liveIn.set(id, new Set()); liveOut.set(id, new Set()); }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of blockMap.keys()) {
      const out = new Set();
      for (const s of succ.get(id)) for (const v of liveIn.get(s) || []) out.add(v);
      const inn = new Set(out);
      for (const v of def.get(id)) inn.delete(v);
      for (const v of use.get(id)) inn.add(v);
      if (inn.size !== liveIn.get(id).size || [...inn].some((v) => !liveIn.get(id).has(v))) {
        liveIn.set(id, inn); changed = true;
      }
      liveOut.set(id, out);
    }
  }
  for (const s of liveOut.values()) for (const v of alwaysLive) s.add(v);
  return liveOut;
}

/** Splice a block into its unique predecessor while that is unambiguous. */
function mergeLinearBlocks(blockMap, entryId) {
  for (let pass = 0; pass < 50; pass++) {
    const preds = new Map();
    for (const id of blockMap.keys()) preds.set(id, []);
    for (const b of blockMap.values())
      for (const to of b.branches.keys()) if (preds.has(to)) preds.get(to).push(b.id);

    let merged = 0;
    for (const b of [...blockMap.values()]) {
      if (!blockMap.has(b.id)) continue;
      if (b.branches.size !== 1) continue;
      const [to, br] = [...b.branches.entries()][0];
      if (br.cond || br.code) continue;
      if (to === entryId || to === b.id) continue;
      const next = blockMap.get(to);
      if (!next) continue;
      if ((preds.get(to) || []).length !== 1) continue;
      b.stmts = b.stmts.concat(next.stmts);
      b.branches = next.branches;
      b.condMarker = next.condMarker;
      blockMap.delete(to);
      merged++;
    }
    if (!merged) break;
  }
}

/**
 * Rename each definition inside a block to a fresh name (block-local SSA).
 *
 * The bytecode recycles a handful of scratch registers for long arithmetic
 * chains, which stops the expression combiner cold: `x = a | b; b = ...;
 * x = x * b` cannot be folded while `b` is being overwritten.  After renaming,
 * every temporary has exactly one definition and folds freely.  Registers a
 * closure captured keep their name — those really are one shared variable.
 */
function ssaRenameBlock(blk, isReg, noRename, prefix, sink) {
  const stmts = blk.stmts;
  const defOf = (st) => {
    if (st.type !== "ExpressionStatement") return null;
    const e = st.expression;
    if (e.type !== "AssignmentExpression" || e.operator !== "=") return null;
    if (e.left.type !== "Identifier" || !isReg(e.left.name)) return null;
    return e;
  };

  const lastDef = new Map();
  stmts.forEach((st, i) => {
    const d = defOf(st);
    if (d) lastDef.set(d.left.name, i);
  });

  const cur = new Map();
  let n = 0;
  stmts.forEach((st, i) => {
    for (const ref of collectRegRefs(st, isReg).reads) {
      const to = cur.get(ref.name);
      if (to) ref.replace(t.identifier(to));
    }
    const d = defOf(st);
    if (!d) return;
    const name = d.left.name;
    if (noRename.has(name)) { cur.delete(name); return; }
    if (lastDef.get(name) === i) { cur.delete(name); return; }
    const fresh = `${prefix}s${n++}`;
    sink.add(fresh);
    d.left = t.identifier(fresh);
    cur.set(name, fresh);
  });

  for (const br of blk.branches.values()) {
    if (br.code)
      for (const st of br.code)
        for (const ref of collectRegRefs(st, isReg).reads) {
          const to = cur.get(ref.name);
          if (to) ref.replace(t.identifier(to));
        }
  }
}

/**
 * Collapse the three-address code of a block into nested expressions.
 *
 * A definition is only folded into its use when the use immediately consumes
 * the tail of the pending-definition stack, which is exactly the discipline a
 * compiler emits its temporaries in — so evaluation order is preserved by
 * construction.  Anything that does not fit stays a plain assignment.
 */
function combineExpressions(stmts, liveOut, isReg, noInline) {
  const info = stmts.map((st) => collectRegRefs(st, isReg));
  const nextWrite = new Map(), readIdx = new Map();
  stmts.forEach((st, i) => {
    for (const r of info[i].reads) {
      if (!readIdx.has(r.name)) readIdx.set(r.name, []);
      readIdx.get(r.name).push(i);
    }
    for (const w of info[i].writes) {
      if (!nextWrite.has(w)) nextWrite.set(w, []);
      nextWrite.get(w).push(i);
    }
  });

  const simpleDef = (st) => {
    if (st.type !== "ExpressionStatement") return null;
    const e = st.expression;
    if (e.type !== "AssignmentExpression" || e.operator !== "=") return null;
    if (e.left.type !== "Identifier" || !isReg(e.left.name)) return null;
    return { name: e.left.name, expr: e.right };
  };

  const canFold = (i, name) => {
    if (noInline.has(name)) return false;
    const writes = (nextWrite.get(name) || []).filter((w) => w > i);
    const limit = writes.length ? writes[0] : Infinity;
    // a statement that both reads and writes the register (`x = x + 1`) reads
    // it first, so the read at `limit` still refers to this definition
    const reads = (readIdx.get(name) || []).filter((r) => r > i && r <= limit);
    if (reads.length !== 1) return false;
    if (limit === Infinity && liveOut.has(name)) return false;
    return true;
  };

  const result = [];
  const stack = [];
  const flush = (upto) => {
    for (let k = 0; k <= upto; k++)
      result.push(t.expressionStatement(t.assignmentExpression("=",
        t.identifier(stack[k].name), stack[k].expr)));
  };

  for (let i = 0; i < stmts.length; i++) {
    const reads = info[i].reads;
    const subs = [];
    const used = new Set();
    let allPure = true;
    let maxAllowed = stack.length - 1;   // keeps folded definitions in order
    for (let ri = reads.length - 1; ri >= 0; ri--) {
      const name = reads[ri].name;
      let k = -1;
      for (let j = maxAllowed; j >= 0; j--)
        if (!used.has(j) && stack[j].name === name) { k = j; break; }
      if (k < 0) {
        // a plain variable read: stepping over it only reorders side-effect
        // free work already folded to its right
        if (!allPure) break;
        continue;
      }
      const entry = stack[k];
      let ok = true;
      for (let j = k + 1; j < stack.length && ok; j++) {
        if (used.has(j)) continue;
        // everything hoisted over must be pure and independent
        if (!isPureExpr(stack[j].expr)) ok = false;
        else if (entry.reads.has(stack[j].name)) ok = false;
        else if (stack[j].reads.has(entry.name)) ok = false;
      }
      if (!ok) break;
      used.add(k);
      maxAllowed = k - 1;
      subs.push([reads[ri], entry.expr]);
      if (!isPureExpr(entry.expr)) allPure = false;
    }
    for (const [ref, expr] of subs) ref.replace(expr);

    // Definitions this statement did not use stay pending — a later statement
    // may still consume them — unless keeping them would change what they see.
    const remaining = stack.filter((_, k) => !used.has(k));
    const readNames = new Set(reads.map((r) => r.name));
    const writeNames = new Set(info[i].writes);
    let mustFlush = false;
    for (const e of remaining) {
      if (readNames.has(e.name)) mustFlush = true;
      if (writeNames.has(e.name)) mustFlush = true;
      for (const r of e.reads) if (writeNames.has(r)) mustFlush = true;
    }
    const flushAll = () => {
      for (const e of remaining)
        result.push(t.expressionStatement(t.assignmentExpression("=",
          t.identifier(e.name), e.expr)));
      remaining.length = 0;
    };
    if (mustFlush) flushAll();
    stack.length = 0;
    for (const e of remaining) stack.push(e);

    const d = simpleDef(stmts[i]);
    if (d && canFold(i, d.name)) {
      const rd = new Set(collectRegRefs(
        t.expressionStatement(d.expr), isReg).reads.map((r) => r.name));
      stack.push({ name: d.name, expr: d.expr, reads: rd });
    } else {
      flush(stack.length - 1);
      stack.length = 0;
      result.push(stmts[i]);
    }
  }
  flush(stack.length - 1);
  return result;
}

/* ========================================================================== *
 * 8. lifting bytecode -> JS
 * ========================================================================== */

const HELPERS = { enumKeys: "_enumKeys", defineGetter: "_defineGetter",
  defineSetter: "_defineSetter" };

function valueToNode(v) {
  if (v === undefined) return t.unaryExpression("void", t.numericLiteral(0));
  if (v === null) return t.nullLiteral();
  if (typeof v === "string") return t.stringLiteral(v);
  if (typeof v === "boolean") return t.booleanLiteral(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return t.identifier("NaN");
    if (v === Infinity) return t.identifier("Infinity");
    if (v === -Infinity) return t.unaryExpression("-", t.identifier("Infinity"));
    if (v < 0) return t.unaryExpression("-", t.numericLiteral(-v));
    return t.numericLiteral(v);
  }
  return t.identifier("undefined");
}

function createLifter(payload, options) {
  const decode = makeDecoder(payload.pool);
  const usedHelpers = new Set();
  const specialize = options ? options.specialize !== false : true;
  let depth = 0;

  const regName = (fnId, reg) => `v${fnId}_${reg}`;

  function liftFunction(fnRec, capNames) {
    if (++depth > 64) throw new Error("closure nesting too deep");
    try { return liftInner(fnRec, capNames || []); } finally { depth--; }
  }

  /* ---- block graph, either straight from the bytecode or specialized ----- */
  function buildGraph(fnRec) {
    if (specialize) {
      const spec = specializeFunction(fnRec, decode);
      if (spec) return spec;
    }
    const pcs = [...fnRec.insts.keys()].sort((a, b) => a - b);
    const leaders = new Set([fnRec.entry]);
    for (const pc of pcs) {
      const i = fnRec.insts.get(pc);
      if (i.kind === "jump") leaders.add(i.target);
      else if (i.kind === "branch" || i.kind === "forInNext") {
        leaders.add(i.target); leaders.add(i.next);
      }
    }
    const blocks = new Map();
    let cur = null;
    for (const pc of pcs) {
      if (cur === null || leaders.has(pc)) {
        cur = { id: pc, pc, steps: [], edges: [] };
        blocks.set(pc, cur);
      }
      const inst = fnRec.insts.get(pc);
      cur.steps.push({ inst, constIn: new Map(), dead: false });
      if (inst.kind === "jump") { cur.edges = [{ to: inst.target }]; cur = null; }
      else if (inst.kind === "branch") {
        cur.edges = [{ to: inst.target, cond: true }, { to: inst.next }]; cur = null;
      } else if (inst.kind === "forInNext") {
        cur.edges = [{ to: inst.target, cond: true }, { to: inst.next, edgeAssign: true }];
        cur = null;
      } else if (["return", "throw", "jumpIndirect"].includes(inst.kind)) {
        cur.edges = []; cur = null;
      } else if (!fnRec.insts.has(inst.next)) {
        cur.edges = []; cur = null;
      } else if (leaders.has(inst.next)) {
        cur.edges = [{ to: inst.next }]; cur = null;
      }
    }
    return { blocks, entryId: fnRec.entry };
  }

  function liftInner(fnRec, capNames) {
    const fnId = fnRec.id;
    const usedRegs = new Set();
    const isReg = (name) => name.startsWith(`v${fnId}_`);
    const R = (reg) => { usedRegs.add(reg); return t.identifier(regName(fnId, reg)); };

    const graph = buildGraph(fnRec);
    const capturedRegs = new Set();
    for (const inst of fnRec.insts.values())
      if (inst.kind === "makeFunction")
        for (const c of inst.captures) if (c.own) capturedRegs.add(regName(fnId, c.idx));

    /* ---- statements + edges -------------------------------------------- */
    const blockMap = new Map();
    for (const g of graph.blocks.values()) {
      const blk = new Block(g.id);
      blk.stmts = [];
      blk.consts = new Map();
      blockMap.set(g.id, blk);
      blk.graph = g;
    }
    for (const blk of blockMap.values()) {
      for (const step of blk.graph.steps)
        emit(step, blk, fnId, R, capNames, blk.graph.edges);
      // instructions that fell through without a terminator
      if (blk.branches.size === 0 && blk.graph.edges.length === 1 &&
          !blk.graph.edges[0].cond)
        blk.addBranch(blk.graph.edges[0].to, null, null);
    }

    /* ---- fold three-address code into expressions ----------------------- */
    mergeLinearBlocks(blockMap, graph.entryId);
    const ssaNames = new Set();
    for (const blk of blockMap.values())
      ssaRenameBlock(blk, isReg, capturedRegs, `v${fnId}_`, ssaNames);
    const liveOut = computeLiveness(blockMap, isReg, capturedRegs);
    for (const blk of blockMap.values()) {
      blk.stmts = combineExpressions(blk.stmts, liveOut.get(blk.id), isReg, capturedRegs);
      if (blk.condMarker) {
        const idx = blk.stmts.indexOf(blk.condMarker);
        if (idx >= 0) {
          const cond = blk.stmts[idx].expression;
          blk.stmts.splice(idx, 1);
          for (const br of blk.branches.values()) if (br.cond) br.cond = cond;
        }
      }
      peephole(blk.stmts);
      for (const br of blk.branches.values()) {
        if (br.cond) br.cond = peepholeExpr(br.cond);
        if (br.code) peephole(br.code);
      }
    }

    /* ---- structure ------------------------------------------------------ */
    const shape = reloop(blockMap, graph.entryId);
    const pruned = pruneLabels(renderShape(shape));

    /* ---- prologue ------------------------------------------------------- */
    const nParams = fnRec.hasRest ? Math.max(0, fnRec.params - 1) : fnRec.params;
    const params = [];
    for (let i = 0; i < nParams; i++) params.push(t.identifier(regName(fnId, i)));
    if (fnRec.hasRest)
      params.push(t.restElement(t.identifier(regName(fnId, fnRec.params - 1))));

    const decls = [];
    if (pruned.usesLabelVar) decls.push(t.variableDeclarator(t.identifier(LABEL_VAR)));
    for (const reg of [...usedRegs].sort((a, b) => a - b)) {
      if (reg < fnRec.params) continue;
      if (reg === fnRec.params && fnRec.params < fnRec.regs) {
        decls.push(t.variableDeclarator(t.identifier(regName(fnId, reg)),
          t.callExpression(t.memberExpression(
            t.memberExpression(t.arrayExpression([]), t.identifier("slice")),
            t.identifier("call")), [t.identifier("arguments")])));
      } else {
        decls.push(t.variableDeclarator(t.identifier(regName(fnId, reg))));
      }
    }
    for (const name of ssaNames) decls.push(t.variableDeclarator(t.identifier(name)));
    const prologue = decls.length ? [t.variableDeclaration("var", decls)] : [];
    return t.functionExpression(null, params, t.blockStatement([...prologue, ...pruned.body]));
  }

  /* ---- a single instruction ------------------------------------------- */
  function emit(step, blk, fnId, R, capNames, edges) {
    const { inst, constIn, dead } = step;
    const stmts = blk.stmts;
    const known = (reg) => (constIn.has(reg) ? constIn.get(reg) : blk.consts.get(reg));
    const V = (reg) => (constIn.has(reg) ? valueToNode(constIn.get(reg)) : R(reg));

    const assign = (dst, expr, impure) => {
      if (dead) {
        if (impure) stmts.push(t.expressionStatement(expr));
        blk.consts.delete(dst);
        return;
      }
      stmts.push(t.expressionStatement(t.assignmentExpression("=", R(dst), expr)));
      blk.consts.delete(dst);
    };
    const setConst = (dst, expr, value) => {
      if (dead) return;
      stmts.push(t.expressionStatement(t.assignmentExpression("=", R(dst), expr)));
      blk.consts.set(dst, value);
    };

    switch (inst.kind) {
      case "binop": {
        let e;
        if (inst.int32 && inst.op === "*")
          e = t.callExpression(t.memberExpression(t.identifier("Math"), t.identifier("imul")),
            [V(inst.a), V(inst.b)]);
        else if (inst.int32 && (inst.op === "+" || inst.op === "-"))
          e = t.binaryExpression("|", t.binaryExpression(inst.op,
            t.binaryExpression("|", V(inst.a), t.numericLiteral(0)),
            t.binaryExpression("|", V(inst.b), t.numericLiteral(0))), t.numericLiteral(0));
        else e = t.binaryExpression(inst.op, V(inst.a), V(inst.b));
        assign(inst.dst, e, false);
        break;
      }
      case "unop":   assign(inst.dst, t.unaryExpression(inst.op, V(inst.a)), false); break;
      case "move":
        assign(inst.dst, V(inst.src), false);
        if (!dead && blk.consts.has(inst.src)) blk.consts.set(inst.dst, blk.consts.get(inst.src));
        break;
      case "loadImm":   setConst(inst.dst, valueToNode(inst.value >>> 0), inst.value >>> 0); break;
      case "loadConst": {
        const v = decode(inst.index, inst.key);
        setConst(inst.dst, valueToNode(v), v);
        break;
      }
      case "loadUndef": assign(inst.dst, t.unaryExpression("void", t.numericLiteral(0)), false); break;
      case "loadThis":  assign(inst.dst, t.thisExpression(), false); break;
      case "loadGlobal":
        assign(inst.dst, t.identifier(String(decode(inst.index, inst.key))), false); break;
      case "typeofGlobal":
        assign(inst.dst, t.unaryExpression("typeof",
          t.identifier(String(decode(inst.index, inst.key)))), false); break;
      case "storeGlobal":
        stmts.push(t.expressionStatement(t.assignmentExpression("=",
          t.identifier(String(decode(inst.index, inst.key))), V(inst.src)))); break;
      case "getMember":
        assign(inst.dst, member(V(inst.obj), V(inst.key), known(inst.key)), true); break;
      case "setMember":
        stmts.push(t.expressionStatement(t.assignmentExpression("=",
          member(V(inst.obj), V(inst.key), known(inst.key)), V(inst.val)))); break;
      case "deleteMember":
        assign(inst.dst, t.unaryExpression("delete",
          member(V(inst.obj), V(inst.key), known(inst.key))), true); break;
      case "defineGetter":
      case "defineSetter": {
        const h = inst.kind === "defineGetter" ? HELPERS.defineGetter : HELPERS.defineSetter;
        usedHelpers.add(h);
        stmts.push(t.expressionStatement(t.callExpression(t.identifier(h),
          [V(inst.obj), V(inst.key), V(inst.fn)])));
        break;
      }
      case "arrayLit":
        assign(inst.dst, t.arrayExpression(inst.elems.map((e) => V(e))), false); break;
      case "objectLit": {
        const safe = inst.pairs.every(([k]) => {
          const v = known(k);
          return typeof v === "string" && v !== "__proto__";
        });
        if (safe) {
          assign(inst.dst, t.objectExpression(inst.pairs.map(([k, v]) => {
            const key = known(k);
            return t.isValidIdentifier(key)
              ? t.objectProperty(t.identifier(key), V(v))
              : t.objectProperty(t.stringLiteral(key), V(v));
          })), false);
        } else {
          assign(inst.dst, t.objectExpression([]), false);
          for (const [k, v] of inst.pairs)
            stmts.push(t.expressionStatement(t.assignmentExpression("=",
              t.memberExpression(R(inst.dst), V(k), true), V(v))));
        }
        break;
      }
      case "call":
        assign(inst.dst, t.callExpression(V(inst.callee), callArgs(inst, V)), true); break;
      case "construct":
        assign(inst.dst, t.newExpression(V(inst.callee), callArgs(inst, V)), true); break;
      case "methodCall":
        assign(inst.dst, t.callExpression(
          t.memberExpression(t.identifier("Reflect"), t.identifier("apply")),
          [V(inst.callee), V(inst.obj), inst.spread ? V(inst.args[0])
            : t.arrayExpression(inst.args.map((a) => V(a)))]), true);
        break;
      case "makeFunction": {
        const caps = inst.captures.map((c) =>
          c.own ? regName(fnId, c.idx) : capNames[c.idx]);
        for (const c of inst.captures) if (c.own) R(c.idx);
        assign(inst.dst, liftFunction(inst.fn, caps), false);
        break;
      }
      case "loadCell":  assign(inst.dst, t.identifier(capNames[inst.cell]), false); break;
      case "storeCell":
        stmts.push(t.expressionStatement(t.assignmentExpression("=",
          t.identifier(capNames[inst.cell]), V(inst.src)))); break;
      case "return":    stmts.push(t.returnStatement(V(inst.src))); break;
      case "throw":     stmts.push(t.throwStatement(V(inst.src))); break;
      case "forInInit":
        usedHelpers.add(HELPERS.enumKeys);
        assign(inst.dst, t.objectExpression([
          t.objectProperty(t.identifier("keys"),
            t.callExpression(t.identifier(HELPERS.enumKeys), [V(inst.obj)])),
          t.objectProperty(t.identifier("i"), t.numericLiteral(0)),
        ]), false);
        break;
      case "debugger":  stmts.push(t.debuggerStatement()); break;
      case "decrypt":
      case "popHandler":
      case "jump":      break;
      case "branch": {
        const marker = t.expressionStatement(
          inst.negate ? t.unaryExpression("!", V(inst.cond)) : V(inst.cond));
        stmts.push(marker);
        blk.condMarker = marker;
        blk.addBranch(edges[0].to, marker.expression, null);
        blk.addBranch(edges[1].to, null, null);
        break;
      }
      case "forInNext": {
        const keys = () => t.memberExpression(R(inst.iter), t.identifier("keys"));
        const marker = t.expressionStatement(t.binaryExpression(">=",
          t.memberExpression(R(inst.iter), t.identifier("i")),
          t.memberExpression(keys(), t.identifier("length"))));
        stmts.push(marker);
        blk.condMarker = marker;
        blk.addBranch(edges[0].to, marker.expression, null);
        blk.addBranch(edges[1].to, null, [t.expressionStatement(t.assignmentExpression("=",
          R(inst.dst), t.memberExpression(keys(),
            t.updateExpression("++", t.memberExpression(R(inst.iter), t.identifier("i")), false),
            true)))]);
        break;
      }
      case "pushCatch":
      case "pushFinally":
        throw new Error(`unsupported: try/catch bytecode (${inst.kind}) at pc ${inst.pc}`);
      case "jumpIndirect":
        throw new Error(`unsupported: computed jump at pc ${inst.pc}`);
      default:
        throw new Error(`cannot lift instruction ${inst.kind} at pc ${inst.pc}`);
    }
  }

  function callArgs(inst, V) {
    if (inst.spread) return [t.spreadElement(V(inst.args[0]))];
    return inst.args.map((a) => V(a));
  }

  function member(objExpr, keyExpr, constKey) {
    if (typeof constKey === "string" && t.isValidIdentifier(constKey))
      return t.memberExpression(objExpr, t.identifier(constKey));
    if (keyExpr.type === "StringLiteral" && t.isValidIdentifier(keyExpr.value))
      return t.memberExpression(objExpr, t.identifier(keyExpr.value));
    return t.memberExpression(objExpr, keyExpr, true);
  }

  return { liftFunction, regName, usedHelpers, decode };
}


/* --- small readability rewrites ------------------------------------------ */

function peephole(stmts) {
  for (const st of stmts) rewriteDeep(st);
}

function peepholeExpr(e) {
  const box = { e };
  rewriteDeep(box, "e");
  return box.e;
}

function rewriteDeep(node, key) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((_, i) => rewriteDeep(node, i)); return; }
  if (key !== undefined) {
    const child = node[key];
    if (child && typeof child === "object" && typeof child.type === "string") {
      rewriteDeep(child);
      node[key] = simplify(child);
    } else rewriteDeep(child);
    return;
  }
  if (typeof node.type !== "string") return;
  for (const k of (t.VISITOR_KEYS[node.type] || [])) {
    const child = node[k];
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) {
        if (child[i] && typeof child[i].type === "string") {
          rewriteDeep(child[i]);
          child[i] = simplify(child[i]);
        }
      }
    } else if (child && typeof child.type === "string") {
      rewriteDeep(child);
      node[k] = simplify(child);
    }
  }
}

function isSimpleRef(n) {
  return n.type === "Identifier" || n.type === "ThisExpression";
}

function simplify(n) {
  // Reflect.apply(o.m, o, [a, b])  ->  o.m(a, b)
  if (n.type === "CallExpression" && n.callee.type === "MemberExpression" &&
      !n.callee.computed && n.callee.object.type === "Identifier" &&
      n.callee.object.name === "Reflect" && n.callee.property.name === "apply" &&
      n.arguments.length === 3) {
    const [fn, thisArg, argsArr] = n.arguments;
    const argsOk = argsArr.type === "ArrayExpression" &&
      argsArr.elements.every((e) => e && e.type !== "SpreadElement");
    const spreadOk = argsArr.type !== "ArrayExpression";
    if (fn.type === "MemberExpression" && isSimpleRef(thisArg) &&
        sameRef(fn.object, thisArg)) {
      if (argsOk) return t.callExpression(fn, argsArr.elements);
      if (spreadOk) return t.callExpression(fn, [t.spreadElement(argsArr)]);
    }
    if (thisArg.type === "UnaryExpression" && thisArg.operator === "void" && argsOk)
      return t.callExpression(fn, argsArr.elements);
  }
  return n;
}

function sameRef(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "Identifier") return a.name === b.name;
  if (a.type === "ThisExpression") return true;
  return false;
}



/* ========================================================================== *
 * 9. per-instruction liveness + control-flow-flattening removal
 *
 * JS-Confuser also flattens the protected function: one register holds a state
 * number, every block ends by computing the next state through a wall of mixed
 * boolean arithmetic, and a dispatcher chain routes on it.  Because the state
 * is always a constant at the dispatcher, propagating constants through the CFG
 * and specializing each block on the constants that reach it makes the whole
 * dispatcher fold away.
 * ========================================================================== */

const MAX_STATES_PER_PC = 600;
const MAX_BLOCKS = 40000;
const MAX_STEPS_PER_BLOCK = 20000;

function instReads(inst) {
  switch (inst.kind) {
    case "binop":       return [inst.a, inst.b];
    case "unop":        return [inst.a];
    case "move":        return [inst.src];
    case "getMember":
    case "deleteMember": return [inst.obj, inst.key];
    case "setMember":   return [inst.obj, inst.key, inst.val];
    case "defineGetter":
    case "defineSetter": return [inst.obj, inst.key, inst.fn];
    case "storeGlobal": return [inst.src];
    case "arrayLit":    return inst.elems;
    case "objectLit":   return inst.pairs.flat();
    case "call":        return [inst.callee, ...inst.args];
    case "construct":   return [inst.callee, ...inst.args];
    case "methodCall":  return [inst.obj, inst.callee, ...inst.args];
    case "storeCell":   return [inst.src];
    case "return":
    case "throw":       return [inst.src];
    case "branch":      return [inst.cond];
    case "jumpIndirect": return [inst.reg];
    case "forInInit":   return [inst.obj];
    case "forInNext":   return [inst.iter];
    case "makeFunction": return inst.captures.filter((c) => c.own).map((c) => c.idx);
    default:            return [];
  }
}

function instWrites(inst) {
  if (inst.kind === "forInNext") return [inst.dst];
  if (inst.dst !== undefined) return [inst.dst];
  return [];
}

/** liveAfter(pc): registers whose value is still needed after that instruction */
function computeInstLiveness(fnRec) {
  const pcs = [...fnRec.insts.keys()].sort((a, b) => a - b);
  const leaders = new Set([fnRec.entry]);
  for (const pc of pcs) {
    const i = fnRec.insts.get(pc);
    if (i.kind === "jump") leaders.add(i.target);
    else if (i.kind === "branch" || i.kind === "forInNext") {
      leaders.add(i.target); leaders.add(i.next);
    }
  }
  const blocks = [];
  let cur = null;
  const blockOf = new Map();
  for (const pc of pcs) {
    if (cur === null || leaders.has(pc)) { cur = { id: blocks.length, insts: [], succ: [] }; blocks.push(cur); }
    blockOf.set(pc, cur);
    const inst = fnRec.insts.get(pc);
    cur.insts.push(inst);
    if (["jump", "branch", "return", "throw", "forInNext", "jumpIndirect"].includes(inst.kind)) cur = null;
    else if (!fnRec.insts.has(inst.next)) cur = null;
  }
  for (const b of blocks) {
    const last = b.insts[b.insts.length - 1];
    const targets = [];
    if (last.kind === "jump") targets.push(last.target);
    else if (last.kind === "branch" || last.kind === "forInNext") {
      targets.push(last.target, last.next);
    } else if (!["return", "throw", "jumpIndirect"].includes(last.kind)) targets.push(last.next);
    for (const tpc of targets) if (blockOf.has(tpc)) b.succ.push(blockOf.get(tpc).id);
  }

  const forever = new Set();
  for (const pc of pcs) {
    const i = fnRec.insts.get(pc);
    if (i.kind === "makeFunction")
      for (const c of i.captures) if (c.own) forever.add(c.idx);
  }

  const liveIn = blocks.map(() => new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const live = new Set();
      for (const s of b.succ) for (const v of liveIn[s]) live.add(v);
      for (let k = b.insts.length - 1; k >= 0; k--) {
        for (const w of instWrites(b.insts[k])) live.delete(w);
        for (const r of instReads(b.insts[k])) live.add(r);
      }
      if (live.size !== liveIn[i].size || [...live].some((v) => !liveIn[i].has(v))) {
        liveIn[i] = live; changed = true;
      }
    }
  }

  const liveAfter = new Map();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const live = new Set(forever);
    for (const s of b.succ) for (const v of liveIn[s]) live.add(v);
    for (let k = b.insts.length - 1; k >= 0; k--) {
      liveAfter.set(b.insts[k].pc, new Set(live));
      for (const w of instWrites(b.insts[k])) if (!forever.has(w)) live.delete(w);
      for (const r of instReads(b.insts[k])) live.add(r);
    }
  }
  return liveAfter;
}

const PURE_KINDS = new Set(["binop", "unop", "move", "loadImm", "loadConst",
  "loadUndef", "loadThis", "typeofGlobal", "arrayLit", "objectLit",
  "makeFunction", "loadCell"]);

const PRIMITIVE = (v) =>
  v === null || v === undefined || ["number", "string", "boolean"].includes(typeof v);

function foldBinary(op, a, b, int32) {
  if (!PRIMITIVE(a) || !PRIMITIVE(b)) return undefined;
  if (int32) {
    if (op === "*") return Math.imul(a | 0, b | 0);
    if (op === "+") return ((a | 0) + (b | 0)) | 0;
    if (op === "-") return ((a | 0) - (b | 0)) | 0;
  }
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return a / b;
    case "%": return a % b;
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "<<": return a << b;
    case ">>": return a >> b;
    case ">>>": return a >>> b;
    case "<": return a < b;
    case ">": return a > b;
    case "<=": return a <= b;
    case ">=": return a >= b;
    case "==": return a == b;      // eslint-disable-line eqeqeq
    case "!=": return a != b;      // eslint-disable-line eqeqeq
    case "===": return a === b;
    case "!==": return a !== b;
    case "**": return Math.pow(a, b);
    default: return undefined;
  }
}

function foldUnary(op, a) {
  if (!PRIMITIVE(a)) return undefined;
  switch (op) {
    case "!": return !a;
    case "-": return -a;
    case "+": return +a;
    case "~": return ~a;
    case "typeof": return typeof a;
    default: return undefined;
  }
}

/**
 * Symbolically execute a function, specializing each program point on the
 * constant registers that reach it.  Returns a block graph whose instructions
 * carry `constIn` (constants usable for their operands) and `dead` (the result
 * register is never read again, so the store can be dropped).
 */
/**
 * Registers that can decide a branch: the backward slice of every branch
 * condition through value-producing instructions.  Specializing on anything
 * outside this set only duplicates code, so the env is restricted to it.
 */
function controlRegisters(fnRec) {
  const ctrl = new Set();
  for (const inst of fnRec.insts.values())
    if (inst.kind === "branch") ctrl.add(inst.cond);
  const producers = new Map();  // reg -> [instructions writing it]
  for (const inst of fnRec.insts.values())
    for (const w of instWrites(inst)) {
      if (!producers.has(w)) producers.set(w, []);
      producers.get(w).push(inst);
    }
  const work = [...ctrl];
  const PURE = new Set(["binop", "unop", "move", "loadImm", "loadConst", "loadUndef"]);
  while (work.length) {
    const r = work.pop();
    for (const inst of producers.get(r) || []) {
      if (!PURE.has(inst.kind)) continue;
      for (const src of instReads(inst))
        if (!ctrl.has(src)) { ctrl.add(src); work.push(src); }
    }
  }
  return ctrl;
}

/**
 * Two passes.  The first is a probe with a small budget whose only job is to
 * measure, per program point, how many distinct values each register takes.
 * At the flattening dispatcher the state register stands out by an order of
 * magnitude, so the second pass specializes on those registers only and every
 * other value stops duplicating blocks.
 */
function specializeFunction(fnRec, decode) {
  const liveAfter = computeInstLiveness(fnRec);
  const ctrl = controlRegisters(fnRec);
  const probe = runSpecialize(fnRec, decode, liveAfter, ctrl, PROBE_BLOCKS);
  if (probe.ok) return probe;

  let hub = null, hubStates = -1;
  for (const [pc, n] of probe.perPc) if (n > hubStates) { hubStates = n; hub = pc; }
  const seen = probe.variance.get(hub);
  let focus = null;
  if (seen && seen.size) {
    const counts = [...seen.entries()].map(([r, s]) => [r, s.size]).sort((a, b) => b[1] - a[1]);
    const max = counts[0][1];
    if (max >= 8) {
      // the state registers (huge variance) plus anything that is effectively
      // constant at this point — the latter never multiplies states but lets
      // ordinary constants keep folding across blocks
      focus = new Set(counts.filter(([, n]) => n * 4 >= max || n <= 2).map(([r]) => r));
    }
  }
  if (!focus) return null;
  const second = runSpecialize(fnRec, decode, liveAfter, focus, MAX_BLOCKS);
  return second.ok ? second : null;
}

const PROBE_BLOCKS = 12000;

function runSpecialize(fnRec, decode, liveAfter, ctrl, blockBudget) {
  const blocks = new Map();
  const byState = new Map();
  const perPc = new Map();
  const variance = new Map();
  const dropped = new Set();
  let nextId = 0;
  let bailed = false;
  const queue = [];

  const sigOf = (env) => {
    if (env.size === 0) return "";
    const parts = [];
    for (const k of [...env.keys()].sort((a, b) => a - b)) {
      const v = env.get(k);
      parts.push(k + ":" + (typeof v) + ":" + String(v));
    }
    return parts.join(",");
  };

  /**
   * Adaptive widening: a program point that keeps producing new states is
   * being unrolled, so the register that varies most there is dropped from the
   * env for good.  Loop induction variables lose their constants that way,
   * while the flattening state — constant at each loop header — survives.
   */
  function blockFor(pc, env) {
    const e = new Map();
    for (const [k, v] of env) if (ctrl.has(k) && !dropped.has(k)) e.set(k, v);
    let key = pc + "|" + sigOf(e);
    if (byState.has(key)) return byState.get(key);

    let seen = variance.get(pc);
    if (!seen) { seen = new Map(); variance.set(pc, seen); }
    for (const [r, v] of e) {
      if (!seen.has(r)) seen.set(r, new Set());
      seen.get(r).add(typeof v + ":" + String(v));
    }
    let count = perPc.get(pc) || 0;
    while (count >= MAX_STATES_PER_PC && e.size > 0) {
      let worst = null, worstN = -1;
      for (const [r, vals] of seen)
        if (e.has(r) && vals.size > worstN) { worst = r; worstN = vals.size; }
      if (worst === null) break;
      dropped.add(worst);
      for (const k of [...e.keys()]) if (dropped.has(k)) e.delete(k);
      key = pc + "|" + sigOf(e);
      if (byState.has(key)) return byState.get(key);
      count = perPc.get(pc) || 0;
    }

    if (blocks.size >= blockBudget) bailed = true;
    perPc.set(pc, count + 1);
    const blk = { id: nextId++, pc, env: e, steps: [], edges: [] };
    byState.set(key, blk.id);
    blocks.set(blk.id, blk);
    queue.push(blk);
    return blk.id;
  }

  const entryId = blockFor(fnRec.entry, new Map());

  while (queue.length && !bailed) {
    const blk = queue.shift();
    runBlock(blk);
  }
  if (bailed) return { ok: false, perPc, variance };
  

  function runBlock(blk) {
    const env = new Map(blk.env);
    let pc = blk.pc;
    let lastPc = blk.pc;
    const seen = new Set();
    for (;;) {
      if (blk.steps.length > MAX_STEPS_PER_BLOCK || (seen.has(pc) && blk.steps.length)) {
        blk.exitLive = liveAfter.get(lastPc) || new Set();
        blk.edges = [{ to: blockFor(pc, env) }];
        pruneSteps(blk);
        return;
      }
      seen.add(pc);
      const inst = fnRec.insts.get(pc);
      if (!inst) { blk.exitLive = new Set(); blk.edges = []; pruneSteps(blk); return; }
      const live = liveAfter.get(pc) || new Set();
      lastPc = pc;

      if (inst.kind === "jump") { pc = inst.target; continue; }

      if (inst.kind === "branch") {
        if (env.has(inst.cond)) {
          const truthy = !!env.get(inst.cond);
          const taken = inst.negate ? !truthy : truthy;
          pc = taken ? inst.target : inst.next;
          continue;
        }
        blk.steps.push({ inst, constIn: snapshot(env, instReads(inst)), dead: false });
        prune(env, live);
        blk.exitLive = live;
        blk.edges = [
          { to: blockFor(inst.target, new Map(env)), cond: true },
          { to: blockFor(inst.next, new Map(env)) },
        ];
        pruneSteps(blk);
        return;
      }

      if (inst.kind === "return" || inst.kind === "throw") {
        blk.steps.push({ inst, constIn: snapshot(env, instReads(inst)), dead: false });
        blk.exitLive = new Set();
        blk.edges = [];
        pruneSteps(blk);
        return;
      }

      if (inst.kind === "forInNext") {
        blk.steps.push({ inst, constIn: snapshot(env, instReads(inst)), dead: false });
        env.delete(inst.dst);
        prune(env, live);
        blk.exitLive = live;
        blk.edges = [
          { to: blockFor(inst.target, new Map(env)), cond: true },
          { to: blockFor(inst.next, new Map(env)), edgeAssign: true },
        ];
        pruneSteps(blk);
        return;
      }

      if (inst.kind === "decrypt" || inst.kind === "popHandler") { pc = inst.next; continue; }

      /* ---- ordinary, value-producing instructions ---- */
      let folded;
      if (inst.kind === "binop" && env.has(inst.a) && env.has(inst.b))
        folded = foldBinary(inst.op, env.get(inst.a), env.get(inst.b), inst.int32);
      else if (inst.kind === "unop" && env.has(inst.a))
        folded = foldUnary(inst.op, env.get(inst.a));
      else if (inst.kind === "move" && env.has(inst.src))
        folded = env.get(inst.src);
      else if (inst.kind === "loadImm") folded = inst.value >>> 0;
      else if (inst.kind === "loadConst") folded = decode(inst.index, inst.key);
      else if (inst.kind === "loadUndef") folded = undefined;

      const writes = instWrites(inst);
      const dstDead = writes.length > 0 && !live.has(writes[0]);
      const pure = ["binop", "unop", "move", "loadImm", "loadConst", "loadUndef",
        "loadThis", "typeofGlobal"].includes(inst.kind);

      if (folded !== undefined || (inst.kind === "loadUndef") ||
          (inst.kind === "loadConst" && folded === undefined)) {
        if (PRIMITIVE(folded)) env.set(inst.dst, folded);
        else env.delete(inst.dst);
      } else {
        for (const w of writes) env.delete(w);
      }

      if (!(pure && dstDead))
        blk.steps.push({ inst, constIn: snapshot(env, instReads(inst), inst), dead: dstDead });

      prune(env, live);
      pc = inst.next;
    }
  }

  /**
   * Once the branches have folded, most of the mixed-boolean arithmetic exists
   * only to compute conditions nobody asks any more.  Walk the block backwards
   * and drop every pure step whose result is not read — reads that were
   * constant-folded do not count, which is what makes the chains collapse.
   */
  function pruneSteps(blk) {
    const live = new Set(blk.exitLive || []);
    const kept = [];
    for (let i = blk.steps.length - 1; i >= 0; i--) {
      const st = blk.steps[i];
      const inst = st.inst;
      const writes = instWrites(inst);
      const dstLive = writes.length === 0 || live.has(writes[0]);
      if (PURE_KINDS.has(inst.kind) && !dstLive) continue;
      st.dead = writes.length > 0 && !dstLive;
      for (const w of writes) live.delete(w);
      for (const r of instReads(inst)) if (!st.constIn.has(r)) live.add(r);
      kept.push(st);
    }
    kept.reverse();
    blk.steps = kept;
  }

  function snapshot(env, regs, inst) {
    const m = new Map();
    for (const r of regs) if (env.has(r)) m.set(r, env.get(r));
    if (inst && inst.dst !== undefined) m.delete(inst.dst);
    return m;
  }

  // inside a block every constant is useful; only what crosses a block
  // boundary needs restricting (see blockFor)
  function prune(env, live) {
    for (const k of [...env.keys()]) if (!live.has(k)) env.delete(k);
  }

  pruneGraph(blocks, capturedForever(fnRec));
  return { ok: true, blocks, entryId, perPc, variance };
}

function capturedForever(fnRec) {
  const forever = new Set();
  for (const inst of fnRec.insts.values())
    if (inst.kind === "makeFunction")
      for (const c of inst.captures) if (c.own) forever.add(c.idx);
  return forever;
}

/**
 * Liveness over the *specialized* graph.  Reads that were constant-folded do
 * not keep a register alive, so the state variable of the flattening — whose
 * only readers were the dispatcher predicates — dies here along with the
 * constants that fed it.
 */
function pruneGraph(blocks, forever) {
  const liveIn = new Map();
  for (const id of blocks.keys()) liveIn.set(id, new Set(forever));
  const stepReads = (st) => instReads(st.inst).filter((r) => !st.constIn.has(r));

  for (let iter = 0; iter < 200; iter++) {
    let changed = false;
    for (const b of blocks.values()) {
      const live = new Set(forever);
      for (const e of b.edges) for (const v of liveIn.get(e.to) || []) live.add(v);
      for (let i = b.steps.length - 1; i >= 0; i--) {
        const st = b.steps[i];
        for (const w of instWrites(st.inst)) if (!forever.has(w)) live.delete(w);
        for (const r of stepReads(st)) live.add(r);
      }
      const prev = liveIn.get(b.id);
      if (live.size !== prev.size || [...live].some((v) => !prev.has(v))) {
        liveIn.set(b.id, live);
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const b of blocks.values()) {
    const live = new Set(forever);
    for (const e of b.edges) for (const v of liveIn.get(e.to) || []) live.add(v);
    const kept = [];
    for (let i = b.steps.length - 1; i >= 0; i--) {
      const st = b.steps[i];
      const writes = instWrites(st.inst);
      const dstLive = writes.length === 0 || live.has(writes[0]);
      if (PURE_KINDS.has(st.inst.kind) && !dstLive) continue;
      st.dead = writes.length > 0 && !dstLive;
      for (const w of writes) if (!forever.has(w)) live.delete(w);
      for (const r of stepReads(st)) live.add(r);
      kept.push(st);
    }
    kept.reverse();
    b.steps = kept;
  }
}

/* ========================================================================== *
 * 10. output cleanup
 * ========================================================================== */

const RESERVED = new Set(("break case catch class const continue debugger default delete do " +
  "else export extends finally for function if import in instanceof new return super switch " +
  "this throw try typeof var void while with yield let static enum await implements package " +
  "protected interface private public null true false undefined NaN Infinity arguments eval")
  .split(" "));

function isPureExpr(n) {
  switch (n.type) {
    case "NumericLiteral": case "StringLiteral": case "BooleanLiteral":
    case "NullLiteral": case "Identifier": case "ThisExpression":
    case "FunctionExpression": case "ArrowFunctionExpression":
      return true;
    case "UnaryExpression":
      return n.operator !== "delete" && isPureExpr(n.argument);
    case "BinaryExpression":
      return isPureExpr(n.left) && isPureExpr(n.right);
    case "LogicalExpression":
      return isPureExpr(n.left) && isPureExpr(n.right);
    case "ConditionalExpression":
      return isPureExpr(n.test) && isPureExpr(n.consequent) && isPureExpr(n.alternate);
    case "ArrayExpression":
      return n.elements.every((e) => !e || isPureExpr(e));
    case "ObjectExpression":
      return n.properties.every((p) => p.type === "ObjectProperty" &&
        (!p.computed || isPureExpr(p.key)) && isPureExpr(p.value));
    default:
      return false;
  }
}

const REG_RE = /^v\d+_(\d+|s\d+)$/;

/**
 * Dead-store elimination.  Register names are globally unique by construction,
 * so a whole-program read count is enough — no scope analysis needed, which
 * keeps this linear instead of quadratic on very large functions.
 */
function dropDeadRegisters(ast) {
  for (let round = 0; round < 10; round++) {
    const reads = new Map();
    countReads(ast, reads);

    let removed = 0;
    traverse(ast, {
      ExpressionStatement(p) {
        const e = p.node.expression;
        if (e.type !== "AssignmentExpression" || e.operator !== "=") return;
        if (e.left.type !== "Identifier" || !REG_RE.test(e.left.name)) return;
        if ((reads.get(e.left.name) || 0) > 0) return;
        if (isPureExpr(e.right)) p.remove();
        else p.replaceWith(t.expressionStatement(e.right));
        removed++;
      },
      AssignmentExpression(p) {
        if (p.parentPath.isExpressionStatement()) return;
        const e = p.node;
        if (e.operator !== "=" || e.left.type !== "Identifier") return;
        if (!REG_RE.test(e.left.name)) return;
        if ((reads.get(e.left.name) || 0) > 0) return;
        p.replaceWith(e.right);
        removed++;
      },
      VariableDeclarator(p) {
        const id = p.node.id;
        if (id.type !== "Identifier" || !REG_RE.test(id.name)) return;
        if ((reads.get(id.name) || 0) > 0) return;
        if (p.node.init && !isPureExpr(p.node.init)) return;
        p.remove();
        removed++;
      },
    });
    traverse(ast, {
      VariableDeclaration(p) { if (p.node.declarations.length === 0) p.remove(); },
    });
    if (!removed) break;
  }
}

function countReads(ast, reads) {
  traverse(ast, {
    Identifier(p) {
      const name = p.node.name;
      if (!REG_RE.test(name)) return;
      const parent = p.parent;
      if (parent.type === "AssignmentExpression" && parent.left === p.node &&
          parent.operator === "=") return;
      if (parent.type === "VariableDeclarator" && parent.id === p.node) return;
      if (parent.type === "MemberExpression" && parent.property === p.node &&
          !parent.computed) return;
      if (parent.type === "ObjectProperty" && parent.key === p.node && !parent.computed) return;
      if (parent.type === "FunctionExpression" || parent.type === "RestElement") return;
      reads.set(name, (reads.get(name) || 0) + 1);
    },
  });
}

/** Give every register a short name, respecting nesting and captured names. */
function renameRegisters(ast) {
  const globals = new Set(RESERVED);
  traverse(ast, {
    Identifier(p) {
      const name = p.node.name;
      if (REG_RE.test(name)) return;
      const parent = p.parent;
      if (parent.type === "MemberExpression" && parent.property === p.node && !parent.computed) return;
      if (parent.type === "ObjectProperty" && parent.key === p.node && !parent.computed) return;
      globals.add(name);
    },
    LabeledStatement(p) { globals.add(p.node.label.name); },
  });

  const mapping = new Map();
  const assign = (fnPath, taken) => {
    const declared = [];
    const seen = new Set();
    fnPath.traverse({
      Function(q) { q.skip(); },
      Identifier(q) {
        const name = q.node.name;
        if (!REG_RE.test(name) || seen.has(name)) return;
        seen.add(name);
        declared.push(name);
      },
    });
    if (fnPath.isFunction()) {
      for (const prm of fnPath.node.params) {
        const id = prm.type === "RestElement" ? prm.argument : prm;
        if (id.type === "Identifier" && REG_RE.test(id.name) && !seen.has(id.name)) {
          seen.add(id.name); declared.unshift(id.name);
        }
      }
    }
    declared.sort((a, b) => {
      const ka = a.match(/^v(\d+)_(s?)(\d+)$/);
      const kb = b.match(/^v(\d+)_(s?)(\d+)$/);
      return (+ka[1]) - (+kb[1]) || (ka[2] ? 1 : 0) - (kb[2] ? 1 : 0) || (+ka[3]) - (+kb[3]);
    });
    const next = new Set(taken);
    let i = 0;
    for (const old of declared) {
      if (mapping.has(old)) { next.add(mapping.get(old)); continue; }
      let name;
      do { name = nameForIndex(i++); } while (next.has(name));
      next.add(name);
      mapping.set(old, name);
    }
    const kids = [];
    fnPath.traverse({
      Function(q) { kids.push(q); q.skip(); },
    });
    for (const k of kids) assign(k, next);
  };

  traverse(ast, {
    Program(p) { assign(p, globals); p.stop(); },
  });

  traverse(ast, {
    Identifier(p) {
      const to = mapping.get(p.node.name);
      if (!to) return;
      const parent = p.parent;
      if (parent.type === "MemberExpression" && parent.property === p.node && !parent.computed) return;
      if (parent.type === "ObjectProperty" && parent.key === p.node && !parent.computed) return;
      p.node.name = to;
    },
  });
}

function nameForIndex(i) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  let n = i;
  do { s = letters[n % 26] + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/* --------------------------------------------------------------------------
 * Mixed boolean-arithmetic simplification
 *
 * JS-Confuser rewrites `a - b` into pages of algebra that is *identically*
 * equal to it.  Rather than pattern-matching the expansions, evaluate the
 * expression tree (with a small interpreter — never `eval`) on a large,
 * deliberately awkward sample set and see whether a short expression agrees on
 * every single sample, floats and out-of-range values included.  A rewrite that
 * only holds for int32 inputs is rejected by the float samples, so a match is
 * never an approximation.
 * ------------------------------------------------------------------------ */

const ARITH_BINARY = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"]);
const ARITH_UNARY = new Set(["-", "+", "~"]);

function arithVars(node, out) {
  switch (node.type) {
    case "NumericLiteral": return true;
    case "Identifier":
      out.add(node.name);
      return out.size <= 3;
    case "UnaryExpression":
      return ARITH_UNARY.has(node.operator) && arithVars(node.argument, out);
    case "BinaryExpression":
      return ARITH_BINARY.has(node.operator) &&
        arithVars(node.left, out) && arithVars(node.right, out);
    default: return false;
  }
}

function arithSize(node) {
  if (node.type === "BinaryExpression") return 1 + arithSize(node.left) + arithSize(node.right);
  if (node.type === "UnaryExpression") return 1 + arithSize(node.argument);
  return 1;
}

function evalArith(node, env) {
  switch (node.type) {
    case "NumericLiteral": return node.value;
    case "Identifier": return env[node.name];
    case "UnaryExpression": {
      const v = evalArith(node.argument, env);
      if (node.operator === "-") return -v;
      if (node.operator === "+") return +v;
      return ~v;
    }
    case "BinaryExpression": {
      const l = evalArith(node.left, env);
      const r = evalArith(node.right, env);
      switch (node.operator) {
        case "+": return l + r; case "-": return l - r; case "*": return l * r;
        case "/": return l / r; case "%": return l % r;
        case "&": return l & r; case "|": return l | r; case "^": return l ^ r;
        case "<<": return l << r; case ">>": return l >> r; case ">>>": return l >>> r;
      }
      return NaN;
    }
    default: return NaN;
  }
}

const MBA_SAMPLES = (() => {
  // Non-numeric samples come first and are deliberately nasty: a rewrite that
  // drops a `|0` looks fine on numbers but changes `"5" + "5"` into `"55"`.
  // With these in the set such a candidate is rejected, and the `x | 0` form
  // is chosen instead.
  const odd = ["0", "1", "5", "-3", "abc", "", " ", "1e3", "0x10",
    true, false, null, undefined, NaN, Infinity, -0];
  const mixed = [];
  for (let i = 0; i < odd.length; i++)
    mixed.push([odd[i], odd[(i + 1) % odd.length], odd[(i + 2) % odd.length]],
      [odd[i], 7, -3], [3, odd[i], 11]);

  const base = [0, 1, -1, 2, -2, 3, 7, 15, 16, 255, 256, 65535, 65536, 123456789,
    -123456789, 2147483647, -2147483648, 1073741824, -1073741825, 0.5, -0.5,
    1.25, 3.75, 1e10, -1e10, 12.5, 99.9];
  const numeric = [];
  for (const a of base) for (const b of base) numeric.push([a, b, (a ^ b) | 0]);

  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 4e9 - 2e9;
  };
  for (let i = 0; i < 600; i++) {
    const a = rnd(), b = rnd(), c = rnd();
    numeric.push([Math.round(a), Math.round(b), Math.round(c)], [a, b, c]);
  }
  return [...mixed, ...numeric];
})();

const MBA_QUICK = 64;   // prefilter window; covers every mixed-type sample

function sameValue(a, b) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === 0 && b === 0) return Object.is(a, b);
  return a === b;
}

function simplifyArithmetic(node) {
  const vars = new Set();
  if (!arithVars(node, vars)) return null;
  if (vars.size > 3) return null;
  const size = arithSize(node);
  if (size < 3) return null;

  const names = [...vars];
  const [x, y, z] = names;
  const env = {};

  const evalOn = (expr, from, to) => {
    const out = [];
    for (let i = from; i < to; i++) {
      const s2 = MBA_SAMPLES[i];
      if (x !== undefined) env[x] = s2[0];
      if (y !== undefined) env[y] = s2[1];
      if (z !== undefined) env[z] = s2[2];
      out.push(evalArith(expr, env));
    }
    return out;
  };

  const V = (n) => t.identifier(n);
  const candidates = [];
  for (let i = 0; i < names.length; i++)
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue;
      for (const op of ["+", "-", "*", "&", "|", "^", "<<", ">>", ">>>", "%"])
        candidates.push(t.binaryExpression(op, V(names[i]), V(names[j])));
    }
  for (const n of names) {
    candidates.push(V(n));
    candidates.push(t.unaryExpression("~", V(n)));
    candidates.push(t.unaryExpression("-", V(n)));
    candidates.push(t.binaryExpression("|", V(n), t.numericLiteral(0)));
  }

  // cheap pre-filter over the awkward samples, then confirm on all of them
  const QUICK = MBA_QUICK;
  const quick = evalOn(node, 0, QUICK);
  if (quick.every((v) => sameValue(v, quick[0])) && Number.isFinite(quick[0]))
    candidates.push(valueToNode(quick[0]));

  const survivors = candidates.filter((c) => {
    if (arithSize(c) >= size) return false;
    const got = evalOn(c, 0, QUICK);
    return got.every((v, i) => sameValue(v, quick[i]));
  });
  if (!survivors.length) return null;

  const full = evalOn(node, QUICK, MBA_SAMPLES.length);
  for (const cand of survivors) {
    const got = evalOn(cand, QUICK, MBA_SAMPLES.length);
    if (got.every((v, i) => sameValue(v, full[i]))) return cand;
  }
  return null;
}

/** bottom-up rewrite; a replacement is only taken when it is strictly smaller */
function simplifyMBANode(node) {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type !== "string") return node;
  for (const k of t.VISITOR_KEYS[node.type] || []) {
    const child = node[k];
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++)
        if (child[i]) child[i] = simplifyMBANode(child[i]);
    } else if (child) {
      node[k] = simplifyMBANode(child);
    }
  }
  if (node.type === "BinaryExpression" || node.type === "UnaryExpression") {
    const s = simplifyArithmetic(node);
    if (s && arithSize(s) < arithSize(node)) return s;
  }
  return node;
}

function simplifyMBA(ast) {
  simplifyMBANode(ast.program);
}

/* --------------------------------------------------------------------------
 * Collapse the relooper's dispatch variable.
 *
 * `if (c) { _lbl = 1 } else { _lbl = 2 }` immediately followed by
 * `if (_lbl === 1) { X } else if (_lbl === 2) { Y }` is just `if (c) X else Y`.
 * The assignment dominates the dispatch (a `continue` re-enters the loop body
 * from the top, so it runs the assignment again), which makes the rewrite safe
 * wherever the two statements are adjacent.
 * ------------------------------------------------------------------------ */

function labelAssignTree(node, out) {
  if (node.type === "ExpressionStatement") {
    const e = node.expression;
    if (e.type !== "AssignmentExpression" || e.operator !== "=") return false;
    if (e.left.type !== "Identifier" || e.left.name !== LABEL_VAR) return false;
    if (e.right.type !== "NumericLiteral") return false;
    out.push({ value: e.right.value, holder: node });
    return true;
  }
  if (node.type === "BlockStatement")
    return node.body.length === 1 && labelAssignTree(node.body[0], out);
  if (node.type === "IfStatement")
    return !!node.alternate && labelAssignTree(node.consequent, out) &&
      labelAssignTree(node.alternate, out);
  return false;
}

function dispatchHandlers(node) {
  const map = new Map();
  let cur = node;
  while (cur && cur.type === "IfStatement") {
    const c = cur.test;
    if (c.type !== "BinaryExpression" || c.operator !== "===") return null;
    if (c.left.type !== "Identifier" || c.left.name !== LABEL_VAR) return null;
    if (c.right.type !== "NumericLiteral") return null;
    map.set(c.right.value, cur.consequent);
    cur = cur.alternate;
  }
  if (cur) return null;         // a trailing else means an unlabelled path
  return map;
}

function replaceLabelAssign(node, value, body) {
  if (node.type === "ExpressionStatement") return body;
  if (node.type === "BlockStatement")
    return t.blockStatement([replaceLabelAssign(node.body[0], value, body)]);
  const holderValue = (n) => {
    const out = [];
    labelAssignTree(n, out);
    return out;
  };
  const inCons = holderValue(node.consequent).some((h) => h.value === value);
  if (inCons)
    return t.ifStatement(node.test, replaceLabelAssign(node.consequent, value, body),
      node.alternate);
  return t.ifStatement(node.test, node.consequent,
    replaceLabelAssign(node.alternate, value, body));
}

function collapseDispatch(ast) {
  let changed = true;
  for (let round = 0; round < 12 && changed; round++) {
    changed = false;
    traverse(ast, {
      "BlockStatement|Program"(p) {
        const body = p.node.body;
        for (let i = 0; i + 1 < body.length; i++) {
          const assigns = [];
          if (!labelAssignTree(body[i], assigns)) continue;
          const handlers = dispatchHandlers(body[i + 1]);
          if (!handlers) continue;
          const values = assigns.map((a) => a.value);
          if (new Set(values).size !== values.length) continue;
          if (!values.every((v) => handlers.has(v))) continue;
          if (handlers.size !== values.length) continue;
          let tree = body[i];
          for (const { value } of assigns)
            tree = replaceLabelAssign(tree, value, handlers.get(value));
          body.splice(i, 2, tree);
          changed = true;
          return;
        }
      },
    });
  }
}

/** Drop `_lbl` entirely from functions that end up never reading it. */
function dropUnusedDispatchVar(ast) {
  traverse(ast, {
    "Program|Function"(p) {
      let reads = 0;
      p.traverse({
        Function(q) { q.skip(); },
        Identifier(q) {
          if (q.node.name !== LABEL_VAR) return;
          if (q.parentPath.isAssignmentExpression({ left: q.node })) return;
          if (q.parentPath.isVariableDeclarator({ id: q.node })) return;
          reads++;
        },
      });
      if (reads) return;
      p.traverse({
        Function(q) { q.skip(); },
        ExpressionStatement(q) {
          const e = q.node.expression;
          if (e.type === "AssignmentExpression" && e.left.type === "Identifier" &&
              e.left.name === LABEL_VAR) q.remove();
        },
        VariableDeclarator(q) {
          if (q.node.id.type === "Identifier" && q.node.id.name === LABEL_VAR &&
              !q.node.init) q.remove();
        },
      });
    },
  });
  traverse(ast, {
    VariableDeclaration(p) { if (p.node.declarations.length === 0) p.remove(); },
  });
}

/** Cosmetic tidy-up: redundant blocks, `!!` in tests, empty if-branches. */
function tidyStatements(ast) {
  traverse(ast, {
    BlockStatement(p) {
      const out = [];
      let changed = false;
      for (const st of p.node.body) {
        if (st.type === "BlockStatement") { out.push(...st.body); changed = true; }
        else out.push(st);
      }
      if (changed) p.node.body = out;
    },
    IfStatement: {
      exit(p) {
        const n = p.node;
        if (n.test.type === "UnaryExpression" && n.test.operator === "!" &&
            n.test.argument.type === "UnaryExpression" && n.test.argument.operator === "!")
          n.test = n.test.argument.argument;
        const empty = (b) => !b || (b.type === "BlockStatement" && b.body.length === 0);
        if (empty(n.consequent) && n.alternate && !empty(n.alternate)) {
          n.consequent = n.alternate;
          n.alternate = null;
          n.test = n.test.type === "UnaryExpression" && n.test.operator === "!"
            ? n.test.argument : t.unaryExpression("!", n.test);
        } else if (empty(n.alternate)) {
          n.alternate = null;
        }
        if (empty(n.consequent) && !n.alternate) {
          if (isPureExpr(n.test)) p.remove();
          else p.replaceWith(t.expressionStatement(n.test));
        }
      },
    },
    ContinueStatement(p) {
      // a `continue` as the last statement of the loop it belongs to is noise
      const loop = p.findParent((q) => q.isLoop());
      if (!loop || !loop.node.body || loop.node.body.type !== "BlockStatement") return;
      const body = loop.node.body.body;
      if (body[body.length - 1] !== p.node) return;
      const labelled = loop.parentPath.isLabeledStatement();
      if (p.node.label && (!labelled || loop.parentPath.node.label.name !== p.node.label.name))
        return;
      p.remove();
    },
  });
}

function cleanupProgram(ast) {
  collapseDispatch(ast);
  simplifyMBA(ast);
  dropDeadRegisters(ast);
  collapseDispatch(ast);
  simplifyMBA(ast);
  dropDeadRegisters(ast);
  dropUnusedDispatchVar(ast);
  tidyStatements(ast);
  dropDeadRegisters(ast);
  renameRegisters(ast);
}


/* ========================================================================== *
 * 11. driver
 * ========================================================================== */

const HELPER_SOURCE = {
  _enumKeys:
    "function _enumKeys(o) {\n" +
    "  var out = [];\n" +
    "  if (o === null || o === undefined) return out;\n" +
    "  var seen = Object.create(null);\n" +
    "  for (o = Object(o); o !== null; o = Object.getPrototypeOf(o)) {\n" +
    "    var names = Object.getOwnPropertyNames(o);\n" +
    "    for (var i = 0; i < names.length; i++) {\n" +
    "      var k = names[i];\n" +
    "      if (k in seen) continue;\n" +
    "      seen[k] = true;\n" +
    "      var d = Object.getOwnPropertyDescriptor(o, k);\n" +
    "      if (d && d.enumerable) out.push(k);\n" +
    "    }\n" +
    "  }\n" +
    "  return out;\n" +
    "}",
  _defineGetter:
    "function _defineGetter(obj, key, fn) {\n" +
    "  var prev = Object.getOwnPropertyDescriptor(obj, key);\n" +
    "  var d = { get: fn, configurable: true, enumerable: true };\n" +
    "  if (prev && typeof prev.set === 'function') d.set = prev.set;\n" +
    "  Object.defineProperty(obj, key, d);\n" +
    "}",
  _defineSetter:
    "function _defineSetter(obj, key, fn) {\n" +
    "  var prev = Object.getOwnPropertyDescriptor(obj, key);\n" +
    "  var d = { set: fn, configurable: true, enumerable: true };\n" +
    "  if (prev && typeof prev.get === 'function') d.get = prev.get;\n" +
    "  Object.defineProperty(obj, key, d);\n" +
    "}",
};

/**
 * Deobfuscate a JS-Confuser-VM protected source string.
 * Files that do not contain the VM are returned unchanged.
 */
function deobfuscateSource(code, opts) {
  const options = { specialize: true, ...(opts || {}) };
  let ast;
  try {
    ast = parser.parse(code, { sourceType: "unambiguous", errorRecovery: true });
  } catch {
    return { code, changed: false, reason: "parse-error" };
  }

  const vm = detectVM(ast);
  if (!vm) return { code, changed: false, reason: "no-vm" };
  const payload = extractPayload(ast, vm);
  if (!payload) return { code, changed: false, reason: "no-payload" };

  const opmap = buildOpcodeMap(vm);
  const dis = disassemble(payload, opmap);

  const lifter = createLifter(payload, options);
  const topFn = lifter.liftFunction(dis.top, []);

  const body = [];
  for (const name of [...lifter.usedHelpers].sort())
    body.push(...parser.parse(HELPER_SOURCE[name]).program.body);

  // The entry "function" is the whole program; it may `return` and its `this`
  // is the global object, so keep it as a function and call it with globalThis.
  if (topLevelIsPlain(topFn)) {
    const stmts = topFn.body.body.slice();
    while (stmts.length && stmts[stmts.length - 1].type === "ReturnStatement") stmts.pop();
    body.push(...stmts);
  } else {
    body.push(t.expressionStatement(t.callExpression(
      t.memberExpression(topFn, t.identifier("call")), [t.identifier("globalThis")])));
  }

  const out = t.file(t.program(body));
  if (!options.skipCleanup) cleanupProgram(out);

  return {
    code: generate(out, { comments: false, jsescOption: { minimal: true } }).code + "\n",
    changed: true,
    stats: {
      functions: dis.functions.size,
      instructions: [...dis.functions.values()].reduce((a, f) => a + f.insts.size, 0),
      poolSize: payload.pool.length,
      words: payload.words.length,
    },
  };
}

/** true when the entry body can simply become top-level statements */
function topLevelIsPlain(fnExpr) {
  let ok = true;
  const wrapper = t.file(t.program([t.expressionStatement(fnExpr)]));
  traverse(wrapper, {
    Function(p) {
      if (p.node !== fnExpr) { p.skip(); return; }
      p.traverse({
        Function(q) { q.skip(); },
        ThisExpression() { ok = false; },
        ReturnStatement(q) {
          // only a bare trailing `return x;` is droppable
          if (q.parentPath.node !== fnExpr.body) ok = false;
          else if (fnExpr.body.body.indexOf(q.node) !== fnExpr.body.body.length - 1) ok = false;
        },
      });
    },
  });
  return ok;
}

function deobfuscate(inputFile, outputFile) {
  const code = fs.readFileSync(inputFile, "utf8");
  const res = deobfuscateSource(code);
  if (outputFile) fs.writeFileSync(outputFile, res.code);
  return res.code;
}

module.exports = deobfuscate;
module.exports.deobfuscateSource = deobfuscateSource;
Object.assign(module.exports, { detectVM, extractPayload, makeDecoder, canonicalize, specFor,
  identifyMBA, buildOpcodeMap, disassemble, Block, reloop, renderShape, pruneLabels, LABEL_VAR,
  clone, traverseNode, isThisMember, literalValue, own, createLifter,
  combineExpressions, computeLiveness, collectRegRefs, computeInstLiveness, specializeFunction, ssaRenameBlock });

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error("usage: node vm.js <input.js> [output.js]");
    process.exit(1);
  }
  const res = deobfuscateSource(fs.readFileSync(input, "utf8"));
  if (output) fs.writeFileSync(output, res.code);
  else process.stdout.write(res.code);
  if (res.changed) {
    console.error(`deobfuscated ${input}: ${res.stats.functions} functions, ` +
      `${res.stats.instructions} instructions, ${res.stats.poolSize} constants` +
      (output ? ` -> ${output}` : ""));
  } else {
    console.error(`${input}: not JS-Confuser-VM output (${res.reason}); copied unchanged`);
  }
}
