"use strict";

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

function parse(source) {
  return parser.parse(source, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
    plugins: ["optionalCatchBinding"],
  });
}

function propName(key) {
  if (t.isIdentifier(key)) {
    return key.name;
  }
  if (t.isStringLiteral(key) || t.isNumericLiteral(key)) {
    return String(key.value);
  }
  return null;
}

function staticString(node) {
  return t.isStringLiteral(node) ? node.value : null;
}

function safeName(name) {
  return "__dispatcher_" + name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

function bindingFor(scope, name) {
  return name ? scope.getBinding(name) : null;
}

function sameBinding(scope, name, binding) {
  return Boolean(binding && bindingFor(scope, name) === binding);
}

function pathContains(path, predicate) {
  let found = false;
  path.traverse({
    noScope: true,
    enter(innerPath) {
      if (predicate(innerPath)) {
        found = true;
        innerPath.stop();
      }
    },
  });
  return found;
}

function firstDispatcherTable(functionPath) {
  let tablePath = null;

  functionPath.traverse({
    VariableDeclarator(path) {
      if (path.getFunctionParent() !== functionPath) {
        return;
      }

      if (
        t.isIdentifier(path.node.id) &&
        t.isObjectExpression(path.node.init) &&
        path.node.init.properties.length > 0 &&
        path.node.init.properties.every((property) => {
          return (
            t.isObjectProperty(property) &&
            propName(property.key) &&
            t.isFunctionExpression(property.value)
          );
        })
      ) {
        tablePath = path;
        path.stop();
      }
    },
  });

  return tablePath;
}

function learnDispatcherShape(functionPath, tableName) {
  const params = functionPath.node.params;
  const keyParam = t.isIdentifier(params[0]) ? params[0].name : null;
  const modeParam = t.isIdentifier(params[1]) ? params[1].name : null;
  const returnParam = t.isIdentifier(params[2]) ? params[2].name : null;
  const shape = {
    keyParam,
    modeParam,
    returnParam,
    argName: null,
    resetMarker: null,
    factoryMarker: null,
    wrappedReturnMarker: null,
    wrappedReturnProperty: null,
    cacheName: null,
    helperName: null,
  };

  functionPath.traverse({
    IfStatement(path) {
      const test = path.node.test;
      if (
        t.isBinaryExpression(test, { operator: "===" }) &&
        t.isIdentifier(test.left) &&
        t.isStringLiteral(test.right)
      ) {
        const testedName = test.left.name;
        const marker = test.right.value;
        if (
          testedName === modeParam &&
          pathContains(path.get("consequent"), (innerPath) => {
            const node = innerPath.node;
            return (
              t.isAssignmentExpression(node) &&
              t.isIdentifier(node.left) &&
              t.isArrayExpression(node.right)
            );
          })
        ) {
          shape.resetMarker = marker;
          path.traverse({
            AssignmentExpression(innerPath) {
              const node = innerPath.node;
              if (
                t.isIdentifier(node.left) &&
                t.isArrayExpression(node.right)
              ) {
                shape.argName = node.left.name;
                innerPath.stop();
              }
            },
          });
        }

        if (
          testedName === modeParam &&
          pathContains(path.get("consequent"), (innerPath) => {
            return t.isFunctionDeclaration(innerPath.node);
          })
        ) {
          shape.factoryMarker = marker;
          path.traverse({
            CallExpression(innerPath) {
              const callee = innerPath.get("callee");
              if (callee.isIdentifier()) {
                shape.helperName = callee.node.name;
                innerPath.stop();
              }
            },
          });
        }

        if (testedName === returnParam) {
          let objectReturn = null;
          path.traverse({
            ReturnStatement(innerPath) {
              if (t.isObjectExpression(innerPath.node.argument)) {
                objectReturn = innerPath.node.argument;
                innerPath.stop();
              }
            },
          });

          if (objectReturn && objectReturn.properties.length === 1) {
            const onlyProperty = objectReturn.properties[0];
            if (t.isObjectProperty(onlyProperty)) {
              shape.wrappedReturnMarker = marker;
              shape.wrappedReturnProperty = propName(onlyProperty.key);
            }
          }
        }
      }
    },

    AssignmentExpression(path) {
      if (shape.cacheName || path.node.operator !== "=") {
        return;
      }

      const left = path.node.left;
      if (!t.isMemberExpression(left) || !t.isIdentifier(left.object)) {
        return;
      }

      const isKeyedByDispatcherKey =
        left.computed && t.isIdentifier(left.property, { name: shape.keyParam });
      if (!isKeyedByDispatcherKey) {
        return;
      }

      const objectName = left.object.name;
      if (objectName !== tableName && objectName !== shape.returnParam) {
        shape.cacheName = objectName;
      }
    },
  });

  if (!shape.argName) {
    const table = firstDispatcherTable(functionPath);
    for (const property of table.node.init.properties) {
      const body = property.value.body.body;
      const first = body[0];
      if (
        t.isVariableDeclaration(first) &&
        first.declarations.length === 1 &&
        t.isArrayPattern(first.declarations[0].id) &&
        t.isIdentifier(first.declarations[0].init)
      ) {
        shape.argName = first.declarations[0].init.name;
        break;
      }
    }
  }

  return shape;
}

function extractFunctions(tablePath, argName) {
  const functions = [];
  const names = new Map();

  for (const property of tablePath.node.init.properties) {
    const key = propName(property.key);
    const functionName = safeName(key);
    const original = property.value;
    const body = t.cloneNode(original.body, true);
    let params = original.params.map((param) => t.cloneNode(param, true));

    const first = body.body[0];
    if (
      argName &&
      t.isVariableDeclaration(first) &&
      first.declarations.length === 1 &&
      t.isArrayPattern(first.declarations[0].id) &&
      t.isIdentifier(first.declarations[0].init, { name: argName })
    ) {
      params = first.declarations[0].id.elements.map((element, index) => {
        return element ? t.cloneNode(element, true) : t.identifier("_arg" + index);
      });
      body.body.shift();
    }

    functions.push(
      t.functionDeclaration(
        t.identifier(functionName),
        params,
        body,
        original.generator,
        original.async
      )
    );
    names.set(key, functionName);
  }

  return { functions, names };
}

function arrayAssignmentTo(path, argBinding) {
  if (!path.isAssignmentExpression({ operator: "=" })) {
    return null;
  }

  const left = path.get("left");
  const right = path.get("right");
  if (
    left.isIdentifier() &&
    sameBinding(left.scope, left.node.name, argBinding) &&
    right.isArrayExpression()
  ) {
    return right.node.elements.map((element) => {
      return element ? t.cloneNode(element, true) : t.identifier("undefined");
    });
  }

  return null;
}

function dispatcherInvocation(path, dispatcherBinding, returnProperty) {
  if (
    (path.isCallExpression() || path.isNewExpression()) &&
    path.get("callee").isIdentifier() &&
    sameBinding(
      path.scope,
      path.node.callee.name,
      dispatcherBinding
    )
  ) {
    const key = staticString(path.node.arguments[0]);
    if (!key) {
      return null;
    }
    return {
      key,
      mode: staticString(path.node.arguments[1]),
      wrapped: false,
    };
  }

  if (path.isMemberExpression()) {
    const property = path.node.computed
      ? staticString(path.node.property)
      : propName(path.node.property);
    const object = path.get("object");

    if (property === returnProperty) {
      const invocation = dispatcherInvocation(
        object,
        dispatcherBinding,
        returnProperty
      );
      if (invocation) {
        invocation.wrapped = true;
        return invocation;
      }
    }
  }

  return null;
}

function replacementFor(invocation, args, functionNames, factoryMarker) {
  const functionName = functionNames.get(invocation.key);
  if (!functionName) {
    return null;
  }

  const id = t.identifier(functionName);
  if (invocation.mode === factoryMarker) {
    return id;
  }

  return t.callExpression(id, args.map((arg) => t.cloneNode(arg, true)));
}

function isWrappedDispatcherParent(path, dispatcherBinding, returnProperty) {
  const parent = path.parentPath;
  if (!parent || !parent.isMemberExpression() || parent.get("object") !== path) {
    return false;
  }
  return Boolean(dispatcherInvocation(parent, dispatcherBinding, returnProperty));
}

function replaceDispatcherCalls(ast, info) {
  let replacements = 0;
  const {
    dispatcherName,
    dispatcherBinding,
    argBinding,
    returnProperty,
    factoryMarker,
    functionNames,
  } = info;

  traverse(ast, {
    SequenceExpression(path) {
      const expressions = path.get("expressions");
      if (expressions.length < 2) {
        return;
      }

      const firstArgs = arrayAssignmentTo(expressions[0], argBinding);
      if (!firstArgs) {
        return;
      }

      const last = expressions[expressions.length - 1];
      const invocation = dispatcherInvocation(
        last,
        dispatcherBinding,
        returnProperty
      );
      if (!invocation) {
        return;
      }

      const replacement = replacementFor(
        invocation,
        firstArgs,
        functionNames,
        factoryMarker
      );
      if (!replacement) {
        return;
      }

      if (expressions.length === 2) {
        path.replaceWith(replacement);
      } else {
        path.replaceWith(
          t.sequenceExpression([
            ...expressions
              .slice(1, -1)
              .map((expressionPath) => t.cloneNode(expressionPath.node, true)),
            replacement,
          ])
        );
      }
      replacements++;
      path.skip();
    },

    MemberExpression(path) {
      const invocation = dispatcherInvocation(
        path,
        dispatcherBinding,
        returnProperty
      );
      if (!invocation) {
        return;
      }

      const replacement = replacementFor(
        invocation,
        [],
        functionNames,
        factoryMarker
      );
      if (replacement) {
        path.replaceWith(replacement);
        replacements++;
        path.skip();
      }
    },

    "CallExpression|NewExpression"(path) {
      if (isWrappedDispatcherParent(path, dispatcherBinding, returnProperty)) {
        return;
      }

      const callee = path.get("callee");
      if (
        !callee.isIdentifier() ||
        callee.node.name !== dispatcherName ||
        !sameBinding(path.scope, callee.node.name, dispatcherBinding)
      ) {
        return;
      }

      const invocation = dispatcherInvocation(
        path,
        dispatcherBinding,
        returnProperty
      );
      if (!invocation) {
        return;
      }

      const replacement = replacementFor(
        invocation,
        [],
        functionNames,
        factoryMarker
      );
      if (replacement) {
        path.replaceWith(replacement);
        replacements++;
        path.skip();
      }
    },
  });

  return replacements;
}

function removeBinding(binding) {
  if (!binding) {
    return;
  }

  binding.scope.crawl();
  const fresh = binding.scope.getBinding(binding.identifier.name);
  if (!fresh || fresh.references > 0) {
    return;
  }

  const bindingPath = fresh.path;
  if (bindingPath.isVariableDeclarator()) {
    const declaration = bindingPath.parentPath;
    bindingPath.remove();
    if (declaration.isVariableDeclaration() && declaration.node.declarations.length === 0) {
      declaration.remove();
    }
    return;
  }

  if (bindingPath.isFunctionDeclaration()) {
    bindingPath.remove();
  }
}

function removeUnusedObjectCreateNullBinding(binding) {
  if (!binding) {
    return;
  }

  binding.scope.crawl();
  const fresh = binding.scope.getBinding(binding.identifier.name);
  if (!fresh || fresh.references > 0 || !fresh.path.isVariableDeclarator()) {
    return;
  }

  const init = fresh.path.node.init;
  const isObjectCreateNull =
    t.isCallExpression(init) &&
    init.arguments.length === 1 &&
    t.isNullLiteral(init.arguments[0]) &&
    t.isMemberExpression(init.callee) &&
    t.isIdentifier(init.callee.object, { name: "Object" }) &&
    ((init.callee.computed &&
      t.isStringLiteral(init.callee.property, { value: "create" })) ||
      (!init.callee.computed &&
        t.isIdentifier(init.callee.property, { name: "create" })));

  if (!isObjectCreateNull) {
    return;
  }

  const declaration = fresh.path.parentPath;
  fresh.path.remove();
  if (
    declaration.isVariableDeclaration() &&
    declaration.node.declarations.length === 0
  ) {
    declaration.remove();
  }
}

function transformOne(ast) {
  let dispatcherPath = null;
  let tablePath = null;
  traverse(ast, {
    FunctionDeclaration(path) {
      const possibleTable = firstDispatcherTable(path);
      if (possibleTable) {
        dispatcherPath = path;
        tablePath = possibleTable;
        path.stop();
      }
    },
  });

  if (!dispatcherPath || !tablePath || !t.isIdentifier(dispatcherPath.node.id)) {
    return false;
  }

  const containerScope = dispatcherPath.parentPath.scope;
  const dispatcherName = dispatcherPath.node.id.name;
  const tableName = tablePath.node.id.name;
  const shape = learnDispatcherShape(dispatcherPath, tableName);
  if (!shape.argName || !shape.wrappedReturnProperty) {
    return false;
  }

  const { functions, names } = extractFunctions(tablePath, shape.argName);
  dispatcherPath.insertBefore(functions);
  containerScope.crawl();

  const dispatcherBinding = containerScope.getBinding(dispatcherName);
  const argBinding = containerScope.getBinding(shape.argName);
  const cacheBinding = containerScope.getBinding(shape.cacheName);
  const helperBinding = containerScope.getBinding(shape.helperName);

  for (let pass = 0; pass < 10; pass++) {
    const replacements = replaceDispatcherCalls(ast, {
      dispatcherName,
      dispatcherBinding,
      argBinding,
      returnProperty: shape.wrappedReturnProperty,
      factoryMarker: shape.factoryMarker,
      functionNames: names,
    });
    if (replacements === 0) {
      break;
    }
  }

  dispatcherPath.remove();
  removeBinding(argBinding);
  removeBinding(cacheBinding);
  removeBinding(helperBinding);
  removeUnusedObjectCreateNullBinding(cacheBinding);

  return true;
}

function transformAst(ast) {
  let changed = false;

  for (let pass = 0; pass < 50; pass++) {
    if (!transformOne(ast)) {
      break;
    }
    changed = true;
  }

  return changed;
}

function deobfuscate(inputFile, outputFile) {
  const source = fs.readFileSync(inputFile, "utf8");
  const ast = parse(source);
  const changed = transformAst(ast);
  const output = changed
    ? generate(ast, {
        comments: false,
        compact: false,
        retainLines: false,
      }).code + "\n"
    : source;

  if (outputFile) {
    fs.writeFileSync(outputFile, output);
  }

  return output;
}

if (require.main === module) {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    const script = path.basename(process.argv[1]);
    console.error(`Usage: node ${script} input.js output.js`);
    process.exit(1);
  }

  deobfuscate(input, output);
}

module.exports = deobfuscate;
