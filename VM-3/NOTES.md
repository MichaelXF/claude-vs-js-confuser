# JS-Confuser-VM — reverse engineering notes

Working notes behind `vm.js`. Everything here was derived from `input.js` alone.

```
$ node vm.js input.js output.js     # 296,671 bytes  ->  1,891 bytes
$ node test.js                      # 27/27 checks passed
```

---

## 1. What the protection looks like

The whole program is replaced by a register machine. `input.js` contains:

| helper | role |
| --- | --- |
| `f(a)` | base64 → bytes |
| `g(a)` | *function template*: `{I:{p,e,v,a}, j:[cells], prototype:{}}` |
| `q(a,b)` | *closure cell*: `{g:stack, s:slot, m:materialized, o:value}` |
| `u(...)` | VM object: `i`=bytecode, `n`=constant pool, `E`=global, `g`=stack, `h`=stack top, `w`=frame pointer, `l`=cells |
| `v(...)` | materializes live cells when a frame dies |
| `w(...)` | pushes a call frame |
| `x(a,b)` | reads the next operand word (`a.i[a.g[a.w+8]++]`); the 2nd argument is junk |
| `y(a,b,e)` | decodes a constant-pool entry |
| `z(...)` | the dispatch loop |
| `C[n] = function(){}` | **144** opcode handlers on `u.prototype` |

### Frame slots (relative to the frame pointer `w`)

```
+0  this value            +6  try/catch handler stack
+1  function template     +8  program counter
+2  frame size            +9  caller's frame pointer
+3  register base         +10 frame end
+4  return destination — (destinationRegister << 1) | isConstructor
```

Registers live at `stack[stack[fp+3] + i]`.  Template info `{p,e,v,a}` is
`{paramCount, registerCount, entryPc, hasRestParam}`; on entry registers
`0..p-1` hold the arguments and register `p` holds the argument array.

### Constant decoding (`y`)

```
value = pool[index];   if (!key) return value
number  -> value ^ key
string  -> base64 → bytes, then per 16-bit chunk:
             key  = (key + 0x9E3779B9) | 0
             char = (lo | hi<<8) ^ ((key ^ key>>>13) & 0xFFFF)
```

### The payload

```
51,782 bytecode words · 150 pool entries · entry template {p:0, e:5, v:0}
fn#0  entry 0     top level,                 8 instructions
fn#1  entry 14    the real program body,    78 instructions
fn#2  entry 287   2 params, 10466 registers, 15,373 instructions
```

---

## 2. Identifying the opcodes without guessing

Opcode numbers are randomized per build and there are 144 handlers, so nothing
is hard-coded.  Each handler's AST is *canonicalized* instead
(`canonicalize()`):

* aliases (`var a=this.g, b=a[this.w+3]`) are resolved,
* frame slots become `PC`, `TH`, `HND`, … and registers become `R[$]`,
* `x(this, junk)` **and** constants baked into the handler both become the
  operand marker `$`,
* single-use temporaries are inlined and locals renamed,
* junk arguments to runtime helpers are erased.

Two handlers that mean the same thing then print the same string:

```
R[$]=R[$]%R[$];      <- op 5592          (operands read from the stream)
                        ops 54791/29062/57232 (operands baked into the handler)
```

`slots` records for each printed `$` whether it comes from the stream (and at
which read position) or is a constant — that is what makes the "specialized"
handlers decode correctly even though they read nothing.

**144 handlers → 72 shapes → 36 instruction kinds, nothing unclassified.**

### Instructions worth calling out

* **`makeFunction`** — dst, entryPc, paramCount, regCount, capCount, hasRest,
  then `capCount` × (isOwnCell, index).  VM closure cells map exactly onto JS
  closures, so each VM function is emitted as a *nested* function expression
  and its captured registers become ordinary outer `var`s.  Nothing else is
  needed to get closure semantics right.
* **`call` / `methodCall` / `construct`** — an argument count equal to
  `185599912` means "spread the single register that follows".
* **`decrypt`** — an XOR keystream that decodes a bytecode range in place
  (JS-Confuser's *Encode Bytecode*).  Applied during the disassembly walk.
  This particular sample does not use it.
* **three MBA handlers** hide one plain int32 operation behind a page of mixed
  boolean arithmetic.  `identifyMBA()` evaluates the expression on sample
  inputs with a tiny interpreter (never `eval`) and matches it against
  candidate operators — all three turn out to be `^`.

---

## 3. The second layer: control-flow flattening

`fn#2` is flattened on top of being virtualized.  Register 31 is the state
variable, every block ends by computing the next state through a wall of MBA,
and a chain of opaque predicates at pc 302 routes on it.  Registers
10456–10460 are the MBA scratch registers — that is why so many "specialized"
handlers address them.

A runtime trace of the original shows the dispatcher runs 699 times but visits
only **102 distinct states**, so the flattened graph is small; the naive
approach fails only because propagating *every* constant also unrolls real
loops.  `specializeFunction()` therefore runs twice:

1. **Probe** with a small block budget, recording how many distinct values each
   register takes at each program point.
2. At the hottest point the state registers stand out by an order of magnitude
   (97 and 98 distinct values, everything else ≤ 14).  The real run specializes
   on those, plus registers that are effectively constant there (≤ 2 values, so
   they cost nothing and keep ordinary constants folding).

Blocks are keyed by `(pc, constant registers)`; folded branches disappear and
the dispatcher collapses:

```
15,373 instructions  ->  103 blocks / 489 steps  ->  6 blocks after merging
```

Two liveness-driven DCE passes (per block during the walk, then over the whole
specialized graph where *constant-folded reads do not keep a register alive*)
remove the arithmetic that only ever fed the now-folded predicates.

---

## 4. Getting back to JavaScript

| stage | what it does |
| --- | --- |
| `mergeLinearBlocks` | splices blocks into their unique predecessor |
| `ssaRenameBlock` | block-local SSA — the bytecode recycles scratch registers, which otherwise blocks all expression folding |
| `combineExpressions` | folds three-address code into nested expressions, consuming definitions in the order a compiler emitted them so evaluation order is preserved by construction |
| `reloop` / `renderShape` | Emscripten-style Simple/Loop/Multiple shape recovery — correct for any CFG, including irreducible ones |
| `pruneLabels` | drops labels nobody jumps to and the dispatch variable when unread |
| `simplifyMBA` | bottom-up algebraic simplification (see below) |
| `collapseDispatch` | turns `if (c) {_lbl=1} else {_lbl=2}` + `if (_lbl===1)…` back into `if (c) … else …` |
| `dropDeadRegisters` / `renameRegisters` | whole-program DCE (register names are globally unique, so no scope analysis is needed) and short readable names |

### `simplifyMBA`

Rather than pattern-matching JS-Confuser's expansions, each arithmetic subtree
over ≤ 3 variables is evaluated on ~1,900 deliberately awkward samples
(zeros, powers of two, int32 boundaries, negatives, **floats**, big values) and
compared against short candidate expressions.  A rewrite is only taken when it
agrees on *every* sample and is strictly smaller.  The float samples are the
important part: a candidate that is only equal for int32 inputs disagrees on
them and is rejected, so a match is never an approximation.

---

## 5. Result

```js
window._ttwl6apnfd = function () {
  var a, b, c, d, e, f, g, h, ...;
  h = function (r, s) { ... };          // the XTEA-ish string cipher
  k = document;
  a = k.createElement("div");
  a.style.width = "calc(100px + 20px * 2)";
  l = document.body;
  l.appendChild(a);
  b = a.offsetWidth;
  ...
  Reflect.apply(j, i, [g, h(g, b + d)]);   // console.log(g, h(g, b + d))
};
```

`test.js` runs both the original and `output.js` in the same deterministic
fake-DOM sandbox and compares every console call, exported global, return
value and thrown error across six argument shapes — they match exactly.

## 6. Known limits

* **try/catch/finally bytecode** (`pushCatch` / `pushFinally` / computed
  `finally` dispatch) is decoded and classified but not yet lifted; `vm.js`
  raises a clear error instead of emitting something that might be wrong.
  This sample does not use it, so I had no way to test a lowering.
* If the flattening cannot be resolved within the block budget, the specializer
  gives up and the function is lifted straight from the bytecode — still
  correct, just longer.
* `Reflect.apply(f, o, [...])` is only turned back into `o.m(...)` when the
  callee expression folds into the call site; otherwise it is left as-is,
  because re-reading the property could run a getter twice.

## 7. Files

| file | |
| --- | --- |
| `vm.js` | the deobfuscator (`node vm.js input.js output.js`, or `require('./vm.js')('input.js')`) |
| `test.js` | the checks described above |
| `regular.js` | ordinary program used for the pass-through test |
| `output.js` | generated |
| `debug/` | the scratch tools used to work this out — handler dumps, canonical shape tables, disassembler, runtime tracer, stage timings, behaviour differ |
