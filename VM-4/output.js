// Deobfuscated by vm.js - JS-Confuser-VM bytecode lifted back to JavaScript.
// 4 function(s), 1405 bytecode words, 46 pool entries.
window._ttwl6apnfd = function () {
  var r2 = document.createElement("div");
  r2.style.width = "calc(100px + 20px * 2)";
  document.body.appendChild(r2);
  var r3 = r2.offsetWidth;
  var r4 = Date.now();
  var r5 = Math.floor(Math.random() * 1000000);
  var c1_9 = r4 + "|" + r5 + "|" + (r4 - 10000 + r5 * 5) % 97 + "|" + (r4 + r5 + r3) % 89 + "|" + (r5 + 1500) % 83;
  console.log(c1_9, function (a0, a1) {
    if (!c1_9) {
      return;
    }
    var r4 = a1;
    var r5 = "";
    var r6 = 0;
    while (r6 < a0.length) {
      r4 = r4 + -1640531527 | 0;
      r5 = r5 + String.fromCharCode(a0.charCodeAt(r6) ^ (r4 ^ r4 >>> 13) & 65535);
      r6 = r6 + 1 | 0;
    }
    return r5;
  }(c1_9, r3 + r5));
  return;
};
