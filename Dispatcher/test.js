"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EventEmitter = require("events");
const deobfuscate = require("./dispatcher");

const here = __dirname;
const inputFile = path.join(here, "input.js");
const input2File = path.join(here, "input2.js");
const originalFile = path.join(here, "original.js");
const outputFile = path.join(here, "output.js");
const output2File = path.join(here, "output2.js");
const regularFile = path.join(here, "regular.js");
const regularOutputFile = path.join(here, "regular.output.js");

function runGame(source, actions) {
  const writes = [];
  const fakeStdin = new EventEmitter();
  let timer = null;
  let now = 1000;

  fakeStdin.isTTY = true;
  fakeStdin.setRawMode = function setRawMode() {};

  const fakeProcess = new EventEmitter();
  fakeProcess.stdin = fakeStdin;
  fakeProcess.stdout = {
    columns: 80,
    write(value) {
      writes.push(String(value));
    },
  };
  fakeProcess.exit = function exit(code) {
    throw new Error("Unexpected process.exit(" + code + ")");
  };

  const FakeDate = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  };

  vm.runInNewContext(source, {
    require(name) {
      if (name === "readline") {
        return {
          emitKeypressEvents() {},
        };
      }
      return require(name);
    },
    process: fakeProcess,
    console,
    setTimeout(callback) {
      timer = callback;
    },
    Date: FakeDate,
    Math,
    String,
    Array,
    Set,
  });

  function tick() {
    now += 40;
    const callback = timer;
    timer = null;
    callback();
  }

  for (const action of actions) {
    if (typeof action === "string") {
      fakeStdin.emit("keypress", "", { name: action });
    } else if (action && action.ctrl) {
      fakeStdin.emit("keypress", "", action);
    } else {
      tick();
    }
  }

  return writes;
}

const output = deobfuscate(inputFile, outputFile);
assert(output.includes("function __dispatcher_Tz2pjo"));
assert(!output.includes("leyVQ33vd3"));
assert(!output.includes("function c("));

new Function(output);

const original = fs.readFileSync(originalFile, "utf8");
const actions = [
  null,
  null,
  "space",
  null,
  null,
  "p",
  null,
  "p",
  "down",
  null,
  "r",
  null,
];
const writes = runGame(output, actions);
assert.deepStrictEqual(writes, runGame(original, actions));
assert(writes.join("").includes("\x1B[?25l\x1B[2J"));

const output2 = deobfuscate(input2File, output2File);
assert(!output2.includes("function c("));
assert(!output2.includes("function k("));
assert(!output2.includes("function r("));
assert(!output2.includes("yyBjNbZhSv"));
assert(!output2.includes("sHxFJmnFW0"));
assert(!output2.includes("hTHdsKiM2B"));
assert(!output2.includes("Object[\"create\"]"));

const logs = [];
vm.runInNewContext(output2, {
  console: {
    log(value) {
      logs.push(String(value));
    },
  },
});
assert.deepStrictEqual(logs, ["Hello, World!"]);

const regularSource = fs.readFileSync(regularFile, "utf8");
const regularOutput = deobfuscate(regularFile, regularOutputFile);
assert.strictEqual(regularOutput, regularSource);

const regularModule = { exports: {} };
vm.runInNewContext(regularOutput, {
  module: regularModule,
  exports: regularModule.exports,
  require,
});
assert.strictEqual(regularModule.exports.value, 5);

console.log("dispatcher tests passed");
