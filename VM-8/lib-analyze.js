'use strict';
// ---------------------------------------------------------------------------
// Whole-program analysis: discovers every VM function, walks its CFG and turns
// each reachable bytecode site into IR.
// ---------------------------------------------------------------------------
const { sweep, classify } = require('./lib-disasm.js');

function analyze(M) {
  const { index, decrypted } = sweep(M);
  const ctx = { nibbleHint: new Map(), notTyped: new Set() };
  const functions = [];
  const byEntry = new Map();

  function addFunction(info) {
    if (byEntry.has(info.C)) return byEntry.get(info.C);
    const fn = {
      id: functions.length, entry: info.C, B: info.B | 0,
      nregs: info.nregs, nparams: info.nparams, rest: !!info.rest,
      sites: new Map(), order: [], upvals: info.upvals || [], parent: info.parent,
    };
    functions.push(fn);
    byEntry.set(info.C, fn);
    return fn;
  }

  const main = addFunction({
    C: M.meta.C, B: M.meta.B, nregs: M.meta.l, nparams: M.meta.j, rest: false, parent: null,
  });

  const queue = [main];
  while (queue.length) {
    const fn = queue.shift();
    const work = [fn.entry];
    while (work.length) {
      const pc = work.pop();
      if (fn.sites.has(pc)) continue;
      const site = index.get(pc);
      if (!site) throw new Error('jump into the middle of an instruction at ' + pc);
      const ir = classify(M, site, fn, ctx);
      ir.fn = fn.id;
      fn.sites.set(pc, ir);
      if (ir.kind === 'closure' && ir.fnInfo) {
        const child = addFunction(Object.assign({}, ir.fnInfo, { parent: fn.id, upvals: ir.upvals }));
        ir.target = child.id;
        if (child.sites.size === 0 && !queue.includes(child)) queue.push(child);
      }
      for (const s of successors(ir)) if (s != null && index.has(s)) work.push(s);
      // A computed jump lands on a pc that some constant in this function holds;
      // once the worklist drains, follow those.
      if (!work.length && [...fn.sites.values()].some(x => x.kind === 'jreg')) {
        for (const other of fn.sites.values()) {
          if (other.kind !== 'const') continue;
          const v = other.value;
          if (typeof v === 'number' && index.has(v) && !fn.sites.has(v)) work.push(v);
        }
      }
    }
    fn.order = [...fn.sites.keys()].sort((a, b) => a - b);
  }
  return { functions, index, main, decrypted };
}

function successors(ir) {
  switch (ir.kind) {
    case 'ret': case 'throw': return [];
    case 'jmp': return [ir.target];
    case 'jt': case 'jf': case 'forinnext': return [ir.target, ir.next];
    case 'jreg': return [];
    case 'trypush':
      return ir.catchPc !== undefined
        ? [ir.next, ir.catchPc]
        : [ir.next, ...(ir.fields || []).filter(v => typeof v === 'number')];
    default: return [ir.next];
  }
}

module.exports = { analyze, successors };
