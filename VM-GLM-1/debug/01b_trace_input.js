// Run input.js with deep Proxy instrumentation to record all global/DOM activity
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const trace = [];
let depth = 0;

function makeTracer(name) {
  const fn = function (...args) {
    trace.push(`${" ".repeat(Math.min(depth, 8))}CALL ${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
    return undefined;
  };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => `${name}`;
      if (typeof prop === "symbol") return undefined;
      trace.push(`GET ${name}.${String(prop)}`);
      return makeTracer(`${name}.${String(prop)}`);
    },
    set(target, prop, value) {
      trace.push(`SET ${name}.${String(prop)} = ${typeof value === "object" ? "[obj]" : JSON.stringify(value)}`);
      return true;
    },
    apply(target, thisArg, args) {
      depth++;
      trace.push(`${" ".repeat(Math.min(depth, 8))}CALL ${name}(${args.map((a) => (typeof a === "object" ? "[obj]" : JSON.stringify(a))).join(", ")})`);
      depth--;
      return makeTracer(`${name}()`);
    },
    construct() {
      trace.push(`NEW ${name}`);
      return makeTracer(`${name}()`);
    },
    has(target, prop) {
      trace.push(`HAS ${name} [${String(prop)}]`);
      return true;
    },
  });
}

const realConsole = {
  log: (...a) => trace.push(`console.log ${a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")}`),
  warn: (...a) => trace.push(`console.warn ${a.map(String).join(" ")}`),
  error: (...a) => trace.push(`console.error ${a.map(String).join(" ")}`),
  info: (...a) => trace.push(`console.info ${a.map(String).join(" ")}`),
};

const sandbox = {
  console: realConsole,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
};
sandbox.globalThis = sandbox;
sandbox.window = makeTracer("window");
sandbox.window.console = realConsole;
sandbox.document = makeTracer("document");
sandbox.setTimeout = (fn) => { trace.push("setTimeout"); return 0; };
sandbox.setInterval = () => 0;
sandbox.alert = (x) => trace.push(`alert(${String(x)})`);
sandbox.prompt = () => "";
sandbox.confirm = () => true;
sandbox.navigator = makeTracer("navigator");
sandbox.location = makeTracer("location");

const ctx = vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
try {
  vm.runInContext(src, ctx, { timeout: 15000 });
  trace.push("--- finished ---");
} catch (e) {
  trace.push(`THREW: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
}
fs.writeFileSync(path.join(__dirname, "01_trace.txt"), trace.join("\n"));
console.log(trace.slice(0, 120).join("\n"));
console.log(`... total ${trace.length} entries`);
