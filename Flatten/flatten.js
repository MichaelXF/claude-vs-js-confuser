const fs = require("fs");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

function propertyName(key) {
  if (t.isIdentifier(key)) {
    return key.name;
  }
  if (t.isStringLiteral(key) || t.isNumericLiteral(key)) {
    return String(key.value);
  }
  return null;
}

function isIdentifierName(node, name) {
  return t.isIdentifier(node, { name });
}

function getSingleReturnExpression(method) {
  const statements = method.body.body;
  if (statements.length !== 1 || !t.isReturnStatement(statements[0])) {
    return null;
  }
  return statements[0].argument;
}

function getSetterTarget(method) {
  const param = method.params[0];
  if (!t.isIdentifier(param)) {
    return null;
  }

  for (const statement of method.body.body) {
    if (!t.isExpressionStatement(statement)) {
      continue;
    }

    const expression = statement.expression;
    if (
      t.isAssignmentExpression(expression, { operator: "=" }) &&
      isIdentifierName(expression.right, param.name)
    ) {
      return expression.left;
    }
  }

  return null;
}

function getForwardedCallee(method) {
  const argument = method.params[0];
  const returned = getSingleReturnExpression(method);
  if (!t.isRestElement(argument) || !t.isIdentifier(argument.argument) || !t.isCallExpression(returned)) {
    return null;
  }

  const onlyArgument = returned.arguments.length === 1 && returned.arguments[0];
  if (!t.isSpreadElement(onlyArgument) || !isIdentifierName(onlyArgument.argument, argument.argument.name)) {
    return null;
  }

  return returned.callee;
}

function addMapEntry(map, key, value) {
  if (!map.has(key)) {
    map.set(key, {});
  }
  Object.assign(map.get(key), value);
}

function buildContextMap(objectExpression) {
  const map = new Map();

  for (const property of objectExpression.properties) {
    if (!t.isObjectMethod(property)) {
      continue;
    }

    const key = propertyName(property.key);
    if (key === null) {
      continue;
    }

    if (property.kind === "get") {
      const expression = getSingleReturnExpression(property);
      if (expression) {
        addMapEntry(map, key, { getter: expression });
      }
      continue;
    }

    if (property.kind === "set") {
      const target = getSetterTarget(property);
      if (target) {
        addMapEntry(map, key, { setter: target });
      }
      continue;
    }

    if (property.kind === "method") {
      const callee = getForwardedCallee(property);
      if (callee) {
        addMapEntry(map, key, { method: callee });
      }
    }
  }

  return map;
}

function getHandlerInfo(path) {
  const node = path.node;
  if (node.params.length !== 0 || node.body.body.length === 0) {
    return null;
  }

  const firstStatement = node.body.body[0];
  if (!t.isVariableDeclaration(firstStatement) || firstStatement.declarations.length !== 1) {
    return null;
  }

  const declarator = firstStatement.declarations[0];
  if (!t.isArrayPattern(declarator.id) || !isIdentifierName(declarator.init, "arguments")) {
    return null;
  }

  const [contextId, argsPattern] = declarator.id.elements;
  if (!t.isIdentifier(contextId) || !t.isArrayPattern(argsPattern)) {
    return null;
  }

  return {
    node,
    contextName: contextId.name,
    argsPattern,
  };
}

function getWrapperInfo(path, handlers) {
  const params = path.node.params;
  if (
    params.length !== 1 ||
    !t.isRestElement(params[0]) ||
    !t.isIdentifier(params[0].argument)
  ) {
    return null;
  }

  const body = path.node.body.body;
  if (body.length !== 2) {
    return null;
  }

  const [declaration, returned] = body;
  if (!t.isVariableDeclaration(declaration) || declaration.declarations.length !== 1) {
    return null;
  }

  const declarator = declaration.declarations[0];
  if (!t.isIdentifier(declarator.id) || !t.isObjectExpression(declarator.init)) {
    return null;
  }

  if (!t.isReturnStatement(returned) || !t.isCallExpression(returned.argument)) {
    return null;
  }

  const call = returned.argument;
  if (!t.isIdentifier(call.callee) || call.arguments.length !== 2) {
    return null;
  }

  const handler = handlers.get(call.callee.name);
  if (
    !handler ||
    !isIdentifierName(call.arguments[0], declarator.id.name) ||
    !isIdentifierName(call.arguments[1], params[0].argument.name)
  ) {
    return null;
  }

  return {
    contextObject: declarator.init,
    handler,
  };
}

function isContextMember(path, contextBinding) {
  const object = path.get("object");
  return object.isIdentifier() && object.scope.getBinding(object.node.name) === contextBinding;
}

function isAssignmentOrUpdateTarget(path) {
  const parent = path.parentPath;
  return (
    (parent.isAssignmentExpression() && parent.get("left") === path) ||
    (parent.isUpdateExpression() && parent.get("argument") === path)
  );
}

function replacementForMember(path, entry) {
  const parent = path.parentPath;
  if (parent.isCallExpression() && parent.get("callee") === path && entry.method) {
    return t.cloneNode(entry.method, true);
  }

  if (isAssignmentOrUpdateTarget(path) && entry.setter) {
    return t.cloneNode(entry.setter, true);
  }

  if (entry.getter) {
    return t.cloneNode(entry.getter, true);
  }

  if (entry.method) {
    return t.cloneNode(entry.method, true);
  }

  return null;
}

function removeHandlerArgumentUnpack(functionNode) {
  const body = functionNode.body.body;
  const index = body.findIndex((statement) => {
    if (!t.isVariableDeclaration(statement) || statement.declarations.length !== 1) {
      return false;
    }
    const declarator = statement.declarations[0];
    return t.isArrayPattern(declarator.id) && isIdentifierName(declarator.init, "arguments");
  });

  if (index !== -1) {
    body.splice(index, 1);
  }
}

function canUsePatternAsParams(argsPattern) {
  return argsPattern.elements.every((element) => {
    return (
      t.isIdentifier(element) ||
      t.isAssignmentPattern(element) ||
      t.isObjectPattern(element) ||
      t.isArrayPattern(element) ||
      t.isRestElement(element)
    );
  });
}

function inlineHandler(wrapperPath, wrapperInfo) {
  const contextMap = buildContextMap(wrapperInfo.contextObject);
  const clonedFunction = t.cloneNode(wrapperInfo.handler.node, true);
  const file = t.file(t.program([clonedFunction]));

  traverse(file, {
    FunctionDeclaration(path) {
      if (path.node !== clonedFunction) {
        return;
      }

      const contextBinding = path.scope.getBinding(wrapperInfo.handler.contextName);
      path.traverse({
        MemberExpression(memberPath) {
          if (!isContextMember(memberPath, contextBinding)) {
            return;
          }

          const key = propertyName(memberPath.node.property);
          if (key === null || !contextMap.has(key)) {
            return;
          }

          const replacement = replacementForMember(memberPath, contextMap.get(key));
          if (replacement) {
            memberPath.replaceWith(replacement);
          }
        },
      });

      path.stop();
    },
  });

  removeHandlerArgumentUnpack(clonedFunction);

  const statements = [];
  const argCount = wrapperInfo.handler.argsPattern.elements.length;
  if (argCount > 0 && canUsePatternAsParams(wrapperInfo.handler.argsPattern)) {
    wrapperPath.node.params = wrapperInfo.handler.argsPattern.elements
      .filter((element) => element !== null)
      .map((element) => t.cloneNode(element, true));
  } else if (argCount > 0) {
    const argsId = wrapperPath.scope.generateUidIdentifier("args");
    wrapperPath.node.params = [t.restElement(argsId)];
    statements.push(
      t.variableDeclaration("var", [
        t.variableDeclarator(t.cloneNode(wrapperInfo.handler.argsPattern, true), t.cloneNode(argsId)),
      ]),
    );
  } else {
    wrapperPath.node.params = [];
  }

  statements.push(...clonedFunction.body.body);
  wrapperPath.node.body = t.blockStatement(statements);
}

function normalizeSyntax(ast) {
  traverse(ast, {
    MemberExpression(path) {
      if (!path.node.computed || !t.isStringLiteral(path.node.property)) {
        return;
      }

      const name = path.node.property.value;
      if (t.isValidIdentifier(name)) {
        path.node.computed = false;
        path.node.property = t.identifier(name);
      }
    },
    ObjectProperty(path) {
      if (!path.node.computed || !t.isStringLiteral(path.node.key)) {
        return;
      }

      const name = path.node.key.value;
      if (t.isValidIdentifier(name)) {
        path.node.computed = false;
        path.node.key = t.identifier(name);
      }
    },
  });
}

function collectHandlers(ast) {
  const handlers = new Map();
  traverse(ast, {
    FunctionDeclaration(path) {
      if (!path.node.id) {
        return;
      }

      const handler = getHandlerInfo(path);
      if (handler) {
        handlers.set(path.node.id.name, handler);
      }
    },
  });
  return handlers;
}

function removeUnusedHandlers(ast, handlers) {
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
      for (const name of handlers.keys()) {
        const binding = path.scope.getBinding(name);
        if (binding && !binding.referenced && binding.path.isFunctionDeclaration()) {
          binding.path.remove();
        }
      }
    },
  });
}

function deobfuscate(source) {
  const ast = parser.parse(source, {
    sourceType: "script",
    plugins: ["optionalCatchBinding"],
  });

  const handlers = collectHandlers(ast);

  traverse(ast, {
    FunctionDeclaration(path) {
      if (!path.node.id || handlers.has(path.node.id.name)) {
        return;
      }

      const wrapperInfo = getWrapperInfo(path, handlers);
      if (wrapperInfo) {
        inlineHandler(path, wrapperInfo);
      }
    },
  });

  removeUnusedHandlers(ast, handlers);
  normalizeSyntax(ast);

  return generate(ast, {
    comments: false,
    jsescOption: {
      minimal: true,
    },
  }).code;
}

function flatten(inputFile, outputFile) {
  const source = fs.readFileSync(inputFile, "utf8");
  const output = deobfuscate(source);

  if (outputFile) {
    fs.writeFileSync(outputFile, output);
  }

  return output;
}

flatten.deobfuscate = deobfuscate;

if (require.main === module) {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: node flatten.js input.js [output.js]");
    process.exit(1);
  }

  flatten(inputFile, outputFile);
}

module.exports = flatten;
