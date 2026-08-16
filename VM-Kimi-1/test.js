// test.js — verification for vm.js (JS-Confuser-VM 0.1.5 deobfuscator).
//
//   node test.js
//
// Checks:
//   1. require('./vm.js')('input.js') returns the deobfuscated program with
//      decoded strings and recovered structure.
//   2. require('./vm.js')('regular.js') passes a non-obfuscated file through
//      unchanged, without errors.
//   3. Behavioral equivalence: with Date.now/Math.random mocked deterministically,
//      the original and the deobfuscated program log byte-identical output —
//      including the run-once guard (second call is a no-op).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const deobfuscate = require('./vm.js');

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

// ---- 1. deobfuscate input.js ----
const output = deobfuscate(path.join(__dirname, 'input.js'));
check('deobfuscation returns a string', typeof output === 'string' && output.length > 0);

const expectedStrings = [
  '_k1crlxlk2w8',            // the installed global's name
  'calc(100px + 20px * 2)',  // concealed constant string
  'createElement', 'div', 'style', 'width', 'body', 'appendChild', 'offsetWidth',
  'now', 'floor', 'random', 'log', 'charCodeAt', 'fromCharCode', 'length',
];
for (const s of expectedStrings) {
  check('output contains decoded string ' + JSON.stringify(s), output.includes(s));
}
check('run-once guard store preserved (g2 = true)', /= true;/.test(output));
check('no VM machinery left (no Uint32Array/base64 payload)',
  !/Uint32Array/.test(output) && !/[A-Za-z0-9+/=]{500,}/.test(output));

// output must be syntactically valid JS
try {
  new Function(output);
  check('output parses', true);
} catch (e) {
  check('output parses (' + e.message + ')', false);
}

// ---- 2. regular.js passes through unchanged ----
const regularSrc = fs.readFileSync(path.join(__dirname, 'regular.js'), 'utf8');
let regularOutput, threw = false;
try {
  regularOutput = deobfuscate(path.join(__dirname, 'regular.js'));
} catch (e) {
  threw = true;
}
check('regular.js passes through without errors', !threw);
check('regular.js passes through unchanged', regularOutput === regularSrc);

// ---- 3. behavioral equivalence under deterministic mocks ----
// Writes output.js (same as `node vm.js input.js output.js`) and runs both
// programs through debug/harness.js, which mocks Date.now/Math.random/document
// and calls the installed global twice.
fs.writeFileSync(path.join(__dirname, 'output.js'), output);
const run = f =>
  execFileSync(process.execPath, [path.join(__dirname, 'debug', 'harness.js'), f], {
    cwd: __dirname,
    encoding: 'utf8',
  });
const origRun = run('input.js');
const deobRun = run('output.js');
check('original and deobfuscated outputs are byte-identical', origRun === deobRun);
const logLines = origRun.split(/\r?\n/).filter(l => l.length > 0 && l !== 'LOGS:');
check('run-once guard: exactly one log line across two calls', logLines.length === 1);
if (logLines.length === 1) {
  check('log line has expected fingerprint shape',
    /^\d{13}\|\d+\|\d+\|\d+\|\d+ /.test(logLines[0]));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
