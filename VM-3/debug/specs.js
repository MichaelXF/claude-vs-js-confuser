// debug/specs.js — check that every handler maps to a known instruction spec
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const { detectVM, canonicalize, specFor, identifyMBA } = require("../vm.js");

const file = process.argv[2] || path.join(__dirname, "..", "input.js");
const ast = parser.parse(fs.readFileSync(file, "utf8"), { sourceType: "script" });
const vm = detectVM(ast);

const byKind = new Map();
const unknown = [];
const out = [];
for (const [op, fn] of vm.handlers) {
  const { canon, slots } = canonicalize(fn, vm);
  const spec = specFor(canon, slots, vm, fn);
  let label = spec.kind + (spec.op ? " " + spec.op : "");
  if (spec.kind === "mba") {
    const real = identifyMBA(fn, vm);
    label += " -> " + (real || "UNRESOLVED");
  }
  if (spec.kind === "unknown") unknown.push({ op, canon });
  byKind.set(spec.kind, (byKind.get(spec.kind) || 0) + 1);
  out.push(`${String(op).padStart(6)}  fixed=${spec.fixed}  ${label}  slots=${slots
    .map((s) => (s.stream ? "s" + s.read : "c" + s.value)).join(" ")}`);
}
out.sort();
fs.writeFileSync(path.join(__dirname, "specs.txt"), out.join("\n"));
console.log("kinds:", [...byKind.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
if (unknown.length) {
  console.log("UNKNOWN handlers:", unknown.length);
  for (const u of unknown.slice(0, 10)) console.log("  op", u.op, "->", u.canon.slice(0, 160));
}
