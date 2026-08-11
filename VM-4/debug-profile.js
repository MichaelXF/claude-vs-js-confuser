// debug-profile.js - group handlers by "interesting feature" so we can see how
// many are pure-arithmetic (MBA obfuscated) vs structural.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;

const src = fs.readFileSync(path.join(__dirname, "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });

const handlers = [];
traverse(ast, {
  AssignmentExpression(p) {
    const { left, right } = p.node;
    if (
      left.type === "MemberExpression" &&
      left.computed &&
      left.property.type === "NumericLiteral" &&
      right.type === "FunctionExpression"
    ) {
      handlers.push({ op: left.property.value, node: right });
    }
  },
});

// Feature = every global-ish identifier / member name that is not a local var
const PURE = new Set(["x", "Math", "imul", "this", "c", "g", "j", "f", "i"]);
const rows = [];
for (const h of handlers) {
  const feats = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n.type) return;
    if (n.type === "Identifier") feats.add("id:" + n.name);
    if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier")
      feats.add("." + n.property.name);
    if (n.type === "NewExpression") feats.add("new");
    if (n.type === "ThrowStatement") feats.add("throw");
    if (n.type === "ForStatement") feats.add("for");
    if (n.type === "TemplateLiteral") feats.add("tpl");
    if (n.type === "ObjectExpression") feats.add("obj");
    if (n.type === "ArrayExpression") feats.add("arr");
    for (const k in n) {
      if (k === "loc" || k === "type" || k === "start" || k === "end") continue;
      walk(n[k]);
    }
  };
  walk(h.node.body);
  const interesting = [...feats].filter(
    (f) =>
      !/^id:(a|b|c|d|e|f|h|l|m|n|p|q|u|A|H|x|this)$/.test(f) &&
      !/^\.(c|g|j|f|i|h|G|imul)$/.test(f) &&
      f !== "id:Math"
  );
  const code = generate(h.node).code;
  rows.push({ op: h.op, len: code.length, feats: interesting.sort().join(" ") });
}

const byFeat = new Map();
for (const r of rows) {
  if (!byFeat.has(r.feats)) byFeat.set(r.feats, []);
  byFeat.get(r.feats).push(r.op);
}
const out = [...byFeat.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([f, ops]) => `[${ops.length}] ${f || "(pure arithmetic)"}\n    ops: ${ops.join(", ")}`)
  .join("\n");
console.log(out);
fs.writeFileSync(path.join(__dirname, "debug-profile.txt"), out);
