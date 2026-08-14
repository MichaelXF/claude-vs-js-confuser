// test.js -- verifies that vm.js deobfuscates input.js correctly and that a
// regular (non-obfuscated) file passes through unharmed.
//
//   node test.js
const fs = require('fs');
const path = require('path');
const vmMod = require('vm');
const deobfuscate = require('./vm.js');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
}

/* ---------- a small deterministic browser-ish sandbox ---------------------- */
function makeSandbox() {
  const logs = [];
  let seed = 42;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const styleOf = () => ({});
  const makeEl = (tag) => ({
    tagName: tag, style: styleOf(), children: [], offsetWidth: 137,
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() { }, getAttribute() { return null; },
  });
  const document = {
    body: makeEl('body'),
    createElement: makeEl,
    getElementById: () => null,
    querySelector: () => null,
  };
  const sandbox = {
    console: { log: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => logs.push('ERR ' + a.map(String).join(' ')) },
    Math: Object.assign(Object.create(Math), { random }),
    Date: Object.assign(function Date() { }, { now: () => 1700000000000 }),
    Object, Array, String, Number, Boolean, JSON, Reflect, WeakMap, WeakSet, Map, Set, Symbol,
    RegExp, Promise, Proxy, Error, TypeError, RangeError, ReferenceError, SyntaxError, Function,
    Uint8Array, Uint32Array, Int32Array, Buffer, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, Infinity, NaN, undefined,
    document, navigator: { userAgent: 'test' }, location: { href: 'http://example.test/' },
    setTimeout: (fn) => fn(), clearTimeout: () => { },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return { sandbox, logs };
}

function runProgram(code, name, after) {
  const { sandbox, logs } = makeSandbox();
  const ctx = vmMod.createContext(sandbox);
  try {
    vmMod.runInContext(code, ctx, { filename: name, timeout: 10000 });
    if (after) after(ctx, sandbox);
  } catch (e) {
    logs.push('THREW ' + e.constructor.name + ': ' + e.message);
  }
  return logs;
}

/* ---------- 0. the API shape the README asks for -------------------------- */
{
  const a = require('./vm.js')(path.join(__dirname, 'input.js'));      // -> decoded strings
  const b = require('./vm.js')(path.join(__dirname, 'regular.js'));    // -> passes through
  check('require("vm.js")(file) returns source',
    typeof a === 'string' && typeof b === 'string' && a.length > 0 && b.length > 0);
}

/* ---------- 1. input.js -> deobfuscated output ---------------------------- */
console.log('vm.js on input.js');
const inputPath = path.join(__dirname, 'input.js');
const output = deobfuscate(inputPath, path.join(__dirname, 'output.js'));
check('produced output', typeof output === 'string' && output.length > 0, output.length + ' bytes');

// it must be parseable and must not contain any VM leftovers
let parsed = true;
try { new (require('vm').Script)(output); } catch (e) { parsed = false; console.log(e.message); }
check('output parses as JavaScript', parsed);
check('strings are decoded', /_k1crlxlk2w8/.test(output) && /calc\(100px \+ 20px \* 2\)/.test(output));
check('no bytecode blob left', !/[A-Za-z0-9+/]{200,}={0,2}/.test(output));
check('no opcode dispatch left', !/Math\.imul\(Math\.imul/.test(output));

// behavior must match: drive both versions through the same stubbed browser
const original = fs.readFileSync(inputPath, 'utf8');
const drive = (ctx) => {
  const fn = ctx.window && ctx.window._k1crlxlk2w8;
  if (typeof fn !== 'function') throw new Error('entry point missing');
  fn(); fn();          // second call exercises the run-once guard
};
const logsA = runProgram(original, 'input.js', drive);
const logsB = runProgram(output, 'output.js', drive);
check('same observable behavior', JSON.stringify(logsA) === JSON.stringify(logsB),
  JSON.stringify(logsA) + ' vs ' + JSON.stringify(logsB));
check('behavior is non-trivial', logsA.length > 0 && !/THREW/.test(logsA.join(' ')), JSON.stringify(logsA));

/* ---------- 2. a regular file must survive the round trip ----------------- */
console.log('\nvm.js on regular.js');
const regularPath = path.join(__dirname, 'regular.js');
let regularOutput = null;
let threw = null;
try { regularOutput = deobfuscate(regularPath); } catch (e) { threw = e; }
check('no error thrown', !threw, threw ? threw.message : '');
check('produced output', typeof regularOutput === 'string' && regularOutput.length > 0);
const regSrc = fs.readFileSync(regularPath, 'utf8');
const logsC = runProgram(regSrc, 'regular.js');
const logsD = runProgram(regularOutput || '', 'regular.out.js');
check('same observable behavior', JSON.stringify(logsC) === JSON.stringify(logsD),
  JSON.stringify(logsC) + ' vs ' + JSON.stringify(logsD));
check('no THREW in regular run', !/THREW/.test(logsC.join(' ')), JSON.stringify(logsC));

/* ---------- 3. assorted other programs pass through ---------------------- */
console.log('\nvm.js on assorted plain programs');
const samples = {
  'empty.js': '',
  'iife.js': '(function () { console.log("hi"); })();',
  'module.js': 'module.exports = function (a, b) { return a + b; };',
  'async.js': 'async function f() { await 0; return 1; } f().then(function (v) { console.log(v); });',
  'json-ish.js': 'var o = { "a-b": 1, c: [1, 2, 3] }; console.log(JSON.stringify(o));',
  'looks-like-vm.js': 'function g(b, c, h) { this.i = b; } var r = new WeakMap(); console.log(typeof g);',
};
for (const [name, src] of Object.entries(samples)) {
  const tmp = path.join(__dirname, 'debug', '_tmp_' + name);
  fs.writeFileSync(tmp, src);
  let out = null, err = null;
  try { out = deobfuscate(tmp); } catch (e) { err = e; }
  fs.unlinkSync(tmp);
  const same = !err && JSON.stringify(runProgram(src, name)) === JSON.stringify(runProgram(out, name));
  check(name, same, err ? err.message : '');
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
