var bh = false;
window._k1crlxlk2w8 = function () {
  var bm, ce, bz, ca, s, bg, bq;
  var cp = function (x, w) {
    var aa, z, y, af;
    if (!s) {
      return;
    }
    aa = w;
    z = "";
    y = 0;
    while (y < x.length) {
      aa = aa - 1640531527 | 0;
      af = x.charCodeAt(y) | 0;
      z = z + String.fromCharCode(af);
      y = y + 1;
    }
    return z;
  };
  if (!bh) {
    bh = true;
    bm = document.createElement("div");
    bm.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(bm);
    ce = bm.offsetWidth;
    bz = Date.now();
    bg = Math.random();
    ca = Math.floor(bg * 1000000);
    s = bz + "|" + ca + "|" + +(bz - 10000 + ca * 5) + "|" + +(bz - ce + ca) + "|" + +(ca + 1500);
    bq = cp(s, ce + ca);
    console.log(s, bq);
  }
};
