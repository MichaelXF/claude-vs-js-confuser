// Extracts the encoded bytecode and constants pool from input.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../input.js', 'utf8');

// Extract the base64 payload (first big base64 string passed to r(...))
const m = src.match(/r\("([A-Za-z0-9+/=]+)"\)/);
const buf = Buffer.from(m[1], 'base64');
console.log('bytecode bytes:', buf.length, 'words:', buf.length / 4);

// Convert to Uint32Array like the VM does
const E = new Uint32Array(buf.length / 4);
for (let F = 0; F < E.length; F++) {
  E[F] = (buf[F * 4] | buf[F * 4 + 1] << 8 | buf[F * 4 + 2] << 16 | buf[F * 4 + 3] << 24) >>> 0;
}
fs.writeFileSync(__dirname + '/bytecode.json', JSON.stringify(Array.from(E)));
console.log('first 64 words:', Array.from(E.slice(0, 64)).join(','));
