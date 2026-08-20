var c1_0;
c1_0 = false;
window._k1crlxlk2w8 = function () {
  var c2_0, v10, v2, v3, v4, v5, v35, v36;
  v10 = function (p0, p1) {
    var v4, v5, v6;
    if (!c2_0) {
      return;
    }
    v4 = p1;
    v5 = "";
    v6 = 0;
    while (v6 < p0.length) {
      v4 = v4 + -1640531527 | 0;
      v5 = v5 + String.fromCharCode(p0.charCodeAt(v6) ^ (v4 ^ v4 >>> 13) & 65535);
      v6 = v6 + 1;
    }
    return v5;
  };
  if (!c1_0) {
    c1_0 = true;
    v2 = document.createElement("div");
    v2.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(v2);
    v3 = v2.offsetWidth;
    v4 = Date.now();
    v5 = Math.floor(Math.random() * 10000000);
    c2_0 = v4 + "|" + v5 + "|" + (v4 - 10000 + v3 + v5 * 5) % 97 + "|" + (v4 + v5) % 89 + "|" + (v5 + 1500) % 83;
    v35 = v10(c2_0, 5 + v3 + v5);
    v36 = v10("CLAUDE OPUS 5", v3);
    console.log(c2_0, v35, v36);
  }
};