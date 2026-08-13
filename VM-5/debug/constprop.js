// debug/constprop.js - prototype: constant propagation to resolve dispatcher jumps
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const env = V.buildEnv(fs.readFileSync(file, 'utf8'));
const K = env.templateKeys;
const P = env.cap.state.constructor, T = env.cap.template.constructor;
const PURE_GLOBALS = { Math, Number, String, Boolean, Array, Object, JSON, parseInt, parseFloat, isNaN, isFinite };

function callVM(entry, m, l, rest, args) {
  const st = new P(env.code, PURE_GLOBALS, env.pool);
  const tm = new T({ [K.m]: m, [K.l]: l, [K.entry]: entry, [K.rest]: rest ? 1 : 0 });
  return env.cap.runner(st, undefined, tm, undefined, args, []);
}

const UNKNOWN = Symbol('unknown');

// execute one instruction with a concrete register map; returns {ins, writes, unknownRead}
function step(env, pc, regs) {
  const op = env.code[pc];
  const kind = env.kinds.get(op);
  let unknownRead = false;
  const regsObj = {};
  for (const [k, v] of regs) if (v !== UNKNOWN) regsObj[k] = v;
  const m = V.runHandler(env, op, {
    code: env.code, ip: pc + 1, regs: regsObj,
    regValue: () => { unknownRead = true; return 0; },
    globalValue: () => { unknownRead = true; return undefined; },
  });
  return { op, kind, operands: m.rec.operands, next: pc + 1 + m.rec.operands.length, rec: m.rec, unknownRead };
}

// ---- walk function #1 (entry 40) with constant propagation
const entry = Number(process.argv[3] || 40);
const regs = new Map();
let pc = entry;
const log = [];
for (let i = 0; i < 60; i++) {
  const s = step(env, pc, regs);
  const k = s.kind.kind;
  let note = '';
  if (k === 'make_function') {
    regs.set(s.operands[env.meta.dstSlot], { fn: true, entry: s.operands[env.meta.entry], m: s.operands[env.meta.m], l: s.operands[env.meta.l], rest: !!s.operands[env.meta.rest] });
    note = 'fn@' + s.operands[env.meta.entry];
  } else if (k === 'call') {
    const callee = regs.get(s.operands[s.kind.calleeSlot]);
    const argc = s.operands[s.kind.countSlot];
    const args = [];
    for (let a = 0; a < argc; a++) args.push(regs.get(s.operands[s.kind.countSlot + 1 + a]));
    if (callee && callee.fn && args.every(a => a !== undefined && a !== UNKNOWN)) {
      const r = callVM(callee.entry, callee.m, callee.l, callee.rest, args);
      regs.set(s.operands[s.kind.dstSlot], r);
      note = 'call fn@' + callee.entry + '(' + args.join(',') + ') = ' + JSON.stringify(r);
    } else { regs.set(s.operands[s.kind.dstSlot], UNKNOWN); note = 'call (unknown)'; }
  } else if (k === 'get_member') {
    const o = regs.get(s.operands[s.kind.objSlot]), key = regs.get(s.operands[s.kind.keySlot]);
    if (o && o !== UNKNOWN && key !== undefined && key !== UNKNOWN) {
      regs.set(s.operands[s.kind.dst], o[key]); note = 'get ' + key + ' = ' + o[key];
    } else { regs.set(s.operands[s.kind.dst], UNKNOWN); }
  } else if (s.unknownRead) {
    for (const [r] of s.rec.regWrites) regs.set(r, UNKNOWN);
    note = '(unknown inputs)';
  } else {
    for (const [r, v] of s.rec.regWrites) regs.set(r, v);
    if (s.rec.regWrites.length) note = 'r' + s.rec.regWrites[0][0] + ' = ' + JSON.stringify(s.rec.regWrites[0][1]);
  }
  log.push(String(pc).padStart(5) + ': ' + k.padEnd(14) + ' [' + s.operands.join(',') + '] ' + note);
  if (k === 'jmp') { pc = s.operands[s.kind.target]; continue; }
  if (k === 'jmp_reg') {
    const v = regs.get(s.operands[0]);
    log.push('      computed jump -> ' + v);
    pc = typeof v === 'number' ? v : -1;
    if (pc < 0 || pc >= env.code.length) { log.push('      !! out of range'); break; }
    continue;
  }
  if (k === 'ret' || k === 'throw') break;
  if (k === 'jz' || k === 'jnz') {
    const c = regs.get(s.operands[s.kind.cond]);
    log.push('      cond r' + s.operands[s.kind.cond] + ' = ' + JSON.stringify(c));
    if (c === UNKNOWN || c === undefined) { log.push('      (branch not resolved, following fallthrough)'); pc = s.next; continue; }
    const taken = k === 'jz' ? !c : !!c;
    pc = taken ? s.operands[s.kind.target] : s.next;
    continue;
  }
  pc = s.next;
}
console.log(log.join('\n'));
