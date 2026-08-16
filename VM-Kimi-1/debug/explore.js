// Generalized CFG explorer for one function, given its trampoline/dispatcher config.
const core = require('./core');
const { C, X, E, XMERGE, evalBin, evalUn, evalTree, findVars, mergeVal, runDispatcher, MAGIC, BIN_OPS, UN_OPS } = core;

function explore(ctx, cfg) {
  // cfg: { trampIp, argRegs:[Areg,Breg], prop, dispEntry, nreg }
  const argRegs = cfg.argRegs;

  function runBlock(startIp, regsIn) {
    const regs = regsIn.slice();
    const instrs = [];
    let ip = startIp;
    while (true) {
      const ins = ctx.decodeAt(ip);
      if (!ins) throw new Error('undecodable at ' + ip);
      instrs.push(ins);
      const o = ins.operands;
      const R = i => regs[i] || X('r' + i);
      switch (ins.name) {
        case 'LOAD_THIS': regs[o[0]] = X('this'); break;
        case 'LOAD_CONST': regs[o[0]] = C(ctx.decodeConst(o[1], o[2])); break;
        case 'LOAD_LITERAL': regs[o[0]] = C(o[1] >> 0); break;
        case 'LOAD_UNDEF': regs[o[0]] = C(undefined); break;
        case 'MOVE': regs[o[0]] = R(o[1]); break;
        case 'LOAD_GLOBAL': regs[o[0]] = X('global:' + ctx.decodeConst(o[1], o[2])); break;
        case 'TYPEOF_GLOBAL': regs[o[0]] = X('typeofglobal'); break;
        case 'STORE_GLOBAL': break;
        case 'GET_PROP': regs[o[0]] = X('prop'); break;
        case 'SET_PROP': break;
        case 'CALL': case 'CALL_NULL': regs[o[0]] = X('call'); break;
        case 'NEW': regs[o[0]] = X('new'); break;
        case 'MAKE_FUNC': regs[o[0]] = X('func@' + o[1]); break;
        case 'MAKE_ARRAY': regs[o[0]] = X('array'); break;
        case 'MAKE_OBJECT': regs[o[0]] = X('object'); break;
        case 'LOAD_CLOSURE': regs[o[0]] = X('closure' + o[1]); break;
        case 'STORE_CLOSURE': break;
        case 'FORIN_SETUP': regs[o[0]] = X('forin'); break;
        case 'FORIN_NEXT': regs[o[0]] = X('forinnext'); break;
        case 'DEFINE_GETTER': case 'DEFINE_SETTER': case 'DELETE': break;
        case 'POP_TRY': case 'DEBUGGER': break;
        case 'TRY': case 'TRY2': break;
        case 'JUMP': case 'JUMP_REG': case 'RETURN': case 'THROW':
        case 'JUMP_IF_TRUE': case 'JUMP_IF_FALSE':
          break; // handled after the switch
        default:
          if (BIN_OPS.includes(ins.name)) regs[o[0]] = evalBin(ins.name, R(o[1]), R(o[2]));
          else if (UN_OPS.includes(ins.name)) regs[o[0]] = evalUn(ins.name, R(o[1]));
          else throw new Error('unhandled ' + ins.name);
          break;
      }
      if (ins.name === 'JUMP') {
        if (o[0] === cfg.trampIp) return finishDispatch(instrs, regs);
        return { instrs, regs, kind: 'jump', target: o[0] };
      }
      if (ins.name === 'JUMP_REG') return { instrs, regs, kind: 'jumpreg', reg: o[0] };
      if (ins.name === 'RETURN') return { instrs, regs, kind: 'return', reg: o[0] };
      if (ins.name === 'THROW') return { instrs, regs, kind: 'throw', reg: o[0] };
      if (ins.name === 'JUMP_IF_TRUE') return { instrs, regs, kind: 'condjump', condReg: o[0], target: o[1], fallthrough: ip + ins.size, when: true };
      if (ins.name === 'JUMP_IF_FALSE') return { instrs, regs, kind: 'condjump', condReg: o[0], target: o[1], fallthrough: ip + ins.size, when: false };
      ip += ins.size;
    }
  }

  function finishDispatch(instrs, regs) {
    const A = regs[argRegs[0]];
    const B = regs[argRegs[1]];
    if (!A || A.t !== 'c') throw new Error('A not concrete: ' + JSON.stringify(A));
    const prop = cfg.prop;
    const disp = (a, b) => {
      const res = runDispatcher(ctx, cfg.dispEntry, a, b);
      return Array.isArray(res) ? res[prop] : res[prop];
    };
    if (B.t === 'c') {
      return { instrs, regs, kind: 'dispatch', A: A.v, B: B.v, targets: [disp(A.v, B.v)] };
    }
    if (B.t === 'e') {
      const cmpAcc = [], xAcc = [];
      findVars(B, cmpAcc, xAcc);
      if (cmpAcc.length + xAcc.length === 1) {
        const condNode = cmpAcc[0] || xAcc[0];
        const Btrue = evalTree(B, condNode, true) | 0;
        const Bfalse = evalTree(B, condNode, false) | 0;
        return {
          instrs, regs, kind: 'dispatch-cond', A: A.v, cond: condNode,
          Btrue, Bfalse, targetTrue: disp(A.v, Btrue), targetFalse: disp(A.v, Bfalse),
        };
      }
    }
    throw new Error('cannot resolve dispatch; B=' + JSON.stringify(B).slice(0, 300));
  }

  const envs = new Map();
  const wl = [];
  function pushState(ip, regs) {
    if (!envs.has(ip)) { envs.set(ip, regs.slice()); wl.push(ip); }
    else {
      const cur = envs.get(ip);
      const merged = cur.map((v, i) => mergeVal(v, regs[i]));
      if (merged.some((v, i) => v !== cur[i])) { envs.set(ip, merged); wl.push(ip); }
    }
  }
  const init = [];
  for (let i = 0; i < (cfg.nreg || 160); i++) init.push(X('undef'));
  init[0] = X('arguments');
  for (let i = 1; i < 8; i++) init[i] = X('arg' + i);
  pushState(cfg.entry, init);

  const results = new Map();
  let guard = 0;
  while (wl.length) {
    if (++guard > 20000) { console.log('GUARD TRIPPED'); break; }
    const ip = wl.pop();
    let res;
    try { res = runBlock(ip, envs.get(ip)); }
    catch (e) { console.log('block ' + ip + ' ERROR: ' + e.message); continue; }
    results.set(ip, res);
    if (res.kind === 'dispatch') pushState(res.targets[0], res.regs);
    else if (res.kind === 'dispatch-cond') { pushState(res.targetTrue, res.regs); pushState(res.targetFalse, res.regs); }
    else if (res.kind === 'jump') pushState(res.target, res.regs);
    else if (res.kind === 'condjump') { pushState(res.target, res.regs); pushState(res.fallthrough, res.regs); }
  }
  return results;
}

module.exports = { explore };
