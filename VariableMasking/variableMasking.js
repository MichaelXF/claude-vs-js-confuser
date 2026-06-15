const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

function parse(source) {
  return parser.parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: ["jsx", "classProperties", "optionalChaining"],
  });
}

function memberInfo(node, restName) {
  if (!t.isMemberExpression(node) || !t.isIdentifier(node.object, { name: restName })) {
    return null;
  }

  if (!node.computed && t.isIdentifier(node.property, { name: "length" })) {
    return { type: "length" };
  }

  if (!node.computed) {
    return null;
  }

  if (t.isNumericLiteral(node.property) && Number.isInteger(node.property.value) && node.property.value >= 0) {
    return { type: "index", key: node.property.value };
  }

  if (t.isStringLiteral(node.property)) {
    if (node.property.value === "length") {
      return { type: "length" };
    }

    if (/^(?:0|[1-9]\d*)$/.test(node.property.value)) {
      return { type: "index", key: Number(node.property.value) };
    }

    if (t.isValidIdentifier(node.property.value)) {
      return { type: "prop", key: node.property.value };
    }
  }

  return null;
}

function isWholeLengthAssignment(path, restName) {
  if (!path.isExpressionStatement()) {
    return false;
  }

  const expression = path.get("expression");
  if (!expression.isAssignmentExpression({ operator: "=" })) {
    return false;
  }

  const left = expression.get("left");
  return memberInfo(left.node, restName)?.type === "length";
}

function isLengthAssignmentMember(path, restName) {
  const parent = path.parentPath;
  const grandparent = parent?.parentPath;
  return (
    parent?.isAssignmentExpression({ operator: "=" }) &&
    parent.get("left") === path &&
    grandparent?.isExpressionStatement() &&
    memberInfo(path.node, restName)?.type === "length"
  );
}

function undefinedResetInfo(path, restName) {
  if (!path.isExpressionStatement()) {
    return null;
  }

  const expression = path.get("expression");
  if (!expression.isAssignmentExpression({ operator: "=" })) {
    return null;
  }

  const left = expression.get("left");
  const right = expression.get("right");
  const info = memberInfo(left.node, restName);
  if (!info || (info.type !== "index" && info.type !== "prop") || !right.isIdentifier({ name: "undefined" })) {
    return null;
  }

  return info;
}

function isUndefinedReset(path, restName) {
  const info = undefinedResetInfo(path, restName);
  return info?.type === "index" ? info.key : null;
}

function collectIndexUses(path, restName) {
  const used = new Set();
  path.traverse({
    Function(innerPath) {
      innerPath.skip();
    },
    MemberExpression(memberPath) {
      const info = memberInfo(memberPath.node, restName);
      if (info?.type === "index") {
        used.add(info.key);
      }
    },
  });
  return used;
}

function findLocalIndexSlots(functionPath, restName) {
  const body = functionPath.get("body");
  if (!body.isBlockStatement()) {
    return new Set();
  }

  const seen = new Set();
  const locals = new Set();
  for (const statement of body.get("body")) {
    const resetIndex = isUndefinedReset(statement, restName);
    if (resetIndex !== null && !seen.has(resetIndex)) {
      locals.add(resetIndex);
      continue;
    }

    for (const index of collectIndexUses(statement, restName)) {
      seen.add(index);
    }
  }

  return locals;
}

function uniqueName(scope, base, reserved) {
  let name = base.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!/^[A-Za-z_$]/.test(name)) {
    name = `_${name}`;
  }

  let candidate = name;
  let counter = 1;
  while (reserved.has(candidate) || scope.hasBinding(candidate) || scope.hasGlobal(candidate)) {
    candidate = `${name}${counter++}`;
  }

  reserved.add(candidate);
  return t.identifier(candidate);
}

function shouldIgnoreRestReference(path) {
  const parent = path.parentPath;
  return parent.isMemberExpression() && parent.get("object") === path;
}

function transformVariableMaskedFunction(functionPath) {
  const params = functionPath.node.params;
  if (params.length !== 1 || !t.isRestElement(params[0]) || !t.isIdentifier(params[0].argument)) {
    return false;
  }

  const restName = params[0].argument.name;
  const indices = new Set();
  const props = new Set();
  let unsupported = false;

  functionPath.traverse({
    Function(path) {
      path.skip();
    },
    Identifier(path) {
      if (
        path.node.name === restName &&
        path.isReferencedIdentifier() &&
        !shouldIgnoreRestReference(path)
      ) {
        unsupported = true;
      }
    },
    MemberExpression(path) {
      const info = memberInfo(path.node, restName);
      if (!info) {
        return;
      }

      if (info.type === "index") {
        indices.add(info.key);
      } else if (info.type === "prop") {
        props.add(info.key);
      } else if (info.type === "length" && !isLengthAssignmentMember(path, restName)) {
        unsupported = true;
      }
    },
  });

  if (unsupported) {
    return false;
  }

  const localIndices = findLocalIndexSlots(functionPath, restName);
  const reserved = new Set([restName]);
  const paramIndices = [...indices].filter((index) => !localIndices.has(index));
  const maxParamIndex = paramIndices.length ? Math.max(...paramIndices) : -1;
  const paramIds = new Map();
  for (let index = 0; index <= maxParamIndex; index++) {
    paramIds.set(index, uniqueName(functionPath.scope, `${restName}${index}`, reserved));
  }

  const indexIds = new Map();
  for (const index of [...indices].sort((left, right) => left - right)) {
    if (localIndices.has(index)) {
      indexIds.set(index, uniqueName(functionPath.scope, `${restName}${index}`, reserved));
    } else {
      indexIds.set(index, paramIds.get(index));
    }
  }

  const propIds = new Map();
  for (const prop of [...props].sort()) {
    propIds.set(prop, uniqueName(functionPath.scope, `${restName}_${prop}`, reserved));
  }

  functionPath.node.params = [...paramIds.values()].map((id) => t.cloneNode(id));

  const localIds = [
    ...[...localIndices].sort((left, right) => left - right).map((index) => indexIds.get(index)),
    ...propIds.values(),
  ];
  if (localIds.length) {
    const declarations = localIds.map((id) => t.variableDeclarator(t.cloneNode(id)));
    functionPath.get("body").unshiftContainer("body", t.variableDeclaration("let", declarations));
  }

  functionPath.traverse({
    Function(path) {
      path.skip();
    },
    ExpressionStatement(path) {
      const resetInfo = undefinedResetInfo(path, restName);
      if (
        isWholeLengthAssignment(path, restName) ||
        resetInfo?.type === "prop" ||
        (resetInfo?.type === "index" && localIndices.has(resetInfo.key))
      ) {
        path.remove();
      }
    },
    MemberExpression(path) {
      const info = memberInfo(path.node, restName);
      if (!info) {
        return;
      }

      if (info.type === "index") {
        path.replaceWith(t.cloneNode(indexIds.get(info.key)));
      } else if (info.type === "prop") {
        path.replaceWith(t.cloneNode(propIds.get(info.key)));
      }
    },
  });

  return true;
}

function cleanupComputedMembers(ast) {
  traverse(ast, {
    MemberExpression(path) {
      const property = path.node.property;
      if (path.node.computed && t.isStringLiteral(property) && t.isValidIdentifier(property.value)) {
        path.node.computed = false;
        path.node.property = t.identifier(property.value);
      }
    },
    ObjectProperty(path) {
      const key = path.node.key;
      if (path.node.computed && t.isStringLiteral(key) && t.isValidIdentifier(key.value)) {
        path.node.computed = false;
        path.node.key = t.identifier(key.value);
      }
    },
  });
}

function deobfuscateSource(source) {
  const ast = parse(source);

  traverse(ast, {
    Function(path) {
      transformVariableMaskedFunction(path);
    },
  });

  cleanupComputedMembers(ast);

  return generate(ast, {
    comments: false,
    compact: false,
    jsescOption: { minimal: true },
  }).code;
}

function deobfuscateFile(inputFile, outputFile) {
  const source = fs.readFileSync(inputFile, "utf8");
  const output = deobfuscateSource(source);
  if (outputFile) {
    fs.writeFileSync(outputFile, output);
  }
  return output;
}

module.exports = deobfuscateFile;
module.exports.deobfuscateSource = deobfuscateSource;

if (require.main === module) {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    const script = path.basename(process.argv[1]);
    console.error(`Usage: node ${script} <input.js> [output.js]`);
    process.exit(1);
  }

  const output = deobfuscateFile(inputFile, outputFile);
  if (!outputFile) {
    process.stdout.write(output);
  }
}
