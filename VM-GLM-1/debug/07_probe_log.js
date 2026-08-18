// probe: capture console.log args from output.js to see what the decoder returns
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const file = process.argv[2] || "output.js";
const log = [];
const makeDiv = () => { const d = { style: {} }; Object.defineProperty(d, "offsetWidth", { get() { return 140; } }); d.appendChild = (c) => c; return d; };
const sandbox = {
  console: { log: (...a) => log.push(a.map((x) => `${typeof x}:${JSON.stringify(x && x.length !== undefined ? x.slice(0, 60) : x)}`).join(" || ")) },
  document: { createElement: () => makeDiv(), body: { appendChild: (c) => c } },
  Math, Date, JSON,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), ctx, { timeout: 10000 });
try { vm.runInContext("window._k1crlxlk2w8()", ctx, { timeout: 10000 }); } catch (e) { log.push("CALL ERR: " + e.message); }
console.log(log.join("\n"));
