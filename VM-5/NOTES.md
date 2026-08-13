# VM-5 — reverse-engineering notes (JS-Confuser-VM, MBA #3)

`input.js` is a register-based bytecode VM: 76 279 bytes containing an interpreter, a
115-entry opcode table, an encrypted constant pool and 3 054 words of bytecode. The
original program was compiled away; what ships is the machine that runs it.
`vm.js` (3 124 lines) recovers the source.

```
$ node vm.js input.js output.js
[vm.js] 115 opcodes, 3054 words of bytecode, 5 functions
[vm.js] wrote output.js (957 bytes) in 9100ms
```

Behaviour was verified by running `input.js` and `output.js` in the same fake-DOM sandbox
with a deterministic `Date.now`/`Math.random`: identical `console.log` output, identical
return values, identical exported global, across repeated calls (which exercises the
run-once latch) — `node debug/equiv.js`.

---

## 1. Anatomy of the VM

Minified names as they appear in this build.

| name | role |
| --- | --- |
| `k(a)` | base64 → `Buffer` / `Uint8Array` |
| `p(a,e,f)` | the interpreter state — `a`=bytecode array, `i`=globals, `w`=constant pool, `g`=stack, `h`=frame pointer, `j`=stack top, `o`=upvalue cells |
| `q(a,e)` | an upvalue cell over `stack[i]`; `.u`=closed flag, `.z`=closed value |
| `t(a)` | a function *template*: `.G`={m,l,t,B}, `.q`=upvalue list, `.prototype` |
| `r` | `WeakMap`: closure → template |
| `p.prototype.n` | the operand reader — `return this.a[this.g[this.h+2]++]` |
| `u(a)` | constant-pool decryptor (reads 2 operands: pool index + key) |
| `v(…)` | close upvalues when a frame dies |
| `w(vm,i,fp)` | create-or-reuse the upvalue cell for register `i` |
| `y(vm,ret,this,tmpl,args)` | push a call frame |
| `z(vm,…)` | the dispatch loop (`try { this[op]() } catch` → unwinder) |
| `A = p.prototype` | the opcode table, `A[<random 16-bit number>] = function () {…}` |

### Frame layout

`y()` reserves a 13-slot header, then `l` registers. `fp` = `vm.h`, stack = `vm.g`.

```
fp+0   register base (absolute)      fp+7   opcode currently executing
fp+1   return destination, dst<<1|isNew   fp+8   try-handler stack
fp+2   program counter               fp+9   rolling instruction counter, (prev+1) % code.length
fp+5   frame size = 13 + l           fp+10  `this`
fp+6   caller frame pointer          fp+12  the function template
fp+13… registers                     fp+3,4,11  unused in this build
```

Registers are `stack[stack[fp+0] + i]`. `vm.js` derives every one of these offsets rather
than assuming them.

### Constant decoding (`u`)

```js
a = pool[index];
if (!key) return a;
if (typeof a === "number") return a ^ key;         // numbers: plain xor
if (typeof a !== "string") return a;
bytes = base64(a); out = "";
for (i = 0; i < bytes.length / 2; i++) {
  key = (key + 2654435769) | 0;                     // Knuth golden ratio
  out += String.fromCharCode((bytes[2i] | bytes[2i+1] << 8) ^ ((key ^ key >>> 13) & 0xffff));
}
```

The key is an operand of the *instruction*, so one pool entry decodes to different strings
at different use sites. (The program's own payload turns out to be the encryptor half of
exactly this cipher — see §5.)

### What is in the handler table

| bucket | handlers |
| --- | --- |
| < 100 chars | 18 |
| 100–300 | 49 |
| 300–1 000 | 35 |
| 1 000–3 000 | 9 |
| > 3 000 | 4 |

55 668 characters of handler code in total, mean 484, median 255. Across the file: 1 133
`Math.imul` calls, 175 `(x-(x|0))*65536` int32 guard terms, 160 `~b&1` guard terms and 351
calls to the operand reader carrying junk arguments (`this.n(26,[])` — `n` takes no
parameters; the arguments exist only to make the call sites look different).

---

## 2. Deconstructing and decoding the VM

Nothing in `vm.js` keys off a literal name or number — opcode values, property names and
handler bodies are all randomised per build. The VM is located *structurally* and then
*interrogated*.

**Locate.** The bootstrap is the last top-level `ExpressionStatement` whose callee is an
identifier, whose 1st argument is `new X(a, b, [ …pool ])` and whose 3rd is
`new Y({…})`. Corroborated by counting `X[<number>] = function(){}` assignments (≥ 8).

**Capture.** The bootstrap callee is rewritten to `__capture` and the file is run in a
`node:vm` sandbox. The interpreter state, the main template and the runner function are
grabbed *before a single instruction executes*. This is the pivot of the whole attack: from
here on, the real handlers are available as live JavaScript functions.

**Discover fields.** The operand reader is the only non-numeric function on the prototype;
its source is matched against `this.<A>[this.<B>[this.<C>+<n>]++]` which yields, in one
regex, the bytecode field, the stack field, the frame-pointer field and the PC slot. The
pool is the remaining array-valued field, globals the remaining object-valued one.

**Mock interpreter.** A fake `this` is built on the real prototype: the stack is a `Proxy`
that maps indices ≥ 2²⁰ to registers (recording every read and write) and lower indices to
frame slots seeded with distinctive sentinels; globals are a `Proxy` recording every access;
the operand reader is replaced with one that pulls from a supplied word array. A handler is
then simply *called* against it. Everything the handler touches is observed.

**Classify.** Each opcode is probed with a strictly-increasing operand vector. Which words
were consumed gives the operand count; which of them were used as register indices, and
which register was written, gives the roles (`dst` / `reg` / `imm`). Behavioural probes then
separate the 30 semantic kinds — `jz`/`jnz` by writing the PC slot on a truthy/falsy
register, `push_try` by pushing onto the try slot, `make_function` by producing a function
value, `call` by `.apply`, `decrypt` by writing to the bytecode array, and so on. Variable
length opcodes (calls, `new`, array/object literals, closures) are found by probing with two
different operand bases and solving for the count slot, the group size and the fixed prefix.

**Recover the frame layout with a real-VM oracle.** The MBA handlers are keyed on the
enclosing function's register count (§3b), so the `(sizeSlot, header)` pair has to be exact.
`vm.js` synthesises a tiny bytecode program — `r1 = X; r2 = Y; r3 = <instruction under
test>; return r3` — runs it on the *genuine* interpreter for three different local counts,
and searches the 16 × 49 `(slot, header)` grid for the pair that makes the mock agree with
the real machine. It lands on `sizeSlot = 5, header = 13`, verified.

**Decode.** With the roles known, decoding an instruction is running its handler at the real
pc and reading back the words the reader consumed. Coverage: **2 731 of 3 054 words (89 %)**
and **70 of 115 opcodes** are reached; the rest is dispatcher decoy.

---

## 3. Undoing the defences

### 3a. Randomised + specialised opcodes

Opcode numbers are random and most handlers are specialised — the operand is baked into the
body rather than read from the stream, so the same semantic operation appears as many
unrelated-looking handlers:

```js
A[52678] = function(){ … a[e+f] = d <= a[e + this.n(85,70)] };   // LE  dst, s1, s2
A[63004] = function(){ … a[e+f] = u(this) };                      // LOADK dst, k, key
A[9160]  = function(){ … a[e+f] = <upvalue read> };               // LOADUP
```

There is no fixed table to hard-code. **Undone by** the probe-and-classify pass above: the
table is rebuilt per file, in about a second.

### 3b. MBA arithmetic keyed on the frame size

The interesting defence. 36 of the 115 handlers read frame slot 5 and fold
`stack[fp+5] - 13` — the *enclosing function's register count* — into their key material.
The junk terms only vanish for the value the obfuscator compiled them with. The mechanism is
a modular inverse over `Math.imul`:

```js
b = e[a+5] - 13;                          // register count of the calling function
b = Math.imul(b, -1398146089) ^ 1002761830 | 1;
… Math.imul(x, Math.imul(b, -9167949)) …  // == x  if  Math.imul(b, -9167949) === 1
```

`Math.imul(b,-9167949) === 1` requires `b === -421393541`, which happens for exactly one
register count: **l = 68** — the register count of function #1. Evaluated with any other
frame size the handler computes garbage. Measured over the 35 size-dependent handlers that
are data opcodes: 26 fit to the same operator either way, **9 change meaning** — e.g. opcode `49023` is
`|` at `l = 44` and unfittable at `l = 68`, opcode `25412` is `===` at `l = 44` and a
constant at `l = 68`. The same opcode genuinely means different things in different
functions.

Two other guard styles appear alongside it:

* `(c - (c|0)) * 65536` — zero only when the register holds an int32. This is a *type*
  assertion: the identity is valid for integers and collapses into noise for floats,
  strings and objects.
* `~b & 1` after `b |= 1` — always zero. 160 occurrences of key material that cancels
  unconditionally; wasted budget (see §6.0).

**Undone by** oracle fitting — not by simplification. `fitDataOpcode` never looks at the
handler body. It:

1. finds which register operands actually matter, by perturbing one at a time from four
   different baselines (one baseline alone hides dependencies — `x >>> y` looks constant
   when `x` is small);
2. finds which immediate operands matter, the same way;
3. samples the handler over a fixed probe grid — 16 int values for one input, 12×12 int
   pairs for two, plus 14×14 general values (`NaN`, `''`, `'abc'`, `true`, `null`, `{}`,
   `[1,2]`) — *with the instruction's real operand words in place*, so the identities stay
   collapsed;
4. keeps every candidate from a table of 12 unary and 25 binary JavaScript operators that
   reproduces every integer observation, refines with the general observations, and takes
   the lowest-ranked survivor.

Cost: **344 handler executions per two-register fit**, 56 per one-register fit, cached by
`(opcode, frame size)` and re-verified per instruction. That is where most of the 9 s goes.

Result over the 3 872 `expr` instructions in the analysed CFG:

| fitted form | count |
| --- | --- |
| `const` (all inputs known) | 1 520 |
| `+` 324 · `-` 306 · `===` 277 · `^` 256 · `&` 177 · `*` 131 · `>>>` 17 · `\|` 4 · `%` 3 · `<<` 2 · `<` 2 · `+\|0` 1 | 1 500 |
| `!` 309 · `+` 304 · `-` 175 · `-\|0` 4 (unary) | 792 |
| `move` | 34 |
| **unknown** | **26** |

848 fits were *ambiguous* (more than one operator survived) and were resolved by the
static rank order — a silent tie-break, and a soft spot (§6.4).

### 3c. Control-flow flattening with a hashed dispatcher

Every basic block ends by computing its successor's key arithmetically and handing it to a
dispatcher, so there are no static edges. **Undone by** path-sensitive constant propagation:
nodes are `(pc, register state)` pairs, so the shared dispatcher tail is specialised back
into each caller where its computed jump is a compile-time constant again. Function #3
expands to 2 780 trace nodes and collapses to 7 basic blocks; function #1 to 2 519.

Real `if`s survive flattening because the branch is folded into the key
(`key = A + (B-A) * +!cond`). `vm.js` models up to three unknown booleans exactly: when an
opcode that always yields a boolean is applied to unknown data the result becomes a fresh
symbolic variable, every later instruction is evaluated once per assignment of those
variables, and when the jump key finally differs between assignments *that* is the original
`if`.

**Keeping the exploration finite.** The dispatcher tail is a state sink: it is reached once
per block per path, so the state set there is a *product* — block key × everything a loop
carries. `b10`'s `while (d6 < d0.length)` has an unknown trip count, so each iteration forks
the condition and carries a fresh `d6`, and the product never converges; left alone the
analysis unrolls the loop until its 512-state budget runs out, and whichever path arrives
last is the one that gets widened into uselessness. `vm.js` handles this in two layers:

* widening exempts the **control slice** — the registers a backward slice from the block's
  terminator says decide where it goes (plus the register holding the deciding boolean when
  the jump is symbolic). Widening those is what turns a dispatcher back into an unresolved
  indirect jump;
* when a program point overflows anyway, the registers responsible are identified (several
  distinct values at the overflowing point, in no control slice, never holding a function
  value or a symbolic condition) and **abstracted for a single retry**. Here that picks out
  exactly one register — `d6`, the induction variable — after which the loop reaches a
  fixpoint in one iteration, nothing overflows, and every computed jump resolves.

The retry is only kept if it does not make things worse (no more unresolved jumps, no more
overflowing points), so a bad guess costs one extra exploration and nothing else.

### 3d. Dead state

Ordinary compiler passes finish the job: constant folding, global dead-code elimination
(seeded from side effects, returns, branch conditions and captured registers — plain
liveness cannot kill the flattening state variable because it keeps itself alive),
dead-store elimination to a fixpoint, single-use temporary inlining, then dominator-based
structuring back into `if`/`while`.

### 3e. The defence that cost the most and bought the least

The four largest handlers — `32143` (4 369 chars), `60495` (3 781), `24801` (3 571),
`22066` (3 360) — are multi-round MBA mixers, **27 % of the entire handler table**. They are
also the only four `vm.js` fails to fit (26 instructions). It does not matter at all: their
inputs are compile-time constants, so the const-prop pass simply *executes* them, folds the
result, and dead-code elimination deletes the instruction. The heaviest MBA in the sample
was never read, never simplified, and never even reached the fallback path — `output.js`
contains no `__vmMba…` shim. See §6.0.

---

## 4. Pipeline in `vm.js`

```
parse ─► findBootstrap ─► sandbox + capture state ─► discover fields/slots
      ─► classify 115 handlers (probing)          ─► frame layout via real-VM oracle
      ─► discover functions from make_function     ─► per function:
             path-sensitive const-prop + symbolic booleans   (kills the dispatcher)
             └─ on state-budget overflow: abstract the exploding registers, retry once
           ─► merge nodes ─► basic blocks ─► fit each expr opcode ─► lift to IR
           ─► global DCE ─► dead stores ─► inline temporaries ─► DCE again
           ─► dominators / post-dominators / natural loops ─► if / while / labels
      ─► Babel AST ─► readability passes ─► generate
```

Fallbacks, in order of how much they give away:

* an opcode that fits no JavaScript operator → the original handler is emitted verbatim
  behind a `__vmMba<op>_<operands>` shim that reproduces the VM's frame. Output still runs;
  the expression stays opaque.
* a function that will not structure → a labelled `while(1) switch(pc)` dispatch loop.
  Ugly, always correct.
* an unresolvable computed jump → `throw new Error("unresolved computed jump at …")` with a
  comment, rather than silently emitting something wrong.
* a file with no VM in it → returned unchanged.

---

## 5. The recovered program

```js
var a2 = false;
window._ttwl6apnfd = function () {
  var b2, b3, b4, b5, b9, b10;
  b10 = function (d0, d1) {
    var d4, d5, d6;
    if (!b9) {
      return;
    } else {
      d4 = d1; d5 = ""; d6 = 0;
      while (true) {
        if (d6 < d0.length) {
          d4 = d4 + -1640531527 | 0;
          d5 = d5 + String.fromCharCode(d0.charCodeAt(d6) ^ (d4 ^ d4 >>> 13) & 65535);
          d6 = d6 + 1 | 0;
          continue;
        } else break;
      }
      return d5;
    }
  };
  if (!a2) {
    a2 = true;
    b2 = document.createElement("div");
    b2.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(b2);
    b3 = b2.offsetWidth;
    b4 = Date.now();
    b5 = Math.floor(Math.random() * 1000000);
    b9 = b4 + "|" + b5 + "|" + (b4 - 10000 + b5 * 5) % 97
            + "|" + (b4 + b5 + b3) % 89 + "|" + (b5 + 1500) % 83;
    console.log(b9, b10(b9, b3 + b5));
  }
};
```

A run-once browser fingerprint — the `offsetWidth` of a `calc()`-sized div, the clock and a
PRNG draw — folded into a `|`-separated string, logged next to the same string run through a
Feistel-ish xorshift stream cipher. The cipher is the *encryptor* half of the VM's own
constant-pool cipher (`+2654435769` / `>>> 13` there, `-1640531527` / `>>> 13` here — the
same golden-ratio constant with the opposite sign).

### Faithfulness

* `| 0` coercions are kept because that is genuinely what the handlers compute; dropping
  them would differ at the 2³¹ boundary.
* Register names (`b2`, `d4`) come from the VM's register file. The original identifiers
  were never compiled in and are not recoverable.
* The `call_method` opcode loads the callee and calls it through `.call(receiver, …)`; the
  readability pass folds that back to `String.fromCharCode(…)` only where the receiver is
  the object the callee was loaded from, so no assumption is being smuggled in.
* No unresolved jumps, no opaque MBA shims, no dispatch-loop fallbacks: every construct in
  the output is recovered source, not a hedge.

---

## 6. Hardening the sample against this deobfuscator

Everything below is about MBA. No runtime values, no environment assertions, no anti-debug —
those are a different axis and are explicitly out of scope here.

### 6.0 The thing to internalise first

**`vm.js` never simplifies an MBA expression. It never parses one. It executes it.**

The handler is a live JavaScript function; `runHandler` calls it against a fake frame and
reads the register it wrote. From the fitter's point of view a handler is a black box with a
signature:

```
(reg_a, reg_b, imm_words…)  ->  reg_dst        pure, deterministic, cheap, re-runnable
```

Given that signature, *no amount of expression-level complexity matters*. 3 571 characters
of nested `Math.imul` mixing and `(x + 1) | 0` cost the same to solve: one call. The four
biggest mixers in the file — a quarter of the handler table — were bypassed without being
looked at (§3e).

So the budget is currently misallocated in two ways:

* **Depth is wasted.** Doubling the number of MBA rounds doubles the runtime cost of the
  protected program and does nothing to the attack.
* **160 guard terms cancel unconditionally.** `b |= 1` then `~b & 1` is always 0 regardless
  of the frame size. That key material protects nothing.

Every recommendation below attacks the *signature*, not the expression. The goal is to make
the handler stop being a pure, cheaply-callable function of two registers — because that,
not the algebra, is what makes it solvable.

Every experiment below is reproducible with `node debug/attack-fitter.js`, which grafts
synthetic handlers onto the real VM prototype — same mock frame, same operand reader, same
field names as the genuine handlers — and calls `vm.js`'s own `fitDataOpcode` on them.

### 6.1 Key the identity on the bytecode stream, not the frame — the strongest cheap win

`fitDataOpcode` probes handlers against a **synthetic four-word instruction stream**
(`code = [op, dst, s1, s2]`), while decoding and const-prop use the real array. Any key
material a handler pulls from the bytecode array *outside its own operand words* is
therefore present when the program runs and absent when the fitter probes.

Do not stop at "the fit fails" — arrange the guard so the handler computes **a different,
perfectly ordinary operator** under the fitter's stream:

```js
// c = a neighbouring bytecode word, W = its compile-time-known value
var t = ((c ^ W) | -(c ^ W)) >> 31;      // 0 when c === W, -1 otherwise
a[e+f] = (x0 + ((x1 ^ t) - t)) | 0;      // (x1^-1)+1 === -x1  =>  a+b  or  a-b
```

| | real VM | vm.js fitter |
| --- | --- | --- |
| context word | present | `undefined \| 0` → `0` |
| handler computes | `(a + b) \| 0` | `(a - b) \| 0` |
| **fit emitted** | | **`binary -\|0`** |

Measured: `vm.js` emits `-|0` with **no warning, no ambiguity flag, and `verifyFit` agrees**
(it re-checks against the same synthetic stream). The output is confidently wrong. That is a
strictly better outcome for the obfuscator than an opaque shim, because a wrong answer that
looks right costs the analyst far more than an obvious failure.

Sources of context worth keying on, all compile-time constants: neighbouring bytecode words,
a rolling checksum over the operand window, the word at the function's entry, the length of
the bytecode array. Same idea, same cost — a couple of `Math.imul`s per handler.

### 6.2 Encode the value domain, not the expression

Today registers hold plain program values and each handler is `dst = OP(a, b)` for a single
JavaScript `OP`. That is exactly the hypothesis space the candidate table enumerates. Break
the hypothesis: let registers hold **encoded** values, with the encode/decode folded into the
MBA so no instruction ever exposes a clean operator.

| encoding | ADD handler becomes | fit result |
| --- | --- | --- |
| none (today) | `(a + b) \| 0` | `binary +\|0` ✗ solved |
| additive, offsets cancel | `(a + b) \| 0` | `binary +\|0` ✗ solved |
| **multiplicative `M·x`** | `(A + B) \| 0` | `binary +\|0` ✗ **linear masks are transparent** |
| **additive `x + k_r`** | `(A + B - (ka+kb-kd)) \| 0` | **unknown** ✓ |
| **xor `x ^ k_r`** | `((A ^ ka) + (B ^ kb)) ^ kd` | **unknown** ✓ |
| xor, on a MUL | `imul(imul(A,B), M⁻¹)` | **unknown** ✓ |

Three things make this the highest-value change:

* **It is unfalsifiable by sampling.** No operator in any candidate table reproduces
  `((A^ka)+(B^kb))^kd`. Extending the table does not help unless the analyst guesses the
  three 32-bit masks — and if the masks live *inside the handler body* (which specialised
  opcodes already allow) rather than in operand words, there is nothing to guess from.
  The attacker is forced back to *reading and simplifying the MBA*, which is the problem MBA
  is actually good at.
* **It destroys the fit cache.** `vm.js` caches by `(opcode, frame size)`. Per-instruction
  masks make every instruction a distinct function, so 7 250 fits × 344 executions instead of
  ~100 cached fits. Combined with §6.5 that is the difference between 40 seconds and a day.
* **It degrades gracefully into §6.1.** Both produce "no operator matches"; mixing them means
  some handlers fail loudly and others fail silently, so the analyst cannot trust the
  successes either.

Choose masks that do **not** cancel: additive masks that sum to zero across an operation
(`(x0-111)+(x1-222)+333`) fold away and fit as plain `+`. Verify at build time that each
emitted handler is not extensionally equal to any single JS operator — the same check the
attacker runs, used as a build assertion.

### 6.3 Attack the interface: arity, dst, and read-set

Cheap structural changes that fall outside the fitter's model entirely.

| change | fit result | note |
| --- | --- | --- |
| fuse an immediate into a 2-register op — `(a + b + 12345) \| 0` | **unknown** | the candidate set has `(reg,reg)`, `(reg,imm)`, `(imm,reg)` — **no `(reg,reg,imm)` form** |
| `(a + b) ^ 0x5a5a5a5a` | **unknown** | same gap |
| three-register fused op — `(a + b + c) \| 0` | **unknown** | `varDeps.length > 2` → gives up immediately |
| **write dst first, a decoy register second** | **unknown** | `evalHandler` returns the *last* register write; `findDstSlot` believes it |
| dead third read — `((a+b)\|0) + 0*c` | `binary +\|0` | ✗ decoys that provably cancel are free to remove |

The decoy-write trick is one line and defeats both the dst discovery and the value read-back.
Make the decoy's value MBA-derived and consumed (and cancelled) by a later instruction so it
cannot be proven dead.

These are individually patchable — an analyst adds fused forms and multi-def handling in an
afternoon. Their value is that they *multiply* with §6.2: a fused 3-register op over an
encoded domain has no chance of being enumerated.

### 6.4 Make identities hold only where the program actually goes

The probe grid is fixed and public: `{0,1,2,3,7,33,255,1000,65535,123456,-1,-7,-100,-65536,
0x7fffffff,-0x80000000}` for one input, a 12-value cross product for two, plus 14 general
values. Two consequences:

* **Restrict the domain and the fit fails.** A handler equal to `(a+b)|0` only for
  `|a|,|b| < 2²⁰` and MBA-garbage outside → **unknown**. The obfuscator needs a range proof
  for the instruction (trivially available for loop counters, array indices, string offsets,
  and for anything already `& 0xffff`), and it gets a hard failure for free.
* **Match a *wrong* operator on the probe set and the fit is silently wrong.** A handler that
  agrees with `+` on every probed value and computes `-` elsewhere fits as `binary +|0`,
  ambiguity flag clear. Generalise this rather than hard-coding one tool's grid: any prober
  reaches for small integers, powers of two, and int32 boundary values. Make the identity
  *disagree* with the true operator precisely on values like `0`, `±1`, `0x7fffffff`,
  `-0x80000000`, `NaN` and non-numbers — values the compiled program provably never sees at
  that instruction, but that every probe set contains.

A related weakness worth exploiting: `check()` treats a probe that makes the handler **throw**
as carrying *no information* (it returns `true` regardless). And 848 of 3 872 fits already
had multiple survivors, resolved by a fixed rank order that prefers `===` over `==`, `+` over
`-|0`, and so on. Handlers deliberately built to throw on the discriminating probes, or to be
extensionally equal to two operators over the whole probe grid, push the fitter onto that
tie-break — where the obfuscator, knowing the ranking, chooses which wrong answer it gets.

### 6.5 Spend the MBA budget where it is paid once and probed many times

Cost asymmetry is the only place expression depth still buys anything, and it must be aimed
correctly:

* the program pays a handler's cost **once per dynamic execution**;
* the fitter pays it **344 times per (opcode, frame size)** — plus once per const-prop step
  over 3 872 expression nodes, plus `verifyFit` per instruction.

So depth belongs on **small, frequently-fitted arithmetic handlers**, not on the four
constant-folded mixers where it currently sits. Moving the 15 081 characters now spent on
opcodes `22066/24801/32143/60495` onto the ~60 arithmetic handlers, and making them
per-instruction (§6.2) to defeat the cache, converts a 9 s run into hours without changing
the protected program's runtime cost measurably — the hot loop executes each handler once per
iteration, the analyst executes it hundreds of times per instruction.

Do not do this by adding rounds to a mixer whose result is a compile-time constant. Check at
build time whether an MBA-heavy instruction's inputs are constant-known; if they are, the
attacker will fold it and the budget is wasted.

### 6.6 Raise the entropy of the existing frame-size key

The frame-size keying is the right *idea* — it is the one defence that made `vm.js` do real
work (a real-VM oracle plus a 784-cell search) — but the key space is far too small.
`stack[fp+5] - 13` is a register count: a small integer, brute-forceable in a few hundred
tries even without the oracle. Fixes, in increasing order of pain for the attacker:

1. Store a **32-bit per-function salt** in the template (`{m,l,t,B}` → add one field) and
   push it into a frame slot at call time. Same mechanism, 2³² key space instead of ~2⁸, and
   `discoverFrameLayout`'s `header ≤ 48` search cannot enumerate it.
2. Put the salt in a **frame slot the mock does not model**. `vm.js` fills unknown slots with
   sentinels (`SLOT_SENT(i) = 2²¹ + 4096·i`); a handler keyed on such a slot is wrong in both
   the fitter *and* `execConcrete`, so dispatcher keys come out wrong too and the
   control-flow reconstruction fails rather than merely the arithmetic.
3. Derive key material from **`stack[fp+9]`, the rolling instruction counter** the dispatch
   loop already maintains and nothing currently reads. A handler that is only correct at the
   right point in a real trace cannot be evaluated in isolation at all: fitting an opcode
   would first require the trace, and reconstructing the trace requires the opcodes. Note
   this only works where the counter is provably invariant at that instruction (straight-line
   code reached on one path); in a loop the counter changes per iteration, so this is a
   targeted weapon, not a blanket transform — but for the block that computes a dispatcher
   key it is exactly right.

### 6.7 Priority

| # | change | effort | effect on `vm.js` |
| --- | --- | --- | --- |
| 6.2 | xor/affine-encoded register domain, per-instruction masks in handler bodies | high | every arithmetic op → `unknown`; fit cache dead; forces real MBA simplification |
| 6.1 | identity keyed on neighbouring bytecode words | low | **silently wrong output** |
| 6.3 | fused `(reg,reg,imm)` and 3-register ops; decoy second write | low | `unknown` across the board |
| 6.4 | domain-restricted identities; probe-grid disagreement | medium | `unknown`, or silently wrong |
| 6.6 | 32-bit salt in an unmodelled frame slot | medium | breaks const-prop, not just fitting → CFF survives |
| 6.5 | move depth off the constant-folded mixers onto hot arithmetic | low | 9 s → hours |
| 6.0 | delete the `~b&1` no-op guards and the 4 giant mixers | negative | frees ~27 % of the handler table for the above |

### 6.8 Non-MBA fragilities noticed in passing

Out of scope for the hardening ask, but recorded because they are cheap and they compose:

* **`decrypt` is unused.** Opcode `18616` decrypts a range of the bytecode array in place and
  never appears in the emitted bytecode of this build. It is also the one instruction whose
  handler `vm.js` runs *for effect* — `execConcrete` passes the real array, so re-executing a
  decrypt instruction on a second visit would XOR the stream twice and corrupt the analysis
  silently. A decrypt placed on a path the analysis visits more than once is a trap for any
  execute-the-handler tool.
* **The capture point is a single call.** Everything depends on `findBootstrap` recognising a
  top-level `f(new P(a,b,[…]), …, new T({…}), …)` and on the state surviving as live objects.
  Splitting the bootstrap across statements, or building the pool lazily, costs the analyst
  the pivot the whole tool is built on.
* **848 ambiguous fits** already exist in this build and are resolved by a hard-coded rank
  order — the failure mode is a plausible wrong operator, not an error.
* **State-explosion pressure on the dispatcher** — a lever that *did* fire, and was then
  closed. The shared dispatcher tail accumulates one state per (block × path), so anything
  that inflates that product exhausts the analysis budget: an unknown-trip-count loop is
  enough on its own, and a dead compile-time-constant update per block would add more for
  free. Before §3c's control-slice and abstract-and-retry logic existed, this cost the tool
  a computed jump in `b10` — emitted as a `throw` on a path the original returned from, with
  a CLI warning as the only signal. Worth recording for two reasons: the failure mode is a
  *wrong output* rather than a stall, and which path gets sacrificed depends on worklist
  order, so an obfuscator that arranges the hot path to be explored last gets a broken
  program rather than a dead one. It is also the cheapest weakness to close — one backward
  slice and one retry, ~90 lines — which is why it ranks below everything in §6.7.

---

## 7. Files

| file | what it is |
| --- | --- |
| `input.js` | the obfuscated sample |
| `vm.js` | the deobfuscator (library + CLI) |
| `output.js` | generated result |
| `NOTES.md` | this file |
| `debug/attack-fitter.js` | the §6 experiments — every fit result quoted above |
| `debug/equiv.js` | behavioural equivalence of `input.js` and `output.js` in a fake DOM |
| `debug/` (rest) | dumping, tracing, classifying and disassembly scripts used to get here |
| `nul` | not a deliverable — a stray `> nul` redirect artifact, byte-identical to `output.js` |
