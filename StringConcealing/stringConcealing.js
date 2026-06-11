#!/usr/bin/env node
"use strict";

/*
 * stringConcealing.js
 *
 * AST deobfuscator for JS-Confuser's "String Concealing" technique.
 *
 * How the obfuscation works
 * -------------------------
 *  - A single shared array of basE91-encoded strings is emitted, e.g.
 *        var __p_VTBJ_array = ["pTVI?RkJ...", ...];
 *  - One or more "decode" functions are emitted, each carrying its own
 *    91-character substitution `table`, but all sharing the exact same
 *    basE91 decoding algorithm + a UTF-8 buffer->string helper:
 *        function __p_gniQ_STR_1_decode(str){ var table="..."; ...; return bufferToString(ret); }
 *  - For every decode function there is a thin "getter":
 *        function __p_gniQ_STR_1(index){ return __p_gniQ_STR_1_decode(__p_VTBJ_array[index]); }
 *  - Every concealed string literal in the program is replaced by a call to a
 *    getter with a constant numeric index, e.g.  __p_gniQ_STR_1(82).
 *
 * Deobfuscation strategy
 * ----------------------
 *  1. Find the AST pattern: a getter is a function `f(index){ return D(ARR[index]); }`
 *     where D is a basE91 decode function (has a `table`) and ARR is an array of
 *     string literals. We identify these structurally (not by name) and resolve
 *     D and ARR through Babel's scope/binding system so nesting + minified names
 *     don't matter.
 *  2. Transform: every call `getter(<constant>)` is replaced by the decoded
 *     string literal, fully undoing the concealing.
 *  3. Cleanup: once all call sites are inlined, the getters / decode functions /
 *     string array / UTF-8 helpers become dead code. We remove unused bindings
 *     whose names are clearly part of the obfuscator scaffolding (the `__`
 *     prefix JS-Confuser uses, plus the fixed `utf8ArrayToStr` helper), so a
 *     normal hand-written file passes through untouched.
 */

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

/**
 * Port of the basE91 decoder JS-Confuser embeds. The byte-level bitwise ops are
 * reproduced exactly so the result is identical to running the obfuscated code
 * (including JS 32-bit bitwise semantics). Bytes are interpreted as UTF-8, which
 * matches the runtime's TextDecoder/Buffer based `bufferToString` helper.
 */
function base91Decode(table, str) {
  const raw = "" + (str || "");
  const len = raw.length;
  const ret = [];
  let b = 0;
  let n = 0;
  let v = -1;
  for (let i = 0; i < len; i++) {
    const p = table.indexOf(raw[i]);
    if (p === -1) continue;
    if (v < 0) {
      v = p;
    } else {
      v += p * 91;
      b |= v << n;
      n += (v & 8191) > 88 ? 13 : 14;
      do {
        ret.push(b & 255);
        b >>= 8;
        n -= 8;
      } while (n > 7);
      v = -1;
    }
  }
  if (v > -1) {
    ret.push((b | (v << n)) & 255);
  }
  return Buffer.from(ret).toString("utf-8");
}

// Read a constant integer index out of a call argument (`5` or `-5`).
function constIndex(node) {
  if (t.isNumericLiteral(node)) return node.value;
  if (
    t.isUnaryExpression(node) &&
    node.operator === "-" &&
    t.isNumericLiteral(node.argument)
  ) {
    return -node.argument.value;
  }
  return null;
}

// Pull the 91-char `table` string out of a (decode) function's body.
function extractTable(fnPath) {
  let table = null;
  fnPath.traverse({
    VariableDeclarator(p) {
      if (
        t.isIdentifier(p.node.id, { name: "table" }) &&
        t.isStringLiteral(p.node.init)
      ) {
        table = p.node.init.value;
        p.stop();
      }
    },
  });
  return table;
}

// Resolve an array binding to its literal string elements (or null).
function extractArray(arrPath) {
  const node = arrPath.node;
  let init = null;
  if (t.isVariableDeclarator(node)) init = node.init;
  if (!t.isArrayExpression(init)) return null;
  return init.elements.map((el) => (t.isStringLiteral(el) ? el.value : null));
}

/**
 * Given the binding path of a candidate getter function, verify the structural
 * pattern and return { table, values } where `values` is the decoded source
 * array. Returns null if it is not a string-concealing getter.
 *
 * Pattern:  function f(p){ return D(ARR[p]); }
 */
function analyzeGetter(fnPath, cache) {
  if (cache.has(fnPath.node)) return cache.get(fnPath.node);
  const fail = () => {
    cache.set(fnPath.node, null);
    return null;
  };

  const fn = fnPath.node;
  if (!t.isFunction(fn) || fn.params.length !== 1) return fail();
  const param = fn.params[0];
  if (!t.isIdentifier(param)) return fail();

  const body = fn.body;
  if (!t.isBlockStatement(body) || body.body.length !== 1) return fail();
  const ret = body.body[0];
  if (!t.isReturnStatement(ret) || !t.isCallExpression(ret.argument)) {
    return fail();
  }

  const call = ret.argument;
  if (!t.isIdentifier(call.callee) || call.arguments.length !== 1) return fail();
  const member = call.arguments[0];
  if (
    !t.isMemberExpression(member) ||
    !member.computed ||
    !t.isIdentifier(member.object) ||
    !t.isIdentifier(member.property, { name: param.name })
  ) {
    return fail();
  }

  // Resolve the decode function and the source array through scope bindings.
  const decodeBinding = fnPath.scope.getBinding(call.callee.name);
  const arrayBinding = fnPath.scope.getBinding(member.object.name);
  if (!decodeBinding || !arrayBinding) return fail();

  if (!decodeBinding.path.isFunction()) return fail();
  const table = extractTable(decodeBinding.path);
  if (!table) return fail();

  const values = extractArray(arrayBinding.path);
  if (!values) return fail();

  const info = { table, values };
  cache.set(fnPath.node, info);
  return info;
}

// Names that belong to the obfuscator scaffolding and are safe to drop once
// they become unreferenced. JS-Confuser prefixes its helpers with `__`.
function isScaffoldName(name) {
  return name.startsWith("__") || name === "utf8ArrayToStr";
}

/**
 * Deobfuscate a source string. Returns the transformed source.
 */
function parse(code) {
  return parser.parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
  });
}

// One sweep removing scaffold-named bindings that are currently unreferenced.
// Returns true if anything was removed. Must be run on a freshly-parsed AST so
// that `binding.referenced` reflects reality (Babel does not eagerly recompute
// reference counts after replaceWith/remove within the same tree).
function cleanupSweep(ast) {
  let removed = false;
  traverse(ast, {
    "FunctionDeclaration|VariableDeclarator"(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id) || !isScaffoldName(id.name)) return;
      const binding = path.scope.getBinding(id.name);
      if (binding && !binding.referenced) {
        path.remove();
        removed = true;
      }
    },
  });
  return removed;
}

function deobfuscate(code) {
  let ast = parse(code);

  const getterCache = new Map();

  // --- Pass 1: inline every getter(<constant>) call into a string literal. ---
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || path.node.arguments.length !== 1) return;

      const index = constIndex(path.node.arguments[0]);
      if (index === null) return;

      const binding = path.scope.getBinding(callee.name);
      if (!binding || !binding.path.isFunction()) return;

      const info = analyzeGetter(binding.path, getterCache);
      if (!info) return;

      const encoded = info.values[index];
      if (typeof encoded !== "string") return; // hole / non-literal element

      const decoded = base91Decode(info.table, encoded);
      path.replaceWith(t.stringLiteral(decoded));
    },
  });

  // --- Pass 2: remove the now-dead obfuscator scaffolding (fixpoint). ---
  // Re-parse before the first sweep (and between sweeps) so reference counts are
  // accurate; this lets the dead-code cascade run to completion:
  //   call sites inlined -> getters dead -> decode fns dead -> array + UTF-8
  //   helpers dead -> getGlobal/global vars dead.
  ast = parse(generate(ast).code);
  while (cleanupSweep(ast)) {
    ast = parse(generate(ast).code);
  }

  const out = generate(ast, {
    comments: true,
    jsescOption: { minimal: true },
  });
  return out.code;
}

/**
 * Module entry point: read a file, return its deobfuscated source.
 * Usage as a library:  require('./stringConcealing.js')('input.js')
 */
function deobfuscateFile(inputPath) {
  const fs = require("fs");
  const code = fs.readFileSync(inputPath, "utf-8");
  return deobfuscate(code);
}

module.exports = deobfuscateFile;
module.exports.deobfuscate = deobfuscate;
module.exports.base91Decode = base91Decode;

// --- CLI:  stringConcealing.js input.js output.js ---
if (require.main === module) {
  const fs = require("fs");
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath) {
    console.error("Usage: stringConcealing.js <input.js> [output.js]");
    process.exit(1);
  }
  const result = deobfuscate(fs.readFileSync(inputPath, "utf-8"));
  if (outputPath) {
    fs.writeFileSync(outputPath, result);
    console.error(`Wrote deobfuscated output to ${outputPath}`);
  } else {
    process.stdout.write(result);
  }
}
