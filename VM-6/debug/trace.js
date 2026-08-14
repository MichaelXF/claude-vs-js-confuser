// debug/trace.js -- run the real VM with an instrumented opcode table and
// compare the pcs it actually executes with the ones vm.js recovered
// statically.  A good cross-check that the devirtualizer did not lose code.
//
//   node debug/trace.js
const path = require('path');
const { loadVM, makeAnalyzer, exploreAll } = require('../vm.js').internals;

const file = process.argv[2] || path.join(__dirname, '..', 'input.js');

// a deterministic browser-ish environment
const logs = [];
let seed = 42;
const makeEl = (tag) => ({
  tagName: tag, style: {}, children: [], offsetWidth: 137,
  appendChild(c) { this.children.push(c); return c; },
});
const win = {};
const extra = {
  window: win,
  document: { body: makeEl('body'), createElement: makeEl },
  console: { log: (...a) => logs.push(a.map(String).join(' ')) },
  Date: Object.assign(function Date() { }, { now: () => 1700000000000 }),
  Math: Object.assign(Object.create(Math), { random: () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; } }),
};

const L = loadVM(file, undefined, extra);
const A = makeAnalyzer(L);

const executed = new Set();
const seq = [];
for (const key of Object.getOwnPropertyNames(L.A)) {
  const op = Number(key);
  if (!Number.isInteger(op)) continue;
  const orig = L.A[key];
  if (typeof orig !== 'function') continue;
  L.A[key] = function () {
    const pc = this.g[this.d + 2] - 1;
    executed.add(pc);
    if (seq.length < 400) seq.push(pc + ':' + op);
    return orig.apply(this, arguments);
  };
}

L.Z(L.vm, L.thisArg, L.args, L.tmpl);          // run the module body
const entry = win._k1crlxlk2w8;
console.log('entry point installed:', typeof entry);
if (typeof entry === 'function') { entry(); entry(); }
console.log('console output:', JSON.stringify(logs));
console.log('distinct pcs executed:', executed.size);
console.log('first instructions:', seq.slice(0, 24).join(' '));

// restore, then compare with the static recovery
for (const key of Object.getOwnPropertyNames(L.A)) {
  const op = Number(key);
  if (Number.isInteger(op) && L.A[key].__orig) L.A[key] = L.A[key].__orig;
}
const L2 = loadVM(file);
const A2 = makeAnalyzer(L2);
const all = exploreAll(A2);
// walk each recovered block the same way the explorer did, so that the
// terminator instructions (jump / return / throw) are counted too
const staticPCs = new Set();
for (const [, rec] of all) for (const b of rec.blocks.values()) {
  let pc = b.pc;
  const seen = new Set();
  for (;;) {
    if (seen.has(pc) || pc >= A2.code.length) break;
    seen.add(pc); staticPCs.add(pc);
    const ins = A2.decode(pc);
    if (!ins) break;
    if (ins.kind === 'JMP') { pc = ins.target; continue; }
    if (['RETURN', 'THROW', 'JMPDYN', 'JMPIF', 'JMPIFNOT', 'FORIN_NEXT'].includes(ins.kind)) break;
    pc = ins.next;
  }
}
const missed = [...executed].filter(pc => !staticPCs.has(pc)).sort((a, b) => a - b);
console.log('pcs executed but NOT recovered statically:', missed.length, missed.slice(0, 20).join(','));
console.log('pcs recovered statically:', staticPCs.size);
process.exit(missed.length ? 1 : 0);
