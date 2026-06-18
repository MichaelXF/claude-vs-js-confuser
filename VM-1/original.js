// original.js was provided AFTER solution was reached!

function hashFn(c) {
  var d = (c | 0) ^ 2654435769,
    e = 608135816 | 0,
    f = 1779033703 | 0;
  for (var g = 0; g < 19; g++) {
    d = (d + ((e << 7) ^ (e >>> 3)) + f) | 0;
    d = (d ^ (d >>> 15)) | 0;
    d = (d + (d << 11)) | 0;
    e = (e ^ ((d << 4) + (d >>> 9) + f)) | 0;
    e = (e + (e << 6)) | 0;
    e = (e ^ (e >>> 13)) | 0;
    f = (f + 2135587861) | 0;
  }
  d = (d ^ e) | 0;
  d = (d + (d << 3)) | 0;
  d = (d ^ (d >>> 11)) | 0;
  d = (d + (d << 15)) | 0;
  e = (e ^ (e >>> 13)) | 0;
  e = (e + (e << 7)) | 0;
  e = (e ^ (e >>> 17)) | 0;
  return (d >>> 0) * 1048576 + (e >>> 12);
}

// Compute anti-bot key
var ts = Date.now();
var salt = Math.floor(Math.random() * 1000000);
var modulo1 = hashFn(ts - 10000 + salt * 5);
var antibotKey = ts + "|" + salt + "|" + modulo1;

var isBrowser =
  typeof window !== "undefined" && typeof document !== "undefined";
var isNode = typeof process !== "undefined";
var isBun = typeof Bun !== "undefined";

var divWidth;
try {
  var div = document.createElement("div");
  div.style.width = "calc(100px + 20px * 2)";
  document.body.appendChild(div);
  var width = div.offsetWidth; // 100px + 20px*2 = 140px

  divWidth = width;
} catch (err) {}

var signals = {
  b: isBrowser,
  n: isNode,
  bu: isBrowser,
  dw: divWidth,
  k: antibotKey,
};

console.log(signals);
