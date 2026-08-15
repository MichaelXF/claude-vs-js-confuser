// Diagnoses which live registers explode the path-sensitive state space.
const { analyzeProgram, TOP } = require("./analyze");
const funcs = analyzeProgram();
for (const target of [1758, 37]) {
  const fa = funcs.get(target);
  console.log(`\n=== fn@${target} ===`);
  const entries = [...fa.byPc.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  for (const [pc, list] of entries) {
    const live = fa.liveIn.get(pc) || new Set();
    const diffs = [];
    for (const r of [...live].sort((a, b) => a - b)) {
      const vals = new Set(list.map((n) => n.state[r]));
      if (vals.size > 1) diffs.push([r, vals]);
    }
    console.log(`block ${pc}: ${list.length} instances; live=${live.size}; varying: ${diffs.map(([r, v]) => `r${r}(${v.size})`).join(" ")}`);
    for (const [r, v] of diffs.slice(0, 8)) {
      console.log(`   r${r}:`, [...v].slice(0, 12).map((x) => (x === TOP ? "TOP" : typeof x === "function" ? "fn" : typeof x === "object" && x ? "obj" : String(x).slice(0, 14))).join(" "));
    }
  }
}
