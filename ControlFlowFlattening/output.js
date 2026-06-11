var o_e, o_f, o_g, o_i, o_j, o_k, o_l, o_m, o_n, x_a;
function f_main() {
  o_e = document.getElementById("myCanvas");
  o_f = o_e.getContext("2d");
  o_f.font = "bold 30px sans-serif";
  o_g = undefined;
  o_i = undefined;
  o_j = undefined;
  o_k = 5;
  o_l = 50;
  o_m = [];
  o_m[0] = {
    x: 300,
    y: 300,
    width: 200
  };
  o_n = {
    x: 0,
    width: 0
  };
  o_e.onpointerdown = function () {
    if (o_i == "gameOver") {
      f_5();
    } else {
      if (o_i == "bounce") {
        o_i = "fall";
      }
    }
  };
  f_5();
  return f_2();
}
function f_2() {
  if (o_i != "gameOver") {
    o_f.fillStyle = "lightblue";
    o_f.fillRect(0, 0, o_e.width, o_e.height);
    o_f.fillStyle = "black";
    o_f.fillText("Score: " + (current - 1).toString(), 100, 200);
    for (let W = 0; W < o_m.length; W++) {
      let X = o_m[W];
      o_f.fillStyle = "rgb(" + W * 16 + "," + W * 16 + "," + W * 16 + ")";
      o_f.fillRect(X.x, 600 - X.y + cameraY, X.width, o_l);
    }
    o_f.fillStyle = "red";
    o_f.fillRect(o_n.x, 600 - o_n.y + cameraY, o_n.width, o_l);
    if (o_i == "bounce") {
      o_m[current].x = o_m[current].x + o_j;
      if (o_j > 0 && o_m[current].x + o_m[current].width > o_e.width) {
        o_j = -o_j;
      }
      if (o_j < 0 && o_m[current].x < 0) {
        o_j = -o_j;
      }
    }
    if (o_i == "fall") {
      o_m[current].y = o_m[current].y - o_k;
      if (o_m[current].y == o_m[current - 1].y + o_l) {
        o_i = "bounce";
        x_a = o_m[current].x - o_m[current - 1].x;
        if (Math.abs(x_a) >= o_m[current].width) {
          f_3();
        }
        o_n = {
          y: o_m[current].y,
          width: x_a
        };
        if (o_m[current].x > o_m[current - 1].x) {
          o_m[current].width = o_m[current].width - x_a;
          o_n.x = o_m[current].x + o_m[current].width;
        } else {
          o_n.x = o_m[current].x - x_a;
          o_m[current].width = o_m[current].width + x_a;
          o_m[current].x = o_m[current - 1].x;
        }
        if (o_j > 0) {
          o_j++;
        } else {
          o_j--;
        }
        current++;
        o_g = o_l;
        f_4();
      }
    }
    o_n.y = o_n.y - o_k;
    if (o_g) {
      cameraY++;
      o_g--;
    }
  }
  window.requestAnimationFrame(f_2);
}
function f_3() {
  o_i = "gameOver";
  o_f.fillText("Game over. Click to play again!", 50, 50);
}
function f_4() {
  o_m[current] = {
    x: 0,
    y: (current + 10) * o_l,
    width: o_m[current - 1].width
  };
}
function f_5() {
  o_m.splice(1, o_m.length - 1);
  o_i = "bounce";
  cameraY = 0;
  o_g = 0;
  o_j = 2;
  current = 1;
  f_4();
  o_n.y = 0;
}
f_main();