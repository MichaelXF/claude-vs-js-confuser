(function () {
  var R = [];
  var A = Array.prototype.slice.call(arguments);
  for (var w = 0; w < A.length && w < 21; w++) R[w] = A[w];
  R[0] = A;
  var H = [];
  var pc = 0;
  while (true) {
    try {
      switch (pc) {
        case 0:
          R[1] = undefined;
          R[15] = function () {
            var R = [];
            var A = Array.prototype.slice.call(arguments);
            for (var w = 0; w < A.length && w < 10; w++) R[w] = A[w];
            R[1] = A;
            var pc = 354;
            while (true) {
              switch (pc) {
                case 354:
                  R[2] = this;
                  R[7] = 0;
                  R[8] = R[0] | R[7];
                  R[7] = 2654435769;
                  R[9] = R[8] ^ R[7];
                  R[3] = R[9];
                  R[7] = 608135816;
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[4] = R[9];
                  R[7] = 1779033703;
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[5] = R[9];
                  R[7] = 0;
                  R[6] = R[7];
                  pc = 412;
                  break;
                case 412:
                  R[7] = 19;
                  R[8] = R[6] < R[7];
                  pc = R[8] ? 423 : 628;
                  break;
                case 423:
                  R[7] = 7;
                  R[8] = R[4] << R[7];
                  R[7] = 3;
                  R[9] = R[4] >>> R[7];
                  R[7] = R[8] ^ R[9];
                  R[8] = R[3] + R[7];
                  R[7] = R[8] + R[5];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[3] = R[9];
                  R[7] = 15;
                  R[8] = R[3] >>> R[7];
                  R[7] = R[3] ^ R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[3] = R[9];
                  R[7] = 11;
                  R[8] = R[3] << R[7];
                  R[7] = R[3] + R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[3] = R[9];
                  R[7] = 4;
                  R[8] = R[3] << R[7];
                  R[7] = 9;
                  R[9] = R[3] >>> R[7];
                  R[7] = R[8] + R[9];
                  R[8] = R[7] + R[5];
                  R[7] = R[4] ^ R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[4] = R[9];
                  R[7] = 6;
                  R[8] = R[4] << R[7];
                  R[7] = R[4] + R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[4] = R[9];
                  R[7] = 13;
                  R[8] = R[4] >>> R[7];
                  R[7] = R[4] ^ R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[4] = R[9];
                  R[7] = 2135587861;
                  R[8] = R[5] + R[7];
                  R[7] = 0;
                  R[9] = R[8] | R[7];
                  R[5] = R[9];
                  R[7] = R[6];
                  R[7] = 1;
                  R[8] = R[6] + R[7];
                  R[6] = R[8];
                  pc = 412;
                  break;
                case 628:
                  R[7] = R[3] ^ R[4];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[3] = R[9];
                  R[7] = 3;
                  R[8] = R[3] << R[7];
                  R[7] = R[3] + R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[3] = R[9];
                  R[7] = 11;
                  R[8] = R[3] >>> R[7];
                  R[7] = R[3] ^ R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[3] = R[9];
                  R[7] = 15;
                  R[8] = R[3] << R[7];
                  R[7] = R[3] + R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[3] = R[9];
                  R[7] = 13;
                  R[8] = R[4] >>> R[7];
                  R[7] = R[4] ^ R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[4] = R[9];
                  R[7] = 7;
                  R[8] = R[4] << R[7];
                  R[7] = R[4] + R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[4] = R[9];
                  R[7] = 17;
                  R[8] = R[4] >>> R[7];
                  R[7] = R[4] ^ R[8];
                  R[8] = 0;
                  R[9] = R[7] | R[8];
                  R[4] = R[9];
                  R[7] = 0;
                  R[8] = R[3] >>> R[7];
                  R[7] = 1048576;
                  R[9] = R[8] * R[7];
                  R[7] = 12;
                  R[8] = R[4] >>> R[7];
                  R[7] = R[9] + R[8];
                  return R[7];
              }
            }
          };
          R[2] = R[15];
          R[15] = Date;
          R[16] = "now";
          R[17] = R[15][R[16]];
          R[16] = R[17].apply(R[15], []);
          R[3] = R[16];
          R[15] = Math;
          R[16] = "floor";
          R[17] = R[15][R[16]];
          R[16] = Math;
          R[18] = "random";
          R[19] = R[16][R[18]];
          R[18] = R[19].apply(R[16], []);
          R[16] = 1000000;
          R[19] = R[18] * R[16];
          R[16] = R[17].apply(R[15], [R[19]]);
          R[4] = R[16];
          R[15] = 10000;
          R[16] = R[3] - R[15];
          R[15] = 5;
          R[17] = R[4] * R[15];
          R[15] = R[16] + R[17];
          R[16] = R[2](R[15]);
          R[5] = R[16];
          R[15] = "|";
          R[16] = R[3] + R[15];
          R[15] = R[16] + R[4];
          R[16] = "|";
          R[17] = R[15] + R[16];
          R[15] = R[17] + R[5];
          R[6] = R[15];
          R[15] = typeof window;
          R[16] = "undefined";
          R[17] = R[15] !== R[16];
          R[15] = R[17];
          pc = R[15] ? 151 : 166;
          break;
        case 151:
          R[16] = typeof document;
          R[17] = "undefined";
          R[18] = R[16] !== R[17];
          R[15] = R[18];
          pc = 166;
          break;
        case 166:
          R[7] = R[15];
          R[15] = typeof process;
          R[16] = "undefined";
          R[17] = R[15] !== R[16];
          R[8] = R[17];
          R[15] = typeof Bun;
          R[16] = "undefined";
          R[17] = R[15] !== R[16];
          R[9] = R[17];
          R[10] = undefined;
          H.push({
            kind: 'catch',
            pc: 294,
            reg: 11
          });
          pc = 206;
          break;
        case 206:
          R[15] = document;
          R[16] = "createElement";
          R[17] = R[15][R[16]];
          R[16] = "div";
          R[18] = R[17].apply(R[15], [R[16]]);
          R[12] = R[18];
          R[15] = "style";
          R[16] = R[12][R[15]];
          R[15] = "width";
          R[17] = "calc(100px + 20px * 2)";
          R[16][R[15]] = R[17];
          R[15] = document;
          R[16] = "body";
          R[17] = R[15][R[16]];
          R[15] = "appendChild";
          R[16] = R[17][R[15]];
          R[15] = R[16].apply(R[17], [R[12]]);
          R[15] = "offsetWidth";
          R[16] = R[12][R[15]];
          R[13] = R[16];
          R[10] = R[13];
          pc = 291;
          break;
        case 291:
          H.pop();
          pc = 292;
          break;
        case 292:
          pc = 294;
          break;
        case 294:
          R[15] = "b";
          R[16] = "n";
          R[17] = "bu";
          R[18] = "dw";
          R[19] = "k";
          R[20] = {
            [R[15]]: R[7],
            [R[16]]: R[8],
            [R[17]]: R[7],
            [R[18]]: R[10],
            [R[19]]: R[6]
          };
          R[14] = R[20];
          R[15] = console;
          R[16] = "log";
          R[17] = R[15][R[16]];
          R[16] = R[17].apply(R[15], [R[14]]);
          R[15] = undefined;
          return R[15];
      }
    } catch (e) {
      if (!H.length) throw e;
      var hd = H.pop();
      if (hd.kind === 'catch') {
        R[hd.reg] = e;
        pc = hd.pc;
      } else {
        R[hd.regV] = hd.marker;
        R[hd.regZ] = e;
        pc = hd.pc;
      }
    }
  }
})();