var t2 = false;
window["_k1crlxlk2w8"] = function () {
  var mt0, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, mt1, m2, m14, m15, m16, m17, m18, m19, m20, m21, mt2, m22, m23, m24, mt3, m25, m26, m27, m28, mt4, m29, mt5, m30, m31, m32, m33, m34, m35, m36, m37, m38, m39, m40, m41, m42, m43, m44, m45, mt6, mt7;
  mt0 = function (a0, a1) {
    var i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15, it0, i16, it1, i17;
    if (m9) {
      i4 = a1;
      i5 = "";
      i6 = 0;
      while (i6 < a0["length"]) {
        i8 = i4 + -1640531527;
        i4 = i8 | 0;
        i10 = 13;
        i11 = i4 ^ i4 >>> i10;
        i12 = 65535;
        i7 = i11 & i12;
        i13 = String;
        i14 = i13["fromCharCode"];
        i15 = "charCodeAt";
        it0 = a0[i15](i6);
        i16 = it0 ^ i7;
        it1 = i14.call(i13, i16);
        i5 = i5 + it1;
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
    m11 = document;
    m13 = "div";
    mt1 = m11["createElement"](m13);
    m2 = mt1;
    m14 = "style";
    m15 = m2[m14];
    m16 = "width";
    m17 = "calc(100px + 20px * 2)";
    m15[m16] = m17;
    m18 = document;
    m19 = "body";
    m20 = m18[m19];
    m21 = m20["appendChild"];
    mt2 = m21.call(m20, m2);
    m22 = m2["offsetWidth"];
    m3 = m22;
    m23 = Date;
    m24 = "now";
    mt3 = m23[m24]();
    m4 = mt3;
    m25 = Math;
    m26 = m25["floor"];
    m27 = Math;
    m28 = m27["random"];
    mt4 = m28.call(m27);
    m29 = mt4 * 1000000;
    mt5 = m26.call(m25, m29);
    m5 = mt5;
    m30 = 10000;
    m31 = m4 - m30;
    m32 = m5 * 5;
    m33 = (m31 + m32) % 97;
    m6 = m33;
    m34 = m4 - m3 + m5;
    m7 = m34 % 89;
    m35 = m5 + 1500;
    m36 = 83;
    m8 = m35 % m36;
    m37 = "|";
    m38 = m4 + m37 + m5;
    m39 = "|";
    m40 = m38 + m39 + m6;
    m41 = "|";
    m42 = m40 + m41 + m7;
    m43 = "|";
    m9 = m42 + m43 + m8;
    m44 = console;
    m45 = m44["log"];
    mt6 = mt0(m9, m3 + m5);
    mt7 = m45.call(m44, m9, mt6);
    return undefined;
  }
};