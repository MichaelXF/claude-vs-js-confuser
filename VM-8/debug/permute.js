'use strict';
// ---------------------------------------------------------------------------
// Builds a *semantically identical* variant of the sample with completely
// different opcode numbers, a shuffled handler table and renamed identifiers.
//
// The interpreter derives its per-instruction key from the opcode
// (`vm.x = f(pc, opcode)`), so a raw renumbering would change what the
// multi-operation handlers compute.  A reverse map is threaded into that one
// expression so the rebuilt sample runs exactly like the original while every
// opcode number the deobfuscator could latch onto has changed.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const { loadRuntime, locateBootstrap } = require('../lib-extract.js');
const { prepare } = require('../lib-probe.js');
const { sweep } = require('../lib-disasm.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function permute(source, seed) {
  const rand = rng(seed || 1);
  const M = prepare(loadRuntime(source));
  const { instrs } = sweep(M);
  const opcodes = M.opKeys.map(Number);

  // bijection old -> new
  const used = new Set();
  const map = new Map();
  for (const op of opcodes) {
    let v;
    do { v = 1 + Math.floor(rand() * 60000); } while (used.has(v));
    used.add(v);
    map.set(op, v);
  }

  const ast = parser.parse(source, { sourceType: 'script' });
  const boot = locateBootstrap(ast);
  if (!boot) throw new Error('bootstrap not found');

  // 1. handler keys + shuffled table order
  const handlerStmts = [];
  const body = ast.program.body;
  for (let i = 0; i < body.length; i++) {
    const st = body[i];
    if (st.type !== 'ExpressionStatement') continue;
    const e = st.expression;
    if (e.type !== 'AssignmentExpression') continue;
    const l = e.left;
    if (l.type !== 'MemberExpression' || !l.computed) continue;
    if (l.object.type !== 'Identifier' || l.object.name !== boot.protoVar) continue;
    if (l.property.type !== 'NumericLiteral') continue;
    if (!map.has(l.property.value)) continue;
    l.property = t.numericLiteral(map.get(l.property.value));
    handlerStmts.push(i);
  }
  const picked = handlerStmts.map(i => body[i]);
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  handlerStmts.forEach((slot, k) => { body[slot] = picked[k]; });

  // 2. renumber the opcode word of every instruction
  const words = Uint32Array.from(M.bytecode);
  for (const ins of instrs) {
    if (!map.has(words[ins.pc])) throw new Error('unknown opcode at ' + ins.pc);
    words[ins.pc] = map.get(words[ins.pc]) >>> 0;
  }
  const buf = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i++) buf.writeUInt32LE(words[i], i * 4);
  const b64 = buf.toString('base64');

  let longest = null;
  traverse(ast, {
    StringLiteral(p) { if (!longest || p.node.value.length > longest.node.value.length) longest = p; },
  });
  longest.node.value = b64;

  // 3. keep vm.x identical by mapping the new opcode back to the old one
  const RM = '__rmap';
  let patched = false;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.node.id.name !== boot.interp) return;
      const vmParam = p.node.params[0].name;
      let opVar = null;
      p.traverse({
        AssignmentExpression(q) {
          const { left, right } = q.node;
          if (left.type !== 'Identifier') return;
          if (right.type === 'MemberExpression' && right.computed &&
              right.object.type === 'MemberExpression' &&
              right.object.object.type === 'Identifier' && right.object.object.name === vmParam) {
            opVar = left.name;
          }
        },
      });
      if (!opVar) return;
      p.traverse({
        AssignmentExpression(q) {
          const { left, right } = q.node;
          if (left.type !== 'MemberExpression' || left.computed) return;
          if (left.object.type !== 'Identifier' || left.object.name !== vmParam) return;
          if (!/Math\.imul/.test(generate(right).code)) return;
          const targets = [];
          q.get('right').traverse({
            Identifier(r) {
              if (r.node.name !== opVar) return;
              if (r.parent.type === 'MemberExpression' && !r.parent.computed && r.parent.property === r.node) return;
              targets.push(r);
            },
          });
          for (const r of targets) {
            r.replaceWith(t.memberExpression(t.identifier(RM), t.identifier(opVar), true));
            r.skip();
            patched = true;
          }
        },
      });
    },
  });
  if (!patched) throw new Error('could not thread the reverse opcode map');

  const pairs = [...map].map(([oldOp, newOp]) =>
    t.objectProperty(t.numericLiteral(newOp), t.numericLiteral(oldOp), true));
  ast.program.body.unshift(t.variableDeclaration('var',
    [t.variableDeclarator(t.identifier(RM), t.objectExpression(pairs))]));

  // 4. rename every top-level identifier
  const prog = ast.program;
  const file = t.file(prog);
  traverse(file, {
    Program(p) {
      p.scope.crawl();
      let n = 0;
      for (const name of Object.keys(p.scope.bindings)) {
        if (name === RM) continue;
        p.scope.rename(name, '_z' + (n++) + '_' + Math.floor(rand() * 1000));
      }
    },
  });

  return generate(file, { compact: true }).code;
}

if (require.main === module) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'input.js'), 'utf8');
  const seed = Number(process.argv[2] || 1);
  const out = permute(src, seed);
  const dest = path.join(__dirname, 'permuted.js');
  fs.writeFileSync(dest, out);
  console.log('wrote', dest, out.length, 'bytes');
}

module.exports = { permute };
