// Counts how much real code the tool actually executes, and where: how many
// times an opcode handler is run, split by phase, and how many inputs each
// operator fit costs.
//
//   node debug/count-oracle.js
const fs = require("fs");
const path = require("path");

// patch before lift.js binds these by destructuring at require time
const machineModule = require("../lib/machine");
const fitModule = require("../lib/fit");

const counts = new Map();
let phase = "probe";
const bump = () => counts.set(phase, (counts.get(phase) || 0) + 1);

const runAt = machineModule.Machine.prototype.runAt;
machineModule.Machine.prototype.runAt = function (...args) { bump(); return runAt.apply(this, args); };

let fitSites = 0;
let fitRuns = 0;
const fitInstruction = fitModule.fitInstruction;
fitModule.fitInstruction = function (...args) {
  fitSites++;
  const before = counts.get(phase) || 0;
  const out = fitInstruction.apply(null, args);
  fitRuns += (counts.get(phase) || 0) - before;
  return out;
};

const { Analyzer } = require("../lib/analyze");
const { Lifter } = require("../lib/lift");

const file = path.join(__dirname, "..", "input.js");
const info = machineModule.inspect(fs.readFileSync(file, "utf8"));
const loaded = machineModule.loadSample(info.ast, info.entryStmt, file);

phase = "probe";
const m = new machineModule.Machine(loaded);
phase = "analyze";
const a = new Analyzer(m);
const functions = a.analyzeProgram();
phase = "lift";
const lifter = new Lifter(m, a, functions);
lifter.liftProgram();

const total = [...counts.values()].reduce((x, y) => x + y, 0);
console.log("handler executions by phase:");
for (const [k, v] of counts) console.log(`  ${k.padEnd(10)} ${v}`);
console.log(`  ${"TOTAL".padEnd(10)} ${total}`);
console.log(`\noperator fits: ${fitSites} sites, ${fitRuns} handler runs (${(fitRuns / Math.max(fitSites, 1)).toFixed(0)} inputs per site)`);
console.log(`opcodes in the handler table: ${m.opcodes.length}`);
console.log(`instructions swept: ${a.instrs.size}`);
console.log(`guest instructions executed: 0 (the entry call is intercepted before the interpreter loop starts)`);
