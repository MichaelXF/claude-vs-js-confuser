# RESUME — VM-GLM-1 devirtualization session state

## Task (from README.md)
- Build `vm.js` (Babel AST deobfuscator) for `input.js` (JS-Confuser-VM 0.1.5).
- `node vm.js input.js output.js`; API `require('./vm.js')('input.js')` → deobfuscated code string; `require('./vm.js')('regular.js')` must pass through unchanged (no VM present → return input unchanged).
- Full bytecode devirtualization + CFG reconstruction required; opcode analysis must survive randomized opcodes per build. Output = original JS, no VM classes.
- Need: test.js, regular.js (my own), NOTES.md (exists, needs final pass), debug/ scripts (keep all).
- Windows PowerShell 5.1; use bash tool with workdir; node v25.8.1; @babel/* in ../node_modules. Stay in this dir. Babel uses `node.left` (NOT `target`) for AssignmentExpression.

## Current vm.js structure (Sections 1-4 written)
1. `extractVM(ast)` — finds dispatcher (`this[computed]()` + catch), handlerVar (`var z = q.prototype`), handler table `z[NUM]=function(){}`, WeakMap var, decoderMult, constants array, bytecode (base64→LE u32), entryMeta `{m,b,v}`, helpers (cellReadFn `w`, framePushFn `x`, metaCtor `u`). All structural, works.
2. `interpretHandler(fn, vm)` — symbolic interpreter → record `{effects, env, opsRead, regReads}`. Terms: reg/regbase/frame/stack/globals/code/consts/fslot{n}/yload/bin/un/either/cellread/mkcell/applycall/newarr/objlit/newmeta/jref/argsslice etc. Effects: streg/setip/fslotw/stackwrite/setglobal/codewrite/elemstore/cellstore/rset/defprop/pushcatch/pushfinally/pophandler/throw/unwind/forloop/vmstate/debugger. `&&`/`||` push guards onto condStack; `either` terms for var rebinds under condition.
3. `matchArchetype(rec)` — 161/161 handlers classified. Archetypes: BINOPs, UNOPs, MOV, LDI, UNDEF, LDC(yload), LDG, TYPEOF_G, STG, GETPROP, SETPROP(rset), DELPROP, THIS, CGET/CSET, MKFUNC, CALL/CALLI/CONSTRUCT (argc sentinel 36020178 = spread), ARRLIT/OBJLIT, DEFGET/DEFSET, FORIN_INIT/FORIN_NEXT, JMP/JMPR/JMPT/JMPF, THROW, RET, PUSHCATCH/PUSHFIN, POPH, DEBUGGER, DECODE. `countRefs` counts ONLY refs with `.op !== undefined` (immediates consume no bytecode words). MKFUNC operand order: dst, entryIP, params, regs, capCount, rest, then pairs (flag,src).
4. `analyze(vm, table, opts)` — path-sensitive abstract execution. Contains `concreteEval2` (pure-leaf VM fn evaluator with GLOBAL_WHITELIST incl Math/JSON; folds e.g. Math.imul hash), `exploreFunction` (worklist, per-path env constant prop, DECODE emulation mutating `n`, edges recorded per fn `{to,kind,cond,sense,origin}`), `envKey`, `tryFoldBinop`.

### MID-REFACTOR (incomplete!) — exploreFunction env change
Was converting env from flat map to `{v:{reg→val}, b:{reg→boolishInvert}}` to support **branchless CFF select detection**:
- DONE: header (newEnv, isSel, C/B accessors), `setR(val, boolishInvert)` (uses `instr.dst` internally), MOV passes B(), NOT/TONUM produce boolish invert (NOT flips), binop block: fold if concrete; `__sel` algebra (`{__sel:{condReg,invert,tv,fv}}` combined with number const maps tv/fv through the op; `MUL` of const × boolish creates `__sel {condReg, invert, tv:const, fv:0}`), INOP/INSTANCEOF set boolish 0.
- NOT DONE (edits failed or pending):
  1. Fix remaining OLD setR call sites passing `instr.dst` explicitly (now wrong): lines near `case "CGET": case "CSET": setR(instr.dst, undefined)` → CGET should be `setR(undefined, 0)`; also check ARRLIT/OBJLIT/MKFUNC/CALL/LDG/etc. all use new signature `setR(value[, boolish])`. THIS already `setR(undefined)`.
  2. `envKey(env)` must handle `{v,b}` structure (key off `env.v` + maybe `env.b`).
  3. Forks must deep-copy `{v,b}` (copyEnv helper drafted in failed edit).
  4. CALL/CALLI: when exactly one arg is `__sel` and others concrete and fnV is pure `__vmfn` → dual-eval fn with tv-args and fv-args → `__sel{tv,fv}` result.
  5. GETPROP: if obj is `__sel` and key concrete → project `obj.tv[key]`/`obj.fv[key]` (needed: dispatcher does `R154 = R154[0]` on hash result `[x]`).
  6. JMPR: if value is `__sel` with numeric tv/fv → `mkEdge(tv,"dispatch",sel.condReg,true)` + `mkEdge(fv,...,false)`; push work items with env copy binding `v[condReg] = !invert` / `!!invert` (delete other junk like findDispatcherChainStart — chain values are already final after projections; NO need to re-run chain).
  7. JMPT/JMPF unknown-cond fork: bind `v[instr.cond]` per side (drafted), copy env properly.
  8. PUSHCATCH/PUSHFIN exceptional edges: `work.push({ip: catchIp, env: newEnv(), ...})` (drafted).

## Program facts (disasm)
- fn@0 (entry): `R1=this; R2=false(const); R3=window; R4="_k1crlxlk2w8"; R5=FN@17; R3[R4]=R5; RET undefined` → program = `window._k1crlxlk2w8 = <closure fn@17>`.
- fn@17 (162 regs): CFF state machine. R156=fn@3446 (hash). Dispatcher chain @2095: `R154 = R156(R154,R155)` (CALLI), 2101: `R157=0`, 2104: `R154=R154[R157]`, 2108: `JMPR R154`. Case blocks: compute real condition into bool reg (e.g. `R54 = R50 SNE R53` or `R160 = cell0`), then `R158=NOT cond; R158=TONUM; R154=<K1>; R159=<K2>; R159=R159-R154; R159=R159*R158; R154=R154+R159` (= select), `R155=<salt>`, `JMP 2095`.
- fn@3446: pure hash: `x^=x>>>28-ish steps; x+=c1; x>>>=0; x^=y; ... Math.imul(x,13947405); x+=c2; >>==0; RET [x]` — folds fine via concreteEval2.
- fn@2109 (88 regs): inner closure (captures 1 cell), own dispatcher JMPR@3445 (state regs ~R70/R71, R82=fn@3574).
- fn@3574: 3 params, 10 regs (another helper).
- Analysis result before refactor: 644 instrs, 5 functions, 0 unknown regions, only 2 unresolved JMPRs = the two dispatchers (2108 in fn@17, 3445 in fn@2109) — exactly what `__sel` completion will fix.

## Section 5 TODO (after analysis works): the lifter
- Per function: ips sorted; identify CFF machinery (dispatcher chain ips; state regs = JMPR src + its CALL/arith feeding chain; select-algebra writes to state regs; salt LDI) and EXCLUDE from output; convert each case block's trailing `JMP dispatcher` into conditional edges (from __sel sense: cond → tv target, else fv target) — this reconstructs real CFG.
- Emit structured JS: basic blocks → if/else, loops (back edges → while), try/catch/finally (PUSHCATCH/PUSHFIN/POPH + catch/finally edges; catch env: exception value in exReg), for-in (FORIN_INIT/FORIN_NEXT/exit), calls (CALL with thisArg → fn.call / method; CALLI plain; spreads), NEW, ARRLIT/OBJLIT, DEFGET/DEFSET, getters, typeof global, STG/LDG, CGET/CSET → captured variable refs (map cell idx → var name; MKFUNC captures: newCell→local var captured, rebind→parent var), delete, debugger.
- Registers → variables (v0..vN or role-based names); fold MOV chains into expressions optionally; entry fn becomes program statements.
- Output via @babel/generator. Then: CLI wrapper (process.argv), API export returning string, pass-through when extractVM returns null.

## Verification plan
- `node vm.js input.js output.js`; `node test.js` (require API on input.js → expect decoded strings like "_k1crlxlk2w8", Math.imul gone/VM gone; on regular.js → passthrough). Sanity: run output.js in stub env (debug/01_run_input.js style) → sets window._k1crlxlk2w8 to a function; compare behavior with input.js trace (SET window._k1crlxlk2w8).
- Lint: none configured; just node syntax check `node -c`-equivalent (node --check vm.js).

## Debug files (keep)
debug/01_run_input.js, 01b_trace_input.js (trace → only `SET window._k1crlxlk2w8`), 02_extract.js, handlers_dump.js, 03_records.js, handler_records.txt (all 161 symbolic records), 04_disasm.js, disasm.txt, bytecode.json, 01_trace.txt.

## Gotchas learned
- `Get-Content -TotalCount` (not -TotalContent). Edit tool needs exact whitespace. Babel AssignmentExpression: `node.left`. `literalValue` handles `!1` via BooleanLiteral + `!` unary. Operand-order bugs: ARRLIT/OBJLIT/MKFUNC varargs start at first symbolic read index (spreadRef.op or elem read idx), not 1+countRefs. `either` terms from `c||(c=[])` need unwrapping when matching FS11 push/pop. Conditional streg (FORIN_NEXT ternary) must not be filtered by `!e.cond`.
