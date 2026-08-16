/**
 * vm.js — AST deobfuscator for "JS-Confuser-VM 0.1.5" full-program VM obfuscation.
 *
 * Options covered: controlFlowFlattening + dispatcher, minify, classObfuscation,
 * handlerTable, randomizeOpcodes, shuffleOpcodes, encodeBytecode, concealConstants.
 *
 * Pipeline (all AST work via @babel/parser / @babel/traverse / @babel/generator):
 *   1. Pattern match the VM boot expression on the parsed AST:
 *        r("<base64 bytecode>")  and  (new <VM>(E, C, [<constants pool>])).E(..., new <meta>({j,b,p,d}), ...)
 *      If the pattern is absent the input is returned unchanged (pass-through).
 *   2. Decode bytecode -> Uint32 words; statically apply DECRYPT (encodeBytecode)
 *      self-decryption ops in execution order.
 *   3. Disassemble using the operand layouts recovered from the 61 opcode handlers.
 *   4. Auto-detect the control-flow-flattening machinery per function: trampoline,
 *      dispatcher entry, state/accumulator/delta/mask registers, header block.
 *   5. Explore each function's CFG by abstract interpretation; the dispatcher hash
 *      is emulated concretely to resolve computed JUMP_REG edges.
 *   6. Unflatten: rebuild the case table from accumulator partial sums, eliminate
 *      header/chain/stub/trampoline machinery, recover the real CFG.
 *   7. Lift real blocks to a Babel AST (registers -> variables, decoded constants
 *      inlined, closures mapped to captured outer variables).
 *   8. Cleanup pass: copy propagation of single-use pure assignments + method-call
 *      restoration (F.call(O, ...) -> O.F(...)).
 *
 * Usage:
 *   node vm.js input.js output.js
 *   const deobfuscate = require('./vm.js'); deobfuscate('input.js') -> code string
 */
'use strict';

const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;

/* ================================================================== *
 * 1. AST pattern matching & payload extraction
 * ================================================================== */

// Evaluate a literal pool element from the AST.
function evalLiteral(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'Identifier':
      return node.name === 'undefined' ? undefined : undefined;
    case 'UnaryExpression': {
      const v = evalLiteral(node.argument);
      switch (node.operator) {
        case '-': return -v;
        case '+': return +v;
        case '!': return !v;
        case '~': return ~v;
        case 'void': return undefined;
        case 'typeof': return typeof v;
      }
      return undefined;
    }
  }
  return undefined;
}

// Find the JS-Confuser-VM pattern on the AST. Returns null when the file is not
// obfuscated with this technique (caller then passes the source through unchanged).
function extractFromAst(ast) {
  let payload = null; // base64 bytecode string
  let pool = null; // constants pool array
  let bootMeta = null; // {j, b, p, d}

  traverse(ast, {
    CallExpression(path) {
      const node = path.node;
      // (a) bytecode payload: f("<long base64 literal>")
      if (
        node.callee.type === 'Identifier' &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'StringLiteral'
      ) {
        const v = node.arguments[0].value;
        if (v.length > 512 && /^[A-Za-z0-9+/=]+$/.test(v)) {
          if (!payload || v.length > payload.length) payload = v;
        }
      }
      // (b) boot call: (new X(a, b, [pool])).E(..., new g({j,b,p,d}), ...)
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object.type === 'NewExpression' &&
        node.callee.object.arguments.length >= 3 &&
        node.callee.object.arguments[2].type === 'ArrayExpression' &&
        node.callee.object.arguments[2].elements.length > 10
      ) {
        pool = node.callee.object.arguments[2].elements.map(evalLiteral);
        for (const arg of node.arguments) {
          if (
            arg.type === 'NewExpression' &&
            arg.arguments.length === 1 &&
            arg.arguments[0].type === 'ObjectExpression'
          ) {
            const meta = {};
            for (const prop of arg.arguments[0].properties) {
              if (prop.type === 'ObjectProperty') {
                const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
                meta[key] = evalLiteral(prop.value);
              }
            }
            if (typeof meta.p === 'number') bootMeta = meta;
          }
        }
      }
    },
  });

  if (!payload || !pool) return null;
  if (!bootMeta) bootMeta = { j: 0, b: 6, p: 0 };
  return { payload, pool, bootMeta };
}

/* ================================================================== *
 * 2. Bytecode decoding + static DECRYPT (encodeBytecode)
 * ================================================================== */

function decodeWords(b64) {
  const buf = Buffer.from(b64, 'base64');
  const words = new Uint32Array(buf.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] = (buf[i * 4] | (buf[i * 4 + 1] << 8) | (buf[i * 4 + 2] << 16) | (buf[i * 4 + 3] << 24)) >>> 0;
  }
  return words;
}

/* ================================================================== *
 * 3. Disassembler (opcode layout recovered from the 61 handlers)
 * ================================================================== */

const MAGIC = 3247410626; // spread marker used by CALL/CALL_NULL/NEW
const OPS = {
  26: ['NOT', 2], 464: ['THROW', 1], 750: ['DEFINE_GETTER', 3], 1149: ['RETURN', 1],
  1864: ['JUMP', 1], 2073: ['XOR', 3], 2939: ['JUMP_REG', 1], 3207: ['CALL', 'call'],
  4239: ['MAKE_OBJECT', 'object'], 5540: ['LOAD_UNDEF', 2], 8957: ['GE', 3], 9273: ['MOD', 3],
  10246: ['STRICT_NE', 3], 10292: ['NEG', 2], 11549: ['TYPEOF', 2], 12250: ['SUB', 3],
  14945: ['FORIN_NEXT', 3], 16990: ['SHR', 3], 19562: ['MOVE', 2], 21410: ['SET_PROP', 3],
  24481: ['LOAD_GLOBAL', 3], 25103: ['TRY', 4], 28700: ['STORE_CLOSURE', 2], 29884: ['IN', 3],
  30300: ['INSTANCEOF', 3], 31355: ['EQ', 3], 31655: ['GT', 3], 31871: ['USHR', 3],
  33322: ['LOAD_CLOSURE', 2], 34503: ['AND', 3], 35033: ['SHL', 3], 35122: ['JUMP_IF_FALSE', 2],
  36652: ['DEFINE_SETTER', 3], 38134: ['POW', 3], 38534: ['LOAD_CONST', 3], 40370: ['LT', 3],
  43207: ['GET_PROP', 3], 43221: ['MAKE_ARRAY', 'array'], 43498: ['LE', 3], 44050: ['POS', 2],
  44091: ['FORIN_SETUP', 2], 44681: ['DECRYPT', 4], 45389: ['BNOT', 2], 46657: ['NEW', 'new'],
  48269: ['TYPEOF_GLOBAL', 3], 52128: ['LOAD_THIS', 1], 53842: ['OR', 3], 56068: ['POP_TRY', 0],
  56444: ['DEBUGGER', 0], 57129: ['ADD', 3], 59112: ['JUMP_IF_TRUE', 2], 60197: ['CALL_NULL', 'callnull'],
  60563: ['DELETE', 3], 60779: ['STRICT_EQ', 3], 61109: ['NE', 3], 61360: ['STORE_GLOBAL', 3],
  61431: ['MAKE_FUNC', 'func'], 62094: ['DIV', 3], 62459: ['TRY2', 2], 63117: ['LOAD_LITERAL', 2],
  65297: ['MUL', 3],
};

function varCount(kind, w, i) {
  switch (kind) {
    case 'func': return 6 + 2 * w[i + 4]; // dest, p, j, b, nclosures, d, (H,e)*
    case 'call': return 4 + (w[i + 3] === MAGIC ? 1 : w[i + 3]); // dest, this, fn, argc|MAGIC, args...
    case 'callnull':
    case 'new': return 3 + (w[i + 2] === MAGIC ? 1 : w[i + 2]); // dest, fn, argc|MAGIC, args...
    case 'object': return 2 + 2 * w[i + 1]; // dest, count, (key,val)*
    case 'array': return 2 + w[i + 1]; // dest, count, regs...
  }
  throw new Error('bad var kind ' + kind);
}

const BIN_SYM = {
  ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%', POW: '**', AND: '&', OR: '|', XOR: '^',
  SHL: '<<', SHR: '>>', USHR: '>>>', EQ: '==', NE: '!=', STRICT_EQ: '===', STRICT_NE: '!==',
  LT: '<', LE: '<=', GT: '>', GE: '>=', IN: 'in', INSTANCEOF: 'instanceof',
};
const BIN_OPS = Object.keys(BIN_SYM);
const UN_OPS = ['NEG', 'POS', 'NOT', 'BNOT', 'TYPEOF'];

function makeCtx(words, pool) {
  // Constant decoder (concealConstants): pool entry XOR key, or base64 + TEA-style
  // stream cipher for strings.
  function decodeConst(idx, key) {
    const b = pool[idx];
    if (!key) return b;
    if (typeof b === 'number') return b ^ key;
    if (typeof b !== 'string') return b;
    const buf = Buffer.from(b, 'base64');
    let e = '', c = key;
    for (let a = 0; a < buf.length / 2; a++) {
      c = (c + 2654435769) | 0;
      e += String.fromCharCode(((buf[a * 2] | (buf[a * 2 + 1] << 8)) ^ (c ^ (c >>> 13))) & 65535);
    }
    return e;
  }
  function decodeAt(ip) {
    const opcode = words[ip];
    const info = OPS[opcode];
    if (!info) return null;
    const [name, kind] = info;
    const n = typeof kind === 'number' ? kind : varCount(kind, words, ip + 1);
    return { ip, opcode, name, operands: Array.from(words.slice(ip + 1, ip + 1 + n)), size: 1 + n };
  }
  return { words, pool, decodeConst, decodeAt };
}

// Walk the bytecode from the entry in execution order, applying DECRYPT self-
// decryption ops in place, so later passes see the decoded instruction stream.
function applyStaticDecrypts(words, entry) {
  const K = words.slice();
  const tmpCtx = makeCtx(K, []);
  const visited = new Set();
  const applied = new Set();
  const worklist = [entry];
  while (worklist.length) {
    let ip = worklist.pop();
    while (true) {
      if (visited.has(ip) || ip < 0 || ip >= K.length) break;
      const ins = tmpCtx.decodeAt(ip);
      if (!ins) break;
      visited.add(ip);
      const o = ins.operands;
      switch (ins.name) {
        case 'JUMP': ip = o[0]; continue;
        case 'JUMP_IF_TRUE':
        case 'JUMP_IF_FALSE': worklist.push(o[1]); ip += ins.size; continue;
        case 'MAKE_FUNC': worklist.push(o[1]); ip += ins.size; continue;
        case 'TRY':
        case 'TRY2': for (const t of o) worklist.push(t); ip += ins.size; continue;
        case 'DECRYPT': {
          const [a, b, c, e0] = o;
          const key = a + ',' + b + ',' + c + ',' + e0;
          if (!applied.has(key)) {
            applied.add(key);
            let e = (e0 ^ a) | 0;
            for (let f = b; f < c; f++) {
              e = (e + 2654435769) | 0;
              K[a + (f - b)] = (K[f] ^ e ^ (e >>> 13)) >>> 0;
            }
          }
          ip += ins.size; continue;
        }
        default: ip += ins.size; continue;
        case 'RETURN':
        case 'THROW':
        case 'JUMP_REG': break;
      }
      break;
    }
  }
  return K;
}

// Linear decode of the whole (decrypted) word stream.
function decodeAll(ctx) {
  const instrs = new Map();
  let ip = 0;
  while (ip < ctx.words.length) {
    const ins = ctx.decodeAt(ip);
    if (!ins) break;
    instrs.set(ip, ins);
    ip += ins.size;
  }
  return instrs;
}

/* ================================================================== *
 * 4. Abstract interpretation core
 * ================================================================== */

const C = v => ({ t: 'c', v }); // concrete
const X = s => ({ t: 'x', s }); // unknown/symbolic
const E = (op, ...args) => ({ t: 'e', op, args }); // expression tree
const XMERGE = { t: 'x', s: 'merge' };

function applyOp(op, c) {
  switch (op) {
    case 'ADD': return c[0] + c[1];
    case 'SUB': return c[0] - c[1];
    case 'MUL': return c[0] * c[1];
    case 'DIV': return c[0] / c[1];
    case 'MOD': return c[0] % c[1];
    case 'POW': return Math.pow(c[0], c[1]);
    case 'AND': return c[0] & c[1];
    case 'OR': return c[0] | c[1];
    case 'XOR': return c[0] ^ c[1];
    case 'SHL': return c[0] << c[1];
    case 'SHR': return c[0] >> c[1];
    case 'USHR': return c[0] >>> c[1];
    case 'EQ': return c[0] == c[1];
    case 'NE': return c[0] != c[1];
    case 'STRICT_EQ': return c[0] === c[1];
    case 'STRICT_NE': return c[0] !== c[1];
    case 'LT': return c[0] < c[1];
    case 'LE': return c[0] <= c[1];
    case 'GT': return c[0] > c[1];
    case 'GE': return c[0] >= c[1];
    case 'NEG': return -c[0];
    case 'POS': return +c[0];
    case 'NOT': return !c[0];
    case 'BNOT': return ~c[0];
    case 'TYPEOF': return typeof c[0];
  }
  throw new Error('applyOp ' + op);
}
function evalBin(op, a, b) { return a.t === 'c' && b.t === 'c' ? C(applyOp(op, [a.v, b.v])) : E(op, a, b); }
function evalUn(op, a) { return a.t === 'c' ? C(applyOp(op, [a.v])) : E(op, a); }
function matchVar(v, condNode) {
  if (!condNode) return false;
  if (condNode.t === 'x') return v.t === 'x' && v.s === condNode.s;
  return v === condNode;
}
function evalTree(v, condNode, condVal) {
  if (matchVar(v, condNode)) return condVal;
  if (v.t === 'c') return v.v;
  if (v.t === 'e') {
    const c = v.args.map(a => (matchVar(a, condNode) ? condVal : a.t === 'c' ? a.v : evalTree(a, condNode, condVal)));
    return applyOp(v.op, c);
  }
  throw new Error('opaque in select: ' + JSON.stringify(v).slice(0, 120));
}
function findVars(v, cmpAcc, xAcc) {
  if (v.t === 'x') { if (!xAcc.some(x => x.s === v.s)) xAcc.push(v); return; }
  if (v.t === 'e') {
    if (/^(STRICT_EQ|STRICT_NE|EQ|NE|LT|LE|GT|GE)$/.test(v.op)) { if (!cmpAcc.includes(v)) cmpAcc.push(v); return; }
    v.args.forEach(a => findVars(a, cmpAcc, xAcc));
  }
}
function mergeVal(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === XMERGE) return a;
  if (a.t === 'c' && b.t === 'c' && a.v === b.v) return a;
  if (a.t === 'x' && b.t === 'x' && a.s === b.s) return a;
  return XMERGE;
}

// Concrete emulation of a dispatcher function (pure arithmetic + Math.imul).
// Runs with r0=A, r1=B and returns the raw result (array or object holding the next ip).
function runDispatcher(ctx, dispEntry, A, B) {
  const regs = new Array(16).fill(undefined);
  regs[0] = A; regs[1] = B; regs[2] = [A, B];
  let ip = dispEntry, guard = 0;
  while (guard++ < 500) {
    const ins = ctx.decodeAt(ip);
    if (!ins) throw new Error('dispatcher: undecodable at ' + ip);
    const o = ins.operands;
    const R = i => regs[i];
    const N = ins.name;
    if (N === 'RETURN') return R(o[0]);
    else if (N === 'LOAD_THIS') regs[o[0]] = { __this: true };
    else if (N === 'LOAD_CONST') regs[o[0]] = ctx.decodeConst(o[1], o[2]);
    else if (N === 'LOAD_LITERAL') regs[o[0]] = o[1] >> 0;
    else if (N === 'LOAD_UNDEF') regs[o[0]] = undefined;
    else if (N === 'MOVE') regs[o[0]] = R(o[1]);
    else if (BIN_OPS.includes(N)) regs[o[0]] = applyOp(N, [R(o[1]), R(o[2])]);
    else if (UN_OPS.includes(N)) regs[o[0]] = applyOp(N, [R(o[1])]);
    else if (N === 'LOAD_GLOBAL') regs[o[0]] = { __global: ctx.decodeConst(o[1], o[2]) };
    else if (N === 'GET_PROP') {
      const obj = R(o[1]), prop = R(o[2]);
      if (obj && obj.__global === 'Math' && prop === 'imul') regs[o[0]] = { __imul: true };
      else regs[o[0]] = obj[prop];
    } else if (N === 'CALL' || N === 'CALL_NULL') {
      const funcReg = N === 'CALL' ? o[2] : o[1];
      const argc = N === 'CALL' ? o[3] : o[2];
      const argStart = N === 'CALL' ? 4 : 3;
      const args = argc === MAGIC ? R(o[argStart]) : Array.from({ length: argc }, (_, i) => R(o[argStart + i]));
      const fn = R(funcReg);
      if (fn && fn.__imul) regs[o[0]] = Math.imul(args[0], args[1]);
      else throw new Error('dispatcher: unknown call');
    } else if (N === 'MAKE_ARRAY') regs[o[0]] = o.slice(2).map(R);
    else if (N === 'MAKE_OBJECT') {
      const obj = {};
      for (let i = 0; i < o[1]; i++) obj[R(o[2 + i * 2])] = R(o[3 + i * 2]);
      regs[o[0]] = obj;
    } else throw new Error('dispatcher: unhandled ' + N);
    ip += ins.size;
  }
  throw new Error('dispatcher: no return');
}

/* ================================================================== *
 * 5. CFG exploration by abstract interpretation
 * ================================================================== */

function explore(ctx, cfg) {
  // cfg: { entry, trampIp, argRegs:[Areg,Breg], prop, dispEntry, nreg }
  const argRegs = cfg.argRegs;

  function runBlock(startIp, regsIn) {
    const regs = regsIn.slice();
    const instrs = [];
    let ip = startIp;
    while (true) {
      const ins = ctx.decodeAt(ip);
      if (!ins) throw new Error('undecodable at ' + ip);
      instrs.push(ins);
      const o = ins.operands;
      const R = i => regs[i] || X('r' + i);
      switch (ins.name) {
        case 'LOAD_THIS': regs[o[0]] = X('this'); break;
        case 'LOAD_CONST': regs[o[0]] = C(ctx.decodeConst(o[1], o[2])); break;
        case 'LOAD_LITERAL': regs[o[0]] = C(o[1] >> 0); break;
        case 'LOAD_UNDEF': regs[o[0]] = C(undefined); break;
        case 'MOVE': regs[o[0]] = R(o[1]); break;
        case 'LOAD_GLOBAL': regs[o[0]] = X('global:' + ctx.decodeConst(o[1], o[2])); break;
        case 'TYPEOF_GLOBAL': regs[o[0]] = X('typeofglobal'); break;
        case 'STORE_GLOBAL': break;
        case 'GET_PROP': regs[o[0]] = X('prop'); break;
        case 'SET_PROP': break;
        case 'CALL': case 'CALL_NULL': regs[o[0]] = X('call'); break;
        case 'NEW': regs[o[0]] = X('new'); break;
        case 'MAKE_FUNC': regs[o[0]] = X('func@' + o[1]); break;
        case 'MAKE_ARRAY': regs[o[0]] = X('array'); break;
        case 'MAKE_OBJECT': regs[o[0]] = X('object'); break;
        case 'LOAD_CLOSURE': regs[o[0]] = X('closure' + o[1]); break;
        case 'STORE_CLOSURE': break;
        case 'FORIN_SETUP': regs[o[0]] = X('forin'); break;
        case 'FORIN_NEXT': regs[o[0]] = X('forinnext'); break;
        case 'DEFINE_GETTER': case 'DEFINE_SETTER': case 'DELETE': break;
        case 'POP_TRY': case 'DEBUGGER': break;
        case 'TRY': case 'TRY2': break;
        case 'JUMP': case 'JUMP_REG': case 'RETURN': case 'THROW':
        case 'JUMP_IF_TRUE': case 'JUMP_IF_FALSE':
          break;
        default:
          if (BIN_OPS.includes(ins.name)) regs[o[0]] = evalBin(ins.name, R(o[1]), R(o[2]));
          else if (UN_OPS.includes(ins.name)) regs[o[0]] = evalUn(ins.name, R(o[1]));
          else throw new Error('unhandled ' + ins.name);
          break;
      }
      if (ins.name === 'JUMP') {
        if (o[0] === cfg.trampIp) return finishDispatch(instrs, regs);
        return { instrs, regs, kind: 'jump', target: o[0] };
      }
      if (ins.name === 'JUMP_REG') return { instrs, regs, kind: 'jumpreg', reg: o[0] };
      if (ins.name === 'RETURN') return { instrs, regs, kind: 'return', reg: o[0] };
      if (ins.name === 'THROW') return { instrs, regs, kind: 'throw', reg: o[0] };
      if (ins.name === 'JUMP_IF_TRUE') return { instrs, regs, kind: 'condjump', condReg: o[0], target: o[1], fallthrough: ip + ins.size, when: true };
      if (ins.name === 'JUMP_IF_FALSE') return { instrs, regs, kind: 'condjump', condReg: o[0], target: o[1], fallthrough: ip + ins.size, when: false };
      ip += ins.size;
    }
  }

  function finishDispatch(instrs, regs) {
    const A = regs[argRegs[0]];
    const B = regs[argRegs[1]];
    if (!A || A.t !== 'c') throw new Error('A not concrete: ' + JSON.stringify(A));
    const prop = cfg.prop;
    const disp = (a, b) => runDispatcher(ctx, cfg.dispEntry, a, b)[prop];
    if (B.t === 'c') {
      return { instrs, regs, kind: 'dispatch', A: A.v, B: B.v, targets: [disp(A.v, B.v)] };
    }
    if (B.t === 'e') {
      const cmpAcc = [], xAcc = [];
      findVars(B, cmpAcc, xAcc);
      if (cmpAcc.length + xAcc.length === 1) {
        const condNode = cmpAcc[0] || xAcc[0];
        const Btrue = evalTree(B, condNode, true) | 0;
        const Bfalse = evalTree(B, condNode, false) | 0;
        return {
          instrs, regs, kind: 'dispatch-cond', A: A.v, cond: condNode,
          Btrue, Bfalse, targetTrue: disp(A.v, Btrue), targetFalse: disp(A.v, Bfalse),
        };
      }
    }
    throw new Error('cannot resolve dispatch; B=' + JSON.stringify(B).slice(0, 300));
  }

  const envs = new Map();
  const wl = [];
  function pushState(ip, regs) {
    if (!envs.has(ip)) { envs.set(ip, regs.slice()); wl.push(ip); }
    else {
      const cur = envs.get(ip);
      const merged = cur.map((v, i) => mergeVal(v, regs[i]));
      if (merged.some((v, i) => v !== cur[i])) { envs.set(ip, merged); wl.push(ip); }
    }
  }
  const init = [];
  for (let i = 0; i < (cfg.nreg || 160); i++) init.push(X('undef'));
  init[0] = X('arguments');
  for (let i = 1; i < 8; i++) init[i] = X('arg' + i);
  pushState(cfg.entry, init);

  const results = new Map();
  let guard = 0;
  while (wl.length) {
    if (++guard > 20000) throw new Error('explore: guard tripped');
    const ip = wl.pop();
    let res;
    try { res = runBlock(ip, envs.get(ip)); }
    catch (e) { throw new Error('explore block ' + ip + ': ' + e.message); }
    results.set(ip, res);
    if (res.kind === 'dispatch') pushState(res.targets[0], res.regs);
    else if (res.kind === 'dispatch-cond') { pushState(res.targetTrue, res.regs); pushState(res.targetFalse, res.regs); }
    else if (res.kind === 'jump') pushState(res.target, res.regs);
    else if (res.kind === 'condjump') { pushState(res.target, res.regs); pushState(res.fallthrough, res.regs); }
  }
  return results;
}

/* ================================================================== *
 * 6. Auto-detection of the flattening machinery
 * ================================================================== */

// Find the dispatch trampoline used by a function starting at entryIp:
// decode until the first JUMP; the target is the trampoline, whose shape is
//   CALL_NULL(dest, funcReg, 2, Areg, Breg); ...; d2 = dest[prop]; JUMP_REG(d2)
function findTrampoline(ctx, instrs, entryIp) {
  let ip = entryIp;
  let trampIp = null;
  while (true) {
    const ins = instrs.get(ip) || ctx.decodeAt(ip);
    if (!ins) return null;
    if (ins.name === 'JUMP') { trampIp = ins.operands[0]; break; }
    if (ins.name === 'JUMP_REG' || ins.name === 'RETURN' || ins.name === 'THROW') return null;
    ip += ins.size;
  }
  let callIns = null, getProp = null;
  const trampInstrs = [];
  for (let p = trampIp; p < ctx.words.length;) {
    const ti = ctx.decodeAt(p);
    if (!ti) break;
    trampInstrs.push(ti);
    if (ti.name === 'CALL_NULL' && !callIns) callIns = ti;
    if (ti.name === 'GET_PROP' && !getProp) getProp = ti;
    if (ti.name === 'JUMP_REG') break;
    p += ti.size;
  }
  if (!callIns) return null;
  const o = callIns.operands;
  const argRegs = [o[3], o[4]]; // dispatcher's (r0, r1)
  let prop = 0;
  if (getProp) {
    const propReg = getProp.operands[2];
    for (const ti of trampInstrs) {
      if ((ti.name === 'LOAD_CONST' || ti.name === 'LOAD_LITERAL') && ti.operands[0] === propReg) {
        prop = ti.name === 'LOAD_LITERAL' ? ti.operands[1] >> 0 : ctx.decodeConst(ti.operands[1], ti.operands[2]);
        break;
      }
    }
  }
  let dispEntry = null;
  for (const [, ins] of instrs) {
    if (ins.name === 'MAKE_FUNC' && ins.operands[0] === callIns.operands[1]) { dispEntry = ins.operands[1]; break; }
  }
  return { trampIp, argRegs, prop, dispEntry };
}

// After exploration, detect stateReg/accReg/headerIp/deltaReg/maskRegs.
function detectFlow(ctx, blocks, argRegs) {
  // header = block with most incoming edges
  const indeg = new Map();
  const addEdge = t => { if (t !== null && t !== undefined) indeg.set(t, (indeg.get(t) || 0) + 1); };
  for (const [, b] of blocks) {
    if (b.kind === 'dispatch') addEdge(b.targets[0]);
    else if (b.kind === 'dispatch-cond') { addEdge(b.targetTrue); addEdge(b.targetFalse); }
    else if (b.kind === 'jump') addEdge(b.target);
    else if (b.kind === 'condjump') { addEdge(b.target); addEdge(b.fallthrough); }
  }
  let headerIp = null, max = -1;
  for (const [ip, d] of indeg) if (d > max) { max = d; headerIp = ip; }

  // stateReg: the register compared against a constant in the header
  const header = blocks.get(headerIp);
  const consts = {};
  for (const ins of header.instrs) {
    const o = ins.operands;
    if (ins.name === 'LOAD_CONST') consts[o[0]] = ctx.decodeConst(o[1], o[2]);
    else if (ins.name === 'LOAD_LITERAL') consts[o[0]] = o[1] >> 0;
  }
  let stateReg = null;
  for (const ins of header.instrs) {
    const o = ins.operands;
    if (ins.name === 'STRICT_NE' || ins.name === 'STRICT_EQ') {
      if (typeof consts[o[1]] === 'number') stateReg = o[2];
      else if (typeof consts[o[2]] === 'number') stateReg = o[1];
    }
  }
  // accReg: the other register in a chain block comparing with stateReg
  let accReg = null;
  for (const [, b] of blocks) {
    if (b.kind !== 'dispatch-cond') continue;
    for (const ins of b.instrs) {
      const o = ins.operands;
      if ((ins.name === 'STRICT_EQ' || ins.name === 'STRICT_NE') && (o[1] === stateReg || o[2] === stateReg)) {
        const other = o[1] === stateReg ? o[2] : o[1];
        if (other !== stateReg && consts[other] === undefined) { accReg = other; }
      }
    }
    if (accReg !== null) break;
  }
  // deltaReg: the other register in "stateReg = stateReg +/- tmp" state updates
  let deltaReg = null;
  for (const [, b] of blocks) {
    for (const ins of b.instrs) {
      const o = ins.operands;
      if ((ins.name === 'ADD' || ins.name === 'SUB') && o[0] === stateReg && (o[1] === stateReg || o[2] === stateReg)) {
        deltaReg = o[1] === stateReg ? o[2] : o[1];
      }
    }
    if (deltaReg !== null) break;
  }
  // maskRegs: the MBA select machinery. A select looks like:
  //   tmp = (lit2 - lit1); tmp = tmp & mask (or tmp * mask); argB = argB + tmp
  // where `mask` is written by a NOT/POS/NEG chain rooted at the condition.
  // Only the mask register and the select temp are machinery; intermediates of the
  // NOT chain may collide with REAL registers used in other blocks and must be kept.
  const maskRegs = new Set();
  const argSet = new Set(argRegs);
  for (const [, b] of blocks) {
    if (b.kind !== 'dispatch-cond') continue;
    const selectTemps = new Set();
    for (const ins of b.instrs) {
      const o = ins.operands;
      if ((ins.name === 'ADD' || ins.name === 'SUB') && argSet.has(o[0])) {
        for (const s of [o[1], o[2]]) if (!argSet.has(s)) selectTemps.add(s);
      }
    }
    for (const ins of b.instrs) {
      const o = ins.operands;
      if ((ins.name === 'AND' || ins.name === 'MUL') && selectTemps.has(o[0])) {
        maskRegs.add(o[0]);
        for (const s of [o[1], o[2]]) {
          const writtenByChain = b.instrs.some(x => ['NOT', 'POS', 'NEG'].includes(x.name) && x.operands[0] === s);
          if (writtenByChain) maskRegs.add(s);
        }
      }
    }
  }
  return { headerIp, stateReg, accReg, deltaReg, maskRegs: [...maskRegs] };
}

/* ================================================================== *
 * 7. Unflatten: recover the real CFG from the flattened state machine
 * ================================================================== */

// Evaluate a register's update inside a block, tracking it as (incoming + offset).
function stateUpdate(block, stateReg, ctx) {
  const vals = new Map();
  vals.set(stateReg, { regPlus: 0 });
  for (const ins of block.instrs) {
    const o = ins.operands;
    const gv = r => vals.get(r);
    if (ins.name === 'LOAD_CONST') vals.set(o[0], { const: ctx.decodeConst(o[1], o[2]) });
    else if (ins.name === 'LOAD_LITERAL') vals.set(o[0], { const: o[1] >> 0 });
    else if (ins.name === 'MOVE') vals.set(o[0], gv(o[1]) || { other: 1 });
    else if (ins.name === 'ADD' || ins.name === 'SUB') {
      const a = gv(o[1]), b = gv(o[2]);
      const sgn = ins.name === 'ADD' ? 1 : -1;
      if (a && a.regPlus !== undefined && b && b.const !== undefined) vals.set(o[0], { regPlus: a.regPlus + sgn * b.const });
      else if (b && b.regPlus !== undefined && a && a.const !== undefined && ins.name === 'ADD') vals.set(o[0], { regPlus: b.regPlus + a.const });
      else vals.set(o[0], { other: 1 });
    } else if (o[0] !== undefined) vals.set(o[0], { other: 1 });
  }
  const v = vals.get(stateReg);
  if (!v) return null;
  if (v.const !== undefined) return { set: v.const };
  if (v.regPlus !== undefined) return { delta: v.regPlus };
  return null;
}

function unflatten(ctx, blocks, cfg) {
  // cfg: { stateReg, accReg, headerIp, entry, trampIp, argRegs }
  const header = blocks.get(cfg.headerIp);
  // special value checked in the header (loop pre-header state)
  let specialValue;
  {
    const consts = {};
    for (const ins of header.instrs) {
      const o = ins.operands;
      if (ins.name === 'LOAD_CONST') consts[o[0]] = ctx.decodeConst(o[1], o[2]);
      else if (ins.name === 'LOAD_LITERAL') consts[o[0]] = o[1] >> 0;
    }
    for (const ins of header.instrs) {
      const o = ins.operands;
      if ((ins.name === 'STRICT_NE' || ins.name === 'STRICT_EQ') && (o[1] === cfg.stateReg || o[2] === cfg.stateReg)) {
        const other = o[1] === cfg.stateReg ? o[2] : o[1];
        specialValue = consts[other];
      }
    }
  }

  // A chain block compares stateReg with accReg.
  function isChainBlock(ip) {
    const b = blocks.get(ip);
    if (!b || b.kind !== 'dispatch-cond') return false;
    return b.instrs.some(ins =>
      (ins.name === 'STRICT_EQ' || ins.name === 'STRICT_NE') &&
      (ins.operands[1] === cfg.stateReg || ins.operands[2] === cfg.stateReg) &&
      (ins.operands[1] === cfg.accReg || ins.operands[2] === cfg.accReg));
  }

  let chainStart = null, specialBlock;
  if (isChainBlock(header.targetTrue)) { chainStart = header.targetTrue; specialBlock = header.targetFalse; }
  else if (isChainBlock(header.targetFalse)) { chainStart = header.targetFalse; specialBlock = header.targetTrue; }
  else throw new Error('unflatten: no chain found from header');

  // Walk the chain, building the case table (accumulator partial sums).
  const cases = [];
  const chainSet = new Set();
  const stubSet = new Set();
  let acc = null;
  let ip = chainStart;
  while (isChainBlock(ip)) {
    chainSet.add(ip);
    const b = blocks.get(ip);
    const upd = stateUpdate(b, cfg.accReg, ctx);
    if (upd) {
      if (upd.set !== undefined) acc = upd.set;
      else acc = acc + upd.delta;
    }
    const payload = resolveStub(b.targetTrue);
    cases.push({ value: acc, payloadIp: payload, chainIp: ip });
    ip = b.targetFalse;
  }

  function resolveStub(startIp) {
    // a stub only loads the dispatcher argument registers and JUMPs to the trampoline
    let cur = startIp;
    const seen = new Set();
    while (true) {
      if (seen.has(cur)) return cur;
      seen.add(cur);
      const b = blocks.get(cur);
      if (!b) return cur;
      if (b.kind === 'dispatch') {
        const isStub = b.instrs.every(ins =>
          (ins.name === 'JUMP' && ins.operands[0] === cfg.trampIp) ||
          ((ins.name === 'LOAD_LITERAL' || ins.name === 'LOAD_CONST' || ins.name === 'MOVE') &&
            cfg.argRegs.includes(ins.operands[0])));
        if (isStub) { stubSet.add(cur); cur = b.targets[0]; continue; }
        return cur;
      }
      return cur;
    }
  }

  const caseMap = new Map(cases.map(c => [c.value, c.payloadIp]));

  // Entry state: concrete stateReg value at the end of the entry (pre-header) block.
  const entryBlock = blocks.get(cfg.entry);
  let entryState;
  {
    const consts = {};
    const moves = {};
    for (const ins of entryBlock.instrs) {
      const o = ins.operands;
      if (ins.name === 'LOAD_CONST') consts[o[0]] = ctx.decodeConst(o[1], o[2]);
      else if (ins.name === 'LOAD_LITERAL') consts[o[0]] = o[1] >> 0;
      else if (ins.name === 'MOVE') moves[o[0]] = o[1];
    }
    let reg = cfg.stateReg;
    const seen = new Set();
    while (moves[reg] !== undefined && !seen.has(reg)) { seen.add(reg); reg = moves[reg]; }
    entryState = consts[reg];
  }

  const machinery = new Set([cfg.headerIp, ...chainSet, ...stubSet]);

  function resolveState(s) {
    if (s === specialValue) return specialBlock;
    if (caseMap.has(s)) return caseMap.get(s);
    return null;
  }

  // Build the real CFG via a worklist over states/blocks.
  const realNodes = new Map();
  const wl = [];
  function addNode(ip, entryState) {
    if (ip === null || ip === undefined) return;
    if (machinery.has(ip)) throw new Error('unflatten: machinery block as real node: ' + ip);
    if (!realNodes.has(ip)) {
      const blk = blocks.get(ip);
      if (!blk) throw new Error('unflatten: missing block ' + ip);
      realNodes.set(ip, { ip, block: blk, entryState, succs: [] });
      wl.push(ip);
    }
  }
  const entryReal = resolveState(entryState);
  addNode(entryReal, entryState);

  while (wl.length) {
    const nip = wl.pop();
    const node = realNodes.get(nip);
    const b = node.block;
    if (b.kind === 'return' || b.kind === 'throw') continue;
    if (b.kind === 'dispatch-cond') {
      // real conditional: arms may be pure state-updaters or real blocks
      for (const [target, when] of [[b.targetTrue, true], [b.targetFalse, false]]) {
        const tb = blocks.get(target);
        const upd = stateUpdate(tb, cfg.stateReg, ctx);
        const isPureArm = tb.kind === 'dispatch' && tb.instrs.every(ins =>
          (ins.name === 'JUMP' && ins.operands[0] === cfg.trampIp) ||
          cfg.argRegs.includes(ins.operands[0]) ||
          ins.name === 'LOAD_LITERAL' || ins.name === 'LOAD_CONST' ||
          ((ins.name === 'ADD' || ins.name === 'SUB' || ins.name === 'MOVE') && ins.operands[0] === cfg.stateReg) ||
          ((ins.name === 'ADD' || ins.name === 'SUB') && (ins.operands[1] === cfg.stateReg || ins.operands[2] === cfg.stateReg)) ||
          (ins.name === 'MOVE' && ins.operands[0] === cfg.stateReg));
        if (isPureArm && upd) {
          const ns = node.entryState + upd.delta;
          const dest = resolveState(ns);
          node.succs.push({ cond: when, arm: target, ip: dest });
          addNode(dest, ns);
        } else {
          node.succs.push({ cond: when, ip: target });
          addNode(target, node.entryState);
        }
      }
    } else {
      // unconditional payload: apply its state update and resolve the next real block
      const upd = stateUpdate(b, cfg.stateReg, ctx);
      const ns = upd ? (upd.set !== undefined ? upd.set : node.entryState + upd.delta) : node.entryState;
      const dest = resolveState(ns);
      if (dest !== null) {
        node.succs.push({ cond: null, ip: dest });
        addNode(dest, ns);
      }
    }
  }

  return { cases, caseMap, specialValue, specialBlock, entryState, entryReal, realNodes, chainSet, stubSet };
}

/* ================================================================== *
 * 8. Lift real blocks to a Babel AST
 * ================================================================== */

const id = name => ({ type: 'Identifier', name });
const lit = v => v === undefined ? id('undefined')
  : v === null ? { type: 'NullLiteral' }
  : typeof v === 'string' ? { type: 'StringLiteral', value: v }
  : typeof v === 'boolean' ? { type: 'BooleanLiteral', value: v }
  : typeof v === 'number' ? (v < 0 || !Number.isFinite(v)
      ? { type: 'UnaryExpression', operator: '-', argument: { type: 'NumericLiteral', value: Math.abs(v) }, prefix: true }
      : { type: 'NumericLiteral', value: v })
  : id('undefined');
const bin = (op, l, r) => ({ type: 'BinaryExpression', operator: op, left: l, right: r });
const un = (op, a) => ({ type: 'UnaryExpression', operator: op, argument: a, prefix: true });
const isIdent = s => typeof s === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const mem = (o, p) => isIdent(p)
  ? { type: 'MemberExpression', object: o, property: id(p), computed: false }
  : { type: 'MemberExpression', object: o, property: typeof p === 'string' ? lit(p) : p, computed: true };
const memC = (o, p) => ({ type: 'MemberExpression', object: o, property: p, computed: true });
const call = (c, args) => ({ type: 'CallExpression', callee: c, arguments: args });
const assign = (l, r) => ({ type: 'AssignmentExpression', operator: '=', left: l, right: r });
const exprStmt = e => ({ type: 'ExpressionStatement', expression: e });
const varDecls = names => ({
  type: 'VariableDeclaration', kind: 'var',
  declarations: names.map(n => ({ type: 'VariableDeclarator', id: id(n), init: null })),
});
const ret = arg => ({ type: 'ReturnStatement', argument: arg || null });
const ifStmt = (test, cons, alt) => ({ type: 'IfStatement', test, consequent: blockStmt(cons), alternate: alt ? blockStmt(alt) : null });
const whileStmt = (test, body) => ({ type: 'WhileStatement', test, body: blockStmt(body) });
const blockStmt = body => ({ type: 'BlockStatement', body });
const throwStmt = arg => ({ type: 'ThrowStatement', argument: arg });
const funcExpr = (params, body) => ({ type: 'FunctionExpression', id: null, params: params.map(id), body: blockStmt(body), generator: false, async: false });

const UN_SYM = { NEG: '-', POS: '+', NOT: '!', BNOT: '~', TYPEOF: 'typeof' };

// Build an expression for one instruction's value. makeFunc(ins) handles MAKE_FUNC.
function buildValue(ctx, ins, R, makeFunc, closureMap) {
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
      const args = o[3] === MAGIC ? [{ type: 'SpreadElement', argument: R(o[4]) }] : o.slice(4).map(r => R(r));
      return { node: call(mem(R(o[2]), 'call'), [R(o[1]), ...args]), pure: false };
    }
    case 'CALL_NULL': {
      const args = o[2] === MAGIC ? [{ type: 'SpreadElement', argument: R(o[3]) }] : o.slice(3).map(r => R(r));
      return { node: call(R(o[1]), args), pure: false };
    }
    case 'NEW': {
      const args = o[2] === MAGIC ? [{ type: 'SpreadElement', argument: R(o[3]) }] : o.slice(3).map(r => R(r));
      return { node: { type: 'NewExpression', callee: R(o[1]), arguments: args }, pure: false };
    }
    case 'MAKE_ARRAY': return { node: { type: 'ArrayExpression', elements: o.slice(2).map(r => R(r)) }, pure: true };
    case 'MAKE_OBJECT': {
      const props = [];
      for (let i = 0; i < o[1]; i++) props.push({ type: 'ObjectProperty', key: R(o[2 + i * 2]), value: R(o[3 + i * 2]), computed: true, shorthand: false });
      return { node: { type: 'ObjectExpression', properties: props }, pure: true };
    }
    case 'MAKE_FUNC': return { node: makeFunc(ins), pure: true };
    case 'DELETE': return { node: un('delete', memC(R(o[1]), R(o[2]))), pure: true };
    default:
      if (BIN_SYM[ins.name]) return { node: bin(BIN_SYM[ins.name], R(o[1]), R(o[2])), pure: true };
      if (UN_SYM[ins.name]) return { node: un(UN_SYM[ins.name], R(o[1])), pure: true };
      return null;
  }
}

// Registers each instruction reads (for read-before-write analysis).
function srcRegsOf(ins) {
  const o = ins.operands;
  switch (ins.name) {
    case 'MOVE': case 'NEG': case 'POS': case 'NOT': case 'BNOT': case 'TYPEOF': return [o[1]];
    case 'GET_PROP': case 'DELETE': return [o[1], o[2]];
    case 'SET_PROP': return [o[0], o[1], o[2]];
    case 'CALL': return [o[1], o[2], ...(o[3] === MAGIC ? [o[4]] : o.slice(4))];
    case 'CALL_NULL': case 'NEW': return [o[1], ...(o[2] === MAGIC ? [o[3]] : o.slice(3))];
    case 'MAKE_ARRAY': return o.slice(2);
    case 'MAKE_OBJECT': {
      const r = [];
      for (let i = 0; i < o[1]; i++) r.push(o[2 + i * 2], o[3 + i * 2]);
      return r;
    }
    case 'STORE_GLOBAL': case 'STORE_CLOSURE': return [o[2] !== undefined ? o[2] : o[1]];
    case 'THROW': case 'RETURN': return [o[0]];
    default:
      if (BIN_SYM[ins.name]) return [o[1], o[2]];
      return [];
  }
}

// Lift a flattened function's real CFG to structured statements.
// cfg: { prefix, stateReg, accReg, headerIp, trampIp, argRegs, maskRegs, deltaReg,
//        nreg, paramRegs, paramNames, dispEntry }
// makeFuncCb(ins, V, closureMap) -> FunctionExpression AST for nested functions.
function liftFunction(ctx, blocks, uf, cfg, closureMap, makeFuncCb) {
  const prefix = cfg.prefix;
  const V = reg => {
    const pi = cfg.paramRegs.indexOf(reg);
    if (pi >= 0) return cfg.paramNames[pi];
    return prefix + reg;
  };
  const makeFunc = ins => makeFuncCb(ins, V, closureMap);

  const argRegs = new Set(cfg.argRegs);
  function isMachineryIns(ins) {
    const o = ins.operands;
    if (ins.name === 'JUMP' && o[0] === cfg.trampIp) return true;
    if (ins.name === 'JUMP_REG') return true;
    if (argRegs.has(o[0]) || cfg.maskRegs.includes(o[0])) return true;
    if (o[0] === cfg.stateReg && (ins.name === 'ADD' || ins.name === 'SUB' || ins.name === 'MOVE')) return true;
    if (o[0] === cfg.deltaReg && (ins.name === 'LOAD_LITERAL' || ins.name === 'LOAD_CONST')) return true;
    // the dispatcher creation itself (only reached if it landed in a real block)
    if (ins.name === 'MAKE_FUNC' && o[1] === cfg.dispEntry) return true;
    return false;
  }

  // ---- read-before-write analysis: registers read across blocks need variables ----
  const crossBlock = new Set();
  for (const n of uf.realNodes.values()) {
    const written = new Set();
    for (const ins of n.block.instrs) {
      if (isMachineryIns(ins)) continue;
      for (const r of srcRegsOf(ins)) {
        if (typeof r === 'number' && r < (cfg.nreg || 160) && !written.has(r)) crossBlock.add(r);
      }
      if (!['SET_PROP', 'STORE_GLOBAL', 'STORE_CLOSURE', 'THROW'].includes(ins.name)) written.add(ins.operands[0]);
    }
  }
  for (const pr of cfg.paramRegs) crossBlock.delete(pr);
  // registers captured by a nested function's closure must always be materialized
  // as variables so the nested body can reference them
  for (const n of uf.realNodes.values()) {
    for (const ins of n.block.instrs) {
      if (ins.name !== 'MAKE_FUNC' || ins.operands[1] === cfg.dispEntry) continue;
      const o = ins.operands;
      for (let i = 0; i < o[4]; i++) {
        const H = o[6 + 2 * i], e = o[7 + 2 * i];
        if (H) crossBlock.add(e);
      }
    }
  }

  // ---- lift one block's real instructions to statements ----
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
      const val = buildValue(ctx, ins, R, makeFunc, closureMap);
      if (!val) throw new Error('lift: unhandled ' + ins.name);
      const dest = o[0];
      if (val.pure && !crossBlock.has(dest)) {
        env.set(dest, val.node);
      } else if (crossBlock.has(dest)) {
        env.delete(dest);
        stmts.push(exprStmt(assign(id(V(dest)), val.node)));
      } else {
        const t = prefix + 't' + tempCounter++;
        localNames.set(dest, t);
        env.delete(dest);
        stmts.push(exprStmt(assign(id(t), val.node)));
      }
    }
  }

  // find the real condition register of a dispatch-cond block: from the first
  // NOT/POS/NEG writing a mask register, follow sources back to the real value.
  function findCondReg(node) {
    const def = new Map();
    for (const ins of node.block.instrs) {
      if (!def.has(ins.operands[0])) def.set(ins.operands[0], []);
      def.get(ins.operands[0]).push(ins);
    }
    const maskRegs = new Set(cfg.maskRegs);
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

  // ---- structuring (sequences, if/else, while) ----
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
    const env = new Map();
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
          const bodySucc = t && reaches(t.ip, cur) ? t : f;
          const exitSucc = bodySucc === t ? f : t;
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
      liftBlock(node, env, out);
      if (node.block.kind === 'return') { out.push(ret(env.has(node.block.reg) ? env.get(node.block.reg) : id(V(node.block.reg)))); return; }
      if (node.block.kind === 'throw') return;
      cur = node.succs.length ? node.succs[0].ip : null;
    }
  }

  const body = [];
  emit(uf.entryReal, new Set(), body);

  // declare all referenced variables of this function's prefix at the top
  const usedVars = new Set();
  const re = new RegExp('^' + prefix + '(t?\\d+)$');
  const collect = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (n.type === 'Identifier' && re.test(n.name)) usedVars.add(n.name);
    for (const k in n) if (typeof n[k] === 'object') collect(n[k]);
  };
  collect(body);
  if (usedVars.size) {
    body.unshift(varDecls([...usedVars].sort((a, b) => {
      const na = a.slice(prefix.length).replace('t', ''), nb = b.slice(prefix.length).replace('t', '');
      return parseInt(na, 10) - parseInt(nb, 10);
    })));
  }

  return { body, usedVars };
}

// Lift a non-flattened (straight-line) function such as the top level.
// Handles closure capture hoisting: a register captured by a nested MAKE_FUNC is
// materialized as a hoisted variable initialized with its value at capture time.
function liftStraightLine(ctx, entry, prefix, closureMap, makeFuncCb, isTopLevel) {
  const V = r => prefix + r;
  const body = [];
  const env = new Map();
  const captured = new Map(); // reg -> { name, init }
  const R = i => {
    if (captured.has(i)) return id(captured.get(i).name);
    return env.has(i) ? env.get(i) : id(V(i));
  };
  const makeFunc = ins => makeFuncCb(ins, V, closureMap);
  let ip = entry;
  let guard = 0;
  while (guard++ < 100000) {
    const ins = ctx.decodeAt(ip);
    if (!ins) throw new Error('straight-line: undecodable at ' + ip);
    const o = ins.operands;
    if (ins.name === 'RETURN') {
      if (!isTopLevel) body.push(ret(R(o[0])));
      break;
    }
    if (ins.name === 'JUMP') { ip = o[0]; continue; }
    if (ins.name === 'SET_PROP') { body.push(exprStmt(assign(memC(R(o[0]), R(o[1])), R(o[2])))); ip += ins.size; continue; }
    if (ins.name === 'STORE_GLOBAL') { body.push(exprStmt(assign(mem(id('window'), String(ctx.decodeConst(o[0], o[1]))), R(o[2])))); ip += ins.size; continue; }
    if (ins.name === 'STORE_CLOSURE') { body.push(exprStmt(assign(id(closureMap[o[0]]), R(o[1])))); ip += ins.size; continue; }
    if (ins.name === 'THROW') { body.push(throwStmt(R(o[0]))); ip += ins.size; continue; }
    if (ins.name === 'MAKE_FUNC') {
      // record captures of this frame's registers before lifting the child
      for (let i = 0; i < o[4]; i++) {
        const H = o[6 + 2 * i], e = o[7 + 2 * i];
        if (H && !captured.has(e)) {
          captured.set(e, { name: V(e), init: env.has(e) ? env.get(e) : null });
          env.delete(e);
        }
      }
    }
    const val = buildValue(ctx, ins, R, makeFunc, closureMap);
    if (!val) throw new Error('straight-line: unhandled ' + ins.name + ' at ' + ip);
    if (captured.has(o[0])) {
      body.push(exprStmt(assign(id(captured.get(o[0]).name), val.node)));
    } else if (val.pure) {
      env.set(o[0], val.node);
    } else {
      env.delete(o[0]);
      body.push(exprStmt(assign(id(V(o[0])), val.node)));
    }
    ip += ins.size;
  }
  // hoisted declarations for captured registers (in capture order)
  const decls = [];
  for (const [, c] of [...captured.entries()].sort((a, b) => a[0] - b[0])) {
    decls.push({ type: 'VariableDeclarator', id: id(c.name), init: c.init });
  }
  if (decls.length) body.unshift({ type: 'VariableDeclaration', kind: 'var', declarations: decls });
  // declare any other referenced prefix variables
  const usedVars = new Set();
  const re = new RegExp('^' + prefix + '\\d+$');
  const collect = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (n.type === 'Identifier' && re.test(n.name) && ![...captured.values()].some(c => c.name === n.name)) usedVars.add(n.name);
    for (const k in n) if (typeof n[k] === 'object') collect(n[k]);
  };
  collect(body);
  const rest = [...usedVars].filter(n => !decls.some(d => d.id.name === n));
  if (rest.length) body.splice(decls.length ? 1 : 0, 0, varDecls(rest.sort()));
  return { body };
}

/* ================================================================== *
 * 9. Cleanup: copy propagation + method-call restoration
 * ================================================================== */

function isPure(n) {
  if (!n || typeof n !== 'object') return true;
  if (Array.isArray(n)) return n.every(isPure);
  switch (n.type) {
    case 'CallExpression':
    case 'NewExpression':
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'TaggedTemplateExpression':
      return false;
  }
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    if (typeof n[k] === 'object' && !isPure(n[k])) return false;
  }
  return true;
}

function hasCall(n) {
  if (!n || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some(hasCall);
  if (n.type === 'CallExpression' || n.type === 'NewExpression') return true;
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    if (typeof n[k] === 'object' && hasCall(n[k])) return true;
  }
  return false;
}

function freeIdents(n, acc) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(x => freeIdents(x, acc)); return; }
  if (n.type === 'Identifier') { acc.add(n.name); return; }
  if (n.type === 'MemberExpression' && !n.computed) { freeIdents(n.object, acc); return; }
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    if (typeof n[k] === 'object') freeIdents(n[k], acc);
  }
}

function countReads(body, name) {
  let count = 0;
  const walk = (n, isLhs) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, false)); return; }
    if (n.type === 'Identifier' && n.name === name && !isLhs) { count++; return; }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (typeof v !== 'object') continue;
      if (n.type === 'AssignmentExpression' && k === 'left') { walk(v, true); continue; }
      if (n.type === 'VariableDeclarator' && k === 'id') { walk(v, true); continue; }
      walk(v, false);
    }
  };
  body.forEach(s => walk(s, false));
  return count;
}

function writesTo(body, names) {
  let found = false;
  const walk = n => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ((n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') && n.left && n.left.type === 'Identifier' && names.has(n.left.name)) { found = true; return; }
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && names.has(n.id.name)) { found = true; return; }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (typeof n[k] === 'object') walk(n[k]);
    }
  };
  body.forEach(walk);
  return found;
}

function replaceSingleRead(stmt, name, replacement) {
  let done = false;
  const clone = typeof structuredClone === 'function' ? structuredClone : (x => JSON.parse(JSON.stringify(x)));
  const walk = (n, parent, key, isLhs) => {
    if (done || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((x, i) => walk(x, n, i, false)); return; }
    if (n.type === 'Identifier' && n.name === name && !isLhs) {
      parent[key] = clone(replacement);
      done = true;
      return;
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (typeof v !== 'object') continue;
      if (n.type === 'AssignmentExpression' && k === 'left') { walk(v, n, k, true); continue; }
      if (n.type === 'VariableDeclarator' && k === 'id') { walk(v, n, k, true); continue; }
      walk(v, n, k, false);
      if (done) return;
    }
  };
  walk(stmt, null, null, false);
  return done;
}

// method-call restoration: F.call(O, ...) -> O.F(...) when F is O.prop
function methodCalls(body) {
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'CallExpression' && n.callee && n.callee.type === 'MemberExpression' &&
        n.callee.property.type === 'Identifier' && n.callee.property.name === 'call' && n.arguments.length >= 1) {
      const fn = n.callee.object;
      const thisArg = n.arguments[0];
      if (fn.type === 'MemberExpression' && fn.object.type === 'Identifier' && thisArg.type === 'Identifier' && fn.object.name === thisArg.name) {
        n.callee = fn;
        n.arguments = n.arguments.slice(1);
      }
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (typeof n[k] === 'object') walk(n[k]);
    }
  };
  body.forEach(walk);
}

function cleanupPass(body, tempRe) {
  // recurse into nested blocks first; propagate their change flags so the outer
  // fixpoint loop keeps running until NOTHING changed anywhere
  let changedNested = false;
  for (const s of body) {
    if (s.type === 'IfStatement') {
      if (cleanupPass(s.consequent.body, tempRe)) changedNested = true;
      if (s.alternate && cleanupPass(s.alternate.body, tempRe)) changedNested = true;
    } else if (s.type === 'WhileStatement') {
      if (cleanupPass(s.body.body, tempRe)) changedNested = true;
    } else if (s.type === 'BlockStatement') {
      if (cleanupPass(s.body, tempRe)) changedNested = true;
    }
  }
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    let name = null, rhs = null;
    if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' &&
        s.expression.operator === '=' && s.expression.left.type === 'Identifier') {
      name = s.expression.left.name; rhs = s.expression.right;
    } else if (s.type === 'VariableDeclaration' && s.declarations.length === 1 &&
               s.declarations[0].id.type === 'Identifier' && s.declarations[0].init) {
      name = s.declarations[0].id.name; rhs = s.declarations[0].init;
    } else continue;

    const pure = isPure(rhs);
    const callOnce = hasCall(rhs);
    if (!pure && !callOnce) continue;

    const rest = body.slice(i + 1);
    const reads = countReads(rest, name);
    // Only lifter temporaries (prefix + 't' + counter) may be dropped when unread.
    // Anything else (notably closure variables, which are read on later invocations
    // or by nested functions) must be kept even when this body never reads it again.
    const isTemp = tempRe.test(name);
    if (reads === 0) {
      if (isTemp) {
        if (pure) body.splice(i, 1);
        else body[i] = { type: 'ExpressionStatement', expression: rhs };
        return true;
      }
      continue;
    }
    const rewrites = writesTo(rest, new Set([name]));
    if (reads !== 1 || rewrites) continue;

    const deps = new Set();
    freeIdents(rhs, deps);
    deps.delete(name);
    if (writesTo(rest, deps)) continue;
    for (let j = i + 1; j < body.length; j++) {
      if (countReads([body[j]], name) === 1) {
        if (replaceSingleRead(body[j], name, rhs)) {
          body.splice(i, 1);
          return true;
        }
      }
    }
  }
  return changedNested;
}

// prune declared variables that are never read anywhere (all uses were inlined).
// Only init-less declarators are removed (initializers may have side effects).
function pruneDeclarations(body) {
  for (let i = body.length - 1; i >= 0; i--) {
    const s = body[i];
    if (s.type !== 'VariableDeclaration') continue;
    s.declarations = s.declarations.filter(d => {
      if (d.init) return true;
      if (d.id.type !== 'Identifier') return true;
      return countReads(body, d.id.name) > 0;
    });
    if (s.declarations.length === 0) body.splice(i, 1);
  }
}

function cleanup(body, prefix) {
  const tempRe = new RegExp('^' + prefix + 't\\d+$');
  let guard = 0;
  while (guard++ < 200) {
    const changed = cleanupPass(body, tempRe);
    methodCalls(body);
    if (!changed) break;
  }
  methodCalls(body);
  pruneDeclarations(body);
}

/* ================================================================== *
 * 10. Driver
 * ================================================================== */

function deobfuscate(inputFile) {
  const src = fs.readFileSync(inputFile, 'utf8');
  let ast;
  try {
    ast = parser.parse(src, { sourceType: 'script' });
  } catch (e) {
    return src; // unparseable: pass through unchanged
  }
  const found = extractFromAst(ast);
  if (!found) return src; // not this obfuscation: pass through unchanged

  const rawWords = decodeWords(found.payload);
  const words = applyStaticDecrypts(rawWords, found.bootMeta.p);
  const ctx = makeCtx(words, found.pool);
  const instrs = decodeAll(ctx);

  // Function table from MAKE_FUNC scan: entry -> {j, b, d}
  const funcTable = new Map();
  for (const [, ins] of instrs) {
    if (ins.name === 'MAKE_FUNC') {
      funcTable.set(ins.operands[1], { j: ins.operands[2], b: ins.operands[3], d: ins.operands[5] });
    }
  }
  funcTable.set(found.bootMeta.p, { j: found.bootMeta.j || 0, b: found.bootMeta.b || 6, d: found.bootMeta.d || 0 });

  // Variable-name prefixes: 'g' for the top level, then a, b, c, ... per function.
  const LETTERS = 'abcdefhijklmnopqrstuvwxyz'.split('');
  let prefixCounter = 0;
  const nextPrefix = () => LETTERS[prefixCounter++] || 'f' + prefixCounter;
  const memo = new Map(); // entry -> { paramNames, body }

  function makeFuncNode(ins, V, closureMap) {
    const o = ins.operands;
    const entry = o[1], nclos = o[4];
    const childClosure = {};
    for (let i = 0; i < nclos; i++) {
      const H = o[6 + 2 * i], e = o[7 + 2 * i];
      // H truthy: capture this frame's register e; falsy: reuse this function's
      // own closure cell e (pass-through from the enclosing function).
      childClosure[i] = H ? V(e) : closureMap[e];
    }
    const child = decompileFunction(entry, childClosure, nextPrefix());
    return funcExpr(child.paramNames, child.body);
  }

  function decompileFunction(entry, closureMap, prefix) {
    if (memo.has(entry)) return memo.get(entry);
    const meta = funcTable.get(entry) || { j: 0, b: 60, d: 0 };
    const paramNames = [];
    for (let i = 0; i < meta.j; i++) paramNames.push('arg' + i);
    const result = { paramNames, body: null };
    memo.set(entry, result);
    const tramp = findTrampoline(ctx, instrs, entry);
    let body;
    if (!tramp) {
      body = liftStraightLine(ctx, entry, prefix, closureMap, makeFuncNode, false).body;
    } else {
      const cfg = {
        entry, prefix, trampIp: tramp.trampIp, argRegs: tramp.argRegs, prop: tramp.prop,
        dispEntry: tramp.dispEntry, nreg: (meta.b || 60) + 12,
        paramRegs: paramNames.map((_, i) => i), paramNames,
      };
      const blocks = explore(ctx, cfg);
      Object.assign(cfg, detectFlow(ctx, blocks, tramp.argRegs));
      const uf = unflatten(ctx, blocks, cfg);
      const out = liftFunction(ctx, blocks, uf, cfg, closureMap, makeFuncNode);
      cleanup(out.body, prefix);
      body = out.body;
    }
    result.body = body;
    return result;
  }

  // Top level: boot metadata gives the entry (p), param count (j) and registers (b).
  const topEntry = found.bootMeta.p;
  const topTramp = findTrampoline(ctx, instrs, topEntry);
  let topBody;
  if (topTramp) {
    topBody = decompileFunction(topEntry, {}, 'g').body;
  } else {
    topBody = liftStraightLine(ctx, topEntry, 'g', {}, makeFuncNode, true).body;
  }

  const program = { type: 'Program', body: topBody };
  return generate(program, { comments: false }).code + '\n';
}

module.exports = deobfuscate;

if (require.main === module) {
  const input = process.argv[2] || 'input.js';
  const output = process.argv[3] || 'output.js';
  const code = deobfuscate(input);
  fs.writeFileSync(output, code);
  console.log('wrote ' + output + ' (' + code.length + ' bytes)');
}
