"use strict";
/**
 * Final emission: graph cleanup, control-flow structuring and function assembly.
 * These methods are mixed into the Lifter defined in lift.js.
 */

const t = require("@babel/types");
const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const { structureGraph, StructureError } = require("./structure");

function install(Lifter, helpers) {
  const { isPureExpr, walkEval, termSuccessors, termUses } = helpers;

  Object.assign(Lifter.prototype, {
    /** Drops empty pass-through blocks left behind by the flattening dispatcher. */
    simplifyGraph(graph) {
      for (let round = 0; round < 200; round++) {
        const redirect = new Map();
        for (const n of graph.nodes) {
          if (n.stmts.length === 0 && n.term && n.term.kind === "goto" && n.term.target !== n) redirect.set(n, n.term.target);
        }
        if (!redirect.size) break;
        const resolve = (n) => {
          const seen = new Set();
          while (redirect.has(n) && !seen.has(n)) { seen.add(n); n = redirect.get(n); }
          return n;
        };
        let changed = false;
        for (const n of graph.nodes) {
          const term = n.term;
          if (!term) continue;
          if (term.kind === "goto") { const r = resolve(term.target); if (r !== term.target) { term.target = r; changed = true; } }
          else if (term.kind === "branch") {
            const a = resolve(term.then);
            const b = resolve(term.else);
            if (a !== term.then || b !== term.else) { term.then = a; term.else = b; changed = true; }
          } else if (term.kind === "forin") {
            const a = resolve(term.body);
            const b = resolve(term.done);
            if (a !== term.body || b !== term.done) { term.body = a; term.done = b; changed = true; }
          }
        }
        const newStart = resolve(graph.start);
        if (newStart !== graph.start) { graph.start = newStart; changed = true; }
        const reachable = new Set();
        const stack = [graph.start];
        while (stack.length) {
          const n = stack.pop();
          if (!n || reachable.has(n)) continue;
          reachable.add(n);
          for (const s of termSuccessors(n.term)) stack.push(s);
        }
        graph.nodes = graph.nodes.filter((n) => reachable.has(n));
        if (!changed) break;
      }
    },

    /**
     * Merges blocks that were duplicated by the path-sensitive analysis.
     * Equivalent blocks are found by partition refinement on (statements,
     * terminator, successor classes), the same way a DFA is minimized.
     */
    mergeEquivalentNodes(fn, graph) {
      const sigOf = (n) => {
        const parts = n.stmts.map((piece) => piece.kind + ":" +
          (piece.kind === "assign" ? this.regName(fn.entry, piece.reg) + "=" : "") + safeCode(piece.expr));
        const term = n.term;
        parts.push("term:" + term.kind + (term.kind === "branch" ? safeCode(term.test) : "") + (term.expr ? safeCode(term.expr) : ""));
        return parts.join(";");
      };
      const base = new Map();
      for (const n of graph.nodes) {
        const sig = sigOf(n);
        if (!base.has(sig)) base.set(sig, []);
        base.get(sig).push(n);
      }
      let classOf = new Map();
      let groups = [...base.values()];
      groups.forEach((g, i) => g.forEach((n) => classOf.set(n, i)));
      for (let round = 0; round < 100; round++) {
        const refined = new Map();
        for (const n of graph.nodes) {
          const key = classOf.get(n) + "|" + termSuccessors(n.term).map((s) => (s ? classOf.get(s) : -1)).join(",");
          if (!refined.has(key)) refined.set(key, []);
          refined.get(key).push(n);
        }
        const next = new Map();
        [...refined.values()].forEach((g, i) => g.forEach((n) => next.set(n, i)));
        let same = true;
        for (const n of graph.nodes) if (next.get(n) !== classOf.get(n)) { same = false; break; }
        classOf = next;
        if (same) break;
      }
      const rep = new Map();
      for (const n of graph.nodes) {
        const cls = classOf.get(n);
        if (!rep.has(cls)) rep.set(cls, n);
      }
      const canonical = (n) => (n ? rep.get(classOf.get(n)) : n);
      if (rep.size === graph.nodes.length) return;
      for (const n of graph.nodes) {
        const term = n.term;
        if (!term) continue;
        if (term.kind === "goto") term.target = canonical(term.target);
        else if (term.kind === "branch") { term.then = canonical(term.then); term.else = canonical(term.else); }
        else if (term.kind === "forin") { term.body = canonical(term.body); term.done = canonical(term.done); }
      }
      graph.start = canonical(graph.start);
      const reachable = new Set();
      const stack = [graph.start];
      while (stack.length) {
        const n = stack.pop();
        if (!n || reachable.has(n)) continue;
        reachable.add(n);
        for (const s of termSuccessors(n.term)) stack.push(s);
      }
      graph.nodes = graph.nodes.filter((n) => reachable.has(n));
    },

    /** `f.call(o, ...)` where `f` is `o.m` is really the method call `o.m(...)`. */
    foldMethodCalls(graph) {
      const simple = (node) => node && (node.type === "Identifier" || node.type === "ThisExpression" ||
        node.type === "StringLiteral" || node.type === "NumericLiteral");
      const fold = (node) => {
        if (!node || typeof node.type !== "string") return node;
        for (const key of Object.keys(node)) {
          const value = node[key];
          if (Array.isArray(value)) value.forEach((item, i) => { if (item && item.type) value[i] = fold(item); });
          else if (value && typeof value === "object" && typeof value.type === "string") node[key] = fold(value);
        }
        if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed &&
            node.callee.property.type === "Identifier" && node.callee.property.name === "call" &&
            node.arguments.length && node.callee.object.type === "MemberExpression") {
          const target = node.callee.object;
          const thisArg = node.arguments[0];
          if (simple(thisArg) && simple(target.object) && safeCode(target.object) === safeCode(thisArg)) {
            return t.callExpression(target, node.arguments.slice(1));
          }
        }
        return node;
      };
      for (const n of graph.nodes) {
        for (const piece of n.stmts) if (piece.expr) piece.expr = fold(piece.expr);
        if (n.term.kind === "branch") n.term.test = fold(n.term.test);
        if (n.term.expr) n.term.expr = fold(n.term.expr);
      }
    },

    /** Merges a block into its single predecessor when that is its only entry. */
    mergeChains(graph) {
      for (let round = 0; round < 200; round++) {
        const preds = new Map(graph.nodes.map((n) => [n, []]));
        for (const n of graph.nodes) for (const s of termSuccessors(n.term)) if (preds.has(s)) preds.get(s).push(n);
        let changed = false;
        for (const n of graph.nodes) {
          const term = n.term;
          if (!term || term.kind !== "goto") continue;
          const target = term.target;
          if (target === n || target === graph.start) continue;
          if ((preds.get(target) || []).length !== 1) continue;
          n.stmts = n.stmts.concat(target.stmts);
          n.term = target.term;
          changed = true;
          break;
        }
        if (!changed) break;
        const reachable = new Set();
        const stack = [graph.start];
        while (stack.length) {
          const n = stack.pop();
          if (!n || reachable.has(n)) continue;
          reachable.add(n);
          for (const s of termSuccessors(n.term)) stack.push(s);
        }
        graph.nodes = graph.nodes.filter((n) => reachable.has(n));
      }
    },

    /** Lifts one VM function into a FunctionExpression. */
    liftFunctionExpression(entry) {
      const fn = this.functions.get(entry);
      if (!fn) {
        this.warnings.push(`function @${entry} was never analyzed`);
        return t.identifier("undefined");
      }
      const { params, body } = this.liftFunctionBody(fn);
      return t.functionExpression(null, params, t.blockStatement(body));
    },

    liftFunctionBody(fn) {
      const graph = this.buildGraph(fn);
      this.simplifyGraph(graph);
      this.eliminateDeadCode(fn, graph);
      this.simplifyGraph(graph);
      this.mergeEquivalentNodes(fn, graph);
      this.mergeChains(graph);
      this.inlineTemporaries(fn, graph);
      this.foldMethodCalls(graph);
      this.inlineTemporaries(fn, graph);
      this.foldMethodCalls(graph);
      this.eliminateDeadCode(fn, graph);
      this.inlineTemporaries(fn, graph);

      const self = this;
      const api = {
        succs: (n) => termSuccessors(n.term),
        stmts: (n) => n.stmts.map((piece) => {
          if (piece.kind === "assign") {
            return t.expressionStatement(t.assignmentExpression("=", t.identifier(self.regName(fn.entry, piece.reg)), piece.expr));
          }
          if (piece.kind === "debugger") return t.debuggerStatement();
          return t.expressionStatement(piece.expr);
        }),
        term: (n) => {
          const term = n.term;
          if (term.kind === "return") return { kind: "return", argument: term.expr && !isUndefinedIdent(term.expr) ? term.expr : null };
          if (term.kind === "throw") return { kind: "throw", argument: term.expr };
          if (term.kind === "goto") return { kind: "goto", target: term.target };
          if (term.kind === "branch") return { kind: "branch", test: term.test, then: term.then, else: term.else };
          if (term.kind === "forin") return { kind: "branch", test: term.test, then: term.body, else: term.done };
          return { kind: "return", argument: null };
        },
      };

      let body;
      try {
        body = structureGraph(graph.start, api);
      } catch (err) {
        if (!(err instanceof StructureError)) throw err;
        this.warnings.push(`function @${fn.entry}: ${err.message} - emitted as an explicit state machine`);
        body = this.emitStateMachine(fn, graph, api);
      }

      const paramCount = fn.desc.d | 0;
      const params = [];
      for (let i = 0; i < paramCount; i++) {
        const id = t.identifier(this.regName(fn.entry, i));
        params.push(fn.desc.F && i === paramCount - 1 ? t.restElement(id) : id);
      }
      const declared = new Set(params.map((p) => (p.type === "RestElement" ? p.argument.name : p.name)));
      const used = new Set();
      for (const st of body) walkAll(st, (node) => { if (node.type === "Identifier") used.add(node.name); });
      const locals = [];
      for (let r = paramCount; r < fn.desc.Q; r++) {
        const key = fn.entry + ":" + r;
        if (!this.names.has(key)) continue;
        const name = this.names.get(key);
        if (!used.has(name) || declared.has(name)) continue;
        declared.add(name);
        if (r === paramCount) {
          locals.push(t.variableDeclarator(t.identifier(name), t.callExpression(
            t.memberExpression(t.memberExpression(t.memberExpression(t.identifier("Array"), t.identifier("prototype")), t.identifier("slice")), t.identifier("call")),
            [t.identifier("arguments")]
          )));
        } else {
          locals.push(t.variableDeclarator(t.identifier(name), null));
        }
      }
      if (locals.length) body.unshift(t.variableDeclaration("var", locals));
      for (const st of body) {
        walkAll(st, (node) => {
          const message = this.deferredWarnings.get(node);
          if (message) this.warnings.push(message);
        });
      }
      return { params, body };
    },

    /** Fallback for graphs that cannot be structured: an explicit state machine. */
    emitStateMachine(fn, graph, api) {
      const ids = new Map(graph.nodes.map((n, i) => [n, i]));
      const stateName = this.freshName("state");
      const cases = [];
      for (const n of graph.nodes) {
        const stmts = api.stmts(n);
        const term = api.term(n);
        const goTo = (target) => [
          t.expressionStatement(t.assignmentExpression("=", t.identifier(stateName), t.numericLiteral(ids.get(target)))),
          t.breakStatement(null),
        ];
        if (term.kind === "return") stmts.push(t.returnStatement(term.argument || null));
        else if (term.kind === "throw") stmts.push(t.throwStatement(term.argument));
        else if (term.kind === "goto") stmts.push(...goTo(term.target));
        else if (term.kind === "branch") stmts.push(t.ifStatement(term.test, t.blockStatement(goTo(term.then)), t.blockStatement(goTo(term.else))));
        cases.push(t.switchCase(t.numericLiteral(ids.get(n)), stmts));
      }
      return [
        t.variableDeclaration("var", [t.variableDeclarator(t.identifier(stateName), t.numericLiteral(ids.get(graph.start)))]),
        t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.switchStatement(t.identifier(stateName), cases)])),
      ];
    },

    /**
     * Renumbers the generated names so each role counts up from zero in the
     * order the reader meets it. Names are handed out lazily while lifting, and
     * plenty of them belong to registers whose statements are later deleted, so
     * without this pass the output is full of gaps like `v54` and `p7`.
     */
    renumberNames(program) {
      const order = [];
      const seen = new Set();
      walkAll(program, (node) => {
        if (node.type !== "Identifier" || seen.has(node.name) || !this.nameRole.has(node.name)) return;
        seen.add(node.name);
        order.push(node.name);
      });
      const taken = new Set([...this.usedNames].filter((n) => !this.nameRole.has(n)));
      const counters = new Map();
      const renamed = new Map();
      for (const name of order) {
        const prefix = this.nameRole.get(name);
        let next;
        do {
          const n = counters.get(prefix) || 0;
          counters.set(prefix, n + 1);
          next = prefix + n;
        } while (taken.has(next));
        renamed.set(name, next);
      }
      walkAll(program, (node) => {
        if (node.type === "Identifier" && renamed.has(node.name)) node.name = renamed.get(node.name);
      });
    },

    /** Lifts the whole program. */
    liftProgram() {
      const top = this.functions.get(this.m.topDesc.m);
      const { body } = this.liftFunctionBody(top);
      while (body.length && body[body.length - 1].type === "ReturnStatement" && !body[body.length - 1].argument) body.pop();
      if (this.needsForInHelper) body.unshift(forInHelper(this.forInHelperName()));
      const program = t.program(body);
      this.renumberNames(program);
      return program;
    },
  });
}

function safeCode(node) {
  if (!node) return "";
  try {
    return generate(node, { compact: true, comments: false }).code;
  } catch (e) {
    return "?";
  }
}

function isUndefinedIdent(node) {
  return node && node.type === "Identifier" && node.name === "undefined";
}

function walkAll(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === "string") walkAll(item, visit); }
    else if (value && typeof value === "object" && typeof value.type === "string") walkAll(value, visit);
  }
}

/** The VM enumerates for-in keys eagerly, so the lifted code does the same. */
function forInHelper(name) {
  const src = "function " + name + "(o) { var keys = []; for (var k in Object(o)) keys.push(k); return { keys: keys, i: 0 }; }";
  return parser.parse(src).program.body[0];
}

module.exports = { install, walkAll };
