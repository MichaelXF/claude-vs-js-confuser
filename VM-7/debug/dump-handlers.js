// Dumps every handler body (pretty-printed) with its size, smallest first.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const generator = require("@babel/generator").default;

const src = fs.readFileSync(path.join(__dirname, "..", "input.js"), "utf8");
const ast = parser.parse(src, { sourceType: "script" });

const handlers = [];
for (const st of ast.program.body) {
  if (st.type !== "ExpressionStatement") continue;
  const e = st.expression;
  if (e.type !== "AssignmentExpression") continue;
  if (e.left.type !== "MemberExpression" || !e.left.computed) continue;
  if (e.left.object.type !== "Identifier") continue;
  const key = e.left.property;
  if (key.type !== "NumericLiteral") continue;
  const code = generator(e.right, { compact: false }).code;
  handlers.push({ op: key.value, code, size: code.length });
}
handlers.sort((a, b) => a.size - b.size);
const out = handlers.map((h) => `// ===== op ${h.op} (${h.size} chars) =====\n${h.code}\n`).join("\n");
fs.writeFileSync(path.join(__dirname, "handlers.js"), out);
console.log("handlers:", handlers.length);
console.log(handlers.map((h) => `${h.op}:${h.size}`).join(" "));
