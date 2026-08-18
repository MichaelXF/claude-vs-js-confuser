# RESUME_2 — VM-GLM-1 session state (section 5 lifter debugging)

Read vm.js header comment + README.md first; this file only covers current state + next steps.

## Current state

- Sections 1–4 DONE and verified: `extractVM`, `interpretHandler`/`matchArchetype` (161/161 handlers), `analyze` (path-sensitive abstract exec).
- CFF dispatch SOLVED: `exploreFunction` uses env `{v:{reg→val}, b:{reg→boolPair}}` with boolPairs `{condReg,hi,lo}` (NOT/NEG/BNOT propagate; select creation = `<const> OP <pair>`; select algebra maps `__sel {condReg,tv,fv}` through const binops; GETPROP projects `sel.tv[key]/sel.fv[key]`; CALL dual-evals pure `__vmfn` leaves via `concreteEval2`).
- Convergence: JMP whose target fall-chains into JMPR is INLINED into the same straight-line run (`isDispatcherEntry` + `fn.dispEntries`, `CONTROL_OPS` set), so salt+select never cross a widening point. Widening = per-ip `stableV`/`stableB` maps, contradiction on value mismatch AND on presence/absence mismatch (intersection), `__sel` values exempt from pruning. Multi-pass loop (max 12) reruns until a pass completes.
- Result: `analyze` → 1499 instrs, 5 functions, 0 unknown regions, 0 unresolvedJumps, ~700ms. Edge dump verified: fn@17 has clean case-block CFG (dispatch edges carry `{condReg, sense, blockStart}`); loop 1334→32→46 confirmed.
- Section 5 `liftProgram` + Section 6 API/CLI written but FAILING (see below). `node vm.js input.js output.js` currently writes input unchanged (passthrough fallback in `deobfuscateSource` catches lift error).

## THE BUG being debugged

`liftProgram(dis)` throws:
`TypeError: Property params[0] of FunctionExpression expected node to be of a type ["FunctionParameter"] but instead got undefined`

Stack: `buildFunction` (vm.js:2798, the final `t.functionExpression(name, paramNames, ...)`) ← `emitBlockStmts` (vm.js:2444, MKFUNC case) ← `buildFunction` ← `emitBlockStmts`.

Root cause hypothesis: `paramNamesOf`-style bug — in `emitBlockStmts` MKFUNC case, the sub-node is built via `buildFunction(gi.entry, subName, depth+1)` which RETURNS a complete `FunctionExpression`, but line ~2444 may be calling `t.functionExpression(t.identifier(subName), paramNamesOf(gi.entry), ...)` where `paramNamesOf` doesn't exist anymore (was removed in rewrite) → `params[0] === undefined`. Read vm.js around 2430–2450 and 2760–2800; likely leftover double-wrap from the first draft: just emit the `subNode` returned by `buildFunction` directly (`builtFns` cache map entry → assignment `R{dst} = subNode`). A monkeypatch logging wrapper (see repro below) did NOT catch it because `t.functionExpression` was destructured/bound before patch — patch `@babel/types` via `require` cache injection or add `console.error` in `buildFunction` before both `t.functionExpression` call sites printing `paramNames` when any entry is falsy.

### Quick repro

```bash
node -e "const m=require('./vm.js');const fs=require('fs');const p=require('@babel/parser');const vm=m.extractVM(p.parse(fs.readFileSync('input.js','utf8')));const {table}=m.classifyHandlers(vm);const dis=m.analyze(vm,table);try{require('@babel/generator').default(m.liftProgram(dis))}catch(e){console.error(e.stack)}"
```

## After fixing params

Expected ordering of remaining issues (each likely 1–3 small fixes):

1. `unscheduled block` / `clone budget exhausted` / `bad clone target` throws from structurer → caught, falls back to switch state machine (`st` var + while(true)+switch) — acceptable but try to get `structure()` working: check `ipdom`/`regionNodes`/`resolveCtx` (`ctxStack` loop/ifjoin frames), `loops` (natural loops via `domSet`).
2. Sanity-check lifted output: `node vm.js input.js output.js` then inspect output.js — expect NO VM classes, decoded strings ("_k1crlxlk2w8"), `Math.imul` hash gone, closures as nested `function fn17(){}` etc.
3. Behavioral verify: run output.js under stub like debug/01_run_input.js (window stub) → must `SET window._k1crlxlk2w8 = <function>`; compare with debug/01_trace.txt.
4. `fn.params < fn.regs && readPositions.has(fn.params)` → emits `vN = arguments` binding (VM register[params] = arguments object). Verify fn@17 (params=0, regs=162): check whether R0 is actually read (arguments use) before trusting.
5. CGET/CSET naming: `cellVarName(fnEntry, cellIdx)` walks `fn.captures` (`{newCell, src}`) → `c<src>` names shared across parent/child scopes. fn@0 captures R2 (window cell) → child uses `c2`.

## Remaining TODOs

- [ ] Fix FunctionExpression params bug (above)
- [ ] Get `structure()` path working for fn@17 + fn@2109 (fallback switch OK if not)
- [ ] `node vm.js input.js output.js` → valid, VM-free output; `node --check output.js`
- [ ] Behavioral test vs input trace (debug/01_run_input.js style stub)
- [ ] test.js (API: `require('./vm.js')('input.js')` contains decoded strings; `('regular.js')` passthrough) + write regular.js (small plain JS file, e.g. a few functions/loops)
- [ ] Edge cases in `deobfuscateSource`: parse failure → passthrough (done), extractVM null → passthrough (done), lift throw → passthrough (done, maybe reconsider: warn loudly)
- [ ] Final NOTES.md update (select algebra, widening, chain inlining, lifter design); delete RESUME.md/RESUME_2.md content into NOTES.md if desired (keep files per instructions)
- [ ] `node --check vm.js` clean (currently clean)

## Key internals map (vm.js)

- `analyze()` returns `{instrs:Map<ip>, functions:Map<entry,{entry,params,regs,rest,captures,ips:Set,edges:Map<fromIp,[{to,kind,cond,sense,origin,blockStart?}]>,dispEntries:Set}>, unknownRegions, unresolvedJumps, decodeConst, n}`
- Dispatch edges: kind="dispatch", `blockStart`=case block leader ip, cond/sense set for conditional dispatch (cond = REAL comparison reg written by SEQ/SNE/etc before NOT/TONUM mask ops).
- `liftProgram`: `prepareFn` (machinery exclusion via backward slice from dispatcher-entry JMPs; `blockCondReg`; leaders; `termOf` uses deduped `dispatch` map first, then raw JMP/JMPT/JMPF edges) → `buildFunction` (per-fn emission: `emitBlockStmts` stmt-per-instr with dead-store elim + single-use folding via `pending` map; `structure` dominator/pdom/loop structurer with clone fallback; switch-state-machine fallback) → program = top fn body (parentless via `fnParents`).
- `LIFT_PURE`, `LIFT_TERMINATORS`, `readsOf`/`writesOf`, `literalAst`, `RESERVED_WORDS` all at Section 5 top.
- CLI: `node vm.js input.js output.js`; API `module.exports = runFile` with `.deobfuscateSource`, `.liftProgram`, etc.

## Debug files (keep all; refresh with)

- `node debug/04_disasm.js` — regenerates disasm.txt with current edge annotations (`// -> to(kind)`)
- `debug/handler_records.txt`, `debug/bytecode.json`, `debug/01_trace.txt` (runtime SET window trace)
- Env: Windows PowerShell 5.1, node v25.8.1, `../node_modules` has @babel/*. AVOID `Set-Content`/`Get-Content` round-trips on vm.js (UTF-8 corruption — use Edit/Write tools only; repaired once via node cp1252-reverse script).

## Gotchas learned this session

- Widening must treat fact ABSENCE as contradiction (intersect), else envs never merge and 2095 gets popped 11k+ times.
- boolPairs in `env.b` can be pruned unconditionally at pops (only consumed within one straight-line run).
- `mkEdge` dispatch edges get `blockStart: runStart` (run leader = case block start) — lifter depends on it.
- After a resolved JMPR fork, `delete envD.v[instr.src]` (state reg) so downstream doesn't keep stale sel/const.
- Entry-block repair: fn entry dispatch may fold to `goto` (const cond); `prepareFn` re-enters at loop header with identical `condKey` — needed for fn@17 (entry folded → header at 32? verified blocks 17/32/1334 loop).
- Babel: `t.functionExpression(id, params, body)`; params must be Identifiers/RestElement/AssignmentPattern (no undefined).
