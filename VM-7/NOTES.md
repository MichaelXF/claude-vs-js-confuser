# JS-Confuser-VM MBA v5 — analysis notes

Status: **partially solved.** The VM is fully mapped, the bytecode is disassembled,
the dispatcher and both layers of control-flow flattening are resolved, and the
program is lifted back to readable JavaScript. Two arithmetic details are still
lifted incorrectly, so `output.js` is not yet behaviorally identical to
`input.js` (see [Known defects](#known-defects) and [Next steps](#next-steps)).

---

## 1. Sample architecture

### 1.1 Top-level shape

```js
function g(a,e,h){ this.i=a; this.b=h; this.k=e; ... }   // VM instance
var m = new WeakMap();                                    // fn -> function record
function r(a){ this.C=a; this.j=[]; this.prototype={} }   // function record
function t(a,e){ this.g=e; this.f=a; ... }                // closure cell
function x(a){ return a.i[a.g[a.h+0]++] }                 // fetch operand word
function y(a){ ... }                                      // decode constant
function A(a,e,h,c,b){ ... }                              // interpreter loop
var B = g.prototype;  B[39401] = function(){...}          // 113 opcode handlers
...
A(new g(E, C, [consts...]), new r({d:0,Q:8,m:0,x:2207321894}), void 0, null, "k");
```

* `this.i` — bytecode, a `Uint32Array` built from a base64 blob at load time
  (this is what `encodeBytecode: true` produced; there is **no** runtime
  self-modification in this sample, though a decrypt opcode exists — see 1.3).
* `this.b` — constant pool (49 entries, mixed strings/numbers/`undefined`).
* `this.k` — the globals object (`globalThis`, with `window`/`document`/`module`
  copied onto it at load).
* `this.g` — one flat array holding **all** frames; `this.h` is the frame pointer.

### 1.2 Frame layout (offsets from the frame pointer)

| offset | meaning |
|---|---|
| +0 | program counter |
| +2 | `this` value |
| +3 | try-handler stack (lazily created array) |
| +4 | call flags: bit0 = `new`, `>>1` = destination register in the caller |
| +6 | function record (`r` instance) |
| +7 | **function salt / key** (`desc.x`) — see §2 |
| +8 | argument array |
| +9 | frame size (`13 + Q`) |
| +10 | parent frame pointer |
| +11 | register base (`frame + 13`) |
| +12 | per-dispatch scratch (`imul(op+1, 2168166775) ^ 746681970`) |
| +13… | registers `r0 … r(Q-1)` |

Parameters land in `r0..r(d-1)`; register `r(d)` receives the whole argument
array; `desc.F` marks the last parameter as a rest parameter.

### 1.3 Opcode roles found (113 handlers, randomized numbering)

Control: `jump`, `branch` (jump-if-false / jump-if-true), `dynjump` (jump to a
register — the dispatcher), `return`, `throw`, `trycatch`, `tryfinally`,
`trypop`, `debugger`, `decrypt` (in-place bytecode XOR decryptor, *unused here*).

Data: `loadimm`, `loadconst`, `move`, `this`, `void`, `getmember`, `setmember`,
`deletemember`, `getglobal`, `setglobal`, `typeofglobal`, `getclosure`,
`setclosure`, `array`, `object`, `definegetter`, `definesetter`, `forininit`,
`forinnext`, `call`, `mcall`, `new`, `func`.

Arithmetic: the usual 20 binary + 5 unary operators, plus **~50 extra opcodes
that are MBA rewrites of those same operators** (that is where most of the 113
handlers go).

Constant strings are base64 + a xorshift keystream:

```js
h = key; out = "";
for (i = 0; i < buf.length/2; i++) {
  h = h + 2654435769 | 0;
  out += String.fromCharCode((buf[i*2] | buf[i*2+1]<<8) ^ ((h ^ h>>>13) & 65535));
}
```

Numeric constants are simply `pool[idx] ^ key`.

### 1.4 Two independent flattening layers

1. **Dispatcher (`dispatcher: true`).** Every basic block ends with
   `jmp <trampoline>`, and the trampoline is `state = hash(state, k1, k2);
   jump state`. The hash is itself a VM function (`@2830` for `fn@37`, `@2980`
   for `fn@1758`) doing `imul`/rotate/xor mixing. Block addresses never appear
   literally in the bytecode.
2. **Control-flow flattening (`controlFlowFlattening: true`).** Inside the
   bytecode there is a second switch: a chain of blocks each comparing a state
   register (`r36` in `fn@37`, `r13` in `fn@1758`) against a concealed constant
   and dispatching to one case. Body blocks end by assigning the next state
   constant and jumping back to the chain head.

Recovered program structure:

| function | params | regs | role |
|---|---|---|---|
| `@0` | 0 | 8 | top level: `var flag = false; window["_k1crlxlk2w8"] = fn@37` |
| `@37` | 0 | 72 | the exported function (DOM work + string building + logging) |
| `@2830` | 3 | 16 | dispatcher hash for `fn@37` |
| `@1758` | 2 | 48 | string decoder (closure over `fn@37`'s `r9`) |
| `@2980` | 3 | 16 | dispatcher hash for `fn@1758` |

---

## 2. Function salt (frame key) — how it was obtained

Every MBA handler reads `frame[+7]`, the enclosing function's salt, and derives
junk multipliers from it:

```js
d = rotl(imul(key + 1204453510, -1046618859), 6) - 1749065783 | 0;
b = imul(d, 268556821) ^ 462165301 | 1;
... imul(imul(operand, b), 47908741) ...      // == operand only if imul(b, 47908741) === 1
```

**The salt was never guessed or brute-forced.** Two dynamic sources give it:

* the top-level salt comes straight from the intercepted entry call
  (`new r({d, Q, m, x})` — `x` is the salt);
* nested salts come from *executing the real function-definition handler*
  (`func`, opcode 34577) with the analyzer's register file, then reading the
  resulting closure back out of the VM's own `WeakMap` (`m.get(fn).C.x`). The
  handler computes
  `n = imul(seed,1123873253) ^ imul(w1^w3,601502569) ^ imul(w2+w4+w5,1217387604) ^ parentKey`,
  but the tool never needs to know that formula — it just runs the handler.

`debug/keycheck.js` confirms the mechanism: for `fn@1758`'s salt
(`733337458`), `imul(b, 47908741) === 1` exactly, while every other function's
salt gives a garbage value. **Consequence: each MBA opcode is specialized to one
function** — the same opcode executed under a different salt computes nonsense.
The analyzer therefore always writes the owning function's salt into
`frame[+7]` before running any handler.

---

## 3. Why the MBAs are hard to read statically

A representative handler (opcode 39401, ~1.3 KB after pretty-printing) combines
five separate tricks:

1. **Operand transforms that only cancel for the right operand shape.**
   Terms like `x + Math.imul(x & 15 ^ 9, 493602057)` vanish only when
   `x & 15 === 9`. The obfuscator guarantees that by making every concealed
   constant end in nibble `9` (observed state values `-825403175`,
   `-145925927`, `726489305`, … are all `≡ 9 (mod 16)`).
2. **Salt-derived multipliers.** `imul(imul(d, b), 47908741)` is the identity
   only because `b` is the modular inverse of `47908741`, and `b` comes from the
   function salt. Wrong function ⇒ wrong result, no error.
3. **Dead selector branches.** `n = imul(k ^ C1, C2) >>> 7 & 1` picks between
   two *different-looking but equivalent* formulations,
   `(n&1) * formA + (n&1^1) * formB`. Both are always computed; only the
   immediate decides which one contributes.
4. **Tagged / junk register operands.** Every MBA handler reads one or two extra
   register operands beyond the real ones. Some cancel algebraically for any
   value (`+d-d`, `x & ~d | x & d`, `(16 & ~d) ^ (16 & d)`); others are the
   nibble-9 kind from (1). They are always coerced first (`~~`, `|0`, `&-1`,
   `^0`), so they behave as int32 regardless of the value stored.
5. **Immediate low-bit constraints.** Terms like `Math.imul(f & 7 ^ 1, K)`
   vanish only when the operand immediate satisfies `f & 7 === 1`. Probing an
   MBA handler with synthetic operand words therefore produces *wrong*
   behavior — the real words must be used.

Additionally the destination register is scrambled: MBA handlers write
`reg[destWord ^ (imul(imm, C) & 7)]` rather than `reg[destWord]`.

Net effect: static reading of one handler takes tens of minutes, and there are
~50 of them. Executing them is trivial by comparison — hence the oracle
approach below.

---

## 4. Approach: use the VM as its own oracle

### 4.1 Loading

`lib/machine.js` parses the sample, rewrites **only** the final entry-call's
callee to a capture hook, and runs the file in a Node `vm` sandbox. That yields
the live handler table, bytecode, constant pool, globals and the top-level
function record — before a single instruction of the *guest program* executes.

### 4.2 Behavioral opcode classification (not source matching, not opcode numbers)

Each handler is executed against a synthetic frame in which

* every register holds a `Proxy` recording `get/set/has/delete/apply/construct/
  defineProperty/ownKeys/getPrototypeOf`,
* the globals object, the constant pool and the bytecode array are proxied too,
* operand words are `[1,2,3,…]` so operand slots are identifiable,
* the frame is proxied to record register/frame reads and writes.

The observed traps decide the role: an `apply` trap with a `this` argument means
`mcall`, `construct` means `new`, `ownKeys` means `forininit`, a write to the
globals proxy means `setglobal`, a write into the bytecode array means
`decrypt`, a change of `this.h` means `return`, and so on. Conditional jumps are
found by running the handler twice, once with a falsy and once with a truthy
condition register, and seeing which run writes an out-of-sequence pc
(`jumpTarget()` filters the ordinary `pc++` writes that operand fetching does).

This part is **build-independent**: nothing keys off the opcode numbers.
`debug/test-classify.js` checks the classifier against the 61 opcode roles that
were read by hand: all 61 agree (the 5 "mismatches" it prints are equality/move
opcodes that are deliberately deferred to the operator fitter).

### 4.3 Operator fitting (`lib/fit.js`)

Everything left over (`kind: "arith"`, 78 of 113 opcodes) is identified by
running the handler and matching results against 20 binary and 7 unary candidate
operators:

* **Round 1 — mixed types.** Values drawn from
  `{0,1,-1,2,"","0","1","abc",true,false,null,undefined,NaN,1.5,-0.25,[],{},"5"}`
  plus forced pairs (`0/false`, `"0"/0`, `1/true`, `null/undefined`, equal
  operands). A handler that reproduces a candidate operator exactly on this pool
  is a *plain* handler and is reported as that operator.
* **Round 2 — int32 domain.** If nothing matches exactly, the pool switches to
  int32 values and the candidates are re-tested both exactly and truncated
  (`(a op b) | 0`). MBA handlers match here, which also flags them as int32-only
  implementations.
* **Ranking.** Ties are broken by a preference list (simple operators first,
  non-truncated first) plus a bonus for keeping the operand order the handler
  reads them in, so `a > b` is not silently rewritten as `b < a`.

Critically, fitting happens **at a concrete instruction site**, not on synthetic
words: the real operand words are used, the owning function's salt is installed,
and every operand the analyzer already knows is **pinned to its real value**
while only the unknown ones are sampled. That is what makes the junk operands,
the nibble-9 constraint and the immediate low-bit constraints hold.

Distinguishing `==` from `===` (and `!=` from `!==`) is impossible for the MBA
variants, because they coerce both operands to int32 first; the fitter prefers
the strict form. Not an issue in this sample — every surviving comparison is a
plain handler.

### 4.4 Abstract interpretation (`lib/analyze.js`)

A constant-propagating interpreter walks each function. Pure instructions with
fully known operands are **executed by the real handler**, so:

* concealed constants decode themselves (they are pure functions of the
  immediates plus junk registers),
* the dispatcher resolves itself — the trampoline's callee register holds a real
  JS closure produced by the `func` handler, so the analyzer literally calls it
  to get the next block address,
* the flattening predicates fold, which unflattens the CFG.

Extra mechanisms that were needed:

* **Invariance folding.** An MBA instruction whose result does not change while
  its *unknown* operands are resampled is a concealed constant, so it is folded
  even with unknown inputs. This is what lets the state register stay concrete
  when a junk operand happens to be `this` or a global. *This is also the source
  of one of the remaining defects — see §6.*
* **Path sensitivity with liveness-based keys.** Block instances are keyed on the
  values of the *live* registers, so the flattening state stays precise while
  dead scratch values do not multiply states.
* **Adaptive widening.** If a block exceeds 40 instances the register with the
  most distinct values is widened to unknown and the pass restarts, preferring
  registers that are *not* written exclusively by MBA opcodes (the flattening
  state is; loop counters and accumulators are not). In this sample exactly one
  register is widened per function: `r9` in `fn@37` (closure-aliased) and `r6`
  in `fn@1758` (the loop counter).
* **Closure aliasing.** Registers captured by a nested function are never
  assumed constant, since the child can write them through a closure cell.

Validation: `debug/validate2.js` traces the real VM (with a DOM shim) and checks
that every block transition it performs exists in the recovered graph.
Result: **83/83 observed blocks and all intra-function transitions covered, 0
missing** (the two reported "missing" self-edges are frame-reuse artifacts of the
tracer for the single-block dispatcher functions).

### 4.5 Lifting and structuring (`lib/lift.js`, `lib/emit.js`, `lib/structure.js`, `lib/polish.js`)

Blocks become statement lists over register identifiers, then:

dead-code elimination (kills the entire dispatcher glue) → DFA-style
minimization of blocks duplicated by path sensitivity → chain merging →
temporary inlining (single use, precise liveness, evaluation-order safe) →
`f.call(o, …)` → `o.m(…)` folding → structuring via dominators, post-dominators
and natural-loop detection into `if`/`else`/`while` (with a `while(true)
switch(state)` fallback that is not needed here) → cosmetic passes
(`o["x"]`→`o.x`, `else` flattening after a terminator, declaration hoisting,
`x + -5` → `x - 5`).

---

## 5. Current output

`node vm.js input.js output.js` currently produces:

```js
var bh = false;
window._k1crlxlk2w8 = function () {
  var bm, ce, bz, ca, s, bg, bq;
  var cp = function (x, w) {
    var aa, z, y, af;
    if (!s) { return; }
    aa = w; z = ""; y = 0;
    while (y < x.length) {
      aa = aa - 1640531527 | 0;
      af = x.charCodeAt(y) | 0;             // <-- WRONG, see §6.1
      z = z + String.fromCharCode(af);
      y = y + 1;
    }
    return z;
  };
  if (!bh) {
    bh = true;
    bm = document.createElement("div");
    bm.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(bm);
    ce = bm.offsetWidth;
    bz = Date.now();
    bg = Math.random();
    ca = Math.floor(bg * 1000000);
    s = bz + "|" + ca + "|" + +(bz - 10000 + ca * 5) + "|" + ...;   // <-- missing `% 97`, see §6.2
    bq = cp(s, ce + ca);
    console.log(s, bq);
  }
};
```

Structurally this is the original program: the class/dispatcher/VM scaffolding,
both flattening layers, the concealed constants and the string encoding are all
gone, strings are decoded (`"_k1crlxlk2w8"`, `"calc(100px + 20px * 2)"`,
`"offsetWidth"`, `"fromCharCode"`, …), and the closure structure is preserved.

---

## 6. Known defects

`debug/compare-run.js` runs `input.js` and `output.js` in identical
deterministic sandboxes (stubbed `Date.now`, seeded `Math.random`, DOM shim) and
diffs every observable event. Current result: **10 of 11 events identical, 1
differing** — the single `console.log`, whose two arguments are both wrong.

### 6.1 The decoder loses its keystream XOR

Expected inner statement (this is the same algorithm as the VM's own `y()`):

```js
z += String.fromCharCode(x.charCodeAt(y) ^ ((aa ^ aa >>> 13) & 65535));
```

Lifted as `x.charCodeAt(y) | 0`. The right-hand operand — the whole
`(aa ^ aa >>> 13) & 65535` sub-expression — was **folded to the constant 0** by
the analyzer. `aa` (the running hash) is unknown at that point, so
`aa >>> 13` must not fold. Root cause is almost certainly `invariantValue()` in
`lib/analyze.js`: with the junk operands resampled the MBA handler apparently
returned the same value for every sample, and the fold was accepted.

Evidence: an early dump of block `2534`/`2744` showed
`r39 = <const> // = 0` and `r38 = r4 >>> r8 // = 0` in contexts where `r4` was
genuinely unknown.

### 6.2 A `%` operation is dropped from the string expression

Ground truth from the bytecode (`fn@37`, block `@1259`):

```
1259  op  6548 [66,24,25]        r66 = r24 + r25          // (now-10000) + (rnd*5)
1263  op  3501 [67,11,...]       r67 = 97                 // decoded constant
1267  op  9164 [68,66,67]        r68 = r66 % r67          // opcode 9164 == `%`
1271  op 19461 [6,68]            r6  = r68                // move
```

Original output is `…|89|40|41` (small numbers, consistent with `% 97`), the
lifted output is `…|1700003266770|…` — the `% 97` step is missing and the `move`
came out as unary `+`. Opcode 9164 is a *plain* handler correctly classified as
`%`, so this is a lifting/cleanup bug, not a fitting bug. Prime suspects, in
order: `mergeEquivalentNodes()` merging two blocks that only look alike after
one of them lost a statement; the dead-store→effect conversion in
`eliminateDeadCode()`; or `inlineTemporaries()` dropping a definition whose use
lives in a later block (the live-out set is computed on the lifted graph and
must stay in sync with `mergeChains`).

### 6.3 Smaller open items

* Three residual warnings (`could not identify the operator of opcode 19570 /
  50279`) come from the flattening state-update opcodes. They are dead code and
  are eliminated, but the warning is emitted during lifting, before DCE runs —
  it should be deferred until the statement is known to survive.
* `trycatch` / `tryfinally` / `trypop` are classified but **not reconstructed**;
  the lifter only records a warning. This sample contains no exception handling
  (0 occurrences in the bytecode), so it is untested territory.
* The `decrypt` opcode is classified but not emulated during the sweep. This
  sample never uses it; a build that does would need the decryption applied
  before/while disassembling.
* Generated variable names (`bh`, `cp`, `ce`, …) come from a global counter;
  naming by role/first use would read better.

---

## 7. Answers to the specific questions

**Is the opcode analysis per-build, or only this sample?**
Per-build. Nothing keys off the opcode numbers, the handler source text, or the
salt values. Handler roles come from behavioral probing, operators from
result-fitting, salts from executing the real `func` handler and reading the
VM's own `WeakMap`, and instruction lengths from counting the handler's operand
fetches. A rebuild with re-randomized opcodes, re-shuffled handler table and
different keys should work unchanged.
What *is* still template-specific, and would need adjusting for a different VM
generation: the frame-slot offsets used when building the synthetic probe frame
(`+0` pc, `+2` this, `+3` try stack, `+6` record, `+7` salt, `+9` size, `+11`
register base), the constant-decoder formula in `Machine.decodeConst`, the
spread sentinel `1329987534`, the operand positions used to compute
variable-length instruction sizes, and the recognition of a dispatcher
trampoline as "`call` followed by `dynjump`".

**Does vm.js use dynamic execution / mock browser APIs?**
It uses dynamic execution, but it does **not** mock browser APIs and it does not
run the guest program. The sample is loaded in a `vm` sandbox whose global has
no `window`/`document`; the entry call is replaced by a capture hook *before*
execution, so the interpreter loop never starts. After that, the only code that
runs is (a) individual opcode handlers against synthetic frames, and (b) the
dispatcher hash functions, which are pure integer math. The DOM shim
(`debug/dom-shim.js`) and everything that calls the exported function exist only
in `debug/` for validation — `vm.js` and `lib/` never require them.

**Are the MBAs hard to decipher, and why?**
Yes, statically. See §3: salt-derived modular inverses, nibble-constrained
operand transforms, immediate low-bit constraints, dead selector branches and
junk register operands, all layered on ~1–5 KB expressions, times ~50 handlers.
Behaviorally they are easy — a few hundred handler invocations identify each one
exactly.

**Was the salt guessed, symbolically executed, or probed?**
Neither guessed nor symbolically executed: it is **read out of the running VM**
(entry call for the top level, `WeakMap` record for nested functions) and then
*probed* — installed into the synthetic frame so the handler's own arithmetic
reproduces the identity. `debug/keycheck.js` verifies the derivation
independently (`imul(derive(salt), 47908741) === 1` for exactly one function).

---

## 8. File map

| file | purpose |
|---|---|
| `vm.js` | CLI + `require("./vm.js")(file)` entry point; passes non-samples through untouched |
| `lib/machine.js` | sandbox load, entry-call capture, handler probing, behavioral classification, constant decoding |
| `lib/fit.js` | operator recovery for plain and MBA arithmetic opcodes |
| `lib/analyze.js` | sweep, abstract interpretation, dispatcher resolution, unflattening, liveness, widening |
| `lib/lift.js` | instruction → AST, DCE, temporary inlining, terminator construction |
| `lib/emit.js` | graph cleanup, block minimization, structuring entry, function assembly |
| `lib/structure.js` | dominators / post-dominators / natural loops → `if`/`while` |
| `lib/polish.js` | cosmetic AST passes |
| `debug/validate2.js` | **CFG validation against the real VM** (currently passing) |
| `debug/compare-run.js` | **behavioral diff of input.js vs output.js** (currently 1 differing event) |
| `debug/trace-values.js` | logs every register write the real VM performs — ground truth for folded values |
| `debug/test-classify.js` | classifier regression check against hand-read opcode roles |
| `debug/ir-nodes.js`, `debug/print-cfg.js`, `debug/sweep.js` | disassembly / IR dumps |
| `debug/junk-test.js`, `debug/keycheck.js` | experiments that established the junk-operand and salt mechanics |
| `debug/analyze.js`, `debug/vmmodel2.js`, `debug/semantics.js`, … | earlier research versions, superseded by `lib/` but kept for reference |

---

## Next steps

Ordered by what unblocks the most.

1. **Fix §6.1 (missing keystream XOR) — highest priority.**
   Make `invariantValue()` in `lib/analyze.js` sound:
   * require a much larger and more adversarial sample set, and resample the
     *known* operands too (with their low nibble preserved) rather than only the
     unknown ones;
   * refuse to fold when any unknown operand feeds a shift/xor chain, or more
     simply: only accept a fold when the instruction's result is also invariant
     under perturbing every unknown operand **independently** (currently all
     unknown registers are perturbed together, so a handler that is invariant on
     the diagonal can look constant);
   * add an assertion mode that cross-checks every folded value against
     `debug/trace-values.js` output for the pcs the real VM executed. That
     harness already exists and would have caught this immediately.

2. **Fix §6.2 (dropped `%`).**
   Bisect the cleanup pipeline in `lib/emit.js::liftFunctionBody` by dumping the
   statement lists after each pass for `fn@37` and locating where the
   `r68 = r66 % r67` statement disappears. Order to test:
   `mergeEquivalentNodes` → `eliminateDeadCode` (second call) → `mergeChains` →
   `inlineTemporaries`. Note that `liveSets()` is recomputed inside
   `inlineTemporaries` but `mergeChains` rewrites `n.term` in place, so a stale
   successor set is a plausible culprit.

3. **Re-run the two validators until clean.**
   `node debug/validate2.js` must stay at 0 missing blocks/edges, and
   `node debug/compare-run.js` must reach `IDENTICAL BEHAVIOR`. Extend
   `compare-run.js` to call the exported function several times (the run-once
   flag means only the first call does work) and to exercise the decoder with
   longer inputs.

4. **Write `test.js` and `regular.js`** as the README asks:
   `require("./vm.js")("input.js")` for the decoded output and
   `require("./vm.js")("regular.js")` for pass-through. `vm.js` already returns
   the source unchanged for non-samples; the test should assert that, assert the
   decoded strings appear in the deobfuscated output, and shell out to
   `debug/compare-run.js` for the behavioral check.

5. **Defer the unknown-operator warnings until after DCE** (§6.3) so a clean run
   is silent.

6. **Implement `trycatch`/`tryfinally`/`decrypt`** for other builds:
   * the try opcodes push `{catchPc, catchReg}` / `{s, G, z, B}` onto
     `frame[+3]`, and the interpreter loop unwinds by scanning parent frames;
     reconstructing them means treating a `trycatch` as opening a protected
     region that ends at the matching `trypop`, and emitting `try { … } catch
     (r) { … }` around the dominated blocks;
   * `decrypt` should be applied during `Analyzer.sweep()` — scan for it and run
     its XOR (`c = (c + 2654435769)|0; i[dst+j] = (i[src+j] ^ c ^ c>>>13)>>>0`)
     before disassembling the destination range.

7. **Nice-to-haves:** name variables from context (`el`, `now`, `rnd`, `out`),
   turn `y = y + 1` into `y++` where the value is unused, and reconstruct `for`
   loops from the `while` + trailing-increment shape.
