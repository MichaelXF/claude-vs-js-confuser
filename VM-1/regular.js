// A regular, non-obfuscated file. The deobfuscator must pass this through
// without errors (it contains no VM to undo).
function greet(name) {
  const message = "Hello, " + name + "!";
  console.log(message);
  return message;
}

const numbers = [1, 2, 3, 4, 5];
const total = numbers.reduce((acc, n) => acc + n, 0);

for (let i = 0; i < 3; i++) {
  try {
    if (i % 2 === 0) {
      greet("user " + i);
    } else {
      throw new Error("odd index " + i);
    }
  } catch (e) {
    console.log("caught:", e.message);
  }
}

module.exports = { greet, total };
