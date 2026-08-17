var r0_2 = false;
globalThis.window._k1crlxlk2w8 = function lifted_32() {
  var r32_2,
    r32_3,
    r32_4,
    r32_5,
    r32_9,
    r32_11,
    r32_20,
    r32_23,
    r32_25,
    r32_26,
    r32_27,
    r32_44,
    r32_154_v1 = function lifted_5542(argument_0, argument_1) {
      var r5542_0 = argument_0,
        r5542_4,
        r5542_5,
        r5542_6,
        r5542_7,
        r5542_13,
        r5542_14,
        r5542_86,
        r5542_87;
      r5542_86 = r32_9;
      r5542_87 = !r5542_86;
      r5542_4 = argument_1;
      r5542_5 = "";
      r5542_86 = 0;
      r5542_6 = r5542_86;
      while (r5542_6 < r5542_0.length) {
        r5542_4 = r5542_4 - 1640531527 | 0;
        r5542_86 = (r5542_4 ^ r5542_4 >>> 13) & 65535;
        r5542_7 = r5542_86;
        r5542_13 = globalThis.String;
        r5542_86 = "fromCharCode";
        r5542_14 = r5542_13[r5542_86];
        r5542_86 = r5542_0.charCodeAt;
        r5542_87 = r5542_86.apply(r5542_0, [r5542_6]);
        r5542_86 = r5542_14.apply(r5542_13, [r5542_87 ^ r5542_7]);
        r5542_87 = r5542_5 + r5542_86;
        r5542_5 = r5542_87;
        r5542_86 = 1;
        r5542_6 = r5542_6 + r5542_86;
      }
      return r5542_5;
    };
  if (r0_2) {
    return;
  }
  r0_2 = true;
  r32_11 = globalThis.document;
  r32_2 = r32_11.createElement.apply(r32_11, ["div"]);
  r32_2.style.width = "calc(100px + 20px * 2)";
  r32_20 = globalThis.document.body;
  r32_20.appendChild.apply(r32_20, [r32_2]);
  r32_3 = r32_2.offsetWidth;
  r32_23 = globalThis.Date;
  r32_4 = r32_23.now.apply(r32_23, []);
  r32_25 = globalThis.Math;
  r32_26 = r32_25.floor;
  r32_27 = globalThis.Math;
  r32_5 = r32_26.apply(r32_25, [r32_27.random.apply(r32_27, []) * 1000000]);
  r32_9 = r32_4 + "|" + r32_5 + "|" + (r32_4 - 10000 + r32_5 * 5) % 97 + "|" + (r32_4 - r32_3 + r32_5) % 89 + "|" + (r32_5 + 1500) % 83;
  r32_44 = globalThis.console;
  r32_44.log.apply(r32_44, [r32_9, r32_154_v1.apply(null, [r32_9, r32_3 + r32_5])]);
  return;
};
