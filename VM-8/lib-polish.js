'use strict';
// ---------------------------------------------------------------------------
// Source-level cleanup of the reconstructed program: expression folding
// (re-nesting the three-address temporaries the VM compiler introduced),
// method-call recovery, dead store removal and loop shape recovery.
// ---------------------------------------------------------------------------
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

const RESERVED_WORDS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public', 'null', 'true', 'false']);
// Standard globals are assumed not to be reassigned by intervening calls, which
// lets a temporary holding one of them be folded into its single use.
const SAFE_GLOBALS = new Set(['Math', 'JSON', 'String', 'Number', 'Boolean', 'Object', 'Array',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'console', 'document', 'window', 'globalThis',
  'navigator', 'location', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'NaN',
  'Infinity', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'Function']);
const PURE_TYPES = new Set(['NumericLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral',
  'RegExpLiteral', 'Identifier', 'ThisExpression', 'FunctionExpression', 'ArrowFunctionExpression',
  'TemplateLiteral']);

function isPure(node) {
  if (!node) return true;
  if (PURE_TYPES.has(node.type)) return true;
  switch (node.type) {
    case 'UnaryExpression': return node.operator !== 'delete' && isPure(node.argument);
    case 'BinaryExpression': return isPure(node.left) && isPure(node.right);
    case 'LogicalExpression': return isPure(node.left) && isPure(node.right);
    case 'ConditionalExpression': return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate);
    case 'MemberExpression': return isPure(node.object) && (node.computed ? isPure(node.property) : true);
    case 'ArrayExpression': return node.elements.every(e => !e || isPure(e));
    case 'ObjectExpression': return node.properties.every(p => p.type === 'ObjectProperty' && isPure(p.value));
    default: return false;
  }
}
function isLiteralish(node) {
  return node && (PURE_TYPES.has(node.type) && node.type !== 'Identifier' && node.type !== 'FunctionExpression' ||
    (node.type === 'UnaryExpression' && node.operator === 'void'));
}

// Leaf evaluations of a node, in evaluation order.
function leaves(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  switch (node.type) {
    case 'Identifier': out.push(node); return out;
    case 'MemberExpression': leaves(node.object, out); if (node.computed) leaves(node.property, out); out.push(node); return out;
    case 'CallExpression': case 'NewExpression': leaves(node.callee, out); node.arguments.forEach(a => leaves(a, out)); out.push(node); return out;
    case 'AssignmentExpression':
      if (node.left.type !== 'Identifier') leaves(node.left, out);
      leaves(node.right, out);
      return out;
    case 'BinaryExpression': case 'LogicalExpression': leaves(node.left, out); leaves(node.right, out); return out;
    case 'UnaryExpression': leaves(node.argument, out); return out;
    case 'ConditionalExpression': leaves(node.test, out); leaves(node.consequent, out); leaves(node.alternate, out); return out;
    case 'ArrayExpression': node.elements.forEach(e => leaves(e, out)); return out;
    case 'ObjectExpression': node.properties.forEach(p => p.value && leaves(p.value, out)); return out;
    case 'SpreadElement': leaves(node.argument, out); return out;
    case 'ExpressionStatement': leaves(node.expression, out); return out;
    case 'ReturnStatement': leaves(node.argument, out); return out;
    case 'ThrowStatement': leaves(node.argument, out); return out;
    case 'IfStatement': leaves(node.test, out); return out;
    case 'WhileStatement': leaves(node.test, out); return out;
    case 'VariableDeclaration': node.declarations.forEach(d => leaves(d.init, out)); return out;
    default: return out;
  }
}

function idsIn(node) {
  const set = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n.type) return;
    if (n.type === 'Identifier') { set.add(n.name); return; }
    if (n.type === 'MemberExpression' && !n.computed) { walk(n.object); return; }
    for (const k of Object.keys(n)) if (!['loc', 'start', 'end', 'leadingComments', 'trailingComments'].includes(k)) walk(n[k]);
  };
  walk(node);
  return set;
}

function isUncapturedLocal(binding, fnNode) {
  if (!binding) return false;
  if (!['var', 'let', 'const', 'param'].includes(binding.kind)) return false;
  const inSameFunction = (p) => {
    let cur = p;
    while (cur) {
      if (cur.isFunction()) return cur.node === fnNode;
      cur = cur.parentPath;
    }
    return false;
  };
  for (const r of binding.referencePaths) if (!inSameFunction(r)) return false;
  for (const v of binding.constantViolations) if (!inSameFunction(v)) return false;
  return true;
}

// --- inline single-assignment / single-use temporaries ---------------------
function inlineTemps(ast) {
  let total = 0;
  for (let round = 0; round < 12; round++) {
    let changed = 0;
    traverse(ast, {
      Function(fnPath) {
        const scope = fnPath.scope;
        scope.crawl();
        for (const name of Object.keys(scope.bindings)) {
          const b = scope.bindings[name];
          if (b.kind !== 'var') continue;
          if (b.path.node.init) continue;
          if (b.constantViolations.length !== 1) continue;
          if (b.referencePaths.length !== 1) continue;
          const vio = b.constantViolations[0];
          if (!vio.isAssignmentExpression() || vio.node.operator !== '=') continue;
          if (!vio.parentPath.isExpressionStatement()) continue;
          const ref = b.referencePaths[0];
          const expr = vio.node.right;

          const assignStmt = vio.parentPath;
          const container = assignStmt.container;
          if (!Array.isArray(container)) continue;
          let refStmt = ref;
          while (refStmt && refStmt.container !== container) refStmt = refStmt.parentPath;
          if (!refStmt) continue;
          const ai = container.indexOf(assignStmt.node);
          const ri = container.indexOf(refStmt.node);
          if (ai < 0 || ri < ai) continue;

          const used = idsIn(expr);
          const simple = isLiteralish(expr) || expr.type === 'Identifier' ||
            (expr.type === 'MemberExpression' && !expr.computed && expr.object.type === 'Identifier' &&
             SAFE_GLOBALS.has(expr.object.name));
          let ok = true;
          if (ri > ai) {
            if (!simple) {
              // no intervening write to anything the expression reads
              for (let k = ai + 1; k < ri && ok; k++) {
                const between = container[k];
                for (const w of writtenIn(between)) if (used.has(w)) ok = false;
                if (!isPure(between) && !allSafeLocals(used, scope, fnPath.node)) ok = false;
              }
            } else {
              for (let k = ai + 1; k < ri && ok; k++) {
                for (const w of writtenIn(container[k])) if (used.has(w)) ok = false;
              }
            }
          }
          if (!ok) continue;
          if (!isPure(expr)) {
            if (ri !== ai + 1) continue;
            const ls = leaves(refStmt.node);
            const pos = ls.indexOf(ref.node);
            if (pos < 0) continue;
            let fine = true;
            for (let k = 0; k < pos; k++) {
              const l = ls[k];
              if (l.type === 'MemberExpression') continue;
              if (l.type !== 'Identifier') { fine = false; break; }
              if (SAFE_GLOBALS.has(l.name)) continue;
              if (!isUncapturedLocal(scope.getBinding(l.name), fnPath.node)) { fine = false; break; }
            }
            if (fine) {
              for (let k = 0; k < pos; k++) {
                const l = ls[k];
                if (l.type === 'MemberExpression' &&
                    !(l.object.type === 'Identifier' && SAFE_GLOBALS.has(l.object.name) && !l.computed)) {
                  fine = false; break;
                }
              }
            }
            if (!fine) continue;
          }
          ref.replaceWith(expr);
          assignStmt.remove();
          changed++;
        }
      },
    });
    total += changed;
    if (!changed) break;
  }
  return total;
}

function writtenIn(node) {
  const set = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n.type) return;
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') set.add(n.left.name);
    if ((n.type === 'UpdateExpression') && n.argument.type === 'Identifier') set.add(n.argument.name);
    if (n.type === 'CallExpression' || n.type === 'NewExpression') set.add(' call');
    for (const k of Object.keys(n)) if (!['loc', 'start', 'end'].includes(k)) walk(n[k]);
  };
  walk(node);
  return set;
}
function allSafeLocals(names, scope, fnNode) {
  for (const n of names) if (!isUncapturedLocal(scope.getBinding(n), fnNode)) return false;
  return true;
}

// --- peepholes -------------------------------------------------------------
function peephole(ast) {
  traverse(ast, {
    // obj.m.call(obj, ...) -> obj.m(...)
    CallExpression(path) {
      const c = path.node.callee;
      if (!t.isMemberExpression(c) || c.computed || c.property.name !== 'call') return;
      const inner = c.object;
      if (!t.isMemberExpression(inner)) return;
      const args = path.node.arguments;
      if (!args.length) return;
      if (!sameSimple(inner.object, args[0])) return;
      path.replaceWith(t.callExpression(inner, args.slice(1)));
    },
    ObjectProperty(path) {
      const n = path.node;
      if (n.computed && t.isStringLiteral(n.key) &&
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n.key.value) && !RESERVED_WORDS.has(n.key.value)) {
        n.computed = false;
        n.key = t.identifier(n.key.value);
      } else if (n.computed && (t.isStringLiteral(n.key) || t.isNumericLiteral(n.key))) {
        n.computed = false;
      }
    },
    MemberExpression(path) {
      const n = path.node;
      if (n.computed && t.isStringLiteral(n.property) &&
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n.property.value) && !RESERVED_WORDS.has(n.property.value)) {
        n.computed = false;
        n.property = t.identifier(n.property.value);
      }
    },
    EmptyStatement(path) { path.remove(); },
    ReturnStatement(path) {
      const a = path.node.argument;
      if (a && t.isUnaryExpression(a) && a.operator === 'void' && t.isNumericLiteral(a.argument)) {
        path.node.argument = null;
      }
    },
    // while (true) { ...pre; if (c) { body; continue; } else break; }
    //   ->  while (c) { body }   (when there is no prefix)
    //   ->  while (true) { pre; if (!c) break; body }
    WhileStatement(path) {
      const n = path.node;
      if (!t.isBooleanLiteral(n.test, { value: true })) return;
      const body = n.body.body.slice();
      // an unconditional jump makes everything after it unreachable
      for (let i = 0; i < body.length; i++) {
        if (t.isBreakStatement(body[i]) || t.isContinueStatement(body[i]) ||
            t.isReturnStatement(body[i]) || t.isThrowStatement(body[i])) { body.length = i + 1; break; }
        if (t.isIfStatement(body[i]) && body[i].alternate &&
            terminates(body[i].consequent) && terminates(body[i].alternate)) { body.length = i + 1; break; }
      }
      if (!body.length) return;
      const last = body[body.length - 1];
      if (!t.isIfStatement(last) || !last.alternate) {
        if (body.length !== n.body.body.length) { n.body.body = body; }
        return;
      }
      const cons = t.isBlockStatement(last.consequent) ? last.consequent.body : [last.consequent];
      const alt = t.isBlockStatement(last.alternate) ? last.alternate.body : [last.alternate];
      const endsContinue = cons.length && t.isContinueStatement(cons[cons.length - 1]) && !cons[cons.length - 1].label;
      const altBreaks = alt.length === 1 && t.isBreakStatement(alt[0]) && !alt[0].label;
      if (!endsContinue || !altBreaks) {
        if (body.length !== n.body.body.length) n.body.body = body;
        return;
      }
      const pre = body.slice(0, -1);
      const inner = cons.slice(0, -1);
      while (inner.length && t.isContinueStatement(inner[inner.length - 1]) && !inner[inner.length - 1].label) inner.pop();
      if (!pre.length) {
        path.replaceWith(t.whileStatement(last.test, t.blockStatement(inner)));
      } else {
        n.body.body = pre.concat([t.ifStatement(t.unaryExpression('!', last.test), t.breakStatement())], inner);
      }
    },
    // if (c) { ...return } else { B }  ->  if (c) { ...return } B
    IfStatement(path) {
      const n = path.node;
      if (!n.alternate || !Array.isArray(path.container)) return;
      if (!terminates(n.consequent)) return;
      const alt = t.isBlockStatement(n.alternate) ? n.alternate.body : [n.alternate];
      n.alternate = null;
      path.insertAfter(alt);
    },
    Function(path) {
      const b = path.node.body;
      if (t.isBlockStatement(b)) trimTailReturns(b.body);
    },
    Loop(path) {
      const b = path.node.body;
      if (!t.isBlockStatement(b)) return;
      while (b.body.length && t.isContinueStatement(b.body[b.body.length - 1]) && !b.body[b.body.length - 1].label) {
        b.body.pop();
      }
    },
  });
}
function trimTailReturns(stmts) {
  while (stmts.length) {
    const last = stmts[stmts.length - 1];
    if (t.isReturnStatement(last) && !last.argument) { stmts.pop(); continue; }
    if (t.isIfStatement(last)) {
      if (t.isBlockStatement(last.consequent)) trimTailReturns(last.consequent.body);
      if (last.alternate && t.isBlockStatement(last.alternate)) trimTailReturns(last.alternate.body);
    } else if (t.isBlockStatement(last)) trimTailReturns(last.body);
    return;
  }
}
function terminates(node) {
  const arr = t.isBlockStatement(node) ? node.body : [node];
  const last = arr[arr.length - 1];
  return !!last && (t.isBreakStatement(last) || t.isContinueStatement(last) ||
    t.isReturnStatement(last) || t.isThrowStatement(last));
}
function sameSimple(a, b) {
  if (t.isIdentifier(a) && t.isIdentifier(b)) return a.name === b.name;
  if (t.isThisExpression(a) && t.isThisExpression(b)) return true;
  return false;
}

// --- dead stores and unused declarations ----------------------------------
function removeDeadStores(ast) {
  let changed = true;
  while (changed) {
    changed = false;
    traverse(ast, {
      Function(fnPath) {
        const scope = fnPath.scope;
        scope.crawl();
        for (const name of Object.keys(scope.bindings)) {
          const b = scope.bindings[name];
          if (b.kind !== 'var' || b.referencePaths.length) continue;
          for (const vio of b.constantViolations.slice()) {
            if (!vio.isAssignmentExpression() || vio.node.operator !== '=') continue;
            if (!vio.parentPath.isExpressionStatement()) continue;
            if (isPure(vio.node.right)) { vio.parentPath.remove(); changed = true; }
            else { vio.parentPath.replaceWith(t.expressionStatement(vio.node.right)); changed = true; }
          }
        }
      },
    });
    if (changed) continue;
    traverse(ast, {
      VariableDeclaration(path) {
        const keep = path.node.declarations.filter(d => {
          if (d.init) return true;
          const b = path.scope.getBinding(d.id.name);
          if (!b) return true;
          return b.referencePaths.length > 0 || b.constantViolations.length > 0;
        });
        if (keep.length !== path.node.declarations.length) {
          if (!keep.length) path.remove();
          else path.node.declarations = keep;
          changed = true;
        }
      },
    });
    if (changed) { changed = false; break; }
  }
}

// `vN_k` temporaries are SSA versions of register N; drop the version suffix
// wherever only one version of that register survived.
function renameTemps(ast) {
  traverse(ast, {
    Function(path) {
      path.scope.crawl();
      const groups = new Map();
      for (const name of Object.keys(path.scope.bindings)) {
        const m = /^v(\d+)_(\d+)$/.exec(name);
        if (!m) continue;
        if (!groups.has(m[1])) groups.set(m[1], []);
        groups.get(m[1]).push(name);
      }
      for (const [orig, list] of groups) {
        list.sort();
        if (list.length === 1 && !path.scope.hasBinding('v' + orig)) {
          path.scope.rename(list[0], 'v' + orig);
        } else {
          list.forEach((n, i) => {
            const target = 'v' + orig + '_' + i;
            if (n !== target && !path.scope.hasBinding(target)) path.scope.rename(n, target);
          });
        }
      }
    },
  });
}

// A variable assigned a literal exactly once can be folded into every read
// that the assignment reaches, however many there are.
function propagateLiterals(ast) {
  let changed = 0;
  traverse(ast, {
    Function(fnPath) {
      const scope = fnPath.scope;
      scope.crawl();
      for (const name of Object.keys(scope.bindings)) {
        const b = scope.bindings[name];
        if (b.kind !== 'var' || b.path.node.init) continue;
        if (b.constantViolations.length !== 1 || !b.referencePaths.length) continue;
        const vio = b.constantViolations[0];
        if (!vio.isAssignmentExpression() || vio.node.operator !== '=') continue;
        if (!vio.parentPath.isExpressionStatement()) continue;
        const expr = vio.node.right;
        if (!isLiteralish(expr)) continue;
        const container = vio.parentPath.container;
        if (!Array.isArray(container)) continue;
        const ai = container.indexOf(vio.parentPath.node);
        let all = true;
        const refs = [];
        for (const ref of b.referencePaths) {
          let st = ref;
          while (st && st.container !== container) st = st.parentPath;
          if (!st || container.indexOf(st.node) <= ai) { all = false; break; }
          refs.push(ref);
        }
        if (!all) continue;
        for (const ref of refs) ref.replaceWith(t.cloneNode(expr));
        vio.parentPath.remove();
        changed++;
      }
    },
  });
  return changed;
}

function polish(ast) {
  inlineTemps(ast);
  propagateLiterals(ast);
  peephole(ast);
  removeDeadStores(ast);
  inlineTemps(ast);
  peephole(ast);
  propagateLiterals(ast);
  peephole(ast);
  removeDeadStores(ast);
  renameTemps(ast);
  return ast;
}

module.exports = { polish, inlineTemps, peephole, removeDeadStores, renameTemps, propagateLiterals, isPure };
