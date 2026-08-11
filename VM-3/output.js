window._ttwl6apnfd = function () {
  var a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q;
  h = function (r, s) {
    var t, u, v, w, x, y, z, aa, ab, ac, ad, ae, af, ag;
    if (!g) {
      return void 0;
    } else {
      t = s;
      v = 0;
      x = r.length;
      if ((~~((v | 0 | ~x) + (v & ~x) - ((v | 0) + ~x - ((v | 0) & ~x))) | (~((v ^ x) - 1) - 1 ^ 0) & (v - x ^ 0)) >>> 31) {
        ad = ~~(t + -1640531527);
        ae = 0;
        t = ad | ae;
        af = ~~(t ^ t >>> 13);
        ag = 65535;
        w = af & ag;
        y = String;
        z = y["fromCharCode"];
        ab = ~~r.charCodeAt(v);
        ac = ~~w;
        u = "" + Reflect.apply(z, y, [ab ^ ac]);
        aa = 1 + v;
        L2: while (true) {
          v = ~~((v ^ aa - v | v & 1) + ((v | 0 | 1) - (v ^ 1)));
          x = r.length;
          if (!((~~((v | 0 | ~x) + (v & ~x) - ((v | 0) + ~x - ((v | 0) & ~x))) | (~((v ^ x) - 1) - 1 ^ 0) & (v - x ^ 0)) >>> 31)) {
            break L2;
          }
          ad = ~~(t + -1640531527);
          ae = 0;
          t = ad | ae;
          af = ~~(t ^ t >>> 13);
          ag = 65535;
          w = af & ag;
          y = String;
          z = y["fromCharCode"];
          ab = ~~r.charCodeAt(v);
          ac = ~~w;
          u = u + Reflect.apply(z, y, [ab ^ ac]);
          aa = 1 + v;
        }
        return u;
      } else {
        return "";
      }
    }
  };
  k = document;
  a = k.createElement("div");
  a.style.width = "calc(100px + 20px * 2)";
  l = document.body;
  l.appendChild(a);
  b = a.offsetWidth;
  m = Date;
  c = m.now();
  n = Math;
  o = n.floor;
  p = Math;
  d = Reflect.apply(o, n, [p.random() * 1000000]);
  e = (c + d + b) % 89;
  f = (d + 1500) % 83;
  q = c + "|" + d + "|";
  g = q + (c - 10000 + d * 5) % 97 + "|" + e + "|" + f;
  i = console;
  j = i.log;
  Reflect.apply(j, i, [g, h(g, b + d)]);
  return void 0;
};
