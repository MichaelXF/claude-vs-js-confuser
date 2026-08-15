// Checks the hypothesis that a function's key is the modular inverse feeding the
// MBA junk terms (imul(derived, C) === 1).
function derive(key) {
  const t = Math.imul(key - -1204453510 | 0, -1046618859) | 0;
  return ((t << 6 | t >>> 26) | 0) - 1749065783 | 0;
}
const keys = { top: -2087645402, f37: -616178882, f2830: 213679400, f1758: 733337458, f2980: -1887413072 };
for (const [name, k] of Object.entries(keys)) {
  const d = derive(k);
  // op 39401 uses: b = imul(d, 268556821) ^ 462165301 | 1 ; then imul(imul(x,b), 47908741)
  const b = (Math.imul(d, 268556821) ^ 462165301 | 1) | 0;
  console.log(name, "derived=", d, "b=", b, "imul(b,47908741)=", Math.imul(b, 47908741));
}
