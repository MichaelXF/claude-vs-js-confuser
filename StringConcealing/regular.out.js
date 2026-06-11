// A regular, non-obfuscated module. The deobfuscator must pass this through
// without errors and without changing its behavior.
"use strict";

function greet(name) {
  return "Hello, " + name + "!";
}
const numbers = [1, 2, 3, 4].map(n => n * 2);
const sum = numbers.reduce((a, b) => a + b, 0);

// A name that happens to start with underscores but is NOT obfuscator scaffolding
// because it is still referenced -> must be preserved.
const __keepMe = "still here";
module.exports = {
  greet: greet,
  numbers: numbers,
  sum: sum,
  marker: __keepMe
};