"use strict";

const path = require("path");

function universal(log, label) {
  const target = function placeholder() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => 0;
      if (property === "length") return 0;
      log.push(["get", label, String(property)]);
      return universal(log, `${label}.${String(property)}`);
    },
    set(_target, property, value) {
      log.push(["set", label, String(property), typeof value]);
      return true;
    },
    apply() {
      log.push(["call", label]);
      return universal(log, `${label}()`);
    },
    construct() {
      log.push(["construct", label]);
      return universal(log, `new ${label}`);
    },
  });
}

function execute(filename, options = {}) {
  const effects = [];
  let randomState = options.seed ?? 123456789;
  let clock = options.clock ?? 1700000000000;
  const saved = {
    window: global.window,
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    random: Math.random,
    now: Date.now,
    log: console.log,
  };
  try {
    global.window = {};
    global.document = universal(effects, "document");
    global.requestAnimationFrame = universal(effects, "requestAnimationFrame");
    global.cancelAnimationFrame = universal(effects, "cancelAnimationFrame");
    Math.random = () => ((randomState = (1103515245 * randomState + 12345) >>> 0) / 0x100000000);
    Date.now = () => clock++;
    console.log = (...values) => effects.push(["console.log", ...values.map(String)]);
    const resolved = path.resolve(filename);
    delete require.cache[resolved];
    require(resolved);
    const entry = Object.values(window).find((value) => typeof value === "function");
    if (!entry) throw new Error(`No browser entry in ${filename}`);
    const callCount = options.callCount ?? 1;
    for (let call = 0; call < callCount; call++) {
      const result = entry();
      effects.push(["entry.return", String(result)]);
    }
    if (Array.isArray(global.__liftReturns)) effects.push(["liftReturns", ...global.__liftReturns.slice(0, 20).map(String)]);
    return effects;
  } finally {
    global.window = saved.window;
    global.document = saved.document;
    global.requestAnimationFrame = saved.requestAnimationFrame;
    global.cancelAnimationFrame = saved.cancelAnimationFrame;
    Math.random = saved.random;
    Date.now = saved.now;
    console.log = saved.log;
    delete global.__liftReturns;
  }
}

function compare(originalPath, deobfuscatedPath, options = {}) {
  const original = execute(originalPath, options);
  const deobfuscated = execute(deobfuscatedPath, options);
  return {
    originalEffects: original.length,
    deobfuscatedEffects: deobfuscated.length,
    identical: JSON.stringify(original) === JSON.stringify(deobfuscated),
    originalTail: original.slice(-5),
    deobfuscatedTail: deobfuscated.slice(-5),
  };
}

module.exports = { execute, compare };

if (require.main === module) {
  console.log(JSON.stringify(compare(process.argv[2] || "input.js", process.argv[3] || "output.js"), null, 2));
}
