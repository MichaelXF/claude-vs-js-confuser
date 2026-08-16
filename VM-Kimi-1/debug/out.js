var t2 = false;
window["_k1crlxlk2w8"] = function () {
  var mt0, m3, m4, m5, m9, m2;
  mt0 = function (a0, a1) {
    var i4, i5, i6, i8, it0, i17;
    if (m9) {
      i4 = a1;
      i5 = "";
      i6 = 0;
      while (i6 < a0["length"]) {
        i8 = i4 + -1640531527;
        i4 = i8 | 0;
        it0 = a0["charCodeAt"](i6);
        i5 = i5 + String["fromCharCode"](it0 ^ (i4 ^ i4 >>> 13) & 65535);
        i17 = i6 + 1;
        i6 = i17;
      }
      return i5;
    } else {
      return undefined;
    }
  };
  if (t2) {
    return undefined;
  } else {
    t2 = true;
    m2 = document["createElement"]("div");
    m2["style"]["width"] = "calc(100px + 20px * 2)";
    document["body"]["appendChild"](m2);
    m3 = m2["offsetWidth"];
    m4 = Date["now"]();
    m5 = Math["floor"](Math["random"]() * 1000000);
    m9 = m4 + "|" + m5 + "|" + (m4 - 10000 + m5 * 5) % 97 + "|" + (m4 - m3 + m5) % 89 + "|" + (m5 + 1500) % 83;
    console["log"](m9, mt0(m9, m3 + m5));
    return undefined;
  }
};