# NOTES.md — Deobfuscation findings for JS-Confuser-VM 0.1.5 sample

Sample: `input.js` — a full-program VM obfuscation produced by JS-Confuser-VM 0.1.5 with
options `{ controlFlowFlattening, dispatcher, minify, classObfuscation, handlerTable,
randomizeOpcodes, shuffleOpcodes, encodeBytecode, concealConstants }`, target `browser`.

## 1. VM architecture

The whole original program is compiled to bytecode for a custom **register-based VM**.
Runtime components (minified names from the sample):

- `class d` — the VM. Fields: `k` = bytecode (`Uint32Array`), `v` = constants pool,
  `x` = global scope object, `t` = register stack (flat array), `g` = current frame pointer,
  `h` = stack high-water mark, `m` = closure-cell cache.
- `d.prototype.E` — the dispatch loop. Each frame reserves **11 header slots**:
  `f+0`=register base, `f+1`=return frame, `f+2`=flags, `f+3`=instruction pointer,
  `f+4`=frame end, `f+5`=function metadata, `f+6`=counter, `f+8`=this value,
  `f+9`=try/catch stack, `f+10`=frame size. Registers live at `f+0 + i`.
  The loop reads `k[ip++]`, indexes `this[opcode]()` — the **handlerTable**.
- `v(a)` — reads the next 32-bit operand word (`k[t[g+3]++]`).
- `A(a)` — **constant decoder** (concealConstants). Reads two operands (pool index + key).
  - key falsy → return pool entry as-is,
  - number → `pool[i] ^ key`,
  - string → base64-decode, then a TEA-style stream cipher:
    `c = key; for each uint16: c = c + 2654435769 | 0; ch = u16 ^ (c ^ c>>>13) & 0xffff`.
- `w` / `u` — closure cells (`u{ t,q,l,z }`) created per captured register.
- `x(a,b,c,e,f,h)` — call-frame setup; `y` — frame teardown/return.
- `g({j,b,p,d})` — function metadata: `p`=entry ip, `b`=register count, `j`=arguments-array
  register, `d`=variadic flag.
- `t` (WeakMap) maps VM-created functions to their metadata so calls re-enter the VM.

The final expression `(new d(E, C, [pool])).E(72, 22, void 0, new g({j:0,b:6,p:0}), ...)`
boots the VM at ip `p=0` with the constants pool.

## 2. Opcode handlers (randomizeOpcodes + shuffleOpcodes)

61 opcodes, mapped to random numeric ids (`B[NNNN]=function(){...}`). Semantics recovered
by reading each handler's operand pattern (how many `v(this)` reads) and body. Families:

- Arithmetic/logic: ADD SUB MUL DIV MOD POW AND OR XOR SHL SHR USHR (3 operands:
  dest, lhs, rhs), unary NEG POS NOT BNOT TYPEOF (2 operands).
- Comparisons: EQ NE STRICT_EQ STRICT_NE LT LE GT GE IN INSTANCEOF.
- Data: LOAD_CONST (decoded via `A`), LOAD_LITERAL (raw int32), LOAD_UNDEF, MOVE,
  LOAD_THIS, LOAD_GLOBAL / STORE_GLOBAL (decoded name via `A`), TYPEOF_GLOBAL.
- Objects: GET_PROP, SET_PROP (Reflect.set), DELETE, MAKE_ARRAY, MAKE_OBJECT,
  DEFINE_GETTER, DEFINE_SETTER.
- Calls: CALL (this, fn, argc, args...), CALL_NULL, NEW (with spread magic `3247410626`),
  MAKE_FUNC (dest, entry, j, nregs, nclosures, d, closure pairs...).
- Control: JUMP (absolute), JUMP_IF_TRUE/FALSE, **JUMP_REG** (computed jump — the
  dispatcher mechanism), RETURN, THROW, TRY/TRY2/POP_TRY (exception regions).
- FORIN_SETUP/FORIN_NEXT (for-in iterator), DEBUGGER.
- **DECRYPT (44681)** — encodeBytecode self-decryption:
  `e = seed^dst; for f in [src,dstEnd): e += 2654435769; k[dst+(f-src)] = k[f]^e^(e>>>13)`.
  (Present in the table but not executed on this sample's paths; the deobfuscator must
  apply it statically in bytecode order if encountered.)

## 3. Control-flow flattening + dispatcher

The defining feature of this sample. Each VM function's control flow is compiled into a
**state machine** routed through a central dispatch trampoline:

- A **state register** (main: `r48`, inner: `r20`) holds the current "state constant".
- A long **switch chain** of basic blocks; each block bumps an accumulator register
  (`r50`/`r22`) by a constant and checks `state === accumulator` — i.e. the chain encodes
  `switch (state)` where case values are the running partial sums
  (22385, 29455, 8492, 55929, 61427, 3056, 64592, 40600, 50116, 24844, 28763, 60817, ...).
- Each check uses an **MBA / opaque-predicate select** to compute the next dispatcher input
  without a visible branch:
  `mask = -(+(!cond))` (or `+(!!cond)` etc.), `next = lit1 + ((lit2 - lit1) & mask)`
  (or `* mask`). cond true → `lit1`, false → `lit2`.
- The block then loads a second constant and **JUMPs to the trampoline**
  (main ip 2517, inner ip 3955):
  `tmp = dispatcher(A, next); ip = tmp[prop]; JUMP_REG ip`.
- The **dispatcher** is a small pure-arithmetic hash function (per-function) that maps
  `(A, state) -> next block ip`, hiding the edge targets:
  - main (entry 3971): `imul(~((rotl7(~B) + 371738263 ^ A) ^ ((... ) >>> 26)), -2010834351)`, returns `[ip]`.
  - inner (entry 4135): rotl19/+, +326775336, `^(>>>27)`, rotl13, `imul(...,954974203)`, `-1292571053`, returns `{e6pfz: ip}` (classObfuscation random property name).
- Case handler bodies each do real work, then update the state register by a constant and
  fall back into the dispatch loop — so the whole function is a flat `while`+`switch` net.
- A loop-header block (main 59, inner 2555) pre-checks one special state value
  (48702 / 45937) before entering the chain.

Because every state transition is a constant update, the original control flow is a
**statically recoverable DAG/loop**. Recovering it = constant-fold each block's select,
emulate the dispatcher hash to resolve `JUMP_REG`, build the case table, then re-link the
real basic blocks.

## 4. What the obfuscated program actually is

A browser-fingerprint / bot-check function installed as a global:

- Top level: `flag = false; window["_k1crlxlk2w8"] = function(){...}` (captures `flag`).
- Main function (entry 36, 151 regs): creates an inner helper, then
  `if (!flag) { flag = true; ...work... } return undefined;` (run-once guard).
  Work: `div = document.createElement("div"); div.style.width = "calc(100px + 20px * 2)";
  document.body.appendChild(div); w = div.offsetWidth;` then builds
  `s = Date.now() + "|" + floor(random()*1e6) + "|" + ((now-10000+r*5)%97) + "|" +
  ((now-w+r)%89) + "|" + ((r+1500)%83)` and calls `console.log(s, inner(s, w+r))`.
- Inner function (entry 2532, 84 regs): an XOR "cipher" over the string —
  `h = n; for (i=0; i<s.length; i++) { h = (h + -1640531527)|0; m = (h ^ h>>>13) & 0xffff;
  out += String.fromCharCode(s.charCodeAt(i) ^ m); } return out;`
  (with its own captured-variable guard on main's fingerprint string register `r9`).

## 5. Deobfuscation approach (implemented in debug/, to be assembled into vm.js)

1. **Extract** bytecode words + constants pool from the AST of `input.js`.
2. **Disassemble** using the operand-count table derived from the 61 handlers
   (variable-length for CALL/NEW/MAKE_FUNC/MAKE_ARRAY/MAKE_OBJECT).
3. **Explore** each function's CFG by abstract interpretation: concrete values fold,
   unknowns stay symbolic; a block's select expression is evaluated with its condition =
   true/false to get both successor states; the dispatcher function is emulated concretely
   (it is pure arithmetic + `Math.imul`) to resolve computed jumps. Fixpoint with widening
   handles loops.
4. **Unflatten**: compute the case table (accumulator partial sums), eliminate the
   header/chain/stub/trampoline machinery, and rebuild the real CFG (sequences, if/else,
   while loops) from state transitions.
5. **Lift** real blocks to Babel AST: registers → variables, decoded strings inline,
   `.apply(this,args)` → `.call(...)`, closures mapped to outer variables; then a
   copy-propagation/method-call cleanup pass.
6. Verified: with `Date.now`/`Math.random` mocked deterministically, original and
   deobfuscated outputs are byte-identical (`1786765158007|424242|92|45|35 ...`), and the
   run-once guard behaves the same on a second call.

Debug artifacts live in `debug/` (extract/disasm/trace/graph/cases/simulate/unflatten/lift/
cleanup/build/harness etc.).
