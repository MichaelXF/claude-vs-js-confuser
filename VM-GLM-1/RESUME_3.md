# RESUME_3 — VM-GLM-1 session state (lifter polished, mid-refactor)

Read vm.js header + README.md first. Sections 1–4 done/verified. Section 5 lifter WORKING end-to-end for input.js: `node vm.js input.js output.js` → valid VM-free JS, `node debug/05_verify_output.js --call` → TRACES MATCH (load + payload call). Was at 25806 bytes output with dispatch dissolution working. Currently MID-EDIT with a TDZ bug to fix (see THE BUG).

## Session progress (all fixed & verified this session)

1. **FunctionExpression params bug** (RESUME_2's blocker): `paramNames` were raw strings. Fixed: `paramNames` built AFTER `regName` (captured regs get `c`-names; params can be captured), params mapped to `t.identifier(nm)`, rest via `t.restElement`. Sites: vm.js `buildFunction` end (~line 2845 now).
2. **Top-level return**: `liftProgram` program assembly unwraps top-level `ReturnStatement` → expression statements (drop `undefined` returns). Program = `t.program(progFn.body.body)` mapped.
3. **Structurer rewrite** (`structure`, `cloneSeq`, `resolveCtx` in `buildFunction`):
   - Fixed stack overflow: `loops.has(cur)` guarded by `!ctxStack.some(c => c.type === "loop" && c.header === cur)`.
   - Labeled contexts: loop frames `{type:"loop", header, exits, label:"L"+n, labelUsed, breakOk}`, ifjoin frames `{type:"ifjoin", join, label:"J"+n, labelUsed}`. `resolveCtx(T)`: (1) loop headers at any depth → continue (labeled if not innermost loop, via `loopLabelFor`); (2) enclosing ifjoin → null (fall) or labeled break if loops nested between; (3) innermost loop with `T ∈ exits` AND `frame.breakOk` → break. `breakOk` set only when loop has exactly 1 unscheduled exit target (multi-exit loops must NOT use break → callers tail-clone exit paths instead). Emits `t.labeledStatement` only when `labelUsed`.
   - `cloneSeq`: `cloneActive` Set cycle guard, depth ≤ 24, marks `info.scheduled.add(bs)` after emitBlockStmts succeeds (inside try; fallback clears scheduled). Tail-clones unscheduled in-region gotos, `emitArmWith`/`emitBothOut` handle cond arms leaving region (jump / fall-guard `if(!cond){arm}` / tail-clone `cloneArm`).
   - else-if flattening: `armAst(stmts)` = single IfStatement → unwrapped (else-if chains).
   - cond: hoist `condExpr = exprOf(condReg)` BEFORE emitting arms (pending-fold consumption correctness).
   - dominator/pdom fixed-point: compare set CONTENTS not just `.size` (silent stall bug, both dom and pdom).
   - Loop detection: back edge u→v ⟺ `domSet(u, v)` (v dominates u) — keep original direction (I briefly inverted it wrongly; reverted).
4. **Entry repair (CFF folded entry)**: entry block's dispatch folded to const → entry jumped straight to loop body mid-chain (bypassing loop head B32). Repair in `prepareFn` (~line 2230): follow entry's fall chain to its dispatcher `JMP` instr, find containing block P (max block start ≤ jmpIp), if P is a `cond` block AFTER entry's last ip with a successor == entry's goto target → redirect `entry.term = {kind:"goto", to:P}`. Verified: B17 goto 32 (was goto 46).
5. **Transitive DSE**: `LIFT_DSE_SAFE = LIFT_PURE − {GETPROP, LDG}` (getters may fire). Compute live regs backward (iterative fixpoint over all blocks: essential = reads of non-DSE-safe ops + terminator reads; DSE-safe defs live propagate their reads). `deadIps` skipped in `emitBlockStmts`. Kills salt arithmetic (v154/v159 chains).
6. **CFF case-dispatch dissolution** (`prepareFn`, `for (let round = 0; round < 4; round++)` ~line 2294): detects payload's own `switch(state)` machine:
   - Hub H = block with ≥3 goto-preds + cond term. Header cond `stateReg SEQ/SNE exitConst` → equalSide (exit)/ladderSide. Ladder = chain of cond blocks `lEnv`-tracking a running const ladder var compared to stateReg; each link `{C, target, block}`; ends with fallback block (`goto H`).
   - Const-env propagation (`blockEnv:Map<bs,Map<reg,const>>`) from entry + injected case heads; `joinEnv` = intersection; state conflicts on shared case bodies → clone block (negative keys `-1-split*1000`, max 12 splits); `queue`/`drain` with persistent `qHead`, `seenConflict` dedup. H and `linkBlocks` excluded as propagation targets (hang fix!).
   - Rewires: back-edge blocks with const exit state C → `resolveTarget(C)` (link target or equalSide, following pure-trampoline gotos); entry edge also rewired. Dead-terminal consts (no link, e.g. -13979, 60226) → point link match-edges + dead edges at `fallback` (preserves infinite pure-dispatch = original semantics), then `break` (skeleton remains). Variable (⊥) exit states → bail (`ok=false`). fn17: hub 32 state r50 exit 17834, 33 links incl. 44769 (entry). fn2109: hub 2131 state r20 exit 52856, 18 links.
   - `makeConstEval(getInstr, decodeConst)` factory (module level, after `binopConst`/`unopConst`) shared by dissolution + block-local folding. Handles LIFT_BINOPS/LDI/LDC(scalars)/MOV/LIFT_UNOP_SYM, else kills dst.
7. **Block-local constant folding** (JUST ADDED, has the TDZ bug): kills `v153 = K; v50 = v50 + v153` salt. Computes `blockLocalReg` (regs whose every read has preceding same-block def — reads at terminators disqualify since `blockOfIp.get(termRead) === undefined`) + `constAt:Map<ip, Map<reg,val>>` (env BEFORE each ip). `valOf(reg, ip)` folds to `literalAst(v)` else falls to `exprOf`. `assignAst` skips pure defs of blockLocal regs. All emit sites switched `exprOf(x)` → `valOf(x, ip)` (BINOP/UNOP/MOV/GETPROP/SETPROP/DELPROP/CGET/CSET/ARRLIT/OBJLIT/CALL/CALLI/CONSTRUCT/THROW/DEFGET/DEFSET; `callAst(instr, curBlock, ip)` takes ip now).

## THE BUG (immediate next step)

`buildFunction` throws `ReferenceError: Cannot access 'readPositions' before initialization` (vm.js ~line 2677). Cause: I inserted the block-local-folding block (which uses `readPositions`, `blockOfIp`) BEFORE the `// read positions for dead-store elimination` block that declares them (`const blockOfIp`, `const useCount`, `const readPositions`, `addRead` at ~lines 2717–2734). **Fix: move the block-local-folding block (lines ~2668–2714, the `const blockLocalReg`/`const constAt` IIFE-ish `{...}` block) to AFTER the readPositions computation block.** Note `deadIps`/DSE block (~2632–2666) is BEFORE too but doesn't use readPositions (it recomputes internally) — fine where it is, but double-check. After fixing, run:

```bash
node --check vm.js; node vm.js input.js output.js; node --check output.js; node debug/05_verify_output.js --call
```

Expect TRACES MATCH and output < 25806 bytes (salt gone). Note: BEFORE this refactor output was 25806 bytes WITH traces matching (dissolution working, structure working — zero `let st =` switch fallbacks). One prior run at 41901 bytes was the broken-passthrough run (lift threw, `deobfuscateSource` fell back to source — output was literally input.js minified; that's how passthrough looks, don't be fooled).

## Current output state (at 25806 bytes, pre-TDZ-refactor)

- fn@0 top: `v3=false; v3=window; v4="_k1crlxlk2w8"; v5=function fn17(){...}; v3[v4]=v5; v3=undefined; return v3` (return unwrapped at top level).
- fn17: payload visible — createElement/appendChild/style.width="calc(100px + 20px * 2)"/Date.now/Math.floor/document.body. Remaining noise: `v153 = K; v50 = v50 ± v153` salt (→ fixed by block-local folding once TDZ fixed) and fn2109 dead-dispatch skeleton ladder (`v24 = v20 !== 52856; if...continue` chains, lines ~99-213 of output).
- fn3446/fn3574: clean hash-step functions (imul mixing), fully lifted.

## Remaining TODOs

- [ ] Fix TDZ (above); re-verify: traces match, size drop
- [ ] test.js (README spec): `require('./vm.js')('input.js')` contains decoded strings (e.g. "_k1crlxlk2w8", "createElement", "calc(100px + 20px * 2)"); write `regular.js` (plain JS w/ functions/loops); `('regular.js')` passes through unchanged
- [ ] Optionally: fn2109 ladder skeleton dissolution round 2 (dead-edge fallback keeps skeleton; could rerun dissolution after DSE makes dead edges obviously dead — currently `break` after deadEdges handling)
- [ ] Update NOTES.md (dissolution, structurer labels/breakOk, DSE, block-local folding, entry repair, dom/pdom content-compare fix); keep RESUME*.md files
- [ ] Cleanup: stray duplicated `pending.take` lines were removed earlier; verify no leftover debug dbg lines that are noisy (`dissolve fn%s...` uses dbg so only w/ VM_DEBUG — fine)
- [ ] `node --check vm.js` clean

## Key internals map (vm.js, ~3465 lines)

- Section 5 top: `LIFT_BINOPS/BINOP_SYM/UNOP_SYM/PURE/TERMINATORS`, `LIFT_DSE_SAFE`, `binopConst`, `unopConst`, `makeConstEval`, `readsOf`/`writesOf`, `literalAst`, `RESERVED_WORDS` (~line 2890).
- `liftProgram`: `fnParents`, `cellVarName(fnEntry, cellIdx)` (captures `{newCell, src}` → `c<src>` names, recurses parent), `maxLE`, `prepareFn` (dispatch dedup byBlk→cond/goto/multi terms, machinery backward slice `mach`/`chainReads` from `dispEntries` JMPR chains, leaders, `blockCondReg`, `realIps`, `termOf`, block construction, entry repair, **dissolution rounds**, reachability prune) → `buildFunction` (capRegs/regName, **DSE deadIps**, **blockLocalReg/constAt**, readPositions/useCount, pending/exprOf/valOf, assignAst, callAst, emitBlockStmts, dom/pdom/ipdom/loops, ctxStack/resolveCtx/jumpStmt, cloneSeq/cloneArm/regionNodes/emitSub/armAst, structure, emitArmWith/emitBothOut, switch-machine fallback, hoisted `let` decls, params) → program assembly (top = parentless fn via fnParents walk).
- Debug: `VM_DEBUG=1` dbg lines; `VM_BLOCKS=1` dumps per-fn block CFG to stderr (redirect to file — PS mangles). debug/05_verify_output.js = trace-diff harness (`--call` flag calls `window._k1crlxlk2w8()`), writes debug/05_trace_input.txt + 05_trace_output.txt.
- Gotchas: PowerShell stderr → NativeCommandError noise (ignore); avoid Set-Content on vm.js (UTF-8 corruption); Babel `t.functionExpression(id, params, body)` params must be real Identifier/RestElement nodes; `armAst` single-if unwrap; `exprOf` consumes `pending` (single-use fold) so cond hoist before arms.
- Structure working = zero `unscheduled block`/`clone cycle`/`Maximum call stack` dbg output; switch fallback emits `let st = 0; while(true) switch(st)` (currently NONE in output — all 5 fns structure).
