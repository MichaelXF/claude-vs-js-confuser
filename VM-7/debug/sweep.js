// Linear sweep decode: try decoding the whole bytecode array sequentially.
const { instrLen, LEN } = require("./disasm");
const { entryCall } = require("./probe");

const code = Array.from(entryCall[0].i);
let pc = 0;
let bad = 0;
const out = [];
while (pc < code.length) {
  let len;
  try {
    len = instrLen(code, pc);
  } catch (e) {
    out.push(`${pc}: ??? ${code[pc]}`);
    bad++;
    pc++;
    continue;
  }
  out.push(`${String(pc).padStart(5)}: op ${String(code[pc]).padStart(5)} [${code.slice(pc + 1, pc + len).join(", ")}]`);
  pc += len;
}
console.log(out.join("\n"));
console.error("bad opcodes:", bad, "of", out.length);
