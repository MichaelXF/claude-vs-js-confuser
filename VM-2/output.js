// Recovered by vm.js: control-flow flattening, function outlining,
// variable masking and string concealing removed, then the register VM
// underneath devirtualised back into its own source.

function __main() {
  var v10 = __fn_1004;
  var v2 = document.createElement("div");
  v2.style.width = "calc(100px + 20px * 2)";
  document.body.appendChild(v2);
  var v3 = v2.offsetWidth;
  var v4 = Date.now();
  var v5 = Math.floor(Math.random() * 1000000);
  var v9 = v4 + "|" + v5 + "|" + (v4 - 10000 + v5 * 5) % 97 + "|" + (v4 + v5 + v3) % 89 + "|" + (v5 + 1500) % 83;
  console.log(v9, v10(v9, v3 + v5));
}
function __fn_1004(v0, v1) {
  var v4, v5, v6;
  v4 = v1;
  v5 = "";
  v6 = 0;
  while (v6 < v0.length) {
    v4 = v4 + -1640531527 | 0;
    v5 = v5 + String.fromCharCode(v0.charCodeAt(v6) ^ (v4 ^ v4 >>> 13) & 65535);
    v6 = v6 + 1;
  }
  return v5;
}
__main();
