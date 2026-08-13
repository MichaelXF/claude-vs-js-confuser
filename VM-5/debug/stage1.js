// debug/stage1.js - exercise extraction + field discovery
const fs = require('fs');
const path = require('path');
const V = require('../vm.js');

const file = path.resolve(__dirname, '..', process.argv[2] || 'input.js');
const src = fs.readFileSync(file, 'utf8');
const ast = V.parseSource(src);
console.log('bootstrap found:', !!V.findBootstrap(ast));
console.log('handler assignments:', V.countHandlerAssignments(ast));

const cap = V.captureVM(ast, src);
const proto = Object.getPrototypeOf(cap.state);
const info = V.discoverFields(cap.state, proto);
console.log('fields:', info.fields, 'PC slot:', info.PC);
console.log('opcodes:', info.opcodes.length);
console.log('bytecode len:', cap.state[info.fields.code].length);
console.log('pool len:', cap.state[info.fields.pool].length);
console.log('template:', JSON.stringify(cap.template));
console.log('rest args:', cap.rest.map(x => typeof x === 'object' ? JSON.stringify(x) : x));
