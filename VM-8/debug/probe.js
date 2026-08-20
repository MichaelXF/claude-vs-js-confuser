// Single-instruction probing harness: runs ONE bytecode instruction through the
// real interpreter with a fully controlled frame, recording every effect.
const fs = require('fs');
const path = require('path');
const { buildModule } = require('./loader.js');

function loadVM(file) {
  const src = fs.readFileSync(file, 'utf8');
  const { code, info } = buildModule(src);
  const tmp = path.join(__dirname, '.loaded-probe.js');
  fs.writeFileSync(tmp, code);
  delete require.cache[require.resolve(tmp)];
  const M = require(tmp);
  M.info = info;
  return M;
}

// Fake global object: every lookup returns a tagged marker.
function makeFakeGlobal() {
  const seen = [];
  const target = {};
  const p = new Proxy(target, {
    has() { return true; },
    get(t, k) {
      if (typeof k === 'symbol') return Reflect.get(t, k);
      seen.push(['get', k]);
      return { __global: k };
    },
    set(t, k, v) { seen.push(['set', k, v]); return true; },
  });
  p.__seen = seen;
  return { proxy: p, seen };
}

function probe(M, opts) {
  const {
    pc, B = 0, nregs = 24, regs = [], thisVal = { __this: true },
    upvals = null, Q = null, globalOverride = null, mutateQ = false,
  } = opts;

  const bytecode = Q || M.bytecode;
  const useQ = mutateQ ? bytecode : bytecode.slice();
  const fg = globalOverride ? { proxy: globalOverride, seen: [] } : makeFakeGlobal();

  const vm = new M.VM(useQ, null, fg.proxy, M.pool);

  const raw = [];
  let logging = false;
  const reads = [], writes = [];
  const g = new Proxy(raw, {
    get(t, k) {
      if (logging && typeof k === 'string' && /^\d+$/.test(k)) reads.push([+k, t[k]]);
      return t[k];
    },
    set(t, k, v) {
      if (logging && typeof k === 'string' && /^\d+$/.test(k)) writes.push([+k, v]);
      t[k] = v; return true;
    },
  });
  vm.g = g;

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

  const rec = { operands, reads, writes, op: null, threw: null, ran: false };
  const ops = Object.keys(M.proto).filter(k => /^\d+$/.test(k));
  for (const opKey of ops) {
    const real = M.proto[opKey];
    vm[opKey] = function () {
      rec.op = +opKey; rec.ran = true;
      rec.hBefore = this.h; rec.nBefore = this.n;
      rec.regBase = raw[this.h + 7];
      logging = true;
      try { real.call(this); } catch (e) { rec.threw = e; }
      logging = false;
      rec.hAfter = this.h; rec.nAfter = this.n;
      rec.pcAfter = raw[rec.hBefore + 3];
      rec.frameAfter = raw.slice(rec.hBefore, rec.hBefore + 15);
      rec.stack = raw;
      this.h = 0; // stop the interpreter after one instruction
    };
  }

  const fnObj = new M.Fn({ j: nregs, l: nregs, C: pc, B: B, K: false });
  const upvalOps = [];
  fnObj.f = upvals || new Proxy([], {
    get(t, k) {
      if (typeof k === 'string' && /^\d+$/.test(k)) {
        if (!(k in t)) t[k] = {
          a() { upvalOps.push(['get', +k]); return { __upval: +k }; },
          q(v) { upvalOps.push(['set', +k, v]); },
          s() { upvalOps.push(['close', +k]); },
        };
      }
      return t[k];
    },
  });
  rec.upvalOps = upvalOps;

  const args = new Array(nregs);
  for (let i = 0; i < nregs; i++) args[i] = regs[i];

  try {
    M.interp(vm, fnObj, args, 'q', thisVal);
  } catch (e) {
    rec.outerThrew = e;
  }
  rec.globalSeen = fg.seen;
  rec.vm = vm;
  rec.Q = useQ;
  rec.pcStart = pc;
  rec.nOperands = operands.length;
  rec.next = pc + 1 + operands.length;
  return rec;
}

module.exports = { loadVM, probe, makeFakeGlobal };

if (require.main === module) {
  const M = loadVM(path.join(__dirname, '..', 'input.js'));
  const r = probe(M, { pc: 0, B: M.meta.B, nregs: 40, regs: Array.from({length:40},(_,i)=>1000+i) });
  console.log(JSON.stringify({ op: r.op, operands: r.operands, reads: r.reads, writes: r.writes,
    regBase: r.regBase, pcAfter: r.pcAfter, next: r.next }, (k,v)=> typeof v==='object'&&v&&v.__this?'<this>':v, 2));
}
