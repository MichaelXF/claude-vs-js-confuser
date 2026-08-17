# Deobfuscation notes

## VM pattern

The protected file contains a wordcode VM with these distinguishing nodes:

- A Base64 payload converted into a little-endian `Uint32Array`.
- A machine constructor holding the code, constant pool, global object, register stack, and frame pointer.
- Numeric computed assignments on the machine prototype. These are the randomized opcode handlers.
- A dispatch loop that reads a word at the current frame's program counter and invokes the corresponding prototype property.
- A final bootstrap call containing the constant pool and root function metadata.

The transformer matches the complete pattern instead of relying only on a particular Base64 variable name. Files without the pattern are parsed and regenerated unchanged in meaning.

## Frame and closure layout

Each frame has a 15-word header followed by virtual registers. Important header fields are the program counter (`+2`), closure metadata (`+3`), parent frame (`+4`), exception stack (`+6`), frame size (`+8`), register base (`+9`), call result flags (`+11`), `this` (`+12`), and anti-instrumentation counters (`+1` and `+14`).

Captured variables use cell objects. A virtual function records either a new cell pointing at a parent register or an inherited cell from the parent's capture list. Calls and construction detect virtual functions through a `WeakMap` metadata association.

## Operand and CFG recovery

Most handlers have a fixed operand width, found by counting calls to the bytecode reader in their AST. Variable-width function creation, array/object construction, normal calls, method calls, and constructor calls are recognized structurally and decoded from their count operands. This allows the entire 9,471-word stream to be split into 1,440 instructions even though opcodes were randomized for this build.

Each handler is classified from its AST shape rather than its randomized numeric opcode. The lifter translates handler effects into Babel expressions, identifies virtual-function boundaries, records flattened transfers, and builds basic blocks. Dispatcher helper functions, jump stubs, and the selector region are removed. The remaining application blocks are connected directly and reduced to structured `while`/`if`/`return` control flow.

The browser callback is traced for multiple invocations, but tracing is used only to discover application edges. Its body is emitted from the recovered CFG. This exposes the bytecode's captured Boolean cell, the entry branch that tests it, and the assignment that changes it on the first call. Consequently, later calls return `undefined` because of lifted bytecode state; the transformer does not inject a call-once guard.

The generated file contains no interpreter, handler table, bytecode, program counter, frame object, virtual register array, or dispatcher `switch`. Recovered register slots are materialized as ordinary local variables.

## Cleanup

After CFG recovery, the transformer performs generic constant folding, dead-store elimination, dependency-based removal of disconnected calculations, removal of control-flow-flattening sentinels, single-use temporary inlining, scratch-register versioning, adjacent-copy propagation, and conversion of virtual register arrays to local variables. In this sample that reduces the 9,471-word VM plus runtime to about 1.9 KB of ordinary JavaScript. The nested routine and its loop are emitted from the recovered bytecode CFG; there is no decoder-specific source template or API-name-triggered rewrite. Parameters, registers, captured values, and lifted functions retain structural names, and declarations are emitted as `var` to match the VM's variable model.

## Constants

Strings use a keyed UTF-16 decoder over Base64 bytes. The key is instruction-specific, so merely decoding the pool independently is not possible. The transformer isolates the bootstrap in a Node `vm` context, records decoder calls during initialization, and probes cold string-bearing instructions. All 204 string entries are emitted as plaintext. The remaining pool entries are numbers, booleans, or `undefined`.

## Verification

`test.js` checks that:

- the generated file contains decoded browser and DOM names;
- the bytecode array, Base64 decoder, numeric handler table, VM runtime classes, operand reader, register arrays, and dispatch switch are absent;
- the flattened loop sentinel is gone and the source-level string loop exists;
- the reconstructed browser entry point runs to completion with a minimal DOM proxy; and
- an ordinary JavaScript module passes through and retains its behavior.

The test also invokes `debug/compare.js`, which fixes the clock and random-number source, records DOM, console, and entry-return effects, and compares the original with `output.js`. It checks several clock/random seeds and 1, 2, 3, and 5 callback invocations. The complete effect sequences match, including `undefined` returns without repeated DOM or console effects after the first invocation.
