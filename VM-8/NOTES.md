# JS-Confuser-VM MBA v6 — analysis notes

Sample: `input.js` (94 KB, `target: browser`).
Options in play: `mba`, `controlFlowFlattening`, `minify`, `classObfuscation`,
`handlerTable`, `randomizeOpcodes`, `shuffleOpcodes`, `encodeBytecode`,
`concealConstants`.

Recovered program (`output.js`, 886 bytes):

```js
var c1_0;
c1_0 = false;
window._k1crlxlk2w8 = function () {
  var c2_0, v10, v2, v3, v4, v5, v35, v36;
  v10 = function (p0, p1) {                       // XTEA-ish string mixer
    var v4, v5, v6;
    if (!c2_0) return;
    v4 = p1; v5 = ""; v6 = 0;
    while (v6 < p0.length) {
      v4 = v4 + -1640531527 | 0;
      v5 = v5 + String.fromCharCode(p0.charCodeAt(v6) ^ (v4 ^ v4 >>> 13) & 65535);
      v6 = v6 + 1;
    }
    return v5;
  };
  if (!c1_0) {
    c1_0 = true;
    v2 = document.createElement("div");
    v2.style.width = "calc(100px + 20px * 2)";
    document.body.appendChild(v2);
    v3 = v2.offsetWidth;
    v4 = Date.now();
    v5 = Math.floor(Math.random() * 10000000);
    c2_0 = v4 + "|" + v5 + "|" + (v4 - 10000 + v3 + v5 * 5) % 97 + "|" +
           (v4 + v5) % 89 + "|" + (v5 + 1500) % 83;
    v35 = v10(c2_0, 5 + v3 + v5);
    v36 = v10("CLAUDE OPUS 5", v3);
    console.log(c2_0, v35, v36);
  }
};
```

---

## 1. VM architecture

Five top-level pieces (names are per-build; `vm.js` never uses them):

| role | in this build | what it is |
| --- | --- | --- |
| base64 → bytes | `l` | `Buffer.from(s,'base64')` / `atob` |
| machine | `q` | holds `Q` (bytecode), `A` (constant pool), `i` (global), `g` (stack), `h` (frame ptr), `n` (stack top), `v` (upvalue cells), `x` (per-instruction key) |
| upvalue cell | `t` | `{o: absolute slot, g: stack, u: closed?, m: closed value}` with `.a()` get, `.q()` set, `.s()` close |
| function object | `u` | `{J: {j,l,C,K,B}, f: upvalues[], prototype}` |
| interpreter | `x` | the dispatch loop |

### Frame layout

`v(vm, args, thisValue, retInfo, fnObj)` pushes a frame of `15 + l` slots at
`vm.n`. Header slots (relative to the frame base `h`):

| slot | meaning |
| --- | --- |
| 0 | return-value routing: `>>1` = caller register, `&1` = construct flag |
| 1 | rolling pc hash (decoy — no handler reads it) |
| 3 | program counter |
| 5 | the `u` function object (upvalues live here) |
| 6 | **`B`** — the function's key; MBA handlers derive opaque constants from it |
| 7 | register base (`h + 15`) |
| 9 | frame checksum (decoy) |
| 10 | frame size |
| 11 | caller frame pointer |
| 12 | `this` |
| 13 | instruction counter (decoy) |
| 14 | try-handler stack |

Registers are `g[g[h+7] + i]`. Parameters land in registers `0 .. j-1`, and
register `j` receives the whole argument list (the `arguments` object).

### Dispatch loop

```js
pc = g[h+3]; g[h+3] = pc+1; op = Q[pc];
vm.x = Math.imul(pc ^ op, 963289761) ^ 1057581121 | 0;   // per-instruction key
try { vm[op](); } catch (e) { /* unwind using g[h+14] */ }
if (!vm.h) return vm.g[0];
```

Two things matter for static analysis:

* `vm.x` is a pure function of **(pc, opcode)** — it is a compile-time constant
  at every instruction site, so handlers that use it are still statically
  analyzable *per site*.
* Slots 1, 9 and 13 are updated every instruction but no handler ever reads
  them (`grep` over the handler bodies confirms only slots 0, 3, 5, 6, 7, 10,
  11, 12 and 14 are used). There is therefore **no path-dependent state**.

### Constant decoding (`concealConstants`)

```js
function w(vm) {
  var idx = vm.c(), key = vm.c(), v = vm.A[idx];
  if (!key) return v;                     // raw pool entry
  if (typeof v === 'number') return v ^ key;
  var b = base64(v), out = '';
  for (var i = 0; i < b.length/2; i++) {
    key = key + 2654435769 | 0;
    out += String.fromCharCode((b[i*2] | b[i*2+1] << 8) ^ (key ^ key >>> 13) & 65535);
  }
  return out;
}
```

So every string is a base64 blob plus a per-site 32-bit key. `vm.js` never
reimplements this: it just runs the handler and reads the value that lands in
the destination register.

---

## 2. The handler table

103 handlers, of which the sample executes 57 — the rest are decoys or
duplicates produced by `shuffleOpcodes`. Opcode numbers are 16-bit and
randomized per build.

Roughly a third of the handlers are plain (`b[e+g] = d + b[e+c()]`); the rest
are rewritten by the MBA pass into 1–7 KB expressions such as

```js
e[g + (b ^ h & 15)] =
  (0 | ((0 | ((a & (c & ~a ^ c & a)) + (a - Math.imul(Math.imul(f, 1353804205) >>> 29 ^ 7, -43228665) …
```

Three tricks appear inside them:

1. **Opaque constants from `B`** — `Math.imul(Math.imul(rot(Math.imul(B, -637311745)) - 1215522527, -958313765), K) ^ C | 1`.
   Constant per function, unknown to a reader, irrelevant to an executor.
2. **Masked destination registers** — e.g. `e[g + (b ^ h & 15)]` where `h`
   comes from an operand. The written register is *not* the operand.
3. **Operand-selected sub-operations** — `f = Math.imul(operand ^ this.x ^ K1, K2)`
   then two bits of `f` pick one of four results. `this.x` depends on the pc,
   so the same opcode is a different operator at different sites (`handlerTable`).

### The low-nibble invariant (key finding)

Several MBA handlers are only correct for operands in a particular residue class
mod 16. The tell is terms of the form `Math.imul(x & 15 ^ N, K)`, which vanish
exactly when `x & 15 === N`:

```js
y[24746] = function () {
  … a = ~~e[g + this.c({})],       // register operand
    c = this.c([]) >> 0,           // immediate operand
  e[g + d] = (… Math.imul(a & 15 ^ 15, -1863050439) … Math.imul(c & 15 ^ 0, 1014832903) …)
};
```

`a & 15 ^ 15` ⇒ the register must be ≡ 15 (mod 16), `c & 15 ^ 0` ⇒ the immediate
must be ≡ 0 (mod 16). And indeed every control-flow-flattening state constant in
this build ends in `0xF`, and every state-transition immediate ends in `0x0`.
Probing such a handler with arbitrary integers produces noise:

```
f(-3) = 808330767   f(-2) = -1810887929   f(0) = 1877049927     (garbage)
f(x) with x & 15 === 15:  f(x) === x ^ 368974448                (clean XOR)
```

`vm.js` therefore scans residue classes when fitting a handler and keeps the
interpretation that explains the most inputs — in the wrong class the real
operands look *dead*, which makes the right class easy to recognize.
(`lib-classify.js`, `fitNumeric`.)

---

## 3. Control-flow flattening

Flattening was applied at source level, so it survives into the bytecode. Each
VM function has a dispatcher:

```
 39  v38 = 1509521695            // initial state
 50  v41 = true                  // opaque predicate
 56  if (!v41) goto 331
 59  v40 = 262311919             // first case label
 65  v42 = v38 === v40
 70  if (!v42) goto 75
 73  goto 392                    // -> real block
 75  v40 = v40 ^ 368974448       // next case label
 80  v43 = v38 === v40
 …
329  goto 50
```

and every real block ends with `v38 = <MBA transition>(v38, …); goto 50`.
Some transitions are conditional:

```
767  v59 = !v62
770  v60 = -v59                  //  0 or -1
774  v38 = OPAQUE(v38, v60, …)   //  state = cond ? A : B
```

Function 2 has its own dispatcher on register 13 (head at 826).

Three transition opcodes (26866, 23871, 22474, 51549) are multi-round avalanche
hashes with no readable closed form. They never need one: their inputs are
compile-time constants, so `vm.js` folds them by **executing the handler**
(`lib-classify.js`, `oracle`).

---

## 4. How `vm.js` works

Nothing is keyed on opcode numbers, handler order, identifier names or handler
source text. Every semantic fact is obtained by *running* the sample's own
handlers under instrumentation.

```
lib-extract   find the bootstrap `interp(new VM(bytecode,…,pool), new Fn({…}))`
              by AST shape; re-emit the file with that call replaced by an
              export of the runtime, and evaluate it in a `node:vm` sandbox.
              The payload never runs.

lib-probe     execute exactly ONE instruction: build a synthetic frame with a
              chosen pc / B / register file, wrap every handler, and record
                * operands consumed (by shadowing `vm.c`)
                * register reads/writes (Proxy over the stack array)
                * global reads/writes, property access, calls, `new`, `delete`,
                  defineProperty (Proxy "tracer" values in the registers)
                * upvalue get/set and closure captures
                * pc / frame changes
              Stopping is trivial: the wrapper sets `vm.h = 0`, which makes the
              interpreter return after the single step.

lib-disasm    linear sweep for instruction boundaries (operand counts come from
              the number of `vm.c()` calls), then classify each site:
                control flow  -> compare pc after truthy/falsy/ramped registers
                effects       -> read the tracer log
                arithmetic    -> fit over a mixed-type domain first (catches
                                 `typeof`, `in`, `instanceof`, unary `+`,
                                 string `+`), then over int32 residue classes
                try handlers  -> push the record, throw a sentinel, and let the
                                 interpreter's own unwinder reveal the catch pc
                                 and the registers it fills
                for-in step   -> re-probe with a value shaped like an iterator
                                 record so the non-exhausted path is visible
                self-modifying-> the sweep runs on a working copy of the
                                 bytecode with mutations kept, so `encodeBytecode`
                                 regions decrypt themselves

lib-analyze   walk each function's CFG; closures are inspected by *calling* the
              produced function far enough to read its own frame header (entry
              pc, register count, key B, parameter count, rest flag)

lib-peval     specialize the dispatcher on the state register.  The dispatcher
              head is the highest in-degree jump target; its comparison chain is
              found by following fall-through and conditional edges only, and
              the chain's live-in registers are the state.  At the head every
              other register is reset to unknown, which both removes the
              flattening and bounds the search.  Instruction results are folded
              with the oracle; a state that is still conditional (`cond ? A : B`)
              splits the path in two, which is what turns a flattened `if` back
              into a real branch.

lib-emit      merge chains, dead-code eliminate (the dispatcher's arithmetic all
              becomes dead), rename block-local register versions to SSA
              temporaries, then structure the CFG (dominators, natural loops,
              immediate post-dominators) into if/else, while, break/continue,
              try/catch.

lib-codegen   IR -> Babel AST.  Registers `v0…`, parameters `p0…`, captured
              upvalues `c<fnId>_<idx>` (the capturing function's id), shared with
              the defining scope so the name is the same on both sides.

lib-polish    expression folding (re-nesting the three-address temporaries),
              `obj.m.call(obj, …)` -> `obj.m(…)`, literal propagation, dead
              store removal, loop shape recovery, tidy naming.
```

---

## 5. Verification

`node test.js` (`--quick` skips 3 and 4):

1. **Structure** — output parses; no `Uint32Array`, no base64 loader, no
   `Math.imul`, no `switch` dispatcher; strings decoded; no unresolved opcodes.
2. **Behaviour** — `input.js` and `output.js` run in identical deterministic
   sandboxes (fixed `Date.now`, seeded `Math.random`, instrumented DOM) across
   four seeds; every observable effect matches, including the two mixed strings.
3. **Randomized opcodes** — `debug/permute.js` rebuilds the sample with a fresh
   random bijection over all 103 opcode numbers, a shuffled handler table and
   every identifier renamed. (The interpreter derives `vm.x` from the opcode, so
   a reverse map is threaded into that one expression to keep the rebuild
   semantically identical.) The rebuilt file behaves like the original, and
   `vm.js` deobfuscates it to a **byte-identical** `output.js`.
4. **Unused handlers** — `debug/features.js` assembles fresh programs out of the
   sample's own handler table (`debug/assemble.js` discovers operand slot layouts
   the same way everything else is discovered: emit, classify, see which slot each
   role came from) covering try/catch, try/catch with a join, for-in over an
   object literal, `new`/arrays/`typeof`/`instanceof`/`in`/`delete`, and an
   `encodeBytecode`-style encrypted region. Each is deobfuscated and both
   versions are run and compared.
5. **Pass-through** — `regular.js` (plain modern JS) and a small file containing
   `new Map(...)` come back byte-identical.

---

## 6. Notes, choices and limits

* **Int32 wrapping.** The MBA handlers are int-only encodings of source-level
  integer operations, so `vm.js` emits the plain operator (`a + b`, not
  `a + b | 0`). Where the bytecode contained an explicit `| 0` the output keeps
  it — the decode loop's `v4 = v4 + -1640531527 | 0` is genuinely two
  instructions in the bytecode. A handler that is specifically `Math.imul` is
  emitted as `Math.imul`.
* **`===` vs `==`.** Under the residue-class invariant the two agree on every
  value an MBA comparison handler can legally see, so `===` is emitted.
  Non-MBA handlers are distinguished properly by the mixed-type fitter.
* **Constant folding is done by executing the real handler**, not by
  reimplementing it, so opaque predicates such as `v59 = ~(v38 ^ v38)` collapse
  to `-1` and their dead branch disappears without ever being understood.
* **Property reads may move.** Expression folding treats member reads as pure,
  so a getter with side effects could be re-ordered. This is the usual
  deobfuscation trade-off; `--no-polish` is available through the API
  (`deobfuscateSource(src, { polish: false })`) if a literal transcription is
  wanted.
* **`for-in`** is emitted against two small helpers (`__forInKeys`, `__iterNext`)
  because the VM's iterator record has no direct JS spelling. They are only
  emitted when the program actually uses for-in.
* **Computed jumps** (`goto reg`, used by `finally` dispatch) are resolved when
  the register holds a constant, which is the case the compiler generates. An
  unresolved one is reported rather than silently mis-compiled.
* **Runtime** ≈ 20 s for this sample. Almost all of it is handler fitting:
  ~50 k single-instruction executions, dominated by the residue-class scan for
  the MBA opcodes. The scan is ordered by the `& 15 ^ N` literals present in the
  handler body (a search-order hint only — the full 0..15 scan still runs if
  none of them fits) and cached per opcode.

## 7. Files

| file | |
| --- | --- |
| `vm.js` | entry point: `node vm.js input.js output.js`, or `require('./vm.js')(path)` |
| `lib-extract.js` | locate + sandbox-load the VM runtime |
| `lib-probe.js` | single-instruction execution harness |
| `lib-classify.js` | typed / residue-class operator fitting + the constant-folding oracle |
| `lib-disasm.js` | linear sweep and per-site classification |
| `lib-analyze.js` | function discovery and CFG walk |
| `lib-peval.js` | dispatcher specialization (flattening removal) |
| `lib-emit.js` | merge / DCE / SSA temporaries / CFG structuring |
| `lib-codegen.js` | IR → AST |
| `lib-polish.js` | source-level cleanup |
| `test.js` | the checks in §5 |
| `regular.js` | plain file used for the pass-through check |
| `debug/` | shim, tracing, permutation rebuild, assembler, feature programs, dumps |
