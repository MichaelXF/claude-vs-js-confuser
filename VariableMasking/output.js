"use strict";

const a = require("readline");
if (!process.stdin.isTTY) {
  console.error("This game needs an interactive terminal.");
  process.exit(1);
}
a.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
const b = {
  clear: "\x1B[2J",
  home: "\x1B[H",
  hideCursor: "\x1B[?25l",
  showCursor: "\x1B[?25h",
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m"
};
const c = 30;
const d = 1000 / c;
const e = 15;
const f = 55;
const g = 90;
const h = ["   __ ", "  /oo\\", " /|__/ ", "  /  \\"];
const i = ["   __ ", "  /oo\\", " /|__/ ", "  \\  /"];
const j = ["   __    ", "__/oo\\__", "\\_______"];
const k = ["  |  ", " \\|/ ", "  |  ", " / \\ "];
const l = ["  | | ", " \\| |/", "  | | ", " /   \\"];
const m = [" __ ", "<__>", " /\\ "];
let n;
let o;
let p;
let q;
let r;
let s = 0;
let t;
let u;
let v;
let w;
let x;
let y;
let z;
function A() {
  return Math.max(f, Math.min(g, process.stdout.columns || 80));
}
function B() {
  n = A();
  o = e - 3;
  p = {
    x: 7,
    y: o - h.length,
    vy: 0,
    jumping: false,
    ducking: false
  };
  q = [];
  r = 0;
  t = 0.75;
  u = 35;
  v = 0;
  w = false;
  x = false;
  y = 0;
  z = Date.now();
}
function C() {
  process.stdout.write(b.showCursor + b.reset + "\n");
  try {
    process.stdin.setRawMode(false);
  } catch {}
  process.exit(0);
}
process.on("SIGINT", C);
process.on("exit", () => {
  process.stdout.write(b.showCursor + b.reset);
});
process.stdin.on("keypress", (a0, a1) => {
  if (!a1) {
    return;
  }
  if (a1.ctrl && a1.name === "c") {
    C();
  }
  const b = a1.name;
  if (b === "q" || b === "escape") {
    C();
  }
  if (b === "p") {
    if (!w) {
      x = !x;
    }
    return;
  }
  if (b === "r") {
    B();
    return;
  }
  if (w) {
    return;
  }
  if (b === "space" || b === "up" || b === "w") {
    D();
  }
  if (b === "down" || b === "s") {
    E();
  }
});
function D() {
  if (p.jumping || p.ducking) {
    return;
  }
  p.vy = -1.5;
  p.jumping = true;
}
function E() {
  if (p.jumping) {
    return;
  }
  p.ducking = true;
  y = Date.now() + 450;
}
function F() {
  if (p.ducking) {
    return j;
  }
  return Math.floor(v / 8) % 2 === 0 ? h : i;
}
function G(a0, a1) {
  return Math.floor(Math.random() * (a1 - a0 + 1)) + a0;
}
function H() {
  let a1, a_a;
  const b = Math.random();
  if (r > 250 && b < 0.28) {
    a_a = m;
    a1 = o - G(7, 9);
  } else {
    if (b < 0.62) {
      a_a = k;
      a1 = o - k.length;
    } else {
      a_a = l;
      a1 = o - l.length;
    }
  }
  q.push({
    x: n + 5,
    y: a1,
    sprite: a_a
  });
}
function I() {
  if (x || w) {
    return;
  }
  v++;
  r += 1;
  s = Math.max(s, r);
  t = 0.75 + Math.min(1.7, r / 900);
  if (p.ducking && Date.now() > y) {
    p.ducking = false;
  }
  if (p.jumping) {
    p.y += p.vy;
    p.vy += 0.105;
    const a = F();
    const b = o - a.length;
    if (p.y >= b) {
      p.y = b;
      p.vy = 0;
      p.jumping = false;
    }
  }
  for (const c of q) {
    c.x -= t;
  }
  q = q.filter(a0 => {
    return a0.x + J(a0.sprite) > 0;
  });
  u -= t;
  if (u <= 0) {
    H();
    u = G(38, 68) - Math.min(18, Math.floor(r / 250));
  }
  if (L()) {
    w = true;
  }
}
function J(a0) {
  return Math.max(...a0.map(a0 => {
    return a0.length;
  }));
}
function K(a0, a1, a2) {
  const b = [];
  for (let c = 0; c < a2.length; c++) {
    for (let d = 0; d < a2[c].length; d++) {
      if (a2[c][d] !== " ") {
        b.push({
          x: Math.round(a0 + d),
          y: Math.round(a1 + c)
        });
      }
    }
  }
  return b;
}
function L() {
  const b = F();
  const c = new Set(K(p.x, p.y, b).map(a0 => {
    return "" + a0.x + "," + a0.y;
  }));
  for (const d of q) {
    for (const e of K(d.x, d.y, d.sprite)) {
      if (c.has("" + e.x + "," + e.y)) {
        return true;
      }
    }
  }
  return false;
}
function M(a0, a1, a2, a3) {
  const b = Math.round(a1);
  const c = Math.round(a2);
  for (let d = 0; d < a3.length; d++) {
    for (let f = 0; f < a3[d].length; f++) {
      const g = a3[d][f];
      const h = b + f;
      const i = c + d;
      if (g !== " " && i >= 0 && i < e && h >= 0 && h < n) {
        a0[i][h] = g;
      }
    }
  }
}
function N() {
  n = A();
  const c = Array.from({
    length: e
  }, () => {
    return Array.from({
      length: n
    }, () => {
      return " ";
    });
  });
  for (let d = 0; d < n; d++) {
    c[o][d] = d % 2 === 0 ? "_" : "-";
  }
  for (let d = v % 12; d < n; d += 12) {
    if (o + 1 < e) {
      c[o + 1][d] = ".";
    }
  }
  M(c, p.x, p.y, F());
  for (const f of q) {
    M(c, f.x, f.y, f.sprite);
  }
  const g = "ASCII DINO";
  const h = "Score " + String(r).padStart(5, "0") + "   Hi " + String(s).padStart(5, "0");
  const i = "Space/Up/W jump   Down/S duck   P pause   R restart   Q quit";
  O(c, 1, 0, g);
  O(c, Math.max(1, n - h.length - 2), 0, h);
  O(c, 1, e - 1, i.slice(0, n - 2));
  if (x) {
    P(c, Math.floor(e / 2), "PAUSED");
  }
  if (w) {
    P(c, Math.floor(e / 2) - 1, "GAME OVER");
    P(c, Math.floor(e / 2) + 1, "Press R to restart or Q to quit");
  }
  const j = b.home + c.map(a0 => {
    return a0.join("");
  }).join("\n");
  process.stdout.write(j);
}
function O(a0, a1, a2, a3) {
  for (let b = 0; b < a3.length && a1 + b < n; b++) {
    if (a1 + b >= 0 && a2 >= 0 && a2 < e) {
      a0[a2][a1 + b] = a3[b];
    }
  }
}
function P(a0, a1, a2) {
  const b = Math.max(0, Math.floor((n - a2.length) / 2));
  O(a0, b, a1, a2);
}
function Q() {
  const b = Date.now();
  const c = b - z;
  if (c >= d) {
    z = b;
    I();
    N();
  }
  setTimeout(Q, 4);
}
B();
process.stdout.write(b.hideCursor + b.clear);
Q();