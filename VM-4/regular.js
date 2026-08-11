// regular.js — an ordinary, non-obfuscated program.
// `vm.js` must pass this through untouched (no VM detected).
"use strict";

function greet(name) {
  return "Hello, " + name + "!";
}

const NUMBERS = [3, 1, 4, 1, 5, 9, 2, 6];

function sum(list) {
  let total = 0;
  for (let i = 0; i < list.length; i++) total += list[i];
  return total;
}

class Counter {
  constructor(start) {
    this.value = start || 0;
  }
  inc(by = 1) {
    this.value += by;
    return this;
  }
  toString() {
    return `Counter(${this.value})`;
  }
}

const mapped = NUMBERS.map((n) => n * 2).filter((n) => n > 4);

function classify(n) {
  switch (true) {
    case n < 0:
      return "negative";
    case n === 0:
      return "zero";
    default:
      return "positive";
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  } finally {
    // nothing to clean up
  }
}

const obj = { a: 1, b: 2, ["c"]: 3 };
const keys = [];
for (const k in obj) keys.push(k);

module.exports = {
  greet,
  sum,
  Counter,
  mapped,
  classify,
  safeParse,
  keys,
  run() {
    return [greet("world"), sum(NUMBERS), String(new Counter(5).inc().inc(2)), classify(-3), keys.join(",")].join(" | ");
  },
};
