const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const deobfuscate = require("./variableMasking.js");

const here = __dirname;
const inputFile = path.join(here, "input.js");
const originalFile = path.join(here, "original.js");
const outputFile = path.join(here, "output.js");
const regularFile = path.join(here, "regular.js");
const regularOutputFile = path.join(here, "regular.output.js");

const output = deobfuscate(inputFile, outputFile);
const regularOutput = deobfuscate(regularFile, regularOutputFile);

assert(!output.includes("[\"length\"]"), "target output should remove fake rest length writes");
assert(!output.includes("[\"a\"]"), "target output should replace masked scratch properties");

const ast = parser.parse(output, { sourceType: "unambiguous" });
let restElements = 0;
traverse(ast, {
  RestElement() {
    restElements++;
  },
});
assert.strictEqual(restElements, 0, "target output should not contain rest parameters");

function runWithFakeProcess(file) {
  const code = fs.readFileSync(file, "utf8");
  const stdout = [];
  const stderr = [];
  const sandbox = {
    require,
    console: {
      error(...args) {
        stderr.push(args.join(" "));
      },
      log(...args) {
        stdout.push(args.join(" "));
      },
    },
    process: {
      stdin: {
        isTTY: false,
        on() {},
        setRawMode() {},
      },
      stdout: {
        columns: 80,
        write(value) {
          stdout.push(String(value));
        },
      },
      on() {},
      exit(code = 0) {
        const error = new Error("process.exit");
        error.exitCode = code;
        throw error;
      },
    },
    setTimeout() {},
  };

  try {
    vm.runInNewContext(code, sandbox, { filename: file, timeout: 1000 });
    return { status: 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } catch (error) {
    if (error.message === "process.exit") {
      return {
        status: error.exitCode,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      };
    }

    throw error;
  }
}

function runInteractiveStartup(file) {
  const code = fs.readFileSync(file, "utf8");
  const stdout = [];
  const stderr = [];
  const handlers = new Map();
  const timeValues = [1000, 1040];
  const fakeDate = {
    now() {
      return timeValues.length ? timeValues.shift() : 1040;
    },
  };
  const sandbox = {
    require(name) {
      if (name === "readline") {
        return {
          emitKeypressEvents() {},
        };
      }
      return require(name);
    },
    console: {
      error(...args) {
        stderr.push(args.join(" "));
      },
      log(...args) {
        stdout.push(args.join(" "));
      },
    },
    Date: fakeDate,
    Math,
    process: {
      stdin: {
        isTTY: true,
        on(event, callback) {
          handlers.set(event, callback);
        },
        setRawMode() {},
      },
      stdout: {
        columns: 80,
        write(value) {
          stdout.push(String(value));
        },
      },
      on(event, callback) {
        handlers.set(event, callback);
      },
      exit(code = 0) {
        const error = new Error("process.exit");
        error.exitCode = code;
        throw error;
      },
    },
    setTimeout() {},
  };

  vm.runInNewContext(code, sandbox, { filename: file, timeout: 1000 });
  return { stdout: stdout.join(""), stderr: stderr.join("\n") };
}

const originalRun = runWithFakeProcess(inputFile);
const deobfuscatedRun = runWithFakeProcess(outputFile);
assert.strictEqual(deobfuscatedRun.status, originalRun.status, "target exit status should match");
assert.strictEqual(deobfuscatedRun.stderr, originalRun.stderr, "target stderr should match");
assert.match(deobfuscatedRun.stderr, /interactive terminal/);

if (fs.existsSync(originalFile)) {
  const providedOriginalRun = runWithFakeProcess(originalFile);
  assert.strictEqual(deobfuscatedRun.status, providedOriginalRun.status, "provided original exit status should match");
  assert.strictEqual(deobfuscatedRun.stderr, providedOriginalRun.stderr, "provided original stderr should match");

  const originalStartup = runInteractiveStartup(originalFile);
  const deobfuscatedStartup = runInteractiveStartup(outputFile);
  assert.strictEqual(deobfuscatedStartup.stdout, originalStartup.stdout, "provided original startup render should match");
  assert.strictEqual(deobfuscatedStartup.stderr, originalStartup.stderr, "provided original startup stderr should match");
}

const regularRun = runWithFakeProcess(regularOutputFile);
assert.strictEqual(regularRun.status, 0, regularRun.stderr);
assert.strictEqual(regularRun.stdout.trim(), "regular 5");
assert.match(regularOutput, /function add\(left, right\)/);

console.log("VariableMasking tests passed");
