#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { transform } = require("./StringCompression-GPT-5.5");

const here = __dirname;
const repoRoot = path.resolve(here, "..");
const originalPath = path.join(repoRoot, "StringCompression.js");
const deobfuscatedFixturePath = path.join(here, "StringCompression-GPT-5.5.output.js");
const passThroughInputPath = path.join(here, "StringCompression-GPT-5.5.pass-through.input.js");
const passThroughOutputPath = path.join(here, "StringCompression-GPT-5.5.pass-through.output.js");

function runJavaScript(source, filename) {
  const logs = [];
  const sandbox = {
    console: {
      log(...args) {
        logs.push(args.join(" "));
      },
    },
    module: { exports: {} },
    exports: {},
    define: undefined,
    angular: undefined,
    Uint8Array,
    Array,
    Object,
    String,
    Math,
    RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename, timeout: 1000 });
  return logs;
}

function writeFixture(filePath, contents) {
  fs.writeFileSync(filePath, contents.endsWith("\n") ? contents : `${contents}\n`);
}

const originalSource = fs.readFileSync(originalPath, "utf8");
const originalLogs = runJavaScript(originalSource, originalPath);
const deobfuscated = transform(originalSource);
writeFixture(deobfuscatedFixturePath, deobfuscated.output);
const deobfuscatedLogs = runJavaScript(deobfuscated.output, deobfuscatedFixturePath);

assert.deepStrictEqual(deobfuscatedLogs, originalLogs);
assert.strictEqual(deobfuscated.metadata.decoded, true);
assert.strictEqual(deobfuscated.metadata.replacements, 4);
assert.ok(deobfuscated.output.includes('console.log("Hello World!")'));
assert.ok(deobfuscated.output.includes('console.log("Here is another string...")'));
assert.ok(!deobfuscated.output.includes("decompressFromUTF16"));
assert.ok(!deobfuscated.output.includes("__p_F0Ru_SC"));

const passThroughInput = `
function main() {
  const parts = ["plain", "program"];
  console.log(parts.join(" "));
}
main();
`;
writeFixture(passThroughInputPath, passThroughInput);
const passThrough = transform(passThroughInput);
writeFixture(passThroughOutputPath, passThrough.output);

assert.deepStrictEqual(
  runJavaScript(passThrough.output, passThroughOutputPath),
  ["plain program"]
);
assert.strictEqual(passThrough.metadata.decoded, false);

console.log("StringCompression-GPT-5.5 tests passed");
console.log(`Wrote ${path.relative(repoRoot, deobfuscatedFixturePath)}`);
console.log(`Wrote ${path.relative(repoRoot, passThroughInputPath)}`);
console.log(`Wrote ${path.relative(repoRoot, passThroughOutputPath)}`);
