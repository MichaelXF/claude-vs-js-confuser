var c0_0 = false;
window._k1crlxlk2w8 = function () {
  var v0, v1, v2, v3, c1_0, v5, v6;
  var v4 = function (p0, p1) {
    var v7, v8, v9, v10;
    if (!c1_0) {
      return;
    }
    v7 = p1;
    v8 = "";
    v9 = 0;
    while (v9 < p0.length) {
      v7 = v7 - 1640531527 | 0;
      v10 = p0.charCodeAt(v9) ^ (v7 ^ v7 >>> 13) & 65535;
      v8 = v8 + String.fromCharCode(v10);
      v9 = v9 + 1;
    }
    return v8;
  };
  if (!c0_0) {
    c0_0 = true;
    v0 = document.createElement("div");
    v0.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(v0);
    v1 = v0.offsetWidth;
    v2 = Date.now();
    v5 = Math.random();
    v3 = Math.floor(v5 * 1000000);
    c1_0 = v2 + "|" + v3 + "|" + (v2 - 10000 + v3 * 5) % 97 + "|" + (v2 - v1 + v3) % 89 + "|" + (v3 + 1500) % 83;
    v6 = v4(c1_0, v1 + v3);
    console.log(c1_0, v6);
  }
};
