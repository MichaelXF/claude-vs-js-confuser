const assert = require("assert");
const fs = require("fs");
const flatten = require("./flatten");

const output = flatten("input.js", "output.js");
assert(output.includes("function S()"));
assert(output.includes("function ab(b, c, d)"));
assert(output.includes("function ag(b, c, d)"));
assert(output.includes("E = R();"));
assert(output.includes("process.stdout.write"));
assert(!output.includes("return i(b, a);"));
assert(!output.includes("var [b, c, d] = _args"));
assert(!output.includes("get \""));

new Function(output);

const regularOutput = flatten("regular.js");
assert(regularOutput.includes("function add(a, b)"));
assert.strictEqual(require("./regular"), 5);

const arbitraryNamesOutput = flatten.deobfuscate(`
  function HandlerName() {
    var [state, [left, right]] = arguments;
    return state["x"] + left + right;
  }
  function wrapperName(...payload) {
    var context = {
      get "x"() { return sourceValue; }
    };
    return HandlerName(context, payload);
  }
`);
assert(arbitraryNamesOutput.includes("function wrapperName(left, right)"));
assert(arbitraryNamesOutput.includes("return sourceValue + left + right;"));
assert(!arbitraryNamesOutput.includes("function HandlerName"));

console.log("ok");
