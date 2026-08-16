// Check: how many r("<literal>") calls exist in input.js (for AST extraction design)
const s = require('fs').readFileSync('../input.js', 'utf8');
const re = /r\("([A-Za-z0-9+/=]+)"\)/g;
let m;
while ((m = re.exec(s))) console.log('r() literal call at', m.index, 'len', m[1].length);
// also check packages
for (const p of ['@babel/parser', '@babel/traverse', '@babel/generator', '@babel/types']) {
  try { require.resolve(p); console.log(p, 'OK'); } catch (e) { console.log(p, 'MISSING'); }
}
