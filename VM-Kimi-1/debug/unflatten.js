// Unflatten: recover the real CFG from the flattened state machine.
const core = require('./core');
const { BIN_OPS, UN_OPS } = core;

// Concretely evaluate a register's update inside a block, tracking it as (incoming + offset).
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
  if (v.regPlus !== undefined && v.regPlus !== 0) return { delta: v.regPlus };
  if (v.regPlus === 0) return { delta: 0 };
  return null;
}

// Identify machinery vs real and build the real CFG.
// cfg: { stateReg, accReg, headerIp, entry (block ip), trampIp }
function unflatten(ctx, blocks, cfg) {
  const header = blocks.get(cfg.headerIp);
  // special value checked in header: the constant compared against stateReg
  let specialValue, specialBlock;
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
    // header: if state===special -> specialBlock. Determine which target corresponds.
    // The exploration gives targetTrue/targetFalse; cond = (state !== special) for main/inner.
    // We resolve by checking which target is the chain vs not; but simpler: specialBlock is the
    // non-chain target. Chain target is the one that begins the case chain (targetTrue here).
    // We'll detect chain blocks first, then specialBlock = the other.
  }

  // Walk the chain: start from header's target that is a chain block.
  // A chain block compares stateReg with accReg (STRICT_EQ/NE where neither operand const-only... accReg).
  function isChainBlock(ip) {
    const b = blocks.get(ip);
    if (!b || b.kind !== 'dispatch-cond') return false;
    return b.instrs.some(ins =>
      (ins.name === 'STRICT_EQ' || ins.name === 'STRICT_NE') &&
      (ins.operands[1] === cfg.stateReg || ins.operands[2] === cfg.stateReg) &&
      (ins.operands[1] === cfg.accReg || ins.operands[2] === cfg.accReg));
  }

  let chainStart = null;
  if (isChainBlock(header.targetTrue)) { chainStart = header.targetTrue; specialBlock = header.targetFalse; }
  else if (isChainBlock(header.targetFalse)) { chainStart = header.targetFalse; specialBlock = header.targetTrue; }
  else throw new Error('no chain found from header');

  // Walk chain, building case table.
  const cases = []; // {value, payloadIp, chainIp}
  const chainSet = new Set();
  const stubSet = new Set();
  let acc = null;
  let ip = chainStart;
  while (isChainBlock(ip)) {
    chainSet.add(ip);
    const b = blocks.get(ip);
    // accumulator update
    const upd = stateUpdate(b, cfg.accReg, ctx);
    if (upd) {
      if (upd.set !== undefined) acc = upd.set;
      else acc = acc + upd.delta;
    }
    // targetTrue = case stub (or direct payload); resolve through pure-dispatch stubs
    let t = b.targetTrue;
    let payload = resolveStub(t);
    cases.push({ value: acc, payloadIp: payload, chainIp: ip });
    ip = b.targetFalse;
  }
  const chainEnd = ip; // block after chain (-> header)

  function resolveStub(ip) {
    // a stub is a block whose only non-scratch instructions are argReg loads + JUMP tramp
    let cur = ip;
    const seen = new Set();
    while (true) {
      if (seen.has(cur)) return cur;
      seen.add(cur);
      const b = blocks.get(cur);
      if (!b) return cur;
      if (b.kind === 'dispatch') {
        // check if it's a pure stub: all instrs are LOAD_LITERAL/LOAD_CONST into argRegs or JUMP to tramp
        const isStub = b.instrs.every(ins =>
          (ins.name === 'JUMP' && ins.operands[0] === cfg.trampIp) ||
          ((ins.name === 'LOAD_LITERAL' || ins.name === 'LOAD_CONST' || ins.name === 'MOVE') &&
            (cfg.argRegs.includes(ins.operands[0]))));
        if (isStub) { stubSet.add(cur); cur = b.targets[0]; continue; }
        return cur;
      }
      return cur;
    }
  }

  const caseMap = new Map(cases.map(c => [c.value, c.payloadIp]));

  // Entry state: concrete stateReg value at end of entry block
  const entryBlock = blocks.get(cfg.entry);
  // evaluate entry block concretely for stateReg
  let entryState;
  {
    // walk entry block, tracking consts and moves into stateReg
    const consts = {};
    const moves = {};
    for (const ins of entryBlock.instrs) {
      const o = ins.operands;
      if (ins.name === 'LOAD_CONST') consts[o[0]] = ctx.decodeConst(o[1], o[2]);
      else if (ins.name === 'LOAD_LITERAL') consts[o[0]] = o[1] >> 0;
      else if (ins.name === 'MOVE') moves[o[0]] = o[1];
    }
    // resolve stateReg through moves
    let reg = cfg.stateReg;
    const seen = new Set();
    while (moves[reg] !== undefined && !seen.has(reg)) { seen.add(reg); reg = moves[reg]; }
    entryState = consts[reg];
  }

  // machinery = header + chain + stubs
  const machinery = new Set([cfg.headerIp, ...chainSet, ...stubSet]);

  function resolveState(s) {
    if (s === specialValue) return specialBlock;
    if (caseMap.has(s)) return caseMap.get(s);
    return null; // fallthrough (shouldn't happen on real path)
  }

  // Build real CFG via worklist over states/blocks.
  // Nodes = real blocks. Track entryState per node.
  const realNodes = new Map(); // ip -> {block, entryState, succs:[{cond,ip}]}
  const wl = [];
  function addNode(ip, entryState) {
    if (ip === null || ip === undefined) return;
    if (machinery.has(ip)) throw new Error('machinery block as real node: ' + ip);
    if (!realNodes.has(ip)) {
      const blk = blocks.get(ip);
      if (!blk) { console.log('warning: missing block ' + ip); return; }
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
      // real conditional: two arms. Arms may be pure state-updaters or real blocks.
      for (const [target, when] of [[b.targetTrue, true], [b.targetFalse, false]]) {
        const tb = blocks.get(target);
        const upd = stateUpdate(tb, cfg.stateReg, ctx);
        const isPureArm = tb.kind === 'dispatch' && tb.instrs.every(ins =>
          (ins.name === 'JUMP' && ins.operands[0] === cfg.trampIp) ||
          (cfg.argRegs.includes(ins.operands[0])) ||
          ((ins.name === 'LOAD_LITERAL' || ins.name === 'LOAD_CONST')) ||
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
      // unconditional payload: state update -> resolveState
      const upd = stateUpdate(b, cfg.stateReg, ctx);
      const ns = upd ? (upd.set !== undefined ? upd.set : node.entryState + upd.delta) : node.entryState;
      const dest = resolveState(ns);
      if (dest !== null) {
        node.succs.push({ cond: null, ip: dest });
        addNode(dest, ns);
      }
    }
  }

  return { cases, caseMap, specialValue, specialBlock, entryState, entryReal, realNodes, chainSet, stubSet, chainEnd };
}

module.exports = { unflatten, stateUpdate };
