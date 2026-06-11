/**
 * Shuffle Deobfuscator — undoes JS-Confuser's array shuffle technique.
 *
 * Pattern:
 *   function NAME(NAME, rotCount) {
 *     for (var i = 0; i < rotCount; i++) NAME.push(NAME.shift());
 *     return NAME;
 *   }
 *   NAME([...shuffledArray...], N);
 *
 * Strategy:
 *   1. Detect functions matching the push/shift rotation pattern via AST.
 *   2. Find all call-sites where the args are a static ArrayExpression + NumericLiteral.
 *   3. Evaluate the rotation at compile time and replace the call with the result array.
 *   4. Remove the now-unreferenced shuffle function declaration.
 */

const parser   = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t        = require("@babel/types");
const fs       = require("fs");
const path     = require("path");

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

/**
 * Returns true when `node` is a FunctionDeclaration whose body is:
 *   for (var <i> = 0; <i> < <param1>; <i>++) <param0>.push(<param0>.shift());
 *   return <param0>;
 */
function isShuffleFunction(node) {
  if (!t.isFunctionDeclaration(node)) return false;
  if (node.params.length !== 2) return false;

  const arrParam   = node.params[0].name; // first param = array (shadows fn name)
  const countParam = node.params[1].name; // second param = rotation count
  const stmts      = node.body.body;

  if (stmts.length !== 2) return false;

  // ── Return statement ───────────────────────────────────────────────────────
  const ret = stmts[1];
  if (!t.isReturnStatement(ret)) return false;
  if (!t.isIdentifier(ret.argument, { name: arrParam })) return false;

  // ── For statement ──────────────────────────────────────────────────────────
  const forStmt = stmts[0];
  if (!t.isForStatement(forStmt)) return false;

  // init: var <i> = 0
  const init = forStmt.init;
  if (!t.isVariableDeclaration(init) || init.declarations.length !== 1) return false;
  const counterName = init.declarations[0].id.name;
  if (!t.isNumericLiteral(init.declarations[0].init, { value: 0 })) return false;

  // test: <i> < <countParam>
  const test = forStmt.test;
  if (!t.isBinaryExpression(test, { operator: "<" })) return false;
  if (!t.isIdentifier(test.left,  { name: counterName })) return false;
  if (!t.isIdentifier(test.right, { name: countParam  })) return false;

  // update: <i>++ (prefix or postfix)
  const update = forStmt.update;
  if (!t.isUpdateExpression(update, { operator: "++" })) return false;
  if (!t.isIdentifier(update.argument, { name: counterName })) return false;

  // body (with or without block): <arrParam>.push(<arrParam>.shift())
  let bodyStmt = forStmt.body;
  if (t.isBlockStatement(bodyStmt)) {
    if (bodyStmt.body.length !== 1) return false;
    bodyStmt = bodyStmt.body[0];
  }
  if (!t.isExpressionStatement(bodyStmt)) return false;

  const call = bodyStmt.expression;
  if (!t.isCallExpression(call)) return false;

  // callee must be <arrParam>.push
  const pushCallee = call.callee;
  if (!t.isMemberExpression(pushCallee, { computed: false })) return false;
  if (!t.isIdentifier(pushCallee.object,   { name: arrParam })) return false;
  if (!t.isIdentifier(pushCallee.property, { name: "push"   })) return false;

  // single argument: <arrParam>.shift()
  if (call.arguments.length !== 1) return false;
  const shiftCall = call.arguments[0];
  if (!t.isCallExpression(shiftCall)) return false;
  if (shiftCall.arguments.length !== 0) return false;
  const shiftCallee = shiftCall.callee;
  if (!t.isMemberExpression(shiftCallee, { computed: false })) return false;
  if (!t.isIdentifier(shiftCallee.object,   { name: arrParam })) return false;
  if (!t.isIdentifier(shiftCallee.property, { name: "shift"  })) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Compile-time evaluation
// ---------------------------------------------------------------------------

function evaluateShuffle(elements, rotations) {
  const arr = [...elements];
  for (let i = 0; i < rotations; i++) arr.push(arr.shift());
  return arr;
}

/**
 * Try to extract a plain JS value from a Babel literal node.
 * Returns { ok: true, value } or { ok: false }.
 */
function extractLiteral(node) {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) {
    return { ok: true, value: node.value };
  }
  if (t.isNullLiteral(node))      return { ok: true, value: null };
  if (t.isIdentifier(node, { name: "undefined" })) return { ok: true, value: undefined };
  // Handle unary minus on number: -5
  if (
    t.isUnaryExpression(node, { operator: "-", prefix: true }) &&
    t.isNumericLiteral(node.argument)
  ) {
    return { ok: true, value: -node.argument.value };
  }
  return { ok: false };
}

/**
 * Reconstruct a Babel AST node from a plain JS primitive.
 */
function valueToNode(val) {
  if (val === null)      return t.nullLiteral();
  if (val === undefined) return t.identifier("undefined");
  if (typeof val === "number") {
    return val < 0
      ? t.unaryExpression("-", t.numericLiteral(-val))
      : t.numericLiteral(val);
  }
  if (typeof val === "string")  return t.stringLiteral(val);
  if (typeof val === "boolean") return t.booleanLiteral(val);
  throw new Error(`Unsupported value type: ${typeof val}`);
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

function deobfuscate(code) {
  const ast = parser.parse(code, { sourceType: "script" });

  // Pass 1 — collect shuffle function names
  const shuffleNames = new Set();

  traverse(ast, {
    FunctionDeclaration(nodePath) {
      if (isShuffleFunction(nodePath.node)) {
        shuffleNames.add(nodePath.node.id.name);
      }
    },
  });

  if (shuffleNames.size === 0) {
    // Nothing to do — pass the code through unchanged.
    return code;
  }

  // Pass 2 — evaluate static call-sites and replace them with the result array
  traverse(ast, {
    CallExpression(nodePath) {
      const callee = nodePath.node.callee;
      if (!t.isIdentifier(callee)) return;
      if (!shuffleNames.has(callee.name)) return;

      const [arrArg, countArg] = nodePath.node.arguments;
      if (!t.isArrayExpression(arrArg)) return;
      if (!t.isNumericLiteral(countArg)) return;

      // All elements must be static literals
      const elements = [];
      for (const el of arrArg.elements) {
        if (el === null) return; // sparse array — bail out
        const lit = extractLiteral(el);
        if (!lit.ok) return;
        elements.push(lit.value);
      }

      const result      = evaluateShuffle(elements, countArg.value);
      const replacement = t.arrayExpression(result.map(valueToNode));
      nodePath.replaceWith(replacement);
    },
  });

  // Pass 3 — remove shuffle function declarations that are no longer referenced.
  // IMPORTANT: the function's first param shadows the function name inside the body,
  // so we must look up the binding from the *parent* (outer) scope, not from
  // nodePath.scope which would resolve to the parameter binding.
  traverse(ast, {
    FunctionDeclaration(nodePath) {
      if (!shuffleNames.has(nodePath.node.id.name)) return;

      const outerScope = nodePath.parentPath.scope;
      outerScope.crawl(); // ensure bindings are up to date after replacements
      const binding  = outerScope.getBinding(nodePath.node.id.name);
      const refCount = binding ? binding.referencePaths.length : 0;

      if (refCount === 0) {
        nodePath.remove();
      }
    },
  });

  return generate(ast, { retainLines: false, jsescOption: { minimal: true } }, code).code;
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

const inputFile = process.argv[2];
if (!inputFile) {
  console.error("Usage: node Shuffle-Claude.js <input.js> [output.js]");
  process.exit(1);
}

const inputCode  = fs.readFileSync(inputFile, "utf-8");
const outputCode = deobfuscate(inputCode);

const outputFile = process.argv[3];
if (outputFile) {
  fs.writeFileSync(outputFile, outputCode, "utf-8");
  console.log(`Wrote deobfuscated output to: ${outputFile}`);
} else {
  console.log(outputCode);
}
