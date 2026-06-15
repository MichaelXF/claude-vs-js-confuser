// original.js was provided AFTER solution was reached!

"use strict";

const readline = require("readline");

if (!process.stdin.isTTY) {
  console.error("This game needs an interactive terminal.");
  process.exit(1);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

const ANSI = {
  clear: "\x1b[2J",
  home: "\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const FPS = 30;
const TICK_MS = 1000 / FPS;

const GAME_H = 15;
const MIN_W = 55;
const MAX_W = 90;

const STAND_1 = ["   __ ", "  /oo\\", " /|__/ ", "  /  \\"];

const STAND_2 = ["   __ ", "  /oo\\", " /|__/ ", "  \\  /"];

const DUCK = ["   __    ", "__/oo\\__", "\\_______"];

const CACTUS = ["  |  ", " \\|/ ", "  |  ", " / \\ "];

const TALL_CACTUS = ["  | | ", " \\| |/", "  | | ", " /   \\"];

const BIRD = [" __ ", "<__>", " /\\ "];

let width;
let groundY;
let player;
let obstacles;
let score;
let hiScore = 0;
let speed;
let spawnTimer;
let frame;
let gameOver;
let paused;
let duckUntil;
let lastTime;

function termWidth() {
  return Math.max(MIN_W, Math.min(MAX_W, process.stdout.columns || 80));
}

function resetGame() {
  width = termWidth();
  groundY = GAME_H - 3;

  player = {
    x: 7,
    y: groundY - STAND_1.length,
    vy: 0,
    jumping: false,
    ducking: false,
  };

  obstacles = [];
  score = 0;
  speed = 0.75;
  spawnTimer = 35;
  frame = 0;
  gameOver = false;
  paused = false;
  duckUntil = 0;
  lastTime = Date.now();
}

function cleanupAndExit() {
  process.stdout.write(ANSI.showCursor + ANSI.reset + "\n");
  try {
    process.stdin.setRawMode(false);
  } catch {}
  process.exit(0);
}

process.on("SIGINT", cleanupAndExit);
process.on("exit", () => {
  process.stdout.write(ANSI.showCursor + ANSI.reset);
});

process.stdin.on("keypress", (_, key) => {
  if (!key) return;

  if (key.ctrl && key.name === "c") cleanupAndExit();

  const name = key.name;

  if (name === "q" || name === "escape") cleanupAndExit();

  if (name === "p") {
    if (!gameOver) paused = !paused;
    return;
  }

  if (name === "r") {
    resetGame();
    return;
  }

  if (gameOver) return;

  if (name === "space" || name === "up" || name === "w") {
    jump();
  }

  if (name === "down" || name === "s") {
    duck();
  }
});

function jump() {
  if (player.jumping || player.ducking) return;
  player.vy = -1.5;
  player.jumping = true;
}

function duck() {
  if (player.jumping) return;
  player.ducking = true;
  duckUntil = Date.now() + 450;
}

function currentPlayerSprite() {
  if (player.ducking) return DUCK;
  return Math.floor(frame / 8) % 2 === 0 ? STAND_1 : STAND_2;
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function spawnObstacle() {
  const kindRoll = Math.random();

  let sprite;
  let y;

  if (score > 250 && kindRoll < 0.28) {
    sprite = BIRD;
    y = groundY - rand(7, 9);
  } else if (kindRoll < 0.62) {
    sprite = CACTUS;
    y = groundY - CACTUS.length;
  } else {
    sprite = TALL_CACTUS;
    y = groundY - TALL_CACTUS.length;
  }

  obstacles.push({
    x: width + 5,
    y,
    sprite,
  });
}

function update() {
  if (paused || gameOver) return;

  frame++;
  score += 1;
  hiScore = Math.max(hiScore, score);

  speed = 0.75 + Math.min(1.7, score / 900);

  if (player.ducking && Date.now() > duckUntil) {
    player.ducking = false;
  }

  if (player.jumping) {
    player.y += player.vy;
    player.vy += 0.105;

    const sprite = currentPlayerSprite();
    const floorY = groundY - sprite.length;

    if (player.y >= floorY) {
      player.y = floorY;
      player.vy = 0;
      player.jumping = false;
    }
  }

  for (const obstacle of obstacles) {
    obstacle.x -= speed;
  }

  obstacles = obstacles.filter((o) => o.x + spriteWidth(o.sprite) > 0);

  spawnTimer -= speed;
  if (spawnTimer <= 0) {
    spawnObstacle();
    spawnTimer = rand(38, 68) - Math.min(18, Math.floor(score / 250));
  }

  if (collides()) {
    gameOver = true;
  }
}

function spriteWidth(sprite) {
  return Math.max(...sprite.map((line) => line.length));
}

function spriteBounds(x, y, sprite) {
  const points = [];

  for (let row = 0; row < sprite.length; row++) {
    for (let col = 0; col < sprite[row].length; col++) {
      if (sprite[row][col] !== " ") {
        points.push({
          x: Math.round(x + col),
          y: Math.round(y + row),
        });
      }
    }
  }

  return points;
}

function collides() {
  const pSprite = currentPlayerSprite();
  const playerPoints = new Set(
    spriteBounds(player.x, player.y, pSprite).map((p) => `${p.x},${p.y}`),
  );

  for (const obstacle of obstacles) {
    for (const p of spriteBounds(obstacle.x, obstacle.y, obstacle.sprite)) {
      if (playerPoints.has(`${p.x},${p.y}`)) {
        return true;
      }
    }
  }

  return false;
}

function drawSprite(grid, x, y, sprite) {
  const ix = Math.round(x);
  const iy = Math.round(y);

  for (let row = 0; row < sprite.length; row++) {
    for (let col = 0; col < sprite[row].length; col++) {
      const ch = sprite[row][col];
      const gx = ix + col;
      const gy = iy + row;

      if (ch !== " " && gy >= 0 && gy < GAME_H && gx >= 0 && gx < width) {
        grid[gy][gx] = ch;
      }
    }
  }
}

function render() {
  width = termWidth();

  const grid = Array.from({ length: GAME_H }, () =>
    Array.from({ length: width }, () => " "),
  );

  for (let x = 0; x < width; x++) {
    grid[groundY][x] = x % 2 === 0 ? "_" : "-";
  }

  for (let x = frame % 12; x < width; x += 12) {
    if (groundY + 1 < GAME_H) grid[groundY + 1][x] = ".";
  }

  drawSprite(grid, player.x, player.y, currentPlayerSprite());

  for (const obstacle of obstacles) {
    drawSprite(grid, obstacle.x, obstacle.y, obstacle.sprite);
  }

  const title = "ASCII DINO";
  const info = `Score ${String(score).padStart(5, "0")}   Hi ${String(hiScore).padStart(5, "0")}`;
  const controls =
    "Space/Up/W jump   Down/S duck   P pause   R restart   Q quit";

  putText(grid, 1, 0, title);
  putText(grid, Math.max(1, width - info.length - 2), 0, info);
  putText(grid, 1, GAME_H - 1, controls.slice(0, width - 2));

  if (paused) {
    centerText(grid, Math.floor(GAME_H / 2), "PAUSED");
  }

  if (gameOver) {
    centerText(grid, Math.floor(GAME_H / 2) - 1, "GAME OVER");
    centerText(
      grid,
      Math.floor(GAME_H / 2) + 1,
      "Press R to restart or Q to quit",
    );
  }

  const output = ANSI.home + grid.map((row) => row.join("")).join("\n");

  process.stdout.write(output);
}

function putText(grid, x, y, text) {
  for (let i = 0; i < text.length && x + i < width; i++) {
    if (x + i >= 0 && y >= 0 && y < GAME_H) {
      grid[y][x + i] = text[i];
    }
  }
}

function centerText(grid, y, text) {
  const x = Math.max(0, Math.floor((width - text.length) / 2));
  putText(grid, x, y, text);
}

function loop() {
  const now = Date.now();
  const delta = now - lastTime;

  if (delta >= TICK_MS) {
    lastTime = now;
    update();
    render();
  }

  setTimeout(loop, 4);
}

resetGame();
process.stdout.write(ANSI.hideCursor + ANSI.clear);
loop();
