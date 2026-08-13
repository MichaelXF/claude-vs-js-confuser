// debug/patch1.js - swap the classification section of vm.js for the corrected version
const fs = require('fs');
const path = require('path');
const vmPath = path.resolve(__dirname, '..', 'vm.js');
let s = fs.readFileSync(vmPath, 'utf8');
const start = s.indexOf('function classifyOne(env, op) {');
const end = s.indexOf('/* ================================================================== *\n * 6.  Frame-slot discovery');
if (start < 0 || end < 0) throw new Error('markers not found');
const replacement = fs.readFileSync(path.join(__dirname, 'classify-section.js'), 'utf8');
s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(vmPath, s);
console.log('patched vm.js');
