// Auto-detection of VM config from bytecode + source. Test harness for vm.js logic.
const fs = require('fs');
const core = require('./core');

// ---- bytecode + pool are given (words, pool). Auto-detect everything else. ----
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

// Find the trampoline used by a function whose entry block starts at entryIp.
function findTrampoline(ctx, instrs, entryIp) {
  // decode the entry block: instructions until a JUMP / JUMP_REG / RETURN
  let ip = entryIp;
  let trampIp = null;
  while (true) {
    const ins = instrs.get(ip) || ctx.decodeAt(ip);
    if (!ins) return null;
    if (ins.name === 'JUMP') { trampIp = ins.operands[0]; break; }
    if (ins.name === 'JUMP_REG' || ins.name === 'RETURN' || ins.name === 'THROW') return null;
    ip += ins.size;
  }
  // at trampIp: CALL_NULL(dest, funcReg, argc, a1, a2) ... GET_PROP(d2, dest, propReg), JUMP_REG(d2)
  // Scan the trampoline's instructions until JUMP_REG.
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
  const funcReg = o[1];
  const argRegs = [o[3], o[4]]; // (A, B) = dispatcher's (r0, r1)
  let prop = 0;
  if (getProp) {
    const propReg = getProp.operands[2];
    for (const ti of trampInstrs) {
      if ((ti.name === 'LOAD_CONST' || ti.name === 'LOAD_LITERAL') && ti.operands[0] === propReg) {
        prop = ti.name === 'LOAD_LITERAL' ? (ti.operands[1] >> 0) : ctx.decodeConst(ti.operands[1], ti.operands[2]);
        break;
      }
    }
  }
  // dispEntry: find MAKE_FUNC writing funcReg
  let dispEntry = null;
  for (const [, ins] of instrs) {
    if (ins.name === 'MAKE_FUNC' && ins.operands[0] === funcReg) { dispEntry = ins.operands[1]; break; }
  }
  return { trampIp, argRegs, prop, dispEntry };
}

// After exploration, detect stateReg/accReg/headerIp/specialValue/deltaReg/maskRegs.
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

  // stateReg + specialValue from header: STRICT_NE/EQ with a constant
  const header = blocks.get(headerIp);
  const consts = {};
  for (const ins of header.instrs) {
    const o = ins.operands;
    if (ins.name === 'LOAD_CONST') consts[o[0]] = ctx.decodeConst(o[1], o[2]);
    else if (ins.name === 'LOAD_LITERAL') consts[o[0]] = o[1] >> 0;
  }
  let stateReg = null, specialValue;
  for (const ins of header.instrs) {
    const o = ins.operands;
    if ((ins.name === 'STRICT_NE' || ins.name === 'STRICT_EQ')) {
      if (consts[o[1]] !== undefined && typeof consts[o[1]] === 'number') { stateReg = o[2]; specialValue = consts[o[1]]; }
      else if (consts[o[2]] !== undefined && typeof consts[o[2]] === 'number') { stateReg = o[1]; specialValue = consts[o[2]]; }
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
  // deltaReg: from a payload block's state update (stateReg = stateReg +/- tmp)
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
  // maskRegs: registers written by NOT/POS/NEG in conditional blocks + select temps
  const maskRegs = new Set();
  for (const [, b] of blocks) {
    if (b.kind !== 'dispatch-cond') continue;
    for (const ins of b.instrs) {
      const o = ins.operands;
      if (['NOT', 'POS', 'NEG'].includes(ins.name)) maskRegs.add(o[0]);
      // select: ADD(argB, argB, tmp) ; tmp is select-temp. AND/MUL(tmp, ..., mask)
      if ((ins.name === 'AND' || ins.name === 'MUL') && o[1] !== stateReg && o[2] !== stateReg) {
        // one of o[1]/o[2] is mask, other is tmp
        maskRegs.add(o[0]);
      }
    }
  }
  // remove real registers from maskRegs (argRegs and stateReg/accReg aren't maskRegs anyway)
  return { headerIp, stateReg, accReg, specialValue, deltaReg, maskRegs: [...maskRegs] };
}

module.exports = { decodeAll, findTrampoline, detectFlow };

// ---- test when run directly ----
if (require.main === module) {
  const { explore } = require('./explore');
  const words = require('./bytecode.json');
  const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
  const pool = eval(src.match(/new d\(E,C,(\[[\s\S]*?\])\)\)?\.E/)[1]);
  const ctx = core.makeCtx(words, pool);
  const instrs = decodeAll(ctx);
  for (const entry of [36, 2532]) {
    const t = findTrampoline(ctx, instrs, entry);
    console.log('entry', entry, 'trampoline:', JSON.stringify(t));
    const cfg = { entry, trampIp: t.trampIp, argRegs: t.argRegs, prop: t.prop, dispEntry: t.dispEntry, nreg: 160 };
    const blocks = explore(ctx, cfg);
    const flow = detectFlow(ctx, blocks, t.argRegs);
    console.log('  flow:', JSON.stringify(flow));
  }
}
