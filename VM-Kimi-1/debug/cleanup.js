// Cleanup pass: copy-propagation of single-use pure assignments + method-call restoration.
// Works on plain-object Babel ASTs.

function isIdent(n, name) { return n && n.type === 'Identifier' && (name === undefined || n.name === name); }

function isPure(n) {
  if (!n || typeof n !== 'object') return true;
  if (Array.isArray(n)) return n.every(isPure);
  switch (n.type) {
    case 'CallExpression':
    case 'NewExpression':
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'TaggedTemplateExpression':
      return false;
  }
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    if (typeof n[k] === 'object' && !isPure(n[k])) return false;
  }
  return true;
}

function hasCall(n) {
  if (!n || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some(hasCall);
  if (n.type === 'CallExpression' || n.type === 'NewExpression') return true;
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    if (typeof n[k] === 'object' && hasCall(n[k])) return true;
  }
  return false;
}

function freeIdents(n, acc) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(x => freeIdents(x, acc)); return; }
  if (n.type === 'Identifier') { acc.add(n.name); return; }
  if (n.type === 'MemberExpression' && !n.computed) { freeIdents(n.object, acc); return; }
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    if (typeof n[k] === 'object') freeIdents(n[k], acc);
  }
}

function countReads(body, name) {
  // count Identifier reads of `name` in the statement list (any depth)
  let count = 0;
  const walk = (n, isLhs) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, false)); return; }
    if (n.type === 'Identifier' && n.name === name && !isLhs) { count++; return; }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (typeof v !== 'object') continue;
      if (n.type === 'AssignmentExpression' && k === 'left') { walk(v, true); continue; }
      if (n.type === 'VariableDeclarator' && k === 'id') { walk(v, true); continue; }
      walk(v, false);
    }
  };
  body.forEach(s => walk(s, false));
  return count;
}

function writesTo(body, names) {
  // does any statement in body assign to (or update) any of `names`?
  let found = false;
  const walk = n => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ((n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') && n.left && n.left.type === 'Identifier' && names.has(n.left.name)) { found = true; return; }
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && names.has(n.id.name)) { found = true; return; }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (typeof n[k] === 'object') walk(n[k]);
    }
  };
  body.forEach(walk);
  return found;
}

function replaceSingleRead(stmt, name, replacement) {
  // replace the (single) Identifier read of `name` within stmt with `replacement` (cloned)
  let done = false;
  const clone = typeof structuredClone === 'function' ? structuredClone : (x => JSON.parse(JSON.stringify(x)));
  const walk = (n, parent, key, isLhs) => {
    if (done || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((x, i) => walk(x, n, i, false)); return; }
    if (n.type === 'Identifier' && n.name === name && !isLhs) {
      parent[key] = clone(replacement);
      done = true;
      return;
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (typeof v !== 'object') continue;
      if (n.type === 'AssignmentExpression' && k === 'left') { walk(v, n, k, true); continue; }
      if (n.type === 'VariableDeclarator' && k === 'id') { walk(v, n, k, true); continue; }
      walk(v, n, k, false);
      if (done) return;
    }
  };
  walk(stmt, null, null, false);
  return done;
}

// method-call restoration: F.call(O, ...) -> F(... ) when F is O'.prop with O'===O
function methodCalls(body) {
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'CallExpression' && n.callee && n.callee.type === 'MemberExpression' &&
        n.callee.property.type === 'Identifier' && n.callee.property.name === 'call' && n.arguments.length >= 1) {
      const fn = n.callee.object;
      const thisArg = n.arguments[0];
      if (fn.type === 'MemberExpression' && fn.object.type === 'Identifier' && thisArg.type === 'Identifier' && fn.object.name === thisArg.name) {
        n.callee = fn;
        n.arguments = n.arguments.slice(1);
      }
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (typeof n[k] === 'object') walk(n[k]);
    }
  };
  body.forEach(walk);
}

function cleanupPass(body) {
  // recurse into nested blocks first
  for (const s of body) {
    if (s.type === 'IfStatement') { cleanupPass(s.consequent.body); if (s.alternate) cleanupPass(s.alternate.body); }
    else if (s.type === 'WhileStatement') cleanupPass(s.body.body);
    else if (s.type === 'BlockStatement') cleanupPass(s.body);
  }
  // inline single-use assignments within this body
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    let name = null, rhs = null, isDecl = false;
    if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' &&
        s.expression.operator === '=' && s.expression.left.type === 'Identifier') {
      name = s.expression.left.name; rhs = s.expression.right;
    } else if (s.type === 'VariableDeclaration' && s.declarations.length === 1 &&
               s.declarations[0].id.type === 'Identifier' && s.declarations[0].init) {
      name = s.declarations[0].id.name; rhs = s.declarations[0].init; isDecl = true;
    } else continue;

    const pure = isPure(rhs);
    const callOnce = hasCall(rhs);
    if (!pure && !callOnce) continue;

    const rest = body.slice(i + 1);
    const reads = countReads(rest, name);
    const isTemp = /t\d+$/.test(name);
    if (reads === 0) {
      if (isTemp) {
        // dead temp: drop the assignment, keep side effects (if any) as bare statement
        if (pure) body.splice(i, 1);
        else body[i] = { type: 'ExpressionStatement', expression: rhs };
        return true;
      }
      continue;
    }
    const rewrites = writesTo(rest, new Set([name]));
    if (reads !== 1 || rewrites) continue;

    // deps of rhs must be stable between i and the read
    const deps = new Set();
    freeIdents(rhs, deps);
    deps.delete(name);
    if (writesTo(rest, deps)) continue; // conservative: dep changes later -> skip
    // find the statement containing the read
    for (let j = i + 1; j < body.length; j++) {
      if (countReads([body[j]], name) === 1) {
        // inline
        if (replaceSingleRead(body[j], name, rhs)) {
          body.splice(i, 1);
          return true; // changed; restart
        }
      }
    }
  }
  return false;
}

function cleanup(body) {
  let guard = 0;
  while (guard++ < 200) {
    const changed = cleanupPass(body);
    methodCalls(body);
    if (!changed) break;
  }
  methodCalls(body);
}

module.exports = { cleanup, isPure, hasCall };
