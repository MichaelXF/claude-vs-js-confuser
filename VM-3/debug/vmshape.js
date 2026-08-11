// debug/vmshape.js — locate the JS-Confuser VM runtime pieces inside a parsed program
// and provide a canonicalizer that turns an opcode handler into a shape signature.
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

function clone(node) {
  return JSON.parse(JSON.stringify(node, (k, v) => (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments" || k === "innerComments" || k === "range" || k === "_blockHoist" ? undefined : v)));
}

function analyzeVM(ast) {
  const vm = {
    stackProp: null, // this.g   — flat frame stack
    fpProp: null, // this.w   — current frame pointer
    bcProp: null, // this.i   — bytecode Uint32Array
    poolProp: null, // this.n   — constant pool
    globalProp: null, // this.E   — global object
    spProp: null, // this.h   — stack top
    cellsProp: null, // this.l   — closure cells
    cellFn: null, // u.prototype.c
    pcOff: null,
    regBaseOff: null,
    slots: {}, // name -> offset
    readFn: null, // x
    strFn: null, // y
    b64Fn: null, // f
    pushFrameFn: null, // w
    loopFn: null, // z
    closeFn: null, // v
    tplCtor: null, // g
    cellCtor: null, // q
    vmCtor: null, // u
    weakMapVar: null, // r
    handlers: new Map(),
  };

  // ---- x(a,b){ a.Q = b; return a.i[a.g[a.w + 8]++] } -------------------------
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (body.length !== 2) return;
      if (body[0].type !== "ExpressionStatement" || body[0].expression.type !== "AssignmentExpression") return;
      if (body[1].type !== "ReturnStatement" || !body[1].argument) return;
      const r = body[1].argument;
      // a.BC[ a.STACK[ a.FP + N ]++ ]
      if (r.type !== "MemberExpression" || !r.computed) return;
      if (r.object.type !== "MemberExpression" || r.object.computed) return;
      const upd = r.property;
      if (upd.type !== "UpdateExpression" || upd.operator !== "++") return;
      const inner = upd.argument;
      if (inner.type !== "MemberExpression" || !inner.computed) return;
      if (inner.object.type !== "MemberExpression" || inner.object.computed) return;
      const add = inner.property;
      if (add.type !== "BinaryExpression" || add.operator !== "+") return;
      if (add.left.type !== "MemberExpression" || add.left.computed) return;
      if (add.right.type !== "NumericLiteral") return;
      vm.readFn = p.node.id.name;
      vm.bcProp = r.object.property.name;
      vm.stackProp = inner.object.property.name;
      vm.fpProp = add.left.property.name;
      vm.pcOff = add.right.value;
    },
  });

  // ---- y(a,b,e) — constant/string decoder -----------------------------------
  traverse(ast, {
    FunctionDeclaration(p) {
      let hasMagic = false,
        hasFromCharCode = false,
        poolProp = null;
      p.traverse({
        NumericLiteral(q) {
          if (q.node.value === 2654435769) hasMagic = true;
        },
        MemberExpression(q) {
          if (!q.node.computed && q.node.property.name === "fromCharCode") hasFromCharCode = true;
        },
      });
      if (!hasMagic || !hasFromCharCode) return;
      // a = a.n[e]
      p.traverse({
        AssignmentExpression(q) {
          const n = q.node;
          if (n.left.type === "Identifier" && n.right.type === "MemberExpression" && n.right.computed && n.right.object.type === "MemberExpression" && !n.right.object.computed) {
            if (poolProp === null) poolProp = n.right.object.property.name;
          }
        },
      });
      vm.strFn = p.node.id.name;
      vm.poolProp = poolProp;
    },
  });

  // ---- f(a) — base64 decoder ------------------------------------------------
  traverse(ast, {
    FunctionDeclaration(p) {
      let found = false;
      p.traverse({
        Identifier(q) {
          if (q.node.name === "atob") found = true;
        },
      });
      if (found) vm.b64Fn = p.node.id.name;
    },
  });

  // ---- u(...) — VM constructor: this.g=[]; this.h=12; this.w=0 --------------
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (!body.length || !body.every((s) => s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression")) return;
      const assigns = body.map((s) => s.expression);
      let isVM = false;
      for (const a of assigns) {
        if (a.left.type === "MemberExpression" && a.left.object.type === "ThisExpression" && a.left.property.name === vm.stackProp && a.right.type === "ArrayExpression") isVM = true;
      }
      if (!isVM) return;
      vm.vmCtor = p.node.id.name;
      const params = p.node.params.map((x) => x.name);
      for (const a of assigns) {
        if (a.left.type !== "MemberExpression" || a.left.object.type !== "ThisExpression") continue;
        const name = a.left.property.name;
        if (a.right.type === "Identifier") {
          const idx = params.indexOf(a.right.name);
          if (idx === 2) vm.bcProp = name;
          if (idx === 1) vm.poolProp = vm.poolProp || name;
          if (idx === 4) vm.globalProp = name;
        }
        if (a.right.type === "NumericLiteral" && a.right.value > 0) vm.spProp = name;
        if (a.right.type === "NullLiteral") vm.cellsProp = name;
      }
    },
  });

  // ---- w(...) — push frame; derive frame slot offsets ------------------------
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.node.params.length !== 8) return;
      const src = generate(p.node).code;
      if (!/\.push\(void 0\)/.test(src)) return;
      vm.pushFrameFn = p.node.id.name;
      const params = p.node.params.map((x) => x.name);
      // locals: p = b.I, l = a.g, m = a.h, A = 11 + p.e, t = m + A
      let stackLocal = null,
        baseLocal = null,
        tplLocal = null,
        frameSzLocal = null,
        endLocal = null,
        regBaseLocal = null;
      p.traverse({
        VariableDeclarator(q) {
          const n = q.node;
          if (!n.init) return;
          if (n.init.type === "MemberExpression" && n.init.object.type === "Identifier" && n.init.object.name === params[0] && !n.init.computed) {
            if (n.init.property.name === vm.stackProp) stackLocal = n.id.name;
            if (n.init.property.name === vm.spProp) baseLocal = n.id.name;
          }
          if (n.init.type === "MemberExpression" && n.init.object.type === "Identifier" && n.init.object.name === params[1] && !n.init.computed) tplLocal = n.id.name;
          if (n.init.type === "BinaryExpression" && n.init.operator === "+" && n.init.left.type === "NumericLiteral") frameSzLocal = n.id.name;
          if (n.init.type === "BinaryExpression" && n.init.operator === "+" && n.init.left.type === "Identifier" && n.init.left.name === baseLocal) endLocal = n.id.name;
        },
      });
      // walk `l[m+N] = <expr>` assignments
      p.traverse({
        AssignmentExpression(q) {
          const n = q.node;
          if (n.left.type !== "MemberExpression" || !n.left.computed) return;
          if (n.left.object.type !== "Identifier" || n.left.object.name !== stackLocal) return;
          const idx = n.left.property;
          if (idx.type !== "BinaryExpression" || idx.operator !== "+") return;
          if (idx.left.type !== "Identifier" || idx.left.name !== baseLocal) return;
          if (idx.right.type !== "NumericLiteral") return;
          const off = idx.right.value;
          const r = n.right;
          if (r.type === "MemberExpression" && r.object.name === tplLocal) vm.slots.pc = off;
          else if (r.type === "MemberExpression" && r.object.name === params[0] && r.property.name === vm.fpProp) vm.slots.prevFp = off;
          else if (r.type === "Identifier") {
            const nm = r.name;
            if (nm === params[2]) vm.slots.retDst = off;
            else if (nm === params[6]) vm.slots.thisVal = off;
            else if (nm === params[1]) vm.slots.template = off;
            else if (nm === frameSzLocal) vm.slots.frameSize = off;
            else if (nm === endLocal) vm.slots.frameEnd = off;
            else vm.slots.regBase = off; // `c` = m + 11
          }
        },
      });
    },
  });

  // ---- u.prototype.c — closure cell accessor; gives regBase offset ----------
  traverse(ast, {
    AssignmentExpression(p) {
      const n = p.node;
      if (n.right.type !== "FunctionExpression") return;
      const L = n.left;
      if (L.type !== "MemberExpression" || L.computed) return;
      if (L.object.type !== "MemberExpression" || L.object.property.name !== "prototype") return;
      const b = n.right.body.body;
      if (!b.length || b[0].type !== "ExpressionStatement") return;
      const a0 = b[0].expression;
      if (a0.type !== "AssignmentExpression") return;
      // a = this.g[a + 3] + e
      const r = a0.right;
      if (r.type !== "BinaryExpression" || r.operator !== "+") return;
      const m = r.left;
      if (m.type !== "MemberExpression" || !m.computed) return;
      if (m.object.type !== "MemberExpression" || m.object.object.type !== "ThisExpression") return;
      if (m.property.type !== "BinaryExpression" || m.property.right.type !== "NumericLiteral") return;
      vm.regBaseOff = m.property.right.value;
      vm.cellFn = L.property.name;
    },
  });
  if (vm.regBaseOff == null) vm.regBaseOff = vm.slots.regBase;

  // ---- opcode handler table -------------------------------------------------
  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right } = p.node;
      if (left.type !== "MemberExpression" || !left.computed) return;
      if (left.property.type !== "NumericLiteral") return;
      if (right.type !== "FunctionExpression") return;
      vm.handlers.set(left.property.value, right);
    },
  });

  // ---- misc helper identification ------------------------------------------
  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.init && p.node.init.type === "NewExpression" && p.node.init.callee.name === "WeakMap") vm.weakMapVar = p.node.id.name;
    },
  });
  // g(a): this.I=a; this.j=[]; this.prototype={}
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (body.length !== 3) return;
      const srcs = body.map((s) => generate(s).code);
      if (srcs.some((s) => /this\.prototype\s*=\s*\{\}/.test(s))) {
        vm.tplCtor = p.node.id.name;
        for (const s of body) {
          const a = s.expression;
          if (a && a.type === "AssignmentExpression" && a.right.type === "Identifier") vm.tplInfoProp = a.left.property.name;
          if (a && a.type === "AssignmentExpression" && a.right.type === "ArrayExpression") vm.tplCapturesProp = a.left.property.name;
        }
      }
    },
  });
  // q(a,b): this.g=b; this.s=a; this.m=!1; this.o=void 0
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (body.length !== 4) return;
      let ok = 0;
      for (const s of body) {
        const a = s.expression;
        if (!a || a.type !== "AssignmentExpression" || a.left.object.type !== "ThisExpression") return;
        ok++;
      }
      if (ok === 4 && p.node.params.length === 2) {
        const src = generate(p.node).code;
        if (/!1/.test(src) && /void 0/.test(src)) vm.cellCtor = p.node.id.name;
      }
    },
  });

  vm.canonicalize = (fnNode) => canonicalize(fnNode, vm);
  return vm;
}

// ---------------------------------------------------------------------------
// canonicalizer
// ---------------------------------------------------------------------------
const SLOT = "$";

function canonicalize(fnNode, vm) {
  const root = t.file(t.program([t.expressionStatement(t.functionExpression(null, [], clone(fnNode.body)))]));
  const slotOff = {};
  for (const [k, v] of Object.entries(vm.slots)) slotOff[v] = k;

  // pass 1: alias map for `var a = this.g`, `var b = a[this.w + regBaseOff]`
  const aliases = new Map(); // name -> 'STACK' | 'FP' | 'RB'
  traverse(root, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!n.init || n.id.type !== "Identifier") return;
      const i = n.init;
      if (i.type === "MemberExpression" && i.object.type === "ThisExpression" && !i.computed) {
        if (i.property.name === vm.stackProp) aliases.set(n.id.name, "STACK");
        else if (i.property.name === vm.fpProp) aliases.set(n.id.name, "FP");
      }
      if (i.type === "MemberExpression" && i.computed) {
        // a[this.w + 3]
        const o = i.object,
          pr = i.property;
        const oIsStack = (o.type === "Identifier" && aliases.get(o.name) === "STACK") || (o.type === "MemberExpression" && o.object.type === "ThisExpression" && o.property.name === vm.stackProp);
        if (!oIsStack) return;
        if (pr.type !== "BinaryExpression" || pr.operator !== "+" || pr.right.type !== "NumericLiteral") return;
        const l = pr.left;
        const lIsFp = (l.type === "Identifier" && aliases.get(l.name) === "FP") || (l.type === "MemberExpression" && l.object.type === "ThisExpression" && l.property.name === vm.fpProp);
        if (lIsFp && pr.right.value === vm.regBaseOff) aliases.set(n.id.name, "RB");
      }
    },
  });

  const isStack = (n) => (n.type === "Identifier" && aliases.get(n.name) === "STACK") || (n.type === "MemberExpression" && !n.computed && n.object.type === "ThisExpression" && n.property.name === vm.stackProp);
  const isFp = (n) => (n.type === "Identifier" && aliases.get(n.name) === "FP") || (n.type === "MemberExpression" && !n.computed && n.object.type === "ThisExpression" && n.property.name === vm.fpProp) || (n.type === "Identifier" && n.name === "FP");
  const isRB = (n) => (n.type === "Identifier" && (aliases.get(n.name) === "RB" || n.name === "RB")) || false;

  // pass 2: structural rewrite (post-order so inner nodes are handled first)
  traverse(root, {
    exit(p) {
      const n = p.node;
      if (n.type === "CallExpression" && n.callee.type === "Identifier") {
        if (n.callee.name === vm.readFn) {
          p.replaceWith(t.identifier(SLOT));
          return;
        }
        if (n.callee.name === vm.strFn) {
          if (n.arguments.length <= 1) p.replaceWith(t.callExpression(t.identifier("STR"), []));
          else p.replaceWith(t.callExpression(t.identifier("STRC"), [n.arguments[1], n.arguments[2]]));
          return;
        }
        if (n.callee.name === vm.closeFn) return;
      }
      if (n.type === "MemberExpression" && !n.computed && n.object.type === "ThisExpression") {
        const map = {
          [vm.bcProp]: "BC",
          [vm.poolProp]: "POOL",
          [vm.globalProp]: "GLOBAL",
          [vm.spProp]: "SP",
          [vm.cellsProp]: "CELLS",
          [vm.stackProp]: "STACK",
          [vm.fpProp]: "FP",
        };
        if (map[n.property.name] && !(p.parent.type === "MemberExpression" && p.parent.object === n && p.parent.computed)) {
          p.replaceWith(t.identifier(map[n.property.name]));
          return;
        }
      }
      if (n.type !== "MemberExpression" || !n.computed) return;
      const pr = n.property;
      if (pr.type !== "BinaryExpression" || pr.operator !== "+") return;
      if (!isStack(n.object)) return;
      if (isFp(pr.left) && pr.right.type === "NumericLiteral") {
        const name = slotOff[pr.right.value];
        if (name) {
          p.replaceWith(t.identifier(({ pc: "PC", prevFp: "PFP", retDst: "RDST", thisVal: "TH", template: "TPL", frameSize: "FSZ", frameEnd: "FEND", regBase: "RB" })[name] || "SLOT" + pr.right.value));
          return;
        }
        if (pr.right.value === 6) {
          p.replaceWith(t.identifier("HND"));
          return;
        }
        p.replaceWith(t.identifier("SLOT" + pr.right.value));
        return;
      }
      if (isRB(pr.left) || (pr.left.type === "Identifier" && pr.left.name === "RB")) {
        p.replaceWith(t.memberExpression(t.identifier("R"), pr.right, true));
        return;
      }
    },
  });

  // pass 3: drop now-redundant alias declarators, then inline single-use temps
  traverse(root, {
    VariableDeclarator(p) {
      const i = p.node.init;
      if (i && i.type === "Identifier" && ["STACK", "FP", "RB"].includes(i.name)) p.remove();
    },
  });
  traverse(root, {
    VariableDeclaration(p) {
      if (p.node.declarations.length === 0) p.remove();
    },
  });

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    const fnPath = getFnPath(root);
    fnPath.scope.crawl();
    for (const name of Object.keys(fnPath.scope.bindings)) {
      const b = fnPath.scope.bindings[name];
      if (!b.constant) continue;
      if (b.path.type !== "VariableDeclarator" || !b.path.node.init) continue;
      if (b.references !== 1) continue;
      const ref = b.referencePaths[0];
      // don't hoist across a loop boundary
      let inLoop = false;
      let cur = ref;
      while (cur && cur.node !== b.path.parentPath.node) {
        if (/Loop|While|For/.test(cur.node.type)) inLoop = true;
        cur = cur.parentPath;
      }
      if (inLoop) continue;
      const init = b.path.node.init;
      b.path.remove();
      ref.replaceWith(init);
      changed = true;
      break;
    }
  }
  traverse(root, {
    VariableDeclaration(p) {
      if (p.node.declarations.length === 0) p.remove();
    },
  });

  // pass 4: collect numeric literals in source order, blank them out
  const nums = [];
  traverse(root, {
    NumericLiteral(p) {
      nums.push(p.node.value);
      p.replaceWith(t.identifier("#"));
      p.skip();
    },
  });

  const fn = root.program.body[0].expression;
  const canon = generate(t.program(fn.body.body), { compact: true, comments: false }).code;
  return { canon, nums };
}

function getFnPath(root) {
  let res = null;
  traverse(root, {
    FunctionExpression(p) {
      if (!res) res = p;
      p.stop();
    },
  });
  return res;
}

module.exports = { analyzeVM, clone };
