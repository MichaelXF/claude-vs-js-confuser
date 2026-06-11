// A perfectly ordinary, non-obfuscated program.
// The deobfuscator must pass this through unchanged (no errors).
function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

function fizzbuzz(limit) {
  const out = [];
  for (let i = 1; i <= limit; i++) {
    let s = "";
    if (i % 3 === 0) s += "Fizz";
    if (i % 5 === 0) s += "Buzz";
    out.push(s || String(i));
  }
  return out;
}

const greeting = "hello world";
const numbers = [1, 2, 3, 4, 5].map((x) => x * 2).filter((x) => x > 4);

class Counter {
  constructor() {
    this.value = 0;
  }
  increment() {
    this.value += 1;
    return this.value;
  }
}

function main() {
  const c = new Counter();
  c.increment();
  c.increment();
  return {
    fact: factorial(5),
    fb: fizzbuzz(15),
    greeting,
    numbers,
    counter: c.value,
  };
}

module.exports = { factorial, fizzbuzz, Counter, main };
