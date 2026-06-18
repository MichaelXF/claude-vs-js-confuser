(function () {
  var r2, r3, r4, r6, r7, r8, r10, r12, r15, r17;
  r15 = function (r0) {
    var r3, r4, r5, r6;
    r3 = (r0 | 0) ^ 2654435769;
    r4 = 608135816 | 0;
    r5 = 1779033703 | 0;
    r6 = 0;
    while (r6 < 19) {
      r3 = r3 + (r4 << 7 ^ r4 >>> 3) + r5 | 0;
      r3 = r3 ^ r3 >>> 15 | 0;
      r3 = r3 + (r3 << 11) | 0;
      r4 = r4 ^ (r3 << 4) + (r3 >>> 9) + r5 | 0;
      r4 = r4 + (r4 << 6) | 0;
      r4 = r4 ^ r4 >>> 13 | 0;
      r5 = r5 + 2135587861 | 0;
      r6 = r6 + 1;
    }
    r3 = r3 ^ r4 | 0;
    r3 = r3 + (r3 << 3) | 0;
    r3 = r3 ^ r3 >>> 11 | 0;
    r4 = r4 ^ r4 >>> 13 | 0;
    r4 = r4 + (r4 << 7) | 0;
    return ((r3 + (r3 << 15) | 0) >>> 0) * 1048576 + ((r4 ^ r4 >>> 17 | 0) >>> 12);
  };
  r2 = r15;
  r3 = Date.now();
  r17 = Math.floor;
  r4 = r17.apply(Math, [Math.random() * 1000000]);
  r6 = r3 + "|" + r4 + "|" + r2(r3 - 10000 + r4 * 5);
  r15 = typeof window !== "undefined";
  if (r15) {
    r15 = typeof document !== "undefined";
  }
  r7 = r15;
  r8 = typeof process !== "undefined";
  try {
    r12 = document.createElement("div");
    r12.style.width = "calc(100px + 20px * 2)";
    r17 = document.body;
    r17.appendChild(r12);
    r10 = r12.offsetWidth;
  } catch (r11) {}
  console.log({
    b: r7,
    n: r8,
    bu: r7,
    dw: r10,
    k: r6
  });
  return undefined;
})();