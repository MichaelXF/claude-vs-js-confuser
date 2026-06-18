# VM-1 Devirtualizer — working notes

Target: `input.js` is JS-Confuser's **VM** obfuscation. A register-based bytecode
interpreter (`ra`), bytecode in `Y` (base64→Uint32Array), a constants array, and
XOR+base64 string encoding decoded by `J`.

## Pipeline (vm.js)
1. `extractVM` — Babel-parse input.js, pull the base64 bytecode string + the
   constants array literal + frame size from `new H(Y, 21, [...], W)`.
2. `disassemble` — linear decode of all 817 words into instructions (clean, no gaps).
3. `discoverFunctions` — entry @0 + every `DEFINE_FUNCTION` target; per-function
   reachable instruction set via CFG BFS.
4. `buildBlocks` — basic blocks (leaders at jump/branch/catch/try-pop targets).
5. Emit:
   - `emit-structured.js` (primary): recover if/else, while, try/catch, for-in;
     named register vars; **expression folding** for readability.
   - `emit-dispatcher.js` (fallback): `while(true) switch(pc)` — guaranteed correct.
   vm.js tries structured first, falls back to dispatcher on `Unstructurable`.

## Opcode map (see OP table in vm.js)
Loads/moves, global/upvalue access, member get/set/delete, all binops + `**`(POW),
unops, void, typeof-global, jumps (uncond/iftrue/iffalse), call/call_method/new
(argc sentinel `1609168361` = spread), return/throw, define_function (closures via
capture descriptors), new_array/new_object, define getter/setter, for-in init/next,
try_catch/try_pop/try_finally, jump_dyn (finally), code_copy, debugger.

## Verification
- `verify.js` runs input.js vs output.js in `vm` sandboxes under 7 DISTINGUISHABLE
  deterministic environments (window/document/process/Bun combos, stubbed
  Date.now/Math.random) and deep-compares the console.log output. This proves
  faithfulness (e.g. the bytecode genuinely maps `bu`→window-check register, not Bun).
- `test.js` is the README-style test (decoded-strings + regular.js passthrough).

## Status — COMPLETE
- Dispatcher emitter: DONE, verified (7/7) — `VM_FORCE_DISPATCH=1 node vm.js ...`.
- Structured emitter: DONE, verified (7/7).
- Expression folding: DONE, verified (7/7).
- `node test.js`: all checks pass (decoded strings, executes, regular.js passthrough).
- Idempotent: re-running vm.js on output.js leaves it unchanged.

## Post-hoc check against original.js (provided after the solution)
- `node verify.js output.js original.js` → 7/7. output.js ≡ original.js behaviorally.
- Structural match is near-1:1. Confirmed subtleties:
  - `signals.bu` is `isBrowser` in the original (NOT the Bun check) — output reproduces it.
  - `var isBun = typeof Bun !== "undefined"` is DEAD in the original (never used); the
    folding pass eliminated it as dead code. Behavior unchanged.
  - Cosmetic only: register names (r3/r4/…) vs source names; `while` vs `for`;
    `Math.floor.apply(Math,[…])` vs `Math.floor(…)` (conservative, since a side-effecting
    `Math.random()` sits between the property read and the call).

## Files
- `vm.js`            entry point + extraction/disasm/CFG + emitter wiring + CLI.
- `emit-structured.js`  primary emitter (control-flow recovery + folding).
- `emit-dispatcher.js`  guaranteed-correct fallback (while/switch pc machine).
- `disasm.js`        standalone disassembler (debug).
- `verify.js`        equivalence harness (input.js vs output, 7 scenarios).
- `test.js`          README-style test.  `regular.js` negative sample.
- `output.js`        deobfuscated result.  `output.dispatch.js` fallback form.
