# VM-6 — reverse-engineering notes

Target: `input.js`, 81 KB, produced by **JS-Confuser-VM MBA v4** — a register VM
with randomized opcode numbers, an encrypted constant pool, control-flow
flattening through a hash dispatcher, and keyed mixed boolean-arithmetic inside
the opcode handlers.

Deobfuscator: `vm.js` (single file, `@babel/parser` + `@babel/traverse` +
`@babel/generator`). Tests: `test.js`, `test-features.js`. Scratch tooling: `debug/`.

```
node vm.js input.js output.js      # ~3 s
node test.js                       # end-to-end + pass-through checks
node test-features.js              # synthetic payloads for the rest of the ISA
```

---

## 1. VM architecture

The payload is one machine object plus a flat opcode table on its prototype.

| symbol | role |
|---|---|
| `g(bytecode, pool, globalObj)` | the machine. `.i` = bytecode (`Uint32Array`, 3,326 words), `.A` = constant pool (51 entries), `.h` = global object, `.g` = frame array, `.d` = current frame pointer, `.j` = top of frame stack |
| `A = g.prototype` | opcode table: `A[<random 16-bit number>] = function () { ... }` |
| `w(vm)` | fetch next bytecode word: `vm.i[vm.g[vm.d + 2]++]` |
| `v(vm)` | fetch a constant: reads *two* words (pool index, key) and decrypts |
| `t(desc)` | function template — `desc = {o: params, m: registers, F: entry pc, C: function salt, H: has-rest}`; `.l` = closure-cell list, `.prototype` |
| `u(frames, index)` | closure cell: aliases `frames[index]` until the frame dies, then detaches into `.u` |
| `r` (`WeakMap`) | JS function → its template, so a VM function called from VM code takes the fast path |
| `z(vm, this, args, tmpl)` | the interpreter loop |
| `x(vm, …)` | frame teardown: detaches every live closure cell |

### Frame layout (`vm.g`, one flat array, frame pointer `fp`)

```
fp+0  caller frame pointer          fp+9   function template (t)
fp+1  register base (= fp + 14)     fp+10  call flags (bit0 = new, >>1 = dest reg)
fp+2  program counter               fp+11  new stack top
fp+4  function salt (template .C)   fp+12  try-handler stack
fp+6  `this` value                  fp+13  frame size (14 + registers)
fp+7  current opcode
```

Registers are `vm.g[fp + 14 + n]`. Parameters land in registers `0 .. o-1`,
`arguments` in register `o` (when `o < m`), and with a rest parameter the last
declared parameter gets `args.slice(o-1)`.

### Interpreter loop

```js
for (;;) {
  fp = vm.d; f = frames[fp+2];  if (f >= bytecode.length) break;
  frames[fp+2] = f + 1;  op = bytecode[f];  vm[op]();      // ← dispatch
}
```
Exceptions unwind frame by frame looking for a non-empty `frames[fp+12]`; the
handler record is `{a: catchPc, B: catchReg}` for `catch`, or
`{p, J, I, n}` for `finally`.

### Constant pool encryption (`v`)

```
idx = w(); key = w(); value = pool[idx]
key == 0            -> value verbatim
typeof value number -> value ^ key
typeof value string -> base64-decode, then per 16-bit char:
                       key = key + 0x9E3779B9 | 0
                       ch  = (lo | hi<<8) ^ ((key ^ key >>> 13) & 0xFFFF)
```
The same pool entry with a different key decodes to a different string, so the
pool alone tells you nothing — each *site* must be decoded. 51 pool entries
produce the 50-odd distinct constants listed at the bottom of this file.

### Opcode census (`node debug/opcodes.js`)

```
135 opcodes   30 structural   105 data-processing (66 of them MBA-obfuscated)
 81 of the 135 are actually reachable in this sample
```

Structural opcodes found (by behavior, not by number — the numbers are random
per sample): `LOADCONST LOADIMM LOADTHIS LOADGLOBAL STOREGLOBAL TYPEOFGLOBAL
LOADCELL STORECELL SETMEMBER DELETE DEFGET DEFSET ARRAY OBJECT CALL CALLMETHOD
NEW MAKEFUNC RETURN THROW JMP JMPIF JMPIFNOT JMPDYN TRYCATCH TRYFIN POPTRY
FORIN_INIT FORIN_NEXT DEBUGGER DECRYPT`.

Two notable ones:

* `MAKEFUNC` — `dst, entryPc, nParams, nRegisters, nCells, hasRest, salt,
  then nCells × (isNew, index)`. `isNew` means "create a cell over *my* register
  `index`", otherwise "inherit my own cell `index`". That is exactly lexical
  capture, so a lifted nested `function` expression reproduces it for free.
* `DECRYPT` — `dst, from, to, key`: XORs a bytecode range with a TEA-style key
  stream. Present in the handler table but **not used** by this sample (no
  self-modifying bytecode here).

---

## 2. What makes this sample hard

### 2.1 Randomized opcode numbers

There is no fixed opcode table to hard-code. `vm.js` therefore identifies every
handler *behaviorally*:

1. **Layout probe** — call the handler on a synthetic frame whose bytecode words
   are distinct sentinels, with a `Proxy` over the frame array logging reads and
   writes. That yields: how many words the handler consumes, which of those words
   are register indices, and which one it writes back to. Several register
   fillings are tried (`1`, `{}`, `'abc'`, a function, an array, `Object`)
   because `in` / `instanceof` / member access throw on the wrong types and would
   otherwise look like they never write anything.
2. **Structural match** — a handful of handlers are recognized from their source
   shape (`Reflect.set`, `Object.defineProperty`, `Reflect.construct`,
   `Object.getOwnPropertyNames`, `new t(`, assignment to `frame[fp+2]`, …).
3. **Semantic fit** — everything else is fitted numerically (section 2.3).

### 2.2 The function salt, and how it was found

46 of the 66 MBA handlers read frame slot `fp+4`, and that read is what makes
them work. Tracking it down:

1. **Spot the odd read.** The plain handlers touch only `this.g`, `this.d`,
   `this.d + 1` and their operand registers. The MBA ones additionally read
   `c[b + 4]`, always exactly once, always immediately feeding a
   `Math.imul(..., K1) ^ K2 | 1` chain. Slot 4 is never written by any handler.
2. **Find who writes it.** `g.prototype.t` — the frame setup — contains
   `h[e + 4] = c.C`, where `c = d.x` is the template descriptor. So slot 4 is a
   per-*function* constant, fixed at the moment the frame is pushed. Call it the
   function salt.
3. **Find where the salt comes from.** Templates are created in exactly two
   places: the bootstrap call at the end of the file
   (`new t({o:0, m:6, F:0, C:893140373})`) and the `MAKEFUNC` handler, whose
   seventh operand word is passed straight through as `C`. So every function's
   salt is a plain immediate sitting in the bytecode next to its entry address —
   free to read once `MAKEFUNC` has been decoded.
4. **Prove what it is for.** Opcode `24781` computes
   `b = Math.imul(salt, -1735634999) ^ 1225702399 | 1` and then uses
   `Math.imul(Math.imul(d, -2002302671), b)` where a plain `d` belongs. That is
   only an identity if `b` is the modular inverse of `-2002302671` mod 2³². Try
   all five salts in this sample:

   | function | salt | `Math.imul(derived, -2002302671)` |
   |---|---|---|
   | `fn@0` | `893140373` | `-1654547821` |
   | `fn@37` | `653392047` | `-494180535` |
   | `fn@3010` | `228404641` | `651105511` |
   | **`fn@1883`** | **`139276343`** | **`1`** ✔ |
   | `fn@3178` | `679911913` | `1426880223` |

   Exactly one salt makes it `1`. Opcode `51205`, with completely different
   constants, also resolves only under `139276343`. So these handlers are
   **bound to one function**: run them in any other frame and they silently
   compute garbage.

That binding shows up in the statistics: of the 47 MBA opcodes this sample
actually executes, **45 appear in exactly one function**. The two that appear in
two functions (`32473`, `20243`) are among the 20 MBA handlers that never read
`fp+4`. The obfuscator is effectively emitting a private arithmetic dialect per
function.

The consequence for the deobfuscator: a handler must be probed **with the salt of
the function that uses it**, so `vm.js` keys its fit cache on
`(opcode, salt, immediates, operand aliasing)` and threads each function's `C`
value through the whole analysis.

### 2.3 Keyed MBA arithmetic

66 handlers hide a simple operator inside a mixed boolean-arithmetic blob. For
example `a != K` is spelled:

```js
c[h+f] = !!(!!((Math.imul(Math.imul(d,-2082009911), Math.imul(c[b+4],895315443)^440032356|1)
        | e + Math.imul(Math.imul((a-(a|0))*65536,-1469196981),-1675525683))
        - ((d ^ Math.imul((a-(a|0))*65536,211853537)) & e) | 0) ^ k ^ k ^ 0);
```

Four separate tricks are stacked:

* **salt-keyed multiplicative inverses** — section 2.2.
* **immediate-keyed junk** — terms like `Math.imul(e & 7 ^ 5, X)` vanish only
  when the instruction's own immediate satisfies `e & 7 === 5`, and
  `Math.imul(e ^ K1, K2) >>> n & 1` picks between two algebraically equivalent
  formulations. So handlers must also be fitted **per instruction**, with that
  site's real immediates.
* **junk register operands** — `(X & ~e) + (X & e) === X`, `x + k - k`, … burn a
  bytecode word and read a register that provably cannot affect the result.
* **float guards** — `(a - (a|0)) * 65536` is zero only for int32 inputs, so all
  of these opcodes are int32-only by construction.

`vm.js` fits each *(opcode, salt, immediates, operand aliasing)* combination by
black-box probing:

* **typed probes** first (`5, 'abc', {}, null, NaN, Object, …`): if the handler
  agrees with a real JS operator on ~200 typed pairs it *is* that operator. This
  catches the plain handlers exactly and distinguishes `mov` from unary `+`,
  `==` from `===`, member access from `+`, and so on.
* **numeric probes** otherwise. Two details matter a lot:
  * the probe set must contain the instruction's own immediates (otherwise
    `a != 7924` looks like the constant `true`);
  * the probe set must contain tuples whose operands are *equal to each other*
    (otherwise `a == b` looks like the constant `false` — this one silently broke
    the whole CFG recovery until it was fixed).
* fitted shapes: `a`, `<un> a`, `a <op> b`, `a <op> K`, `K <op> a`,
  `(a <op> b) <op2> K`, `(a <op> b) <op2> c`, or a constant.

Operands that the fit proves irrelevant are recorded in an "essential mask", which
is what lets constant propagation see through the junk operands.

Result on this sample: **all 657 reachable data instructions are identified**, no
`UNKNOWN` left.

### 2.4 Control-flow flattening

There are **no conditional-jump opcodes in the bytecode at all**. Every basic
block ends with:

```
r59 = <state-dependent constant arithmetic>
r60 = <k1>;  r61 = <k2>
JMP dispatcher
dispatcher:  r59 = hashFn(r59, r60, r61)   ; hashFn returns a 1-element array
             r59 = r59[0]
             JMPDYN r59                    ; pc = r59
```

`hashFn` (`fn@3010`, and `fn@3178` for the inner function) is a pure
xor/shift/`Math.imul` mixer. A conditional branch is encoded arithmetically:

```
r64 = !cond ; r64 = +r64            ; 0 or 1
r65 = (B - A) * r64 ; r59 = A + r65 ; A or B, i.e. two different hash inputs
```

so both successors exist, but only as a function of a runtime value.

`vm.js` recovers the CFG by **symbolic execution**:

* register values are tracked as constants / symbolic expression trees; an
  expression node is *evaluated* by calling the real opcode handler with concrete
  operands, so no opcode semantics need to be re-implemented;
* at a `JMPDYN`, if the target evaluates to a constant → plain edge. Otherwise
  pick a *fork node* in the expression (preferring boolean-producing nodes
  computed in this block), bind it to `false`/`true` and evaluate both ways. The
  chosen fork is the one that leaves the flattening state registers concrete on
  both edges — that is the fork corresponding to a real `if` in the source;
* the branch condition is materialized into a temporary at the instruction that
  produced the fork value, so the emitted `if` tests something that is still live
  at the branch;
* successor states are **refined** by the fork decision (substituting
  `node = true` / `node = false` and re-evaluating), which makes the state
  registers constant again on each side;
* blocks are then **cloned per distinct state**, keyed on the value of the
  flattening registers (a structural hash, so symbolic states also separate).
  Cloning is what un-flattens: with the state pinned, each dispatch comparison
  folds to a constant and the whole `switch`-chain collapses to a direct edge.

Which registers are "flattening state" is discovered automatically: a first,
imprecise pass records which live-in registers the dispatcher key depends on
(`r37` for `fn@37`, `r14` for `fn@1883`); the second pass clones on those.
Restricting this to *essential* operands matters — including the junk operands
blew the block count from 191 to 12,367 (and the run time from 2.7 s to 54 s).

Finally the flattening bookkeeping is deleted. Plain liveness cannot do it
(`state = state + delta` keeps itself alive), so `vm.js` also drops any
assignment to a register that no *real* statement reads.

### 2.5 Recovered structure

```
fn@0     module body      0 params,  6 registers  ->   1 block
fn@37    window._k1...    0 params, 72 registers  -> 191 blocks (after unflattening)
fn@1883  the encoder      2 params, 44 registers  -> 101 blocks
fn@3010  dispatcher hash  3 params, 10 registers  ->   1 block   (deleted as dead)
fn@3178  dispatcher hash  2 params,  8 registers  ->   1 block   (deleted as dead)
```

After dead-code elimination, block merging, copy propagation and structuring
(dominators → natural loops → `if`/`while` + labeled breaks) the 33-line
`output.js` remains.

---

## 3. Pipeline in `vm.js`

1. **load** — parse, find the bootstrap `z(new g(D,[…],B), void 0, null, new t({…}))`,
   rewrite its callee to a capture function and run the file in `node:vm`. The
   program itself never runs; we just get the machine, the pool and the opcode table.
2. **probe / classify / fit** — sections 2.1–2.3 above.
3. **explore** — symbolic execution per function → CFG (section 2.4).
4. **lift** — opcodes → IR statements over "register variables"; nested
   `MAKEFUNC`s become nested function expressions and closure cells resolve to the
   parent function's variable (real lexical capture).
5. **optimize** — reachability, liveness DCE, flattening-chain removal, block
   merging, copy propagation / expression inlining, constant folding, method-call
   rebuilding (`o.m.call(o, …)` → `o.m(…)`), iterated to a fixpoint.
6. **structure** — dominators, natural loops, immediate post-dominators →
   `if/else`, `while (true)` + `break`/`continue` (labeled only when needed),
   `try`/`catch`.
7. **emit** — Babel AST → source, then tidy-ups: invert `if (!c) {} else {…}`,
   `while (true) { if (c) {…; continue} break }` → `while (c) {…}`, fold
   `x + -3` → `x - 3`, merge `var x; x = e` → `var x = e`, drop trailing bare
   `return;`, rename `v<fn>_<reg>` to `a, b, c, …`.

### Safety valve

`auditRecovery()` refuses to emit anything if a dynamic jump was not resolved, an
opcode's semantics were not identified, a `try/finally` region is present, or
self-decrypting bytecode is used. `run()` then falls back to passing the input
through unchanged. Emitting subtly wrong code would be worse than emitting
nothing.

---

## 4. Testing

`test.js`
* deobfuscates `input.js`, checks the output parses, contains decoded strings and
  no bytecode blob / MBA leftovers;
* runs **the original and the deobfuscated file side by side** in one stubbed,
  deterministic browser sandbox (fixed `Date.now`, seeded `Math.random`, fake
  `document`), calling the installed entry point twice (which also exercises the
  run-once guard), and compares all `console.log` output;
* round-trips `regular.js` (classes, `for-in`, `try/catch/finally`, arrow
  functions, spread, getters) and six other plain files, comparing behavior
  before/after.

`test-features.js` — `input.js` only exercises ~60 % of the instruction set, so
`debug/assemble.js` assembles **synthetic payloads on top of the real runtime**
(same file, new bytecode + pool + root template) covering:

| case | covers |
|---|---|
| `basic-control-flow` | `JMPIF`/`JMPIFNOT`/`JMP`, real loops, method calls |
| `objects-arrays-forin` | `OBJECT`, `ARRAY`, `FORIN_INIT/NEXT`, `DELETE`, `TYPEOFGLOBAL` |
| `new-instanceof-accessors` | `NEW`, `LOADTHIS`, `SETMEMBER`, `instanceof`, `in`, `DEFGET` |
| `closures-rest-spread` | `MAKEFUNC` cells, `LOADCELL`/`STORECELL`, rest params, `arguments`, spread call |
| `try-catch` | `TRYCATCH`, `THROW`, `POPTRY` |

Each case runs the synthetic payload, deobfuscates it, runs the result and
compares output. Three real bugs were found this way (`Object.defineProperty`
operands missing from the use-set, so DCE deleted the accessor function;
`FORIN_NEXT` not treated as a branch; the layout probe not seeing writes for
handlers that throw on numeric operands).

`debug/trace.js` instruments the real opcode table and runs the payload for real,
then checks that **every pc the VM executes was recovered statically** (816
executed, 821 recovered — the extra five are the untaken side of an opaque
predicate).

---

## 5. Recovered program

```js
var a = false;
window._k1crlxlk2w8 = function () {
  var b, c, d, e, f,
    g = function (h, i) {            // TEA-ish stream cipher over the payload
      var j, k, l;
      if (!!f) {                     // opaque predicate left by the obfuscator
        j = i; k = ""; l = 0;
        while (l < h.length) {
          j = j - 1640531527 | 0;
          k = k + String.fromCharCode(h.charCodeAt(l) ^ (j ^ j >>> 13) & 65535);
          l = l + 1;
        }
        return k;
      }
    };
  if (!a) {                          // run-once guard
    a = true;
    b = document.createElement("div");
    b.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(b);
    c = b.offsetWidth;               // browser fingerprint: computed layout width
    d = Date.now();
    e = Math.floor(Math.random() * 1000000);
    f = d + "|" + e + "|" + (d - 10000 + e * 5) % 97 + "|" +
        (d - c + e) % 89 + "|" + (e + 1500) % 83;
    console.log(f, g(f, c + e));     // encoded beacon
  }
};
```

Note `j - 1640531527` is `-0x9E3779B9`, and the mixing `(j ^ j >>> 13) & 0xFFFF`
is the *same* construction the VM uses for its own string pool — the obfuscator
and the payload share a primitive.

### Decoded constants (site → value)

`window`, `_k1crlxlk2w8`, `document`, `createElement`, `div`, `style`, `width`,
`calc(100px + 20px * 2)`, `body`, `appendChild`, `offsetWidth`, `Date`, `now`,
`Math`, `floor`, `random`, `1000000`, `10000`, `5`, `97`, `89`, `1500`, `83`,
`|`, `console`, `log`, `16`, `24`, `7`, `25`, `imul`, `-150892297`, `x3ag`,
`length`, `-1640531527`, `13`, `65535`, `String`, `fromCharCode`, `charCodeAt`,
`1469662063`, `-1790807050`, `-49932956`, `895113823`, `17`.

(`x3ag` and the trailing five integers belong to the two dispatcher hash
functions, which do not survive into the output.)

---

## 6. Improving the MBA

Everything `vm.js` does rests on one property: **an opcode handler is a pure
function of `(synthetic frame, bytecode words)` that I can call as often as I
like, in isolation, off the real execution path.** The MBA is strong algebra
protecting a weak interface. The suggestions below are ordered by
(cost to the attacker) ÷ (cost to the obfuscator); the first two would have
stopped this project outright.

### 6.1 Make the salt a rolling value instead of a frame constant

`fp+4` is written once at frame setup and never touched again, so one probe per
`(function, instruction)` recovers everything. Make every handler advance it:

```js
frames[fp+4] = Math.imul(frames[fp+4] ^ op, 0x9E3779B1) + pc | 0;
```

Now the key at instruction *n* depends on the entire executed prefix. A single
site can no longer be probed in isolation — you must emulate from the function
entry, which is impossible while the inputs are still symbolic. This kills
`fitSite`, and with it the constant propagation and dispatcher resolution that
depend on it. Cost: one `imul` per dispatch, and the compiler has to run the
same recurrence when it emits constants.

A cheaper half-measure with much of the benefit: derive part of the key from
`frames[fp+2]` (the live pc). My evaluator relocates instructions into a scratch
buffer at pc 0, so an identity that only holds at the address the instruction
really occupies breaks immediately.

### 6.2 Conceal constants

`LOADCONST` and `LOADIMM` hand me values directly, and *every* static result here
is downstream of "I know this register holds `31300`". Remove plain immediate
loads:

* numbers produced by dedicated handlers from `(salt, pc, pool entry)` rather
  than read verbatim;
* booleans produced by comparisons whose operands are runtime-derived but
  algebraically forced to a known answer, so the obfuscator knows the value and
  the analyst does not;
* large constants split across several instructions and several registers, so a
  peephole constant-folder never sees the whole thing.

If the flattening state cannot be constant-folded, the CFG cannot be recovered at
all — the fallback is a `while (true) switch (state)` reconstruction, which is
barely better than the bytecode.

### 6.3 Key the register indices

`vm.js` learns operand layouts by writing sentinel words into the bytecode and
watching which frame slots get touched: if the read index equals the operand
word, that word is a register index. Decode the index instead —
`idx = (word ^ salt) % nregs`, or a per-function permutation table — and:

* the layout probe can no longer tell register operands from immediates;
* operand-aliasing detection breaks, so `x - x` stops folding to `0`;
* static disassembly needs the salt before it can even find instruction
  boundaries.

Cost: one xor per operand fetch.

### 6.4 Encode the register file

Store `reg[i] = value ^ tag(i, salt)`, decode on read and re-encode on write
inside each handler. Registers stop holding program values, so a lifter cannot
map register → variable directly, and every fold has to model the tag. Combined
with 6.3, whether an operand is junk depends on the tag, which blunts the
essentiality analysis that currently deletes junk operands in one perturbation
test.

### 6.5 Junk that is only *conditionally* junk

Today every junk operand cancels unconditionally — `(X & ~e) + (X & e) === X`
holds for all `e`, so one perturbation proves it irrelevant and it is deleted.
Emit junk that cancels only over the value range the program actually produces,
e.g. terms that vanish because the compiler knows `l < h.length ≤ 2¹⁶`. A
black-box prober perturbing that operand sees the output change, has to keep it,
and every lifted expression stays bloated. This is the cheapest way to make junk
survive into the final output.

### 6.6 Junk with real, checked side effects

Give each live register a shadow maintained by the same handlers
(`shadow = value ^ salt`) and verify it periodically in a handler that faults on
mismatch. `vm.js` deletes any register that no *real* statement reads — a checked
shadow *is* read by a real statement, so the whole shadow chain must survive DCE.
Spread the checks across function boundaries and the analyst cannot even scope
the removal locally.

More generally: decoy reads and writes only help if something observable depends
on them. A decoy that nothing reads is one liveness pass away from deletion.

### 6.7 One operator per opcode is a gift — stop giving it

The fitter tries ~20 JS operators against each handler and exactly one matches.
Select the operator from a *register* value rather than an immediate:

```js
switch (k & 3) { case 0: r = a + b; case 1: r = a - b; case 2: r = a ^ b; ... }
```

expressed, of course, as branch-free MBA. Per-site fitting then finds no single
operator, `vm.js` reports `UNKNOWN` and refuses the file. The obfuscator pays one
extra operand; the attacker has to lift a dynamic operator, which no amount of
probing collapses.

The same trick applied to the *destination* (writing to `reg[k & 7]`) breaks the
layout probe's "exactly one write slot" assumption.

### 6.8 Leave int32

Every identity here is int32-only, and `(a - (a|0)) * 65536` is a zero-guard that
also advertises "this operand is an integer". That let me probe with int32 values
and get exact matches. Identities that are correct over doubles, or MBA applied to
non-arithmetic operations — string concatenation decomposed into character
algebra, property access with a computed-key identity, `typeof` via table lookup —
would defeat both the typed and the numeric fit, because neither has a candidate
to match against.

### 6.9 Bind handlers to the machine, not just the frame

Handlers currently need only `this.g`, `this.d`, `this.i` and slot `fp+4`, all of
which are trivial to fake. Make the identity depend on values a synthetic frame
gets wrong: `frames[fp+9].x.F` (the template entry), `frames[fp+13]` (the frame
size), `frames[fp+7]` (the current opcode), the length of the bytecode, or a
checksum over the handler table itself. Cross-check two or three of them so
patching one is not enough. The attacker then has to reimplement
`g.prototype.t` faithfully before a single probe returns a meaningful value —
and any mistake produces plausible-looking garbage rather than an error.

### 6.10 Break the flat handler table

`A[opcode]` on a reachable prototype is what allows enumerating all 135 handlers
and calling them at will — step zero of this whole attack. Deriving the dispatch
target (`A[opcode ^ frames[fp+4]]`), building the table lazily on first use, or
splitting it across closures so no single object holds them all, raises the cost
of getting a handler list to probe in the first place.

### Summary

| # | change | defeats | obfuscator cost |
|---|---|---|---|
| 6.1 | rolling salt | per-site fitting, all constant propagation | low |
| 6.2 | constant concealment | dispatcher resolution, un-flattening | medium |
| 6.3 | keyed register indices | layout probe, aliasing analysis | low |
| 6.4 | encoded register file | lifting, essentiality analysis | medium |
| 6.5 | conditionally-junk operands | junk removal | low |
| 6.6 | checked shadow registers | dead-code elimination | medium |
| 6.7 | register-selected operator | semantic fitting | low |
| 6.8 | non-int32 / non-arithmetic MBA | typed + numeric fit | medium |
| 6.9 | frame/machine integrity in the identity | synthetic-frame probing | low |
| 6.10 | non-flat handler table | handler enumeration | medium |

---

## 7. Known limitations

* **`try/finally`** (`TRYFIN`, the 4-field handler record) is not reconstructed —
  the audit refuses the file instead of guessing. `try/catch` *is* handled.
* A `catch` block is analyzed with an empty entry state (the throw can come from
  anywhere in the protected region). That is sound, but if a *flattened* function
  had a `try/catch`, the dispatcher inside the catch might not resolve — the audit
  would then refuse rather than emit wrong code.
* Opaque predicates that depend on runtime values (`if (!!f)` above) are kept;
  proving them constant would need value-range reasoning we do not attempt.
* `DECRYPT` (self-decrypting bytecode) is decoded and classified but never
  executed by this sample, so that path is refused rather than emulated.
* Blocks are cloned per flattening state, capped at 400 clones per pc. A payload
  whose state is a genuine unbounded counter would hit the cap and degrade to the
  imprecise (still correct, just flattened) CFG.

## 8. Files

```
vm.js              the deobfuscator (single file)
test.js            end-to-end + pass-through tests
test-features.js   synthetic-payload tests for the rest of the instruction set
regular.js         a normal file used for the pass-through test
output.js          result of `node vm.js input.js output.js`
NOTES.md           this file
debug/                              # kept as the exploration record
  opcodes.js       the definitive opcode table (source of the census above)
  assemble.js      assembler for synthetic payloads on the real runtime
  trace.js         instrumented run of the real VM + static-coverage check
  dump2.js         block listing driven by the finished vm.js
  extract.js       dump the 135 raw opcode handlers to handlers.txt
  load.js          load the payload and capture bytecode / pool / opcode table
  classify.js      first-pass structural classification of handlers
  probe.js         operand-layout probe for every opcode
  ops.js           exploration-stage opcode table + semantic fitting
  disasm.js        exploration-stage linear disassembler
  analyze.js       linear disassembly with fitted semantics
  explore.js       exploration-stage CFG recovery
  dump.js          block listing (exploration stage)
  *.txt / *.json   their outputs, kept for reference
```

The first four are the ones worth running; the rest are the earlier iterations
(they still work, but `vm.js` is the single source of truth now).
