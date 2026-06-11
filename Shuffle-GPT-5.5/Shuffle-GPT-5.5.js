const fs = require("fs");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

function parseJavaScript(code) {
  return parser.parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: [
      "asyncGenerators",
      "bigInt",
      "classProperties",
      "classPrivateMethods",
      "classPrivateProperties",
      "dynamicImport",
      "importMeta",
      "logicalAssignment",
      "nullishCoalescingOperator",
      "numericSeparator",
      "objectRestSpread",
      "optionalCatchBinding",
      "optionalChaining",
      "topLevelAwait",
    ],
  });
}

function unwrapSingleStatementBlock(node) {
  if (t.isBlockStatement(node) && node.body.length === 1) {
    return node.body[0];
  }

  return node;
}

function bindingNameMatches(node, expectedName) {
  return t.isIdentifier(node, { name: expectedName });
}

function isZero(node) {
  return t.isNumericLiteral(node, { value: 0 });
}

function isOne(node) {
  return t.isNumericLiteral(node, { value: 1 });
}

function getForLoopIndexName(init) {
  if (
    t.isVariableDeclaration(init) &&
    init.declarations.length === 1 &&
    t.isIdentifier(init.declarations[0].id) &&
    isZero(init.declarations[0].init)
  ) {
    return init.declarations[0].id.name;
  }

  if (
    t.isAssignmentExpression(init, { operator: "=" }) &&
    t.isIdentifier(init.left) &&
    isZero(init.right)
  ) {
    return init.left.name;
  }

  return null;
}

function isCountTest(test, indexName, countName) {
  return (
    t.isBinaryExpression(test, { operator: "<" }) &&
    bindingNameMatches(test.left, indexName) &&
    bindingNameMatches(test.right, countName)
  );
}

function isIndexIncrement(update, indexName) {
  if (
    t.isUpdateExpression(update) &&
    update.operator === "++" &&
    bindingNameMatches(update.argument, indexName)
  ) {
    return true;
  }

  return (
    t.isAssignmentExpression(update, { operator: "+=" }) &&
    bindingNameMatches(update.left, indexName) &&
    isOne(update.right)
  );
}

function isPushShiftStatement(statement, arrayName) {
  const expr = t.isExpressionStatement(statement) ? statement.expression : statement;

  return (
    t.isCallExpression(expr) &&
    t.isMemberExpression(expr.callee) &&
    !expr.callee.computed &&
    bindingNameMatches(expr.callee.object, arrayName) &&
    t.isIdentifier(expr.callee.property, { name: "push" }) &&
    expr.arguments.length === 1 &&
    t.isCallExpression(expr.arguments[0]) &&
    t.isMemberExpression(expr.arguments[0].callee) &&
    !expr.arguments[0].callee.computed &&
    bindingNameMatches(expr.arguments[0].callee.object, arrayName) &&
    t.isIdentifier(expr.arguments[0].callee.property, { name: "shift" }) &&
    expr.arguments[0].arguments.length === 0
  );
}

function isReturnArray(statement, arrayName) {
  return t.isReturnStatement(statement) && bindingNameMatches(statement.argument, arrayName);
}

function matchShuffleFunction(functionNode) {
  if (functionNode.params.length < 2) {
    return null;
  }

  const arrayParam = functionNode.params[0];
  const countParam = functionNode.params[1];

  if (!t.isIdentifier(arrayParam) || !t.isIdentifier(countParam)) {
    return null;
  }

  const statements = functionNode.body.body;

  if (statements.length !== 2 || !t.isForStatement(statements[0])) {
    return null;
  }

  const loop = statements[0];
  const indexName = getForLoopIndexName(loop.init);

  if (
    !indexName ||
    !isCountTest(loop.test, indexName, countParam.name) ||
    !isIndexIncrement(loop.update, indexName) ||
    !isPushShiftStatement(unwrapSingleStatementBlock(loop.body), arrayParam.name) ||
    !isReturnArray(statements[1], arrayParam.name)
  ) {
    return null;
  }

  return {
    arrayParamName: arrayParam.name,
    countParamName: countParam.name,
  };
}

function rotateLeft(elements, count) {
  if (elements.length === 0) {
    return [];
  }

  const offset = ((count % elements.length) + elements.length) % elements.length;
  return elements.slice(offset).concat(elements.slice(0, offset));
}

function finiteIntegerFromPath(path) {
  const result = path.evaluate();

  if (result.confident && Number.isFinite(result.value) && Number.isInteger(result.value)) {
    return result.value;
  }

  return null;
}

function deobfuscateShuffle(code) {
  const ast = parseJavaScript(code);
  const shuffleBindings = new Map();

  traverse(ast, {
    FunctionDeclaration(path) {
      const match = matchShuffleFunction(path.node);

      if (!match || !path.node.id) {
        return;
      }

      const binding = path.parentPath.scope.getBinding(path.node.id.name);

      if (binding) {
        shuffleBindings.set(binding, {
          name: path.node.id.name,
          declarationPath: path,
        });
      }
    },
  });

  traverse(ast, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee)) {
        return;
      }

      const binding = path.scope.getBinding(path.node.callee.name);
      const shuffleInfo = binding && shuffleBindings.get(binding);

      if (!shuffleInfo || path.node.arguments.length < 2) {
        return;
      }

      const arrayArgumentPath = path.get("arguments.0");
      const countArgumentPath = path.get("arguments.1");

      if (!arrayArgumentPath.isArrayExpression()) {
        return;
      }

      const count = finiteIntegerFromPath(countArgumentPath);

      if (count === null) {
        return;
      }

      const elements = arrayArgumentPath.node.elements;

      if (elements.some((element) => element === null)) {
        return;
      }

      path.replaceWith(t.arrayExpression(rotateLeft(elements.map((element) => t.cloneNode(element, true)), count)));
    },
  });

  ast.program.scope && ast.program.scope.crawl && ast.program.scope.crawl();

  traverse(ast, {
    Program(path) {
      path.scope.crawl();

      for (const shuffleInfo of shuffleBindings.values()) {
        const binding = path.scope.getBinding(shuffleInfo.name);

        if (binding && binding.referencePaths.length === 0) {
          binding.path.remove();
        }
      }
    },
  });

  return generate(ast, {
    comments: true,
    jsescOption: {
      minimal: true,
    },
  }).code;
}

function runCli() {
  const inputPath = process.argv[2];

  if (!inputPath) {
    console.error("Usage: node Shuffle-GPT-5.5.js <input.js> [output.js]");
    process.exitCode = 1;
    return;
  }

  const outputPath = process.argv[3];
  const input = fs.readFileSync(inputPath, "utf8");
  const output = deobfuscateShuffle(input);

  if (outputPath) {
    fs.writeFileSync(outputPath, output);
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  deobfuscateShuffle,
  matchShuffleFunction,
};
