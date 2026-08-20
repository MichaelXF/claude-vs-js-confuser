// A plain, non-obfuscated program: `vm.js` must pass this through untouched.
'use strict';

function fib(n) {
  var a = 0, b = 1;
  for (var i = 0; i < n; i++) {
    var t = a + b;
    a = b;
    b = t;
  }
  return a;
}

class Greeter {
  constructor(name) {
    this.name = name;
  }
  greet() {
    return `hello ${this.name}`;
  }
}

const NUMBERS = [1, 2, 3, 4, 5];

function summarize(values) {
  const doubled = values.map((v) => v * 2).filter((v) => v % 3 !== 0);
  const total = doubled.reduce((acc, v) => acc + v, 0);
  return { doubled, total };
}

async function main() {
  const g = new Greeter('world');
  const { total } = summarize(NUMBERS);
  try {
    if (total > 1000) throw new RangeError('too big');
  } catch (err) {
    console.error(err.message);
  } finally {
    console.log(g.greet(), total, fib(10));
  }
  for (const key of Object.keys({ a: 1, b: 2 })) {
    console.log(key);
  }
  return total;
}

module.exports = { fib, Greeter, summarize, main };
