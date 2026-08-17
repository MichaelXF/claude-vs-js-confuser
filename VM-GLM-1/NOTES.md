# NOTES — JS-Confuser-VM 0.1.5 devirtualization

## Sample identification

- `input.js` = JS-Confuser-VM 0.1.5 output with options: target=browser,
  controlFlowFlattening, dispatcher, minify, classObfuscation, handlerTable,
  randomizeOpcodes, shuffleOpcodes, encodeBytecode, concealConstants,
  specializedOpcodes, aliasedOpcodes.
- 41,901 bytes, 161 VM opcode handlers, 3,729 u32 bytecode words.

## VM architecture (recovered)

Runtime pieces (names from this build; recovered structurally, not by name):

- `q` — VM class. `new q(F, h, n)` with F=constants pool (array literal),
  h=globals object (globalThis + window/document/module/exports),
  n=bytecode (Uint32Array, little-endian from base64 `v()` helper).
- `q.prototype.r` — dispatcher loop:
  `opcode = n[ip++]; this[opcode]()` — handlers are methods NAMED BY NUMBER
  (handlerTable + randomizeOpcodes). Frame slot 9 (`(slot9+1)%len`) and slot 12
  (`slot12^ip`) are decoy/anti-tamper state never read by any handler.
- Frame layout on the stack array `g` (base `m`):
  - `m+1` frame size, `m+2` fn metadata (`u` instance), `m+3` flags
    (retDst<<1 | isConstruct), `m+5` prev frame base, `m+6` IP (index into n),
  - `m+7` arguments, `m+8` `this` (or newTarget-created object for construct),
  - `m+10` register base, `m+11` exception handler stack, `m+14..` registers.
- `u` — fn metadata `{m: paramCount, b: registerCount, v: entryIP, a: hasRest}`,
  `j` = closure cell list.
- `r` — closure cell: stack slot of the DEFINING frame, cached (`l/u`) when the
  defining frame returns (cells freeze at frame exit).
- `x(vm, meta, _, thisArg, args, _, flags)` — push frame; binds params to
  registers; rest param → `args.slice`; `l.m < l.b` → register `l.m` = arguments
  array (arguments object support).
- `q.prototype.e` — operand fetch: `n[g[frame+6]++]`. Handler code calls it with
  random decoy arguments (ignored) — operand ORDER within a handler is what
  matters; several handlers permute operands via `c=[c[i],c[j],c[k]]`.
- `q.prototype.y` — constants decoder: `v=F[b]`; no key → raw; number → `v^key`;
  string → base64 → LE u16 chars, `char ^= (k ^ k>>>13) & 0xffff` with rolling
  `k = key + (i+1)*2654435769`. (concealConstants)
- `q.prototype.z` — frame unwind: freezes closure cells over the frame's slots.
- `q.prototype.t` — allocate closure cell for defining-frame slot.
- Exceptions: dispatcher catch unwinds frames to nearest frame with handler
  stack entries (slot 11): catch = {K: catchIP, B: exReg};
  finally = {I: finallyIP, H: retReg?, L: exReg, G: ?}.

## Handler archetypes (161 handlers classify into these)

generic (operands from bytecode, possibly permuted) + specialized (register
offsets / constants baked into handler code — specializedOpcodes) + aliases
(multiple opcode numbers → same archetype — aliasedOpcodes):

- BINOP: + - * / % & | ^ << >> >>> < <= > >= == != === !== in instanceof pow
- UNOP: - ! ~ + typeof
- MOV, LDI (immediate u32), LDC (const via y), UNDEF
- LOAD_GLOBAL / SET_GLOBAL / TYPEOF_GLOBAL (h[y(...)])
- GETPROP / SETPROP (Reflect.set) / DELPROP
- THIS (R = frame slot 8)
- CLOSURE_GET (w(j[i])) / CLOSURE_SET (j[i] = v)
- MAKE_CLOSURE: ops = dst, entryIP, paramCount, regCount, captureCount,
  restFlag, then per-capture (flag, srcReg); flag=1 → new cell in defining
  frame, flag=0 → rebind parent's cell j[src]. Created JS function re-enters
  `new q(F,h,n).r(this??h, _, meta, args)`.
- CALL: ops = dst, fn, thisArg, argc, argv regs... (argc==36020178 → spread
  from single reg). VM fns detected via WeakMap `e` → push frame with
  flags=dst<<1; native → `fn.apply(thisArg, args)`.
- CALL_INDIRECT (thisArg = undefined → globals h), CONSTRUCT (flags|1, newthis
  = Object.create(meta.prototype||null) for VM fns else Reflect.construct)
- ARR_LIT (count + elems), OBJ_LIT (count + k/v pairs), DEFINE_GETTER/SETTER
  (Object.defineProperty preserving existing accessor)
- FOR_IN_INIT (enum keys iterator {C,D}), FOR_IN_NEXT (dst, iter, exitIP)
- JMP reg / JMP imm / JMP_TRUE (reg,ip) / JMP_FALSE (reg,ip), THROW
- PUSH_CATCH / PUSH_FINALLY / POP_HANDLER
- RETURN (value reg [generic or fixed], flags fixup for construct)
- DECODE (dstOff, start, end, key): in-place `n[dst+i] = (n[start+i] ^
  (k^k>>>13)) >>> 0`, k rolling +=2654435769 starting at key^dstOff
  (encodeBytecode — runtime self-decryption of bytecode regions)
- DEBUGGER

## Program structure (from disassembly of this sample)

- Entry fn (meta m:0 b:6 v:0): loads `window` global into a cell (R2),
  defines closure fn@IP17 (162 regs, CFF state machine in regs 153..161),
  `window._k1crlxlk2w8 = fn`, return undefined. (browser event-handler style
  program; nothing else runs at module scope — that's why running input.js
  under stubs only records one property SET.)
- Inner functions discovered via MAKE_CLOSURE operands (fn@3446 m:2 b:8, ...).

## Decisions / TODO

- Static lifter: symbolic execution per function over bytecode with constant
  propagation; CFF state register (R154 here) resolved by folding XOR/add
  chains of immediates; computed jumps `IP=R(state)` give CFG edges; structured
  output rebuilt (if/else/while) from CFG; closures → nested function decls.
