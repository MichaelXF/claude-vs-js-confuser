// regular.js — an ordinary, non-obfuscated JavaScript file.
// The deobfuscator must pass this through unchanged (no VM pattern present).
function fibonacci(n) {
  if (n < 2) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return b;
}

class Greeter {
  constructor(name) {
    this.name = name;
  }
  greet() {
    return "Hello, " + this.name + "!";
  }
}

const nums = [1, 2, 3, 4, 5].map(x => x * x).filter(x => x % 2 === 0);
const obj = { a: 1, b: "two", c: [3] };
try {
  throw new Error("expected");
} catch (e) {
  console.log("caught:", e.message);
}
console.log(fibonacci(10), new Greeter("world").greet(), nums.join(","), obj.b);
