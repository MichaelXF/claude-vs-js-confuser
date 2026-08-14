var a = false;
window._k1crlxlk2w8 = function () {
  var b,
    c,
    d,
    e,
    f,
    g = function (h, i) {
      var j, k, l;
      if (!!f) {
        j = i;
        k = "";
        l = 0;
        while (l < h.length) {
          j = j - 1640531527 | 0;
          k = k + String.fromCharCode(h.charCodeAt(l) ^ (j ^ j >>> 13) & 65535);
          l = l + 1;
        }
        return k;
      }
    };
  if (!a) {
    a = true;
    b = document.createElement("div");
    b.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(b);
    c = b.offsetWidth;
    d = Date.now();
    e = Math.floor(Math.random() * 1000000);
    f = d + "|" + e + "|" + (d - 10000 + e * 5) % 97 + "|" + (d - c + e) % 89 + "|" + (e + 1500) % 83;
    console.log(f, g(f, c + e));
  }
};
