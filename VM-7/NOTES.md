# JS-Confuser-VM MBA v5 — analysis notes

Status: **solved.** `node vm.js input.js output.js` recovers a 862-byte readable
program from an 84 KB sample. `node test.js` passes 12/12, including a
behavioral diff that runs `input.js` and `output.js` in identical deterministic
sandboxes and compares every observable event: **all 11 events are identical**.
The recovered control-flow graph covers every block and transition the real VM
executes. The tool is deterministic — repeated runs are byte-for-byte equal.

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
   bytecode a state register (`r36` in `fn@37`, `r13` in `fn@1758`) is compared
   against concealed constants, and the comparison result is **not** branched
   on: it is coerced to `0`/`-1` and used to *mask* the next trampoline
   constant.

```
1826  r17 = <state> === <concealed const>          // false here
1832  r33 = !r17 ; r33 = +r33 ; r33 = -r33         // 0 or -1
1841  r29 = C1                                     // constant for one successor
1844  r34 = C2 ; r34 = r34 - r29                   // difference to the other
1851  r34 = r34 & r33                              // branchless select
1855  r29 = r29 + r34                              // == C1 or C2
1862  JMP <trampoline>                             // hash(r29, r30, r31)
```

The whole build contains **no conditional-jump instruction at all** — the
`branch` opcode exists in the handler table but is never emitted, and every
block in every function ends in `jump` or `return`. Real `if`s and `while`s are
encoded the same way as the flattening: the predicate becomes a mask that
selects the next dispatcher constant. That is why §4.4's boolean path split is
not an optimization but a requirement — splitting on an unknown predicate is the
*only* way the recovered graph gets more than one successor.

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
(`jumpTarget()` filters the ordinary `pc++` writes that operand fetching does) —
this build never emits one, but the classifier finds them anyway.

This part is **build-independent**: nothing keys off the opcode numbers.
`debug/test-classify.js` checks the classifier against the 61 opcode roles that
were read by hand: all 61 agree (the 5 "mismatches" it prints are equality/move
opcodes that are deliberately deferred to the operator fitter).

### 4.3 Operator fitting (`lib/fit.js`)

Everything left over (`kind: "arith"`, 78 of 113 opcodes) is identified by
running the handler and matching results against 20 binary and 7 unary candidate
operators:

* **Round 1 — mixed types.** Values drawn from
  `{0,1,-1,2,"","0","1","abc",true,false,null,undefined,NaN,1.5,-0.25,[],{},"5",
  1e9+7,-1e9-7,"1000000007",987654.321}` plus forced pairs (`0/false`, `"0"/0`,
  `1/true`, `null/undefined`, equal operands). A handler that reproduces a
  candidate operator exactly on this pool is a *plain* handler.
* **Round 2 — int32 domain.** If nothing matches exactly, the pool switches to
  int32 values and the candidates are re-tested both exactly and truncated
  (`(a op b) | 0`). MBA handlers match here, which also flags them as int32-only
  implementations.
* **Ranking.** Ties are broken by a preference list (simple operators first,
  non-truncated first) plus a bonus for keeping the operand order the handler
  reads them in, so `a > b` is not silently rewritten as `b < a`.

Fitting happens **at a concrete instruction site**: the real operand words are
used, the owning function's salt is installed, and the operands the analyzer
already knows are pinned to their real values. That is what makes the junk
operands, the nibble-9 constraint and the immediate low-bit constraints hold.

**But pinning is tried second, not first.** Holding an operand at a constant
destroys the information that distinguishes a binary operator from a unary one:
`a % 97` returns exactly `+a` for every sample smaller than the modulus, and the
unary reading outranks the binary one. So each site is first fitted with *all*
operands free, and only a handler that cannot be explained that way — the
signature of an MBA handler, which needs its real junk-operand values — falls
through to the pinned fit. Without this, all three `% 97`, `% 89` and `% 83`
operations in `fn@37` were silently lifted as unary `+`.

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
* the flattening masks fold, which unflattens the CFG.

Extra mechanisms that were needed:

* **Invariance folding.** An MBA instruction whose result does not change while
  its *unknown* operands are resampled is a concealed constant, so it is folded
  even with unknown inputs. Two things make this sound enough to rely on:
  * every register is sampled **independently**. Indexing the sample pool by
    `(round + register) % pool.length` (what an earlier version did) gives
    registers whose numbers differ by a multiple of the pool size the *same*
    value in every round — with a 34-value pool, `r4 ^ r38` was invariantly `0`,
    and the decoder lost its entire keystream XOR;
  * unknown operands are perturbed **one at a time** as well as together, since
    a handler can be invariant along the diagonal without being constant;
  * the pool is **derived from the site**, not generic: the values the known
    operands hold, and their neighbors, are added to it. A generic pool never
    contains the 32-bit constant a flattening state is compared against, so
    `state === K` would look invariantly `false` and the control flow would
    resolve to nonsense.
* **Path sensitivity with liveness-based keys.** Block instances are keyed on the
  values of the *live* registers, so the flattening state stays precise while
  dead scratch values do not multiply states.
* **Measured widening.** When a block exceeds 40 instances, one live register is
  widened to unknown and the pass restarts. *Which* register is chosen is
  measured, not guessed: every candidate is tried and the resulting pass is
  scored by whether it still overflows, then by **how many distinct bytecode
  blocks it can still see**, then by unresolved jumps, unfolded arithmetic and
  size. Widening the flattening state costs coverage immediately (in `fn@1758`
  it drops from 33 blocks to 19, because the dispatcher no longer knows where to
  go), while widening a loop counter costs nothing. Shape-based heuristics do
  not separate the two: in this sample the flattening state (`r13`) and the loop
  counter (`r6`) are both written exclusively by MBA opcodes and both take a
  similar number of values, and preferring one by "distinct value count" picks
  the wrong one. The result is one widened register per function: `r9` in
  `fn@37` (closure-aliased) and `r6` in `fn@1758` (the loop counter).
* **Closure aliasing.** Registers captured by a nested function are never
  assumed constant, since the child can write them through a closure cell.

Validation: `debug/validate2.js` traces the real VM (with a DOM shim) and checks
that every block transition it performs exists in the recovered graph.
Result: **83/83 observed blocks and 99/99 observed transitions covered, 0
missing.**

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

The bytecode carries no identifiers, so variables are named after the **role**
they play rather than invented from context: `p0` for a parameter, `v0` for a
local, `args0` for the argument array the VM keeps in a register, and `c1_0` for
a variable captured by a nested function (`1` being the index of the function
that owns it). Names are unique program-wide, so a nested function can never
shadow a captured variable it also reads, and a final pass renumbers them so
each role counts from zero in reading order.

Warnings about an expression that could not be lifted are **deferred** until the
expression is known to survive cleanup. The flattening state updates are exactly
the instructions the fitter cannot name and exactly the ones dead-code
elimination removes, so reporting them at lift time made every clean run print
three false alarms.

---

## 5. Output

`node vm.js input.js output.js`:

```js
var c0_0 = false;
window._k1crlxlk2w8 = function () {
  var v0, v1, v2, v3, c1_0, v5, v6;
  var v4 = function (p0, p1) {
    var v7, v8, v9, v10;
    if (!c1_0) {
      return;
    }
    v7 = p1;
    v8 = "";
    v9 = 0;
    while (v9 < p0.length) {
      v7 = v7 - 1640531527 | 0;
      v10 = p0.charCodeAt(v9) ^ (v7 ^ v7 >>> 13) & 65535;
      v8 = v8 + String.fromCharCode(v10);
      v9 = v9 + 1;
    }
    return v8;
  };
  if (!c0_0) {
    c0_0 = true;
    v0 = document.createElement("div");
    v0.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(v0);
    v1 = v0.offsetWidth;
    v2 = Date.now();
    v5 = Math.random();
    v3 = Math.floor(v5 * 1000000);
    c1_0 = v2 + "|" + v3 + "|" + (v2 - 10000 + v3 * 5) % 97 + "|" + (v2 - v1 + v3) % 89 + "|" + (v3 + 1500) % 83;
    v6 = v4(c1_0, v1 + v3);
    console.log(c1_0, v6);
  }
};
```

84,539 bytes in, 862 bytes out. The class/dispatcher/VM scaffolding, both
flattening layers, the concealed constants and the string encoding are all gone;
the guest program's own encoder (a xorshift keystream identical to the one the
VM uses for its constant pool) is fully readable; the closure structure is
preserved.

---

## 6. Answers to the specific questions

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
for validation — `vm.js` and `lib/` never require them.

**Are the MBAs hard to decipher, and why?**
Yes, statically. See §3: salt-derived modular inverses, nibble-constrained
operand transforms, immediate low-bit constraints, dead selector branches and
junk register operands, all layered on ~1–5 KB expressions, times ~50 handlers.
Behaviorally they are easy — a few hundred handler invocations identify each one
exactly. **The MBA layer cost far more effort in the abstract interpreter than
in the disassembler**: both of the last two defects to fall were folding
mistakes caused by junk operands, not by the MBA algebra itself.

**Was the salt guessed, symbolically executed, or probed?**
Neither guessed nor symbolically executed: it is **read out of the running VM**
(entry call for the top level, `WeakMap` record for nested functions) and then
*probed* — installed into the synthetic frame so the handler's own arithmetic
reproduces the identity. `debug/keycheck.js` verifies the derivation
independently (`imul(derive(salt), 47908741) === 1` for exactly one function).

---

## 7. Weaknesses of this obfuscation

Ordered by how much each one cost to defeat — the cheapest first, which is also
the order in which they should be fixed.

### 7.1 The handler table is a working interpreter, handed over intact

This is the root weakness and everything else follows from it. The sample must
build a live, callable `prototype[opcode]` table before it can run, and it
builds all 113 of them eagerly. A deobfuscator does not need to understand a
single MBA identity — it needs to *call* the handlers. `lib/machine.js` replaces
one AST node (the entry call's callee), runs the file, and walks away with the
bytecode, the constant pool, the globals and every handler, without the guest
program executing a single instruction.

Every subsequent layer — randomized opcodes, shuffled tables, encoded bytecode,
concealed constants — is defeated by that same oracle, because each of those
layers is *decoded by the handlers themselves*.

### 7.2 The MBA identities are exactly identities

Each MBA handler computes a plain operator, exactly, over int32. That makes it
identifiable by 50–80 executions against candidate operators. The obfuscation
raises the cost of *reading* a handler by three or four orders of magnitude and
the cost of *identifying* it by nothing at all. The junk operands, the
salt-derived modular inverses and the nibble constraints are all invisible to a
fitter that simply calls the handler at a real instruction site.

### 7.3 The salt is stored where the VM can find it

Because the interpreter must recover the per-function key at runtime, it is
either in the frame (`+7`) or reachable from the function record (`m.get(fn).C.x`).
The tool reads it from the same places the VM does. Making the key harder to
*derive* is pointless as long as it is materialized in memory.

### 7.4 Concealed constants are pure functions of the bytecode

A concealed constant is computed by an MBA opcode from immediates plus junk
registers. Purity is what lets an abstract interpreter fold it: run the handler,
keep the answer. There is no dependence on program input, so no amount of
arithmetic complexity helps — the constant is decided before the program runs.

### 7.5 Both flattening layers are input-independent

The dispatcher hash takes only per-block constants, and the flattening state
transitions are arithmetic over concealed constants. Neither depends on data the
analyzer cannot know, so both fold completely under constant propagation. The
mask-select form (§1.4) is actually *easier* than a switch: with no conditional
jumps, there is nothing to enumerate — the arithmetic simply evaluates.

### 7.6 The MBA handlers are algebraically distinguishable from the plain ones

MBA handlers coerce to int32 and cannot reproduce string or `undefined`
semantics; plain handlers can. One round of mixed-type probing separates the two
populations for free, which is what tells the tool where the interesting sites
are.

### 7.7 The bytecode never changes

A `decrypt` opcode exists but is never used. Everything the analyzer needs is
present, in final form, from load time — so a single sweep disassembles the whole
program and the recovered CFG can be validated against a trace.

### 7.8 One function, one salt

The salt is per function, so once it is known, *every* MBA opcode in that
function is decodable. There are 5 functions and therefore 5 secrets in an 84 KB
file.

---

## 8. Hardening the obfuscator (MBA first)

Concrete changes, ordered by how much each one would have cost this tool.
Roughly: **§8.1 breaks it, §8.2–8.4 make MBA identification genuinely hard, and
§8.5–8.8 raise the cost of everything else.**

### 8.1 Don't hand over a callable interpreter (highest impact)

Everything here rests on being able to call handlers in isolation. Break that:

* **Bind handlers to interpreter-loop state that a synthetic frame cannot fake.**
  Have each handler read a rolling value that only the dispatch loop maintains —
  e.g. `this.r = imul(this.r ^ opcode, K) + pcDelta` updated on every dispatch,
  with the MBA identities depending on `this.r` and not just on `frame[+7]`. A
  handler invoked out of order then computes garbage, and the tool cannot probe
  it without emulating the whole loop.
* **Make the table lazy and self-consuming.** Materialize `prototype[op]` only on
  first dispatch, from a generator keyed on the running state, and drop it
  afterwards. Capturing "the handler table" at load time then yields nothing.
* **Fuse the guest program's start into the setup.** The tool relies on being
  able to stop the sample cleanly between "VM built" and "program runs" by
  rewriting the entry call. If the entry call is not a distinguishable top-level
  statement — if the first blocks execute during table construction, or the table
  is only complete after N instructions have run — there is no such seam.
* **Detect the probe.** Handlers executed against a `Proxy`-backed frame see
  register reads in a fixed order with sentinel values. Cheap self-checks
  (`frame[+9] === 13 + Q`, pc within the owning function's range, a checksum over
  the frame) turn probing into observable misbehavior.

### 8.2 Make the MBA identities *conditional*, not unconditional

The fitter works because every MBA handler is an exact identity on all of int32.
Weaken that deliberately:

* **Domain-restricted identities.** Emit an identity that only equals `a + b`
  when the operands satisfy a property the *compiler* can prove of the real
  values at that site (`a` known non-negative, `b < 2^16`, `a & 1 === 0`), and
  computes something else otherwise. A fitter sampling `0x7fffffff` and `-1` gets
  a mismatch on every candidate operator and reports "unknown". The tool then has
  to prove the same range facts before it can even name the opcode — that is real
  work, and it is exactly the work MBA is supposed to force.
* **Per-site specialization.** Today an opcode means the same operator at every
  site in a function. Make the identity depend on the instruction address as well
  as the salt (`k = imul(pc, C) ^ salt`), so an opcode is a different operator at
  different sites and the fitter's 50 observations cannot be pooled.
* **Split one operator across several opcodes with disjoint valid domains**, so
  even a correct per-site fit does not generalize.

### 8.3 Give the junk operands real semantics

Both of the last two bugs in this tool were folding mistakes caused by junk
operands, which shows where the pressure point is — but the junk currently
cancels for *arbitrary* values, so once sampling is done independently it is
detected immediately. Instead:

* **Make junk operands carry live program data.** Feed them registers that hold
  real values (a loop counter, a string length) with an identity that cancels
  only for the values those registers actually take. An analyzer that resamples
  them sees the result change and must refuse to fold — which is correct but
  costs it every concealed constant, so the whole unflattening stalls.
* **Make the junk operand's contribution depend on data the analyzer cannot know**
  (a DOM measurement, `Date.now()`), so no amount of probing settles it and
  static folding becomes impossible without emulating the browser.

### 8.4 Make concealed constants impure

Right now a concealed constant is a pure function of the bytecode, so it folds by
execution. Derive flattening state and constants from a value that only exists at
runtime — a hash of the page, a timing measurement, the length of an input string
— mixed so that the *low nibble* constraints still hold. Constant propagation
then cannot fold the state, path sensitivity cannot key on it, and the dispatcher
becomes genuinely dynamic. This single change would have stopped the unflattening
in §4.4 outright.

### 8.5 Make the salt not exist as a value

* **Never materialize it.** Instead of storing `desc.x` and deriving multipliers
  from it in each handler, bake the already-derived multiplier constants into
  per-function *copies* of the handlers, generated at build time. There is then
  no `frame[+7]` to read and no `WeakMap` record to interrogate.
* **Or split it across the frame** (a few bits in the pc, a few in the frame size,
  a few in a scratch slot), so a synthetic frame that gets any one of them wrong
  produces wrong arithmetic — silently.

### 8.6 Rotate the bytecode while it runs

The unused `decrypt` opcode is the right idea, unused. Encrypt each block under a
key derived from the *path* taken to reach it, decrypt on entry, re-encrypt on
exit. A single static sweep then cannot disassemble the program, `instrLen`
cannot be computed ahead of time, and the trace-based validation this tool uses
becomes the only way to see the code — which requires running it.

### 8.7 Make blocks non-linear to disassemble

`instrLen` is computable from the handler's operand-fetch count, so the sweep is
exact. Overlapping instructions, opcode-dependent operand counts that depend on a
*register* value rather than an immediate, and jumps into the middle of an
instruction all break the "one sweep, one instruction stream" assumption that
everything downstream is built on.

### 8.8 Exploit the analyzer's need to widen

The abstract interpreter must give up precision somewhere, and §4.4 shows how
much rides on giving it up in the right place. Emit loops whose counter is
*aliased into the flattening state*, so that widening the counter also widens the
state and widening the state loses the loop. Combined with §8.4 this makes the
widening choice a genuine dilemma rather than a search over seven candidates.

### 8.9 What is not worth doing

For completeness, these cost this tool essentially nothing and should not be
where effort goes:

* **more MBA terms per handler** — 1 KB and 5 KB expressions are equally easy to
  call;
* **more opcodes / re-randomized numbering / shuffled handler tables** — nothing
  in `lib/` keys off opcode numbers;
* **stronger string encryption** — the decoder is in the file and is run;
* **deeper dispatcher hashes** — they are pure integer functions and get called;
* **minification, class obfuscation, dead code** — invisible to a bytecode lifter.

---

## 9. Limitations of this deobfuscator

Honest scope, so the results are not read as broader than they are.

* **Exception handling is not reconstructed.** `trycatch`, `tryfinally` and
  `trypop` are classified correctly but not lifted; a sample using them would
  emit a warning and lose the protected-region structure. This sample contains
  zero occurrences, so the code path is untested and was deliberately left out
  rather than written blind. The mechanism is understood: the try opcodes push
  `{catchPc, catchReg}` / `{s, G, z, B}` onto `frame[+3]` and the interpreter
  unwinds by scanning parent frames, so reconstruction means treating a
  `trycatch` as opening a region that ends at the matching `trypop` and wrapping
  the dominated blocks.
* **Self-modifying bytecode is not emulated.** The `decrypt` opcode is classified
  but a build that uses it would need its XOR
  (`c = (c + 2654435769)|0; i[dst+j] = (i[src+j] ^ c ^ c>>>13)>>>0`) applied
  during `Analyzer.sweep()` before the destination range is disassembled.
* **`==` versus `===` cannot be recovered for MBA comparison handlers**, which
  coerce to int32 first; the strict form is assumed. Every surviving comparison
  in this sample is a plain handler, so nothing is lost here.
* **Invariance folding is a heuristic, not a proof.** §4.4 lists the three things
  that make it reliable in practice, but a handler engineered along the lines of
  §8.3 would defeat it.
* **Some VM-template details are hard-coded** — see the list in §6.

---

## 10. File map

| file | purpose |
|---|---|
| `vm.js` | CLI + `require("./vm.js")(file)` entry point; passes non-samples through untouched |
| `test.js` | the test suite (`node test.js`) — 12 checks, including the behavioral diff |
| `regular.js` | an ordinary file, used to check pass-through |
| `lib/machine.js` | sandbox load, entry-call capture, handler probing, behavioral classification, constant decoding |
| `lib/fit.js` | operator recovery for plain and MBA arithmetic opcodes |
| `lib/analyze.js` | sweep, abstract interpretation, dispatcher resolution, unflattening, liveness, widening |
| `lib/lift.js` | instruction → AST, naming, DCE, temporary inlining, terminator construction |
| `lib/emit.js` | graph cleanup, block minimization, structuring entry, function assembly, renumbering |
| `lib/structure.js` | dominators / post-dominators / natural loops → `if`/`while` |
| `lib/polish.js` | cosmetic AST passes |
| `debug/validate2.js` | **CFG validation against the real VM** (passing: 0 missing blocks/edges) |
| `debug/compare-run.js` | **behavioral diff of input.js vs output.js** (passing: identical) |
| `debug/dump-lib-ir.js` | disassembly of the analyzed graph with folded values and fitted operators |
| `debug/lift-trace.js` | lifted block graph after each cleanup pass — attributes a lost statement to a pass |
| `debug/widen-trace.js` | every widening trial and the score it produced |
| `debug/widen-metrics.js` | candidate widenings side by side on all scoring signals |
| `debug/fold-flaky.js` | repeats the analysis and reports fold sites whose answer is not stable |
| `debug/fold-probe.js` | per-operand sensitivity of one instruction — which junk operands really cancel |
| `debug/count-oracle.js` | how much real code the tool executes, by phase, and inputs per operator fit |
| `debug/trace-values.js` | logs every register write the real VM performs — ground truth for folded values |
| `debug/test-classify.js` | classifier regression check against hand-read opcode roles |
| `debug/ir-nodes.js`, `debug/print-cfg.js`, `debug/sweep.js` | earlier disassembly / IR dumps |
| `debug/junk-test.js`, `debug/keycheck.js` | experiments that established the junk-operand and salt mechanics |
| `debug/analyze.js`, `debug/vmmodel2.js`, `debug/semantics.js`, … | earlier research versions, superseded by `lib/` but kept for reference |
