'use strict';
// ---------------------------------------------------------------------------
// Linear disassembly + per-site behavioral classification into IR.
// ---------------------------------------------------------------------------
const { probe, iterish } = require('./lib-probe.js');
const C = require('./lib-classify.js');
const { regTracer, regId, fitNumeric, fitTyped, THIS_MARK, writeAt, numRun } = C;

// --- 1. instruction boundaries --------------------------------------------
// The sweep runs on a working copy of the bytecode: builds that use the
// `encodeBytecode` option keep part of the program encrypted and decrypt it
// with a dedicated handler, so any instruction that writes back into the
// bytecode array is executed for real and its effect kept.
function sweep(M) {
  const work = Uint32Array.from(M.bytecode);
  const N = work.length;
  const instrs = [];
  const index = new Map();
  const decrypted = [];
  let pc = 0;
  while (pc < N) {
    const log = [];
    const nregs = 128;
    const regs = new Array(nregs);
    for (let i = 0; i < nregs; i++) regs[i] = regTracer(i, log);
    const before = Uint32Array.from(work);
    const r = probe(M, { pc, B: 0, nregs, regs, thisVal: THIS_MARK, bytecode: work, mutate: true });
    if (!r.ran) {
      // Not a valid opcode: data (an encrypted region, or padding).  Step over
      // it - only pcs the CFG actually reaches are ever used.
      pc++;
      continue;
    }
    let touched = null;
    for (let i = 0; i < N; i++) {
      if (work[i] !== before[i]) { if (!touched) touched = [i, i]; touched[1] = i; }
    }
    const site = { pc, op: r.op, operands: r.operands.slice(), next: r.fall };
    if (touched) { site.decrypts = touched; decrypted.push(site); }
    instrs.push(site);
    index.set(pc, site);
    pc = r.fall;
  }
  M.bytecode = work;
  return { instrs, index, decrypted };
}

// --- 2. closure inspection -------------------------------------------------
// Runs the produced function just far enough to read its own frame header.
function inspectClosure(M, fnValue) {
  const saved = {};
  let rec = null;
  for (const k of M.opKeys) {
    saved[k] = M.proto[k];
    M.proto[k] = function () {
      if (!rec) {
        const h = this.h, g = this.g;
        rec = {
          C: g[h + 3] - 1, B: g[h + 6] | 0, nregs: g[h + 10] - 15,
          regs: g.slice(g[h + 7], g[h + 7] + (g[h + 10] - 15)),
        };
      }
      this.h = 0;
    };
  }
  const NA = 10;
  const marks = [];
  for (let i = 0; i < NA; i++) marks.push({ __arg: i });
  try { fnValue.apply(undefined, marks); } catch (e) { /* ignored */ }
  for (const k of M.opKeys) M.proto[k] = saved[k];
  if (!rec) return null;
  let nparams = rec.nregs, rest = false;
  for (let i = rec.regs.length - 1; i >= 0; i--) {
    if (Array.isArray(rec.regs[i])) {
      if (rec.regs[i].length === NA && rec.regs[i][0] === marks[0]) { nparams = i; rest = false; }
      else { nparams = i + 1; rest = true; }
      break;
    }
  }
  return { C: rec.C, B: rec.B, nregs: rec.nregs, nparams, rest };
}

function regTracerOf(id) {
  const m = /^R(\d+)$/.exec(id);
  return m ? { __isTracer: true, __id: id } : null;
}

function keyOf(k) {
  const m = /^R(\d+)$/.exec(String(k));
  return m ? { reg: +m[1] } : { lit: String(k) };
}

// --- 3. site classification ------------------------------------------------
function classify(M, site, fnInfo, ctx) {
  const nregs = Math.max(fnInfo.nregs, 8) + 8;
  const log = [];
  const regs = new Array(nregs);
  for (let i = 0; i < nregs; i++) regs[i] = regTracer(i, log);
  const rec = probe(M, {
    pc: site.pc, B: fnInfo.B, nregs, regs, thisVal: THIS_MARK, trackCaptures: true,
  });
  const merged = rec.log.concat(log);
  const rb = rec.regBase, hb = rec.hBefore;
  const wregs = [...new Set(rec.writes.filter(x => x[0] >= rb).map(x => x[0] - rb))];
  const rregs = [...new Set(rec.reads.filter(x => x[0] >= rb).map(x => x[0] - rb))];
  const hdrW = [...new Set(rec.writes.filter(x => x[0] >= hb && x[0] < rb).map(x => x[0] - hb))];
  const hdrR = [...new Set(rec.reads.filter(x => x[0] >= hb && x[0] < rb).map(x => x[0] - hb))];
  const out = wregs.length === 1 ? writeAt(rec, wregs[0]) : undefined;
  const ir = { pc: site.pc, op: site.op, operands: site.operands, next: site.next };

  // ---- return -------------------------------------------------------------
  if (rec.hAfter !== rec.hBefore && rec.nAfter <= rec.hBefore) {
    return Object.assign(ir, { kind: 'ret', src: rregs[0] });
  }
  // ---- explicit throw -----------------------------------------------------
  if (rec.threw !== null && regId(rec.threw) !== null) {
    return Object.assign(ir, { kind: 'throw', src: regId(rec.threw) });
  }
  // ---- try bookkeeping ----------------------------------------------------
  if (hdrW.includes(14) || hdrR.includes(14)) {
    const arr = rec.stack[hb + 14];
    if (!Array.isArray(arr) || !arr.length) return Object.assign(ir, { kind: 'trypop' });
    // Push the record, then throw: the interpreter's unwinder tells us exactly
    // where it jumps and which registers it fills.
    const SENT = { __sentinel: true };
    const regs2 = new Array(nregs).fill(undefined);
    const p2 = probe(M, {
      pc: site.pc, B: fnInfo.B, nregs, regs: regs2, thisVal: THIS_MARK, throwAfter: SENT,
    });
    if (p2.afterUnwind) {
      const rb2 = p2.beforeUnwind[p2.hBefore + 7];
      let excReg = null, flagReg = null, flagValue;
      for (let i = 0; i < nregs; i++) {
        const before = p2.beforeUnwind[rb2 + i];
        const after = p2.afterUnwind[rb2 + i];
        if (after === SENT) excReg = i;
        else if (!Object.is(before, after)) { flagReg = i; flagValue = after; }
      }
      if (excReg !== null) {
        return Object.assign(ir, {
          kind: 'trypush', catchPc: p2.unwindPc !== undefined ? p2.unwindPc : p2.pcUnwound, excReg,
          flagReg: flagReg === null ? undefined : flagReg,
          flagValue: flagReg === null ? undefined : flagValue,
        });
      }
    }
    return Object.assign(ir, { kind: 'trypush', unresolved: true, fields: Object.values(arr[arr.length - 1]) });
  }
  // ---- upvalues -----------------------------------------------------------
  if (rec.upvalOps.length) {
    const [what, idx, val] = rec.upvalOps[0];
    if (what === 'get') return Object.assign(ir, { kind: 'getupval', dst: wregs[0], idx });
    return Object.assign(ir, { kind: 'setupval', idx, src: regId(val) });
  }
  // ---- control flow -------------------------------------------------------
  {
    // computed jump: does the new pc track a register value?
    const ramp = (base) => { const a = new Array(nregs); for (let i = 0; i < nregs; i++) a[i] = base + i; return a; };
    const r1 = numRun(M, site, fnInfo, ramp(5000)).pcAfter;
    if (r1 >= 5000 && r1 < 5000 + nregs) {
      const src = r1 - 5000;
      const r2 = numRun(M, site, fnInfo, ramp(9000)).pcAfter;
      if (r2 === 9000 + src) return Object.assign(ir, { kind: 'jreg', src });
    }
    const mk = (v) => { const a = new Array(nregs); for (let i = 0; i < nregs; i++) a[i] = v; return a; };
    const pcTrue = numRun(M, site, fnInfo, mk(1)).pcAfter;
    const pcFalse = numRun(M, site, fnInfo, mk(0)).pcAfter;
    if (pcTrue === pcFalse && pcTrue !== site.next) {
      return Object.assign(ir, { kind: 'jmp', target: pcTrue });
    }
    if (pcTrue !== pcFalse) {
      const cond = rregs[0];
      if (pcTrue !== site.next) return Object.assign(ir, { kind: 'jt', cond, target: pcTrue });
      return Object.assign(ir, { kind: 'jf', cond, target: pcFalse });
    }
    // A branch the numeric probes cannot exercise (iterator step).  Re-run it
    // with a value shaped like a for-in record so the non-exhausted path, and
    // with it the destination register, becomes visible too.
    if (hdrW.includes(3) && rec.pcAfter !== site.next) {
      const ilog = [];
      const iregs = new Array(nregs);
      for (let i = 0; i < nregs; i++) iregs[i] = iterish(ilog, 'I' + i);
      const p3 = probe(M, { pc: site.pc, B: fnInfo.B, nregs, regs: iregs, thisVal: THIS_MARK });
      const rb3 = p3.regBase;
      const w3 = p3.writes.filter(x => x[0] >= rb3).map(x => x[0] - rb3);
      const r3 = [...new Set(p3.reads.filter(x => x[0] >= rb3).map(x => x[0] - rb3))];
      return Object.assign(ir, {
        kind: 'forinnext',
        dst: w3.length ? w3[w3.length - 1] : wregs[0],
        obj: r3.length ? r3[0] : rregs[0],
        target: rec.pcAfter,
      });
    }
  }
  // ---- globals ------------------------------------------------------------
  const gset = merged.find(e => e.t === 'gSet');
  if (gset) return Object.assign(ir, { kind: 'setglobal', name: gset.key, src: regId(gset.val) });
  const gget = merged.find(e => e.t === 'gGet' || e.t === 'gOwn');
  if (gget) {
    if (typeof out === 'string') return Object.assign(ir, { kind: 'typeofglobal', dst: wregs[0], name: gget.key });
    return Object.assign(ir, { kind: 'getglobal', dst: wregs[0], name: gget.key });
  }
  // ---- calls and object effects ------------------------------------------
  const ap = merged.find(e => e.t === 'apply');
  if (ap) {
    const m = /^R(\d+)\.apply$/.exec(ap.id);
    const thisReg = regId(ap.args[0]);
    const list = ap.args[1];
    const spread = !Array.isArray(list);
    const args = spread ? [regId(list)] : list.map(regId);
    return Object.assign(ir, {
      kind: thisReg == null ? 'call' : 'mcall',
      dst: wregs[0], callee: m ? +m[1] : null, thisReg, args, spread,
    });
  }
  const cons = merged.find(e => e.t === 'construct');
  if (cons) {
    const m = /^R(\d+)$/.exec(cons.id);
    // Reflect.construct flattens the argument list, so a spread call shows up
    // as an empty list preceded by a `length` read on the array register.
    const lenGet = merged.filter(e => e.t === 'get' && e.key === 'length' && /^R\d+$/.test(e.id)).pop();
    if (!cons.args.length && lenGet) {
      return Object.assign(ir, {
        kind: 'new', dst: wregs[0], callee: m ? +m[1] : null,
        args: [regId(regTracerOf(lenGet.id))], spread: true,
      });
    }
    return Object.assign(ir, {
      kind: 'new', dst: wregs[0], callee: m ? +m[1] : null,
      args: cons.args.map(regId), spread: false,
    });
  }
  const del = merged.find(e => e.t === 'delete');
  if (del) {
    const m = /^R(\d+)$/.exec(del.id);
    return Object.assign(ir, { kind: 'delete', dst: wregs[0], obj: m ? +m[1] : null, key: keyOf(del.key) });
  }
  const dp = merged.find(e => e.t === 'defineProp');
  if (dp) {
    const m = /^R(\d+)$/.exec(dp.id);
    return Object.assign(ir, { kind: dp.accessor === 'get' ? 'defgetter' : 'defsetter',
      obj: m ? +m[1] : null, key: keyOf(dp.key), fn: regId(dp.fn) });
  }
  const st = merged.find(e => e.t === 'set');
  if (st && wregs.length === 0) {
    const m = /^R(\d+)$/.exec(st.id);
    return Object.assign(ir, { kind: 'setprop', obj: m ? +m[1] : null, key: keyOf(st.key), src: regId(st.val) });
  }
  if (wregs.length === 1 && out && typeof out === 'object' && !out.__isTracer && !Array.isArray(out)) {
    const vals = Object.values(out);
    if (vals.length === 2 && Array.isArray(vals[0]) && vals[1] === 0) {
      return Object.assign(ir, { kind: 'forin', dst: wregs[0], obj: rregs[0] });
    }
    const pairs = Object.entries(out).map(([k, v]) => [keyOf(k), regId(v)]);
    if (pairs.length && pairs.every(p => p[1] !== null)) {
      return Object.assign(ir, { kind: 'object', dst: wregs[0], pairs });
    }
  }
  if (wregs.length === 1 && Array.isArray(out)) {
    return Object.assign(ir, { kind: 'array', dst: wregs[0], items: out.map(regId) });
  }
  if (wregs.length === 1 && out && out.__isTracer && regId(out) === null) {
    const gp = merged.find(e => e.t === 'get' && out.__id === e.id + '.' + String(e.key));
    if (gp) {
      const m = /^R(\d+)$/.exec(gp.id);
      if (m) return Object.assign(ir, { kind: 'getprop', dst: wregs[0], obj: +m[1], key: keyOf(gp.key) });
    }
  }
  if (wregs.length === 1 && out === THIS_MARK) return Object.assign(ir, { kind: 'this', dst: wregs[0] });
  if (wregs.length === 1 && typeof out === 'function' && !out.__isTracer) {
    const info = inspectClosure(M, out);
    return Object.assign(ir, {
      kind: 'closure', dst: wregs[0], fnInfo: info,
      upvals: (rec.capture || []).map(c => c.kind === 'own' ? { own: c.index - rb } : { up: c.index }),
    });
  }
  if (wregs.length === 1 && regId(out) !== null) {
    return Object.assign(ir, { kind: 'mov', dst: wregs[0], src: regId(out) });
  }
  // ---- numeric / opaque ---------------------------------------------------
  if (wregs.length === 1) {
    const dst = wregs[0];
    const hint = ctx && ctx.nibbleHint.get(site.op);
    // The typed sweep is the expensive one; once an opcode has proved not to be
    // a plain JS operator (every MBA handler is int-only) stop retrying it.
    const notTyped = ctx && ctx.notTyped;
    let fit = null;
    if (!notTyped || !notTyped.has(site.op)) {
      fit = fitTyped(M, site, fnInfo, rregs, dst);
      if (!fit && notTyped) notTyped.add(site.op);
    }
    if (!fit) fit = fitNumeric(M, site, fnInfo, rregs, dst, hint);
    if (fit) {
      if (ctx && fit.nibble != null) ctx.nibbleHint.set(site.op, fit.nibble);
      if (fit.kind === 'const') return Object.assign(ir, { kind: 'const', dst, value: fit.value });
      if (fit.kind === 'un') {
        if (fit.operator === 'id') return Object.assign(ir, { kind: 'mov', dst, src: fit.a });
        return Object.assign(ir, { kind: 'un', dst, src: fit.a, operator: fit.operator });
      }
      if (fit.kind === 'bin') return Object.assign(ir, { kind: 'bin', dst, a: fit.a, b: fit.b, operator: fit.operator, wrap: !!fit.wrap });
      if (fit.kind === 'binimm') {
        return Object.assign(ir, { kind: 'binimm', dst, a: fit.a, imm: fit.imm, immFirst: fit.immFirst, operator: fit.operator, wrap: !!fit.wrap });
      }
    }
    return Object.assign(ir, { kind: 'opaque', dst, srcs: rregs });
  }
  if (site.decrypts) return Object.assign(ir, { kind: 'nop', decrypts: site.decrypts });
  if (!wregs.length && !rregs.length && !merged.length) return Object.assign(ir, { kind: 'nop' });
  return Object.assign(ir, { kind: 'unknown', wregs, rregs, hdrW, hdrR });
}

module.exports = { sweep, classify, inspectClosure, keyOf };
