// Prints the lifted block graph of one VM function after each cleanup pass, so
// a statement that disappears (or a test that lifts to `undefined`) can be
// attributed to the pass responsible.
//
//   node debug/lift-trace.js <functionEntry>
const fs = require("fs");
const path = require("path");
const generate = require("@babel/generator").default;
const { inspect, loadSample, Machine } = require("../lib/machine");
const { Analyzer } = require("../lib/analyze");
const { Lifter, termSuccessors } = require("../lib/lift");

const file = path.join(__dirname, "..", "input.js");
const info = inspect(fs.readFileSync(file, "utf8"));
const loaded = loadSample(info.ast, info.entryStmt, file);
const m = new Machine(loaded);
const a = new Analyzer(m);
const functions = a.analyzeProgram();
const lifter = new Lifter(m, a, functions);

const entry = Number(process.argv[2] || m.topDesc.m);
const fn = functions.get(entry);
if (!fn) throw new Error("no such function @" + entry);

const code = (n) => { try { return generate(n, { compact: true, comments: false }).code; } catch (e) { return "?"; } };

function show(label, graph) {
  console.log(`\n===== ${label}  (${graph.nodes.length} nodes, start #${graph.start.id})`);
  for (const n of graph.nodes) {
    console.log(`  block#${n.id} @${n.pc}`);
    for (const piece of n.stmts) {
      const lhs = piece.kind === "assign" ? lifter.regName(fn.entry, piece.reg) + " = " : "";
      console.log(`      ${String(piece.pc).padStart(5)} ${lhs}${code(piece.expr)}`);
    }
    const t = n.term;
    const to = termSuccessors(t).map((s) => "#" + s.id).join(", ");
    console.log(`      term ${t.kind}${t.kind === "branch" ? " (" + code(t.test) + ")" : ""}${t.expr ? " " + code(t.expr) : ""}${to ? " -> " + to : ""}`);
  }
}

const graph = lifter.buildGraph(fn);
show("buildGraph", graph);
const passes = [
  ["simplifyGraph", () => lifter.simplifyGraph(graph)],
  ["eliminateDeadCode", () => lifter.eliminateDeadCode(fn, graph)],
  ["simplifyGraph#2", () => lifter.simplifyGraph(graph)],
  ["mergeEquivalentNodes", () => lifter.mergeEquivalentNodes(fn, graph)],
  ["mergeChains", () => lifter.mergeChains(graph)],
  ["inlineTemporaries", () => lifter.inlineTemporaries(fn, graph)],
];
for (const [name, run] of passes) { run(); show(name, graph); }
