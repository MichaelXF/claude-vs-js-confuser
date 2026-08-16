// Extract all opcode handlers and statically analyze operand-read patterns.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');

// Grab every B[NNNN]=function(){...} block with balanced braces
function extractHandlers(src) {
  const handlers = {};
  const re = /B\[(\d+)\]=function\(\)\{/g;
  let m;
  while ((m = re.exec(src))) {
    const opcode = m[1];
    let i = re.lastIndex, depth = 1;
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    handlers[opcode] = src.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
  }
  return handlers;
}

const handlers = extractHandlers(src);
console.log('handler count:', Object.keys(handlers).length);

const out = {};
for (const [op, body] of Object.entries(handlers)) {
  const vCalls = (body.match(/v\(this\)/g) || []).length;
  const aCalls = (body.match(/A\(this\)/g) || []).length;
  const hasLoop = /for\s*\(/.test(body);
  const hasMagic = body.includes('3247410626');
  out[op] = { vCalls, aCalls, hasLoop, hasMagic, body };
}

// Summary table (without bodies)
for (const [op, info] of Object.entries(out)) {
  console.log(
    `op=${op} vCalls=${info.vCalls} aCalls=${info.aCalls} loop=${info.hasLoop} magic=${info.hasMagic}`
  );
}
fs.writeFileSync(__dirname + '/handlers.json', JSON.stringify(out, null, 1));
