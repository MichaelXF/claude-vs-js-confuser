// Pretty-print the trace: interleave ops with their operand reads and decoded strings
const ops = require('./trace_ops.json');
const reads = require('./trace_reads.json');
const strs = require('./trace_strs.json');
const words = require('./bytecode.json');

// opcode -> handler source (extracted manually from input.js for reference)
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');
const handlerSrc = {};
const re = /B\[(\d+)\]=function\(\)\{(.*?)\};?B\[/gs;
// simpler: split on 'B['
const parts = src.split(/B\[(\d+)\]=/);
for (let i = 1; i < parts.length; i += 2) {
  const code = parts[i];
  let body = parts[i + 1];
  // body runs until next 'B[' was split point already; trim trailing 'var C=' etc
  handlerSrc[code] = body.slice(0, 200);
}

let ri = 0, si = 0;
for (let i = 0; i < ops.length; i++) {
  const [frame, ip, opcode] = ops[i];
  // reads that belong to this op: those with ip > opcode ip until next op ip
  const nextIp = i + 1 < ops.length ? ops[i + 1][1] : 1e9;
  const myReads = [];
  while (ri < reads.length && reads[ri][1] < nextIp && reads[ri][1] > ip) {
    myReads.push(reads[ri][1] + '=' + reads[ri][2]);
    ri++;
  }
  const myStrs = [];
  while (si < strs.length && strs[si][1] >= ip && strs[si][1] < nextIp) {
    myStrs.push(JSON.stringify(strs[si][2]));
    si++;
  }
  console.log(
    `#${i} frame=${frame} ip=${ip} op=${opcode} operands=[${myReads.join(',')}] strs=[${myStrs.join(',')}]`
  );
  const hs = handlerSrc[String(opcode)];
  if (hs) console.log('    handler: ' + hs.slice(0, 160));
}
