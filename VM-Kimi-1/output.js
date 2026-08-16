var g2 = false;
window["_k1crlxlk2w8"] = function () {
  var a2, a3, a4, a5, a9, a10;
  a10 = function (arg0, arg1) {
    var bt0, b4, b5, b6, b8, b17;
    if (a9) {
      b4 = arg1;
      b5 = "";
      b6 = 0;
      while (b6 < arg0["length"]) {
        b8 = b4 + -1640531527;
        b4 = b8 | 0;
        bt0 = arg0["charCodeAt"](b6);
        b5 = b5 + String["fromCharCode"](bt0 ^ (b4 ^ b4 >>> 13) & 65535);
        b17 = b6 + 1;
        b6 = b17;
      }
      return b5;
    } else {
      return undefined;
    }
  };
  if (g2) {
    return undefined;
  } else {
    g2 = true;
    a2 = document["createElement"]("div");
    a2["style"]["width"] = "calc(100px + 20px * 2)";
    document["body"]["appendChild"](a2);
    a3 = a2["offsetWidth"];
    a4 = Date["now"]();
    a5 = Math["floor"](Math["random"]() * 1000000);
    a9 = a4 + "|" + a5 + "|" + (a4 - 10000 + a5 * 5) % 97 + "|" + (a4 - a3 + a5) % 89 + "|" + (a5 + 1500) % 83;
    console["log"](a9, a10(a9, a3 + a5));
    return undefined;
  }
};
