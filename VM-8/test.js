'use strict';
// ---------------------------------------------------------------------------
//  node test.js
//
//  1. deobfuscate input.js and check the recovered source
//  2. run the obfuscated sample and the recovered source side by side in
//     identical deterministic sandboxes and compare every observable effect
//  3. rebuild the sample with completely different opcode numbers, a shuffled
//     handler table and renamed identifiers, and check the result is the same
//  4. assemble programs that use handlers this sample never executes
//     (try/catch, for-in, arrays, `new`, encrypted bytecode) and round-trip them
//  5. check that a plain, non-obfuscated file passes straight through
//
//  Use `node test.js --quick` to skip steps 3 and 4.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const parser = require('@babel/parser');

const deobfuscate = require('./vm.js');
const makeSandbox = require('./debug/shim.js');

const QUICK = process.argv.includes('--quick');
const here = (f) => path.join(__dirname, f);
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
}

// --- 1. deobfuscate --------------------------------------------------------
const started = Date.now();
const output = deobfuscate(here('input.js'), here('output.js'));
console.log(`deobfuscated input.js in ${Date.now() - started}ms (${output.length} bytes)\n`);

check('output parses', (() => {
  try { parser.parse(output, { sourceType: 'unambiguous' }); return true; }
  catch (e) { return false; }
})());
check('no VM runtime left in the output',
  !/Uint32Array/.test(output) && !/atob\(/.test(output) && !/Math\.imul/.test(output) &&
  !/\.prototype\[/.test(output),
  'no bytecode array, no base64 loader, no MBA');
check('decoded strings are present',
  output.includes('CLAUDE OPUS 5') && output.includes('calc(100px + 20px * 2)'));
check('control flow was reconstructed',
  !/switch\s*\(/.test(output) && /while \(/.test(output) && /if \(/.test(output),
  'the flattening dispatcher is gone, real loops and branches are back');
check('no unresolved opcodes', !/opaque|UNRESOLVED|unstructured/i.test(output));

// --- 2. behavioral equivalence --------------------------------------------
function run(file, seed, isSource) {
  const sb = makeSandbox(seed);
  vm.createContext(sb);
  const code = isSource ? file : fs.readFileSync(here(file), 'utf8');
  vm.runInContext(code, sb, { timeout: 30000, filename: isSource ? '<source>' : file });
  for (const key of Object.keys(sb)) {
    if (typeof sb[key] === 'function' && /^_[a-z0-9]{6,}$/i.test(key)) {
      for (let i = 0; i < 3; i++) {
        try { sb.__calls.push(['return', String(sb[key]())]); }
        catch (e) { sb.__calls.push(['threw', e.message]); }
      }
    }
  }
  return sb.__calls.map((c) => JSON.stringify(c));
}

function compare(name, a, b) {
  const n = Math.max(a.length, b.length);
  let firstDiff = -1;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) { firstDiff = i; break; }
  check(name, firstDiff < 0 && a.length > 0,
    firstDiff < 0 ? `${a.length} observable effects identical`
      : `differs at #${firstDiff}: ${a[firstDiff]} vs ${b[firstDiff]}`);
  return firstDiff < 0;
}

for (const seed of [1, 7, 12345, 987654]) {
  let a, b, err = null;
  try { a = run('input.js', seed); b = run('output.js', seed); }
  catch (e) { err = e; }
  if (err) { check(`behavior matches (seed ${seed})`, false, err.message); continue; }
  const ok = compare(`behavior matches (seed ${seed})`, a, b);
  if (seed === 1 && ok) for (const line of a) console.log('      ' + line);
}

// --- 3. randomized opcodes / shuffled handler table ------------------------
if (!QUICK) {
  const { permute } = require('./debug/permute.js');
  const source = fs.readFileSync(here('input.js'), 'utf8');
  for (const seed of [3, 99]) {
    let rebuilt = null, err = null;
    try { rebuilt = permute(source, seed); } catch (e) { err = e; }
    if (err) { check(`rebuild with randomized opcodes (seed ${seed})`, false, err.message); continue; }
    const p = here('debug/permuted.js');
    fs.writeFileSync(p, rebuilt);
    check(`rebuilt sample still behaves like the original (seed ${seed})`,
      JSON.stringify(run(rebuilt, 5, true)) === JSON.stringify(run('input.js', 5)));
    let out2 = null;
    try { out2 = deobfuscate(p, here('debug/permuted.out.js')); }
    catch (e) { err = e; }
    if (err) { check(`deobfuscate randomized build (seed ${seed})`, false, err.message); continue; }
    check(`randomized build deobfuscates to the same source (seed ${seed})`, out2 === output,
      out2 === output ? 'byte identical' : 'differs');
  }
}

// --- 4. handlers this sample never executes -------------------------------
if (!QUICK) {
  console.log('\n-- synthesized programs for unused handlers --');
  const { execFileSync } = require('child_process');
  let out = '', ok = true;
  try { out = execFileSync(process.execPath, [here('debug/features.js')], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); ok = false; }
  for (const line of out.trim().split('\n')) console.log('  ' + line);
  check('synthesized feature programs round-trip', ok && /all feature tests passed/.test(out));
}

// --- 5. pass-through -------------------------------------------------------
console.log('');
const regularSource = fs.readFileSync(here('regular.js'), 'utf8');
let regularOutput = null, regularErr = null;
try { regularOutput = deobfuscate(here('regular.js')); } catch (e) { regularErr = e; }
check('regular.js passes through without errors', regularErr === null, regularErr && regularErr.message);
check('regular.js is unchanged', regularOutput === regularSource);

const tricky = 'var a = new Map([[1, 2]]);\nvar b = new Set([3]);\nconsole.log(a, b);\n';
fs.writeFileSync(here('debug/tricky.js'), tricky);
let trickyOut = null, trickyErr = null;
try { trickyOut = deobfuscate(here('debug/tricky.js')); } catch (e) { trickyErr = e; }
check('non-obfuscated file with new-expressions passes through',
  trickyErr === null && trickyOut === tricky, trickyErr && trickyErr.message);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
