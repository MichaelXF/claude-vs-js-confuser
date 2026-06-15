"use strict";

function __dispatcher_Tz2pjo() {
  return Math["max"](j, Math["min"](k, process["stdout"]["columns"] || 80));
}
function __dispatcher_GQ5vHO() {
  r = __dispatcher_Tz2pjo();
  s = i - 3;
  t = {
    ["x"]: 7,
    ["y"]: s - l["length"],
    ["vy"]: 0,
    ["jumping"]: false,
    ["ducking"]: false
  };
  u = [];
  v = 0;
  x = 0.75;
  y = 35;
  z = 0;
  A = false;
  B = false;
  C = 0;
  D = Date["now"]();
}
function __dispatcher_wk0y6H() {
  process["stdout"]["write"](f["showCursor"] + f["reset"] + "\n");
  try {
    process["stdin"]["setRawMode"](false);
  } catch {}
  process["exit"](0);
}
function __dispatcher_YzXFd8() {
  if (t["jumping"] || t["ducking"]) {
    return;
  }
  t["vy"] = -1.5;
  t["jumping"] = true;
}
function __dispatcher_3Zwp5X() {
  if (t["jumping"]) {
    return;
  }
  t["ducking"] = true;
  C = Date["now"]() + 450;
}
function __dispatcher_rvOjkn() {
  if (t["ducking"]) {
    return n;
  }
  return Math["floor"](z / 8) % 2 === 0 ? l : m;
}
function __dispatcher_GFKFiH(e, g) {
  return Math["floor"](Math["random"]() * (g - e + 1)) + e;
}
function __dispatcher_q8sPGt() {
  const e = Math["random"]();
  let g;
  let E;
  if (v > 250 && e < 0.28) {
    g = q;
    E = s - __dispatcher_GFKFiH(7, 9);
  } else {
    if (e < 0.62) {
      g = o;
      E = s - o["length"];
    } else {
      g = p;
      E = s - p["length"];
    }
  }
  u["push"]({
    ["x"]: r + 5,
    ["y"]: E,
    ["sprite"]: g
  });
}
function __dispatcher_1xnwuL() {
  if (B || A) {
    return;
  }
  z++;
  v += 1;
  w = Math["max"](w, v);
  x = 0.75 + Math["min"](1.7, v / 900);
  if (t["ducking"] && Date["now"]() > C) {
    t["ducking"] = false;
  }
  if (t["jumping"]) {
    t["y"] += t["vy"];
    t["vy"] += 0.105;
    const e = __dispatcher_rvOjkn();
    const g = s - e["length"];
    if (t["y"] >= g) {
      t["y"] = g;
      t["vy"] = 0;
      t["jumping"] = false;
    }
  }
  for (const E of u) {
    E["x"] -= x;
  }
  u = u["filter"](e => {
    return e["x"] + __dispatcher_jm4jQh(e["sprite"]) > 0;
  });
  y -= x;
  if (y <= 0) {
    __dispatcher_q8sPGt();
    y = __dispatcher_GFKFiH(38, 68) - Math["min"](18, Math["floor"](v / 250));
  }
  if (__dispatcher_SItNXt()) {
    A = true;
  }
}
function __dispatcher_jm4jQh(e) {
  return Math["max"](...e["map"](e => {
    return e["length"];
  }));
}
function __dispatcher_6wEtQ2(e, g, E) {
  const F = [];
  for (let G = 0; G < E["length"]; G++) {
    for (let H = 0; H < E[G]["length"]; H++) {
      if (E[G][H] !== " ") {
        F["push"]({
          ["x"]: Math["round"](e + H),
          ["y"]: Math["round"](g + G)
        });
      }
    }
  }
  return F;
}
function __dispatcher_SItNXt() {
  const e = __dispatcher_rvOjkn();
  const g = new Set(__dispatcher_6wEtQ2(t["x"], t["y"], e)["map"](e => {
    return "" + e["x"] + "," + e["y"];
  }));
  for (const E of u) {
    for (const F of __dispatcher_6wEtQ2(E["x"], E["y"], E["sprite"])) {
      if (g["has"]("" + F["x"] + "," + F["y"])) {
        return true;
      }
    }
  }
  return false;
}
function __dispatcher_3Bq1fI(e, g, E, F) {
  const G = Math["round"](g);
  const H = Math["round"](E);
  for (let I = 0; I < F["length"]; I++) {
    for (let a = 0; a < F[I]["length"]; a++) {
      const c = F[I][a];
      const d = G + a;
      const f = H + I;
      if (c !== " " && f >= 0 && f < i && d >= 0 && d < r) {
        e[f][d] = c;
      }
    }
  }
}
function __dispatcher_6X8KUy() {
  r = __dispatcher_Tz2pjo();
  const e = Array["from"]({
    ["length"]: i
  }, () => {
    return Array["from"]({
      ["length"]: r
    }, () => {
      return " ";
    });
  });
  for (let g = 0; g < r; g++) {
    e[s][g] = g % 2 === 0 ? "_" : "-";
  }
  for (let g = z % 12; g < r; g += 12) {
    if (s + 1 < i) {
      e[s + 1][g] = ".";
    }
  }
  __dispatcher_3Bq1fI(e, t["x"], t["y"], __dispatcher_rvOjkn());
  for (const E of u) {
    __dispatcher_3Bq1fI(e, E["x"], E["y"], E["sprite"]);
  }
  const F = "ASCII DINO";
  const H = "Score " + String(v)["padStart"](5, "0") + "   Hi " + String(w)["padStart"](5, "0");
  const I = "Space/Up/W jump   Down/S duck   P pause   R restart   Q quit";
  __dispatcher_8GiUUc(e, 1, 0, F);
  __dispatcher_8GiUUc(e, Math["max"](1, r - H["length"] - 2), 0, H);
  __dispatcher_8GiUUc(e, 1, i - 1, I["slice"](0, r - 2));
  if (B) {
    __dispatcher_XkBOSa(e, Math["floor"](i / 2), "PAUSED");
  }
  if (A) {
    __dispatcher_XkBOSa(e, Math["floor"](i / 2) - 1, "GAME OVER");
    __dispatcher_XkBOSa(e, Math["floor"](i / 2) + 1, "Press R to restart or Q to quit");
  }
  const a = f["home"] + e["map"](e => {
    return e["join"]("");
  })["join"]("\n");
  process["stdout"]["write"](a);
}
function __dispatcher_8GiUUc(e, g, E, F) {
  for (let G = 0; G < F["length"] && g + G < r; G++) {
    if (g + G >= 0 && E >= 0 && E < i) {
      e[E][g + G] = F[G];
    }
  }
}
function __dispatcher_XkBOSa(e, g, E) {
  const F = Math["max"](0, Math["floor"]((r - E["length"]) / 2));
  __dispatcher_8GiUUc(e, F, g, E);
}
function __dispatcher_bHfUCW() {
  const e = Date["now"]();
  const g = e - D;
  if (g >= h) {
    D = e;
    __dispatcher_1xnwuL();
    __dispatcher_6X8KUy();
  }
  setTimeout(__dispatcher_bHfUCW, 4);
}
const e = require("readline");
if (!process["stdin"]["isTTY"]) {
  console["error"]("This game needs an interactive terminal.");
  process["exit"](1);
}
e["emitKeypressEvents"](process["stdin"]);
process["stdin"]["setRawMode"](true);
const f = {
  ["clear"]: "\x1B[2J",
  ["home"]: "\x1B[H",
  ["hideCursor"]: "\x1B[?25l",
  ["showCursor"]: "\x1B[?25h",
  ["reset"]: "\x1B[0m",
  ["bold"]: "\x1B[1m",
  ["dim"]: "\x1B[2m"
};
const g = 30;
const h = 1000 / g;
const i = 15;
const j = 55;
const k = 90;
const l = ["   __ ", "  /oo\\", " /|__/ ", "  /  \\"];
const m = ["   __ ", "  /oo\\", " /|__/ ", "  \\  /"];
const n = ["   __    ", "__/oo\\__", "\\_______"];
const o = ["  |  ", " \\|/ ", "  |  ", " / \\ "];
const p = ["  | | ", " \\| |/", "  | | ", " /   \\"];
const q = [" __ ", "<__>", " /\\ "];
let r;
let s;
let t;
let u;
let v;
let w = 0;
let x;
let y;
let z;
let A;
let B;
let C;
let D;
process["on"]("SIGINT", __dispatcher_wk0y6H);
process["on"]("exit", () => {
  process["stdout"]["write"](f["showCursor"] + f["reset"]);
});
process["stdin"]["on"]("keypress", (a, b) => {
  if (!b) {
    return;
  }
  if (b["ctrl"] && b["name"] === "c") {
    __dispatcher_wk0y6H();
  }
  const d = b["name"];
  if (d === "q" || d === "escape") {
    __dispatcher_wk0y6H();
  }
  if (d === "p") {
    if (!A) {
      B = !B;
    }
    return;
  }
  if (d === "r") {
    __dispatcher_GQ5vHO();
    return;
  }
  if (A) {
    return;
  }
  if (d === "space" || d === "up" || d === "w") {
    __dispatcher_YzXFd8();
  }
  if (d === "down" || d === "s") {
    __dispatcher_3Zwp5X();
  }
});
__dispatcher_GQ5vHO();
process["stdout"]["write"](f["hideCursor"] + f["clear"]);
__dispatcher_bHfUCW();
