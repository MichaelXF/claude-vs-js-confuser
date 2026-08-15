// Alpha-renames each handler (identifiers + member property names) so handlers
// can be recognized across samples where minification picked different names.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const traverse = require("@babel/traverse").default;

function normalizeFn(src) {
  const ast = parser.parse("(" + src + ")", { sourceType: "script" });
  const names = new Map();
  const props = new Map();
  const canon = (map, name, prefix) => {
    if (!map.has(name)) map.set(name, prefix + map.size);
    return map.get(name);
  };
  traverse(ast, {
    Identifier(p) {
      if (p.parent.type === "MemberExpression" && p.parent.property === p && !p.parent.computed) {
        p.node.name = canon(props, p.node.name, "p");
      } else if (p.parent.type === "ObjectProperty" && p.parent.key === p && !p.parent.computed) {
        p.node.name = canon(props, p.node.name, "p");
      } else {
        p.node.name = canon(names, p.node.name, "v");
      }
    },
  });
  return generate(ast, { compact: true, comments: false }).code;
}

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });
const out = [];
for (const st of ast.program.body) {
  if (st.type !== "ExpressionStatement") continue;
  const e = st.expression;
  if (e.type !== "AssignmentExpression") continue;
  if (e.left.type !== "MemberExpression" || !e.left.computed) continue;
  if (e.left.property.type !== "NumericLiteral") continue;
  const code = generate(e.right, { compact: false }).code;
  if (code.length > 2200) continue; // MBA bodies are matched behaviorally instead
  out.push({ op: e.left.property.value, norm: normalizeFn(code), size: code.length });
}
out.sort((a, b) => a.size - b.size);
for (const h of out) console.log(`${h.op}\t${h.norm}`);
console.error("count", out.length);
