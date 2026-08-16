"use strict";

const r = require("readline");
if (!process.stdin.isTTY) {
  console.error("This game needs an interactive terminal.");
  process.exit(1);
}
r.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
const s = {
  clear: "\x1B[2J",
  home: "\x1B[H",
  hideCursor: "\x1B[?25l",
  showCursor: "\x1B[?25h",
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m"
};
const t = 30;
const u = 1000 / t;
const v = 15;
const w = 55;
const x = 90;
const y = ["   __ ", "  /oo\\", " /|__/ ", "  /  \\"];
const z = ["   __ ", "  /oo\\", " /|__/ ", "  \\  /"];
const A = ["   __    ", "__/oo\\__", "\\_______"];
const B = ["  |  ", " \\|/ ", "  |  ", " / \\ "];
const C = ["  | | ", " \\| |/", "  | | ", " /   \\"];
const D = [" __ ", "<__>", " /\\ "];
let E;
let F;
let G;
let H;
let I;
let J = 0;
let K;
let L;
let M;
let N;
let O;
let P;
let Q;
function R() {
  return Math.max(w, Math.min(x, process.stdout.columns || 80));
}
function S() {
  E = R();
  F = v - 3;
  G = {
    x: 7,
    y: F - y.length,
    vy: 0,
    jumping: false,
    ducking: false
  };
  H = [];
  I = 0;
  K = 0.75;
  L = 35;
  M = 0;
  N = false;
  O = false;
  P = 0;
  Q = Date.now();
}
function T() {
  process.stdout.write(s.showCursor + s.reset + "\n");
  try {
    process.stdin.setRawMode(false);
  } catch {}
  process.exit(0);
}
process.on("SIGINT", T);
process.on("exit", () => {
  process.stdout.write(s.showCursor + s.reset);
});
process.stdin.on("keypress", (a, b) => {
  if (!b) {
    return;
  }
  if (b.ctrl && b.name === "c") {
    T();
  }
  const c = b.name;
  if (c === "q" || c === "escape") {
    T();
  }
  if (c === "p") {
    if (!N) {
      O = !O;
    }
    return;
  }
  if (c === "r") {
    S();
    return;
  }
  if (N) {
    return;
  }
  if (c === "space" || c === "up" || c === "w") {
    U();
  }
  if (c === "down" || c === "s") {
    V();
  }
});
function U() {
  if (G.jumping || G.ducking) {
    return;
  }
  G.vy = -1.5;
  G.jumping = true;
}
function V() {
  if (G.jumping) {
    return;
  }
  G.ducking = true;
  P = Date.now() + 450;
}
function W() {
  if (G.ducking) {
    return A;
  }
  return Math.floor(M / 8) % 2 === 0 ? y : z;
}
function X(b, c) {
  return Math.floor(Math.random() * (c - b + 1)) + b;
}
function Y() {
  const b = Math.random();
  let c;
  let d;
  if (I > 250 && b < 0.28) {
    c = D;
    d = F - X(7, 9);
  } else {
    if (b < 0.62) {
      c = B;
      d = F - B.length;
    } else {
      c = C;
      d = F - C.length;
    }
  }
  H.push({
    x: E + 5,
    y: d,
    sprite: c
  });
}
function Z() {
  if (O || N) {
    return;
  }
  M++;
  I += 1;
  J = Math.max(J, I);
  K = 0.75 + Math.min(1.7, I / 900);
  if (G.ducking && Date.now() > P) {
    G.ducking = false;
  }
  if (G.jumping) {
    G.y += G.vy;
    G.vy += 0.105;
    const b = W();
    const c = F - b.length;
    if (G.y >= c) {
      G.y = c;
      G.vy = 0;
      G.jumping = false;
    }
  }
  for (const d of H) {
    d.x -= K;
  }
  H = H.filter(b => {
    return b.x + aa(b.sprite) > 0;
  });
  L -= K;
  if (L <= 0) {
    Y();
    L = X(38, 68) - Math.min(18, Math.floor(I / 250));
  }
  if (ac()) {
    N = true;
  }
}
function aa(b) {
  return Math.max(...b.map(a => {
    return a.length;
  }));
}
function ab(b, c, d) {
  const e = [];
  for (let f = 0; f < d.length; f++) {
    for (let g = 0; g < d[f].length; g++) {
      if (d[f][g] !== " ") {
        e.push({
          x: Math.round(b + g),
          y: Math.round(c + f)
        });
      }
    }
  }
  return e;
}
function ac() {
  const b = W();
  const c = new Set(ab(G.x, G.y, b).map(a => {
    return "" + a.x + "," + a.y;
  }));
  for (const d of H) {
    for (const e of ab(d.x, d.y, d.sprite)) {
      if (c.has("" + e.x + "," + e.y)) {
        return true;
      }
    }
  }
  return false;
}
function ad(b, c, d, e) {
  const f = Math.round(c);
  const g = Math.round(d);
  for (let h = 0; h < e.length; h++) {
    for (let i = 0; i < e[h].length; i++) {
      const j = e[h][i];
      const k = f + i;
      const l = g + h;
      if (j !== " " && l >= 0 && l < v && k >= 0 && k < E) {
        b[l][k] = j;
      }
    }
  }
}
function ae() {
  E = R();
  const b = Array.from({
    length: v
  }, () => {
    return Array.from({
      length: E
    }, () => {
      return " ";
    });
  });
  for (let c = 0; c < E; c++) {
    b[F][c] = c % 2 === 0 ? "_" : "-";
  }
  for (let c = M % 12; c < E; c += 12) {
    if (F + 1 < v) {
      b[F + 1][c] = ".";
    }
  }
  ad(b, G.x, G.y, W());
  for (const d of H) {
    ad(b, d.x, d.y, d.sprite);
  }
  const e = "ASCII DINO";
  const f = "Score " + String(I).padStart(5, "0") + "   Hi " + String(J).padStart(5, "0");
  const g = "Space/Up/W jump   Down/S duck   P pause   R restart   Q quit";
  af(b, 1, 0, e);
  af(b, Math.max(1, E - f.length - 2), 0, f);
  af(b, 1, v - 1, g.slice(0, E - 2));
  if (O) {
    ag(b, Math.floor(v / 2), "PAUSED");
  }
  if (N) {
    ag(b, Math.floor(v / 2) - 1, "GAME OVER");
    ag(b, Math.floor(v / 2) + 1, "Press R to restart or Q to quit");
  }
  const h = s.home + b.map(a => {
    return a.join("");
  }).join("\n");
  process.stdout.write(h);
}
function af(b, c, d, e) {
  for (let f = 0; f < e.length && c + f < E; f++) {
    if (c + f >= 0 && d >= 0 && d < v) {
      b[d][c + f] = e[f];
    }
  }
}
function ag(b, c, d) {
  const e = Math.max(0, Math.floor((E - d.length) / 2));
  af(b, e, c, d);
}
function ah() {
  const b = Date.now();
  const c = b - Q;
  if (c >= u) {
    Q = b;
    Z();
    ae();
  }
  setTimeout(ah, 4);
}
S();
process.stdout.write(s.hideCursor + s.clear);
ah();