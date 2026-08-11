# VM-4 — reverse engineering notes (JS-Confuser-VM)

`input.js` is a **register-based bytecode VM**. The original program was compiled to
bytecode; what ships is the interpreter, an encrypted constant pool and a base64
bytecode blob. `vm.js` recovers the original JavaScript from it.

```
$ node vm.js input.js output.js
$ node test.js            # 20/20 checks, including behavioural equivalence
```

---

## 1. Anatomy of the VM (minified names in this sample)

| name | role |
| --- | --- |
| `g(a)` | base64 → `Buffer` / `Uint8Array` |
| `k(spec)` | *function prototype*. `spec = {m,o,D,d}`; `.l` = upvalue list; `.prototype` |
| `r(j,G,h)` | the VM/context. `j` = bytecode `Uint32Array`, `G` = constant pool, `h` = globals |
| `v(c,idx)` | an **upvalue cell** over `stack[idx]`; `.Q()` reads it, `.A`/`.u` = closed flag/value |
| `w(vm,fp,i)` | create-or-reuse the upvalue cell for register `i` of frame `fp` |
| `x(vm)` | fetch next operand: `vm.j[vm.c[vm.g + 11]++]` |
| `y(…)` | push a call frame |
| `z(vm,_,i,key)` | decode constant `G[i]` with `key` |
| `B(vm,this,args,spec)` | the dispatch loop |
| `C = r.prototype` | opcode table — `C[<opcode>] = function () { … }` |

### Frame layout (`fp` = `vm.g`, stack = `vm.c`)

```
fp+0   param count             fp+7   caller frame pointer
fp+1   frame size (13 + regs)  fp+8   instruction counter (junk)
fp+3   `this` value            fp+9   running hash (junk)
fp+4   the `k` fn-spec         fp+10  return destination, encoded (dst<<1 | isNew)
fp+5   try-handler stack       fp+11  program counter
fp+6   register base (abs)     fp+13… registers
```

Registers are `stack[stack[fp + 6] + i]`. `vm.js` derives every one of these
offsets rather than assuming them (e.g. the register-base slot is found by seeing
which frame slot gets used as an index base — 826 hits on slot 6, 0 on anything else).

### Constant decoding (`z`)

```js
a = G[index];
if (!key) return a;
if (typeof a === "number") return a ^ key;            // numbers: plain xor
if (typeof a !== "string") return a;
bytes = base64(a); out = "";
for (i = 0; i < bytes.length / 2; i++) {
  key = (key + 2654435769) | 0;                        // Knuth golden ratio
  out += String.fromCharCode((bytes[2i] | bytes[2i+1] << 8) ^ ((key ^ key >>> 13) & 0xffff));
}
```

The key is baked into each *instruction*, so one pool entry decodes to different
strings at different use sites.

---

## 2. The four defences, and how each is undone

### 2a. Randomised **and specialised** opcodes

Opcode numbers are random per build, and most handlers are *specialised*: the
operand is baked into the handler body instead of read from the bytecode.

```js
C[59164] = function () { … a[b+f]  = c + a[b+x(this)] };  // generic  ADD dst, s1, s2
C[8262]  = function () { … a[b+12] = a[b+11] + a[b+3]  };  // ADD r12, r11, r3
C[3974]  = function () { … a[b+2]  = this.h[<const 0>] };  // LOADGLOBAL r2, "window"
```

165 handlers exist, 105 of which a full run touches. There is no fixed opcode
table to hard-code — it has to be recovered per file.

**Undone by:** a small purpose-built AST interpreter (`runHandler`) executes each
handler against a synthetic frame where `x()` yields known operands and registers
hold symbolic markers. Marker arithmetic builds an expression tree, so the
handler's effect falls out directly:

```
op 59164 -> r5000 = (r5001 + r5002)        => BIN '+', dst=op0, srcs=[op1,op2]
op 3974  -> r2    = vm.h[K(0,2145282205)]  => GET_GLOBAL r2, "window"
op 44553 -> new k({m:op2,o:op3,D:op1,d:op5}) + pushes  => MAKE_FN
```

All 165 classify into 34 semantic kinds with no leftovers (`debug-ops.txt`).

Operand counts come from probing with two different operand bases; where the
count differs the opcode is variable-length, and the count slot / group size /
fixed prefix are solved for (calls, `new`, array & object literals, closures).

### 2b. MBA-obfuscated arithmetic, **keyed on the frame size**

31 handlers hide the operator behind mixed boolean arithmetic:

```js
C[2701] = function () { …; a[b+f] = ((c|d)-(~c&d) ^ (d&~d|d&d)) + (((c|c)-(~c&c)&d) << 1) ^ 0 };
//                      ≡ (c ^ d) + 2*(c & d)  ≡  (c + d) | 0
```

The nasty part: many of them multiply by a constant derived from
`stack[fp+1] - 13`, i.e. **the enclosing function's register count**. The MBA
identity only collapses for one specific register count — `C[55336]` is `(a+b)|0`
if and only if the calling function has exactly 45 registers, and computes garbage
otherwise. The same opcode genuinely means different things in different functions.

**Undone by:** numeric fitting. Once the symbolic pass has identified which
operands are register indices, immediates and jump targets, the handler is run
with concrete values — the register count taken from the *function being
disassembled*, immediates left at their real bytecode values (some are opaque
predicates that select between two branches, so they must not be randomised) —
and the result is matched against a candidate operator table, including fused
three-input forms such as `(a + k) - b`. Probe values are a fixed list plus a
seeded xorshift, so a given input always produces the same output; the list
includes `2147483647` / `-2147483648` so `a + 1` can be told apart from
`(a + 1) | 0`.

### 2c. Control-flow flattening with a hashed dispatcher

`fn@267` ends every block with

```
r34 = <per-block constant>;  r35 = <constant>;  jmp 1244
1244: r34 = hash(r34, r35);  r37 = 0;  r34 = r34[r37];  jmp *r34
```

`hash` is a real VM function (`fn@1258`, an xorshift/`Math.imul` mixer). The
dispatcher then walks a chain of ~20 opaque comparison blocks
(`r16 += 26722; r18 = r14 == r16; r38 = -+!r18; r34 = base + (delta & r38)`)
until one matches the state register `r14`.

**Undone by:** path-sensitive constant propagation over the recovered IR. The
engine interprets the hash function on constant arguments, so `jmp *r34` resolves
to a concrete address (37 distinct targets here). Where the state depends on
runtime data — `r14` is masked by `-!(i < s.length) & 920`, so a real branch is
folded into the dispatcher state — the comparison is *forked* into both outcomes
and both are followed.

The exploration builds a **trace CFG** whose nodes are `(pc, constant state)`
pairs; that graph is already the de-flattened program. A register that takes too
many distinct values (a loop counter) would unroll the loop forever, so it gets
abstracted away and the exploration retried — the dispatcher state never does
that, so only genuine data registers get widened.

### 2d. Variable masking / dead state

The state bookkeeping is then removed by ordinary compiler passes: constant
folding of everything the engine proved constant and side-effect-free (including
calls to the pure hash function), backward-liveness dead-store elimination, and
Moore partition refinement to merge the block clones the trace produced.
2595 trace nodes collapse to the handful of blocks that carry real work.

---

## 3. Pipeline in `vm.js`

```
parse ─► locateVM ─► classify 165 handlers ─► disassemble (+ resolve dispatcher)
      ─► lift each function to IR ─► fold ─► DCE ─► minimise ─► forward-substitute
      ─► structure (dominators / post-dominators / natural loops) ─► Babel AST
      ─► readability passes ─► generate
```

Structuring uses Cooper–Harvey–Kennedy dominators, post-dominators on the
reversed graph for `if`/`else` joins, and natural loops from back edges,
emitting `while` with labelled `break`/`continue` where needed.
`TRY_CATCH`/`TRY_FINALLY` map onto a real `try`/`catch` (the VM's recovery path —
`reg[excReg] = e; goto handler` — is exactly a catch clause); if the protected
region can't be delimited the tool says so in a warning rather than emitting
something wrong.

Readability passes: `obj[k].call(obj, …)` → `obj[k](…)`, `obj["name"]` → `obj.name`,
single-use temporary inlining, `while (true) { if (c) break; … }` → `while (!c) { … }`,
declaration merging, dead-declaration pruning.

---

## 4. The recovered program

```js
window._ttwl6apnfd = function () {
  var r2 = document.createElement("div");
  r2.style.width = "calc(100px + 20px * 2)";
  document.body.appendChild(r2);
  var r3 = r2.offsetWidth;
  var r4 = Date.now();
  var r5 = Math.floor(Math.random() * 1000000);
  var c1_9 = r4 + "|" + r5 + "|" + (r4 - 10000 + r5 * 5) % 97
                + "|" + (r4 + r5 + r3) % 89 + "|" + (r5 + 1500) % 83;
  console.log(c1_9, function (a0, a1) {
    if (!c1_9) return;
    var r4 = a1, r5 = "", r6 = 0;
    while (r6 < a0.length) {
      r4 = r4 + -1640531527 | 0;
      r5 = r5 + String.fromCharCode(a0.charCodeAt(r6) ^ (r4 ^ r4 >>> 13) & 65535);
      r6 = r6 + 1 | 0;
    }
    return r5;
  }(c1_9, r3 + r5));
};
```

A browser fingerprint (`offsetWidth` of a `calc()`-sized div, clock, PRNG) folded
into a `|`-separated string, logged alongside the same string run through the
*encryptor* half of the VM's own constant cipher.

`test.js` runs `input.js` and `output.js` in the same sandbox with a deterministic
`Date.now`/`Math.random` and checks the console output, the DOM side effects and
the return values match exactly.

### Faithfulness notes

* Int32 coercions are kept (`r6 = r6 + 1 | 0`) because that is genuinely what the
  handler computes; dropping them would differ at the 2³¹ boundary.
* The immediates loaded straight from bytecode are **unsigned** 32-bit
  (`Uint32Array`); pool constants are signed. Both are emitted as written.
* Register names (`r4`, `a0`, `c1_9` = a captured register) come from the VM's
  register file; the original identifiers are not recoverable — they were never
  compiled in.

---

## 5. Coverage

1192 of 1405 bytecode words are reached. The 213 unreached words decode cleanly
(see `debug-disasm.js`) and are all dispatcher decoys — unreachable state
updates plus two duplicate `return undefined` blocks — no program logic.

---

## 6. Files

| file | what it is |
| --- | --- |
| `vm.js` | the deobfuscator (library + CLI) |
| `test.js` | the test suite (`node test.js`) |
| `regular.js` | an ordinary program used to prove pass-through |
| `output.js` | generated result |
| `debug-explore.js` | dumps handlers / bytecode / pool |
| `debug-profile.js` | groups handlers by shape |
| `debug-trace.js` | instruments the *real* VM to get ground-truth execution |
| `debug-classify.js` | prints the symbolic effect recovered for each handler |
| `debug-ops.js` | runs the real classifier over every opcode |
| `debug-disasm.js` | human-readable disassembly |
| `debug-passthrough.js` | pass-through robustness over assorted JavaScript |
| `debug-*.txt` | generated artifacts from the scripts above |
