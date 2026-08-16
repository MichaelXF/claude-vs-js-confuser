// Implement the dispatcher hash and probe next-ips for known blocks.
function rotl7(x) {
  x = x >>> 0;
  return ((x << 7) | (x >>> 25)) >>> 0;
}
function u(x) { return x >>> 0; }

// f(A, B): B is the "state" (r143), A is r144
function dispatch(A, B) {
  let b1 = u(~B);
  let b2 = rotl7(b1);
  let b3 = u(b2 + 371738263);
  let b4 = u(b3 ^ A);
  let b5 = u(b4 ^ (b4 >>> 26));
  let b6 = u(~b5);
  let b7 = Math.imul(b6, -2010834351);
  return b7 | 0; // ip as signed int
}

// From the sweep: block 36 (entry): A=-678747472, cond true -> B=-389244826
console.log('entry block ->', dispatch(-678747472, -389244826));
// block 99: A=363217158, cond false -> B=-1554462678 ; true -> B=1951410499
console.log('block 99 false ->', dispatch(363217158, -1554462678));
console.log('block 99 true  ->', dispatch(363217158, 1951410499));
// block 139: unconditional A=1832632674, B=1658660888
console.log('block 139 ->', dispatch(1832632674, 1658660888));
// block 147: cond block. A=1410612840; true -> -94128059, false -> -882757792
console.log('block 147 true ->', dispatch(1410612840, -94128059));
console.log('block 147 false ->', dispatch(1410612840, -882757792));
