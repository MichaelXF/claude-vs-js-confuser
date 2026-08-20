'use strict';
// ---------------------------------------------------------------------------
// Single-instruction probe: executes exactly ONE bytecode instruction through
// the sample's own interpreter with a fully synthesized frame, recording every
// observable effect (operands consumed, register reads/writes, global access,
// upvalue access, property access, control-flow changes).
// ---------------------------------------------------------------------------

// A value that records everything done to it while still behaving like an
// object, a function and a number.
function tracer(id, log, num) {
  const target = function () {};
  target.__id = id;
  // Detach Function.prototype so that `apply`/`call`/`bind` are reported through
  // the get trap instead of silently forwarding, which keeps the real argument
  // list (and therefore spread calls) observable.
  Object.setPrototypeOf(target, null);
  return new Proxy(target, {
    get(tg, k) {
      if (k === '__id') return id;
      if (k === '__isTracer') return true;
      if (k === Symbol.toPrimitive) return (hint) => (hint === 'number' ? (num | 0) : id);
      if (k === 'valueOf') return () => (num | 0);
      if (k === 'toString') return () => id;
      if (typeof k === 'symbol') return undefined;
      log.push({ t: 'get', id, key: k });
      if (!(k in tg)) tg[k] = tracer(id + '.' + String(k), log, num);
      return tg[k];
    },
    set(tg, k, v) { log.push({ t: 'set', id, key: k, val: v }); tg[k] = v; return true; },
    has(tg, k) { if (typeof k !== 'symbol') log.push({ t: 'has', id, key: k }); return true; },
    deleteProperty(tg, k) { log.push({ t: 'delete', id, key: k }); return true; },
    apply(tg, thisArg, args) { log.push({ t: 'apply', id, thisArg, args }); return tracer(id + '()', log, num); },
    construct(tg, args) { log.push({ t: 'construct', id, args }); return tracer('new ' + id, log, num); },
    defineProperty(tg, k, desc) {
      log.push({
        t: 'defineProp', id, key: k,
        accessor: desc.get ? 'get' : (desc.set ? 'set' : 'value'),
        fn: desc.get || desc.set,
      });
      return Reflect.defineProperty(tg, k, { configurable: true, enumerable: true, value: 0, writable: true });
    },
  });
}

// Behaves like a for-in iterator record no matter what the handler names its
// fields: numerically zero, two entries long, indexable.
function iterish(log, id) {
  const target = {};
  Object.setPrototypeOf(target, null);
  const self = new Proxy(target, {
    get(tg, k) {
      if (k === '__isTracer') return true;
      if (k === '__id') return id;
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'valueOf') return () => 0;
      if (k === 'length') return 2;
      if (typeof k === 'symbol') return undefined;
      log.push({ t: 'iterGet', id, key: k });
      return self;
    },
    set(tg, k, v) { log.push({ t: 'iterSet', id, key: k, val: v }); return true; },
    has() { return true; },
  });
  return self;
}

function fakeGlobal(log) {
  return new Proxy({}, {
    has(tg, k) { if (typeof k !== 'symbol') log.push({ t: 'gHas', key: k }); return true; },
    get(tg, k) {
      if (typeof k === 'symbol') return undefined;
      log.push({ t: 'gGet', key: k });
      return tracer('G:' + String(k), log, 7);
    },
    set(tg, k, v) { log.push({ t: 'gSet', key: k, val: v }); return true; },
    getOwnPropertyDescriptor(tg, k) {
      if (typeof k === 'symbol') return undefined;
      log.push({ t: 'gOwn', key: k });
      return { value: tracer('G:' + String(k), log, 7), writable: true, enumerable: true, configurable: true };
    },
  });
}

const isIndex = (k) => typeof k === 'string' && /^\d+$/.test(k);

function probe(M, opts) {
  const { pc, B = 0, nregs = 32, regs = [], thisVal, upvals = null,
          bytecode = null, mutate = false, params = null, trackCaptures = false,
          throwAfter = null } = opts;
  const src = bytecode || M.bytecode;
  const Q = mutate ? src : src.slice();

  const log = [];
  const gObj = opts.globalObj || fakeGlobal(log);
  const vm = new M.VM(Q, M.ctorArgs ? M.ctorArgs[1] : null, gObj, M.pool);

  const raw = [];
  let logging = false;
  const reads = [], writes = [];
  vm.g = new Proxy(raw, {
    get(tg, k) { if (logging && isIndex(k)) reads.push([+k, tg[k]]); return tg[k]; },
    set(tg, k, v) {
      if (logging && isIndex(k)) writes.push([+k, v]);
      // First pc written by the interpreter's unwinder = the catch target.
      if (throwAfter && rec.ran && rec.unwindPc === undefined && isIndex(k) && +k === rec.hBefore + 3) {
        rec.unwindPc = v;
      }
      tg[k] = v;
      return true;
    },
  });

  const operands = [];
  vm.c = function () {
    const was = logging; logging = false;
    const ptr = raw[this.h + 3];
    raw[this.h + 3] = ptr + 1;
    const v = this.Q[ptr];
    operands.push(v);
    logging = was;
    return v;
  };

  const rec = { operands, reads, writes, log, pc, ran: false, threw: null, upvalOps: [], capture: [] };

  if (trackCaptures) {
    vm.v = new Proxy([], {
      get(tg, k) { return tg[k]; },
      set(tg, k, v) { if (isIndex(k)) rec.capture.push({ kind: 'own', index: +k }); tg[k] = v; return true; },
    });
  }

  for (const key of M.opKeys) {
    const real = M.proto[key];
    vm[key] = function () {
      if (rec.ran) {
        if (throwAfter && !rec.afterUnwind) {
          rec.afterUnwind = raw.slice();
          rec.pcUnwound = raw[this.h + 3] - 1;
          rec.frameUnwound = this.h;
        }
        this.h = 0;
        return;
      }
      rec.ran = true; rec.op = +key;
      rec.hBefore = this.h; rec.nBefore = this.n;
      rec.regBase = raw[this.h + 7];
      logging = true;
      try { real.call(this); } catch (e) { rec.threw = e; }
      logging = false;
      rec.hAfter = this.h; rec.nAfter = this.n;
      rec.pcAfter = raw[rec.hBefore + 3];
      rec.frame = raw.slice(rec.hBefore, rec.hBefore + 15);
      rec.stack = raw.slice();
      if (throwAfter) {
        // Let the interpreter's own unwinder consume the handler record that
        // this instruction just pushed, so the catch target and the registers
        // it fills become directly observable.
        rec.beforeUnwind = raw.slice();
        throw throwAfter;
      }
      this.h = 0;
    };
  }

  const fnObj = new M.Fn({ j: params == null ? nregs : params, l: nregs, C: pc, B: B, K: false });
  fnObj.f = upvals || new Proxy([], {
    get(tg, k) {
      if (!isIndex(k)) return tg[k];
      if (trackCaptures) rec.capture.push({ kind: 'up', index: +k });
      if (!(k in tg)) {
        tg[k] = {
          a() { rec.upvalOps.push(['get', +k]); return tracer('U' + k, log, 11); },
          q(v) { rec.upvalOps.push(['set', +k, v]); },
          s() {},
        };
      }
      return tg[k];
    },
  });

  const args = new Array(nregs);
  for (let i = 0; i < nregs; i++) args[i] = regs[i];
  try { M.interp(vm, fnObj, args, 'q', thisVal); } catch (e) { rec.outerThrew = e; }
  if (throwAfter && rec.hBefore !== undefined && !rec.afterUnwind) {
    rec.afterUnwind = raw.slice();
    rec.pcUnwound = raw[rec.hBefore + 3];
  }
  rec.vm = vm;
  rec.Q = Q;
  rec.nOperands = operands.length;
  rec.fall = pc + 1 + operands.length;
  return rec;
}

function prepare(M) {
  M.opKeys = Object.keys(M.proto).filter(k => /^\d+$/.test(k));
  return M;
}

module.exports = { probe, prepare, tracer, fakeGlobal, iterish };
