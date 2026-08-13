var a2;
a2 = false;
window._ttwl6apnfd = function () {
  var b2, b3, b4, b5, b9, b10;
  b10 = function (d0, d1) {
    var d4, d5, d6;
    if (!b9) {
      return;
    } else {
      d4 = d1;
      d5 = "";
      d6 = 0;
      while (true) {
        if (d6 < d0.length) {
          d4 = d4 + -1640531527 | 0;
          d5 = d5 + String.fromCharCode(d0.charCodeAt(d6) ^ (d4 ^ d4 >>> 13) & 65535);
          d6 = d6 + 1 | 0;
          continue;
        } else {
          break;
        }
      }
      return d5;
    }
  };
  if (!a2) {
    a2 = true;
    b2 = document.createElement("div");
    b2.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(b2);
    b3 = b2.offsetWidth;
    b4 = Date.now();
    b5 = Math.floor(Math.random() * 1000000);
    b9 = b4 + "|" + b5 + "|" + (b4 - 10000 + b5 * 5) % 97 + "|" + (b4 + b5 + b3) % 89 + "|" + (b5 + 1500) % 83;
    console.log(b9, b10(b9, b3 + b5));
    return;
  } else {
    return;
  }
};
