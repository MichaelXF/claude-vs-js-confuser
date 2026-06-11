#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

function parse(source) {
  return parser.parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: ["bigInt"],
  });
}

function memberName(node) {
  if (!t.isMemberExpression(node)) return null;
  if (t.isIdentifier(node.property) && !node.computed) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  return null;
}

function callMemberName(node) {
  if (!t.isCallExpression(node)) return null;
  return memberName(node.callee);
}

function getBindingName(node) {
  if (t.isIdentifier(node)) return node.name;
  return null;
}

function containsIdentifier(node, name) {
  let found = false;
  t.traverseFast(node, (child) => {
    if (found) return;
    if (t.isIdentifier(child, { name })) found = true;
  });
  return found;
}

function hasObjectPropertyKey(node, keyName) {
  let found = false;
  t.traverseFast(node, (child) => {
    if (found || !t.isObjectProperty(child)) return;
    const key = child.key;
    if (
      (t.isIdentifier(key) && key.name === keyName) ||
      (t.isStringLiteral(key) && key.value === keyName)
    ) {
      found = true;
    }
  });
  return found;
}

function findLzStringHelper(programPath) {
  for (const statementPath of programPath.get("body")) {
    if (!statementPath.isVariableDeclaration()) continue;
    for (const declaratorPath of statementPath.get("declarations")) {
      const id = declaratorPath.node.id;
      const init = declaratorPath.node.init;
      if (!t.isIdentifier(id) || !t.isCallExpression(init)) continue;
      if (
        (t.isFunctionExpression(init.callee) || t.isArrowFunctionExpression(init.callee)) &&
        hasObjectPropertyKey(init.callee.body, "decompressFromUTF16")
      ) {
        return {
          name: id.name,
          statementPath,
          declaratorPath,
        };
      }
    }
  }
  return null;
}

function collectVarDeclarators(bodyStatements) {
  const declarations = new Map();
  for (const statement of bodyStatements) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      const name = getBindingName(declarator.id);
      if (name) declarations.set(name, declarator.init || null);
    }
  }
  return declarations;
}

function isLookupReturn(body, arrayName, paramName) {
  let statement = null;
  if (t.isBlockStatement(body) && body.body.length === 1) {
    statement = body.body[0];
  } else if (t.isExpression(body)) {
    return (
      t.isMemberExpression(body) &&
      t.isIdentifier(body.object, { name: arrayName }) &&
      t.isIdentifier(body.property, { name: paramName })
    );
  }
  if (!t.isReturnStatement(statement)) return false;
  const argument = statement.argument;
  return (
    t.isMemberExpression(argument) &&
    t.isIdentifier(argument.object, { name: arrayName }) &&
    t.isIdentifier(argument.property, { name: paramName })
  );
}

function analyzeDecoderIife(iifeStatement, helperName) {
  if (!iifeStatement.isExpressionStatement()) return null;
  const expression = iifeStatement.node.expression;
  if (!t.isCallExpression(expression)) return null;
  const callee = expression.callee;
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return null;

  const body = t.isBlockStatement(callee.body) ? callee.body.body : [];
  const declarations = collectVarDeclarators(body);
  let compressedVar = null;
  let utf8Var = null;
  let arrayVar = null;

  for (const [name, init] of declarations) {
    if (t.isStringLiteral(init)) compressedVar = name;
  }

  for (const [name, init] of declarations) {
    if (
      t.isCallExpression(init) &&
      t.isMemberExpression(init.callee) &&
      t.isIdentifier(init.callee.object, { name: helperName }) &&
      memberName(init.callee) === "decompressFromUTF16" &&
      init.arguments.length === 1 &&
      (t.isIdentifier(init.arguments[0], { name: compressedVar }) || t.isStringLiteral(init.arguments[0]))
    ) {
      utf8Var = name;
    }
  }

  for (const [name, init] of declarations) {
    if (
      t.isCallExpression(init) &&
      t.isMemberExpression(init.callee) &&
      t.isIdentifier(init.callee.object, { name: utf8Var }) &&
      memberName(init.callee) === "split" &&
      init.arguments.length === 1 &&
      t.isStringLiteral(init.arguments[0], { value: "|" })
    ) {
      arrayVar = name;
    }
  }

  if (!compressedVar || !utf8Var || !arrayVar) return null;

  for (const statement of body) {
    if (!t.isExpressionStatement(statement)) continue;
    const assignment = statement.expression;
    if (!t.isAssignmentExpression(assignment, { operator: "=" })) continue;
    const lookupName = getBindingName(assignment.left);
    const fn = assignment.right;
    if (!lookupName || (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn))) continue;
    if (fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) continue;
    if (isLookupReturn(fn.body, arrayVar, fn.params[0].name)) {
      return {
        lookupName,
        iifeStatement,
      };
    }
  }

  return null;
}

function decodeTable(helperStatement, lookupDeclaration, decoderStatement, lookupName) {
  const helperCode = generate(helperStatement.node).code;
  const lookupCode = lookupDeclaration ? generate(lookupDeclaration.node).code : `var ${lookupName};`;
  const decoderCode = generate(decoderStatement.node).code;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    define: undefined,
    angular: undefined,
    console: { log() {} },
    Uint8Array,
    Array,
    Object,
    String,
    Math,
    RegExp,
  };

  vm.createContext(sandbox);
  vm.runInContext(`${helperCode}\n${lookupCode}\n${decoderCode}`, sandbox, {
    timeout: 1000,
  });

  const lookup = sandbox[lookupName];
  if (typeof lookup !== "function") {
    throw new Error(`Decoded lookup ${lookupName} was not created`);
  }

  const table = [];
  for (let index = 0; index < 10000; index++) {
    const value = lookup(index);
    if (value === undefined) break;
    table.push(String(value));
  }

  if (table.length === 10000) {
    throw new Error("String table did not terminate before safety limit");
  }

  return table;
}

function replaceLookupCalls(ast, lookupName, table) {
  let replacements = 0;
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee, { name: lookupName })) return;
      if (path.node.arguments.length !== 1) return;
      const arg = path.node.arguments[0];
      if (!t.isNumericLiteral(arg)) return;
      const value = table[arg.value];
      if (value === undefined) return;
      path.replaceWith(t.stringLiteral(value));
      replacements++;
    },
  });
  return replacements;
}

function simplifyComputedStringMembers(ast) {
  traverse(ast, {
    MemberExpression(path) {
      if (!path.node.computed || !t.isStringLiteral(path.node.property)) return;
      const name = path.node.property.value;
      if (!t.isValidIdentifier(name)) return;
      path.node.computed = false;
      path.node.property = t.identifier(name);
    },
  });
}

function findLookupDeclaration(programPath, lookupName) {
  for (const statementPath of programPath.get("body")) {
    if (!statementPath.isVariableDeclaration()) continue;
    for (const declaratorPath of statementPath.get("declarations")) {
      if (t.isIdentifier(declaratorPath.node.id, { name: lookupName })) {
        return statementPath;
      }
    }
  }
  return null;
}

function removeStatementOrDeclarator(statementPath, name) {
  if (!statementPath || statementPath.removed) return;
  if (!statementPath.isVariableDeclaration()) {
    statementPath.remove();
    return;
  }
  const declarators = statementPath.get("declarations");
  if (declarators.length === 1) {
    statementPath.remove();
    return;
  }
  for (const declaratorPath of declarators) {
    if (t.isIdentifier(declaratorPath.node.id, { name })) {
      declaratorPath.remove();
    }
  }
}

function maybeRemoveUmd(programPath, helperName) {
  for (const statementPath of programPath.get("body")) {
    if (!statementPath.isExpressionStatement()) continue;
    const code = generate(statementPath.node).code;
    if (
      containsIdentifier(statementPath.node, helperName) &&
      code.includes("define") &&
      code.includes("module") &&
      code.includes("angular")
    ) {
      statementPath.remove();
      return true;
    }
  }
  return false;
}

function transform(source) {
  const ast = parse(source);
  let metadata = { decoded: false, replacements: 0, tableSize: 0 };

  traverse(ast, {
    Program(programPath) {
      const helper = findLzStringHelper(programPath);
      if (!helper) return;

      let decoder = null;
      for (const statementPath of programPath.get("body")) {
        const analyzed = analyzeDecoderIife(statementPath, helper.name);
        if (analyzed) {
          decoder = analyzed;
          break;
        }
      }
      if (!decoder) return;

      const lookupDeclaration = findLookupDeclaration(programPath, decoder.lookupName);
      const table = decodeTable(
        helper.statementPath,
        lookupDeclaration,
        decoder.iifeStatement,
        decoder.lookupName
      );
      const replacements = replaceLookupCalls(ast, decoder.lookupName, table);
      if (replacements === 0) return;

      decoder.iifeStatement.remove();
      removeStatementOrDeclarator(lookupDeclaration, decoder.lookupName);
      maybeRemoveUmd(programPath, helper.name);
      helper.statementPath.remove();
      simplifyComputedStringMembers(ast);

      metadata = {
        decoded: true,
        replacements,
        tableSize: table.length,
      };
      programPath.stop();
    },
  });

  const output = generate(ast, {
    comments: true,
    compact: false,
    jsescOption: { minimal: true },
  }).code;

  return { output, metadata };
}

function main() {
  const inputFile = process.argv[2] || "StringCompression.js";
  const source = fs.readFileSync(path.resolve(inputFile), "utf8");
  const result = transform(source);
  process.stdout.write(result.output);
  if (!result.output.endsWith("\n")) process.stdout.write("\n");
}

if (require.main === module) {
  main();
}

module.exports = {
  transform,
};
