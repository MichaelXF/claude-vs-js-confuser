"use strict";
/**
 * Operator recovery for the arithmetic opcodes.
 *
 * Both the plain handlers (`dest = a + b`) and the MBA-rewritten ones
 * (`dest = ~~(((a ^ b) + 2 * (a & b) | 0) + ...)`) are identified the same way:
 * the handler is executed on chosen inputs and the observed results are matched
 * against every candidate JavaScript operator. MBA handlers additionally carry
 * junk operands and per-function key material, so they are fitted at a concrete
 * instruction site with the operands the analyzer already knows pinned to their
 * real values.
 */

const BINARY = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "**": (a, b) => a ** b,
  "&": (a, b) => a & b,
  "|": (a, b) => a | b,
  "^": (a, b) => a ^ b,
  "<<": (a, b) => a << b,
  ">>": (a, b) => a >> b,
  ">>>": (a, b) => a >>> b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "==": (a, b) => a == b,
  "!=": (a, b) => a != b,
};
const UNARY = {
  "!": (a) => !a,
  "~": (a) => ~a,
  "-": (a) => -a,
  "+": (a) => +a,
  typeof: (a) => typeof a,
  void: () => undefined,
  "": (a) => a, // plain move
};
// preferred reading when several operators fit the observations
const RANK = ["", "!", "~", "-", "+", "typeof", "void",
  "+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>",
  "<", "<=", ">", ">=", "===", "!==", "==", "!="];

function intPool() {
  return [0, 1, -1, 2, 3, 5, 7, 8, 9, 16, 31, 32, 255, -256, 1023, 65535, -65536,
    2147483647, -2147483648, 123456789, -987654321,
    (Math.random() * 2 ** 32) | 0, (Math.random() * 2 ** 32) | 0, (Math.random() * 2 ** 32) | 0,
    (Math.random() * 200 - 100) | 0, (Math.random() * 200 - 100) | 0];
}
function mixedPool() {
  return [0, 1, -1, 2, "", "0", "1", "abc", true, false, null, undefined, NaN, 1.5, -0.25, [], {}, "5"];
}

/**
 * Fits the operator implemented by the instruction at `pc`.
 *
 * @param machine  the probed VM
 * @param code     bytecode array
 * @param pc       instruction address
 * @param key      enclosing function's key
 * @param srcRegs  register operands, in the order the handler reads them
 * @param fixed    Map reg -> concrete value for operands whose value is known
 */
function fitInstruction(machine, code, pc, key, srcRegs, fixed) {
  const NREG = machine.constructor.NREG || 256;
  const uniq = [...new Set(srcRegs)];
  const free = uniq.filter((r) => !fixed || !fixed.has(r));
  if (!free.length) return { kind: "const" };

  const observe = (assignments) => {
    const regs = new Array(256).fill(0);
    if (fixed) for (const [r, v] of fixed) if (typeof v !== "symbol") regs[r] = v;
    for (const [r, v] of Object.entries(assignments)) regs[r] = v;
    const res = machine.runAt(code, pc, key, regs, {});
    if (res.error || !res.regWrites.length) return { failed: true };
    return { value: res.regWrites[res.regWrites.length - 1][1] };
  };

  const gather = (pool, extraPairs) => {
    const trials = [];
    for (let i = 0; i < pool.length * 3; i++) {
      const assignments = {};
      for (const r of free) assignments[r] = pool[(Math.random() * pool.length) | 0];
      if (i % 4 === 0 && free.length > 1) {
        const v = pool[(Math.random() * pool.length) | 0];
        for (const r of free) assignments[r] = v; // equal operands
      }
      const out = observe(assignments);
      if (out.failed) return null;
      const inputs = {};
      for (const r of uniq) inputs[r] = r in assignments ? assignments[r] : fixed.get(r);
      trials.push({ inputs, out: out.value });
    }
    if (extraPairs) {
      for (const [x, y] of extraPairs) {
        if (free.length < 1) break;
        const assignments = {};
        free.forEach((r, i) => { assignments[r] = i === 0 ? x : y; });
        const out = observe(assignments);
        if (out.failed) return null;
        const inputs = {};
        for (const r of uniq) inputs[r] = r in assignments ? assignments[r] : fixed.get(r);
        trials.push({ inputs, out: out.value });
      }
    }
    return trials;
  };

  const candidatesFrom = (trials, truncate) => {
    const found = [];
    const norm = truncate ? (v) => (typeof v === "number" ? v | 0 : v) : (v) => v;
    for (const a of uniq) {
      for (const [name, fn] of Object.entries(UNARY)) {
        if (trials.every((t) => Object.is(norm(fn(t.inputs[a])), t.out))) found.push({ kind: "unary", op: name, a, int32: !!truncate });
      }
    }
    for (const a of uniq) {
      for (const b of uniq) {
        if (a === b) continue;
        for (const [name, fn] of Object.entries(BINARY)) {
          if (trials.every((t) => Object.is(norm(fn(t.inputs[a], t.inputs[b])), t.out))) found.push({ kind: "binary", op: name, a, b, int32: !!truncate });
        }
      }
    }
    return found;
  };

  const first = srcRegs[0];
  const pick = (list) => {
    if (!list.length) return null;
    const score = (c) => RANK.indexOf(c.op) + (c.kind === "unary" ? 0 : 100) + (c.int32 ? 1000 : 0) +
      (c.a === first ? 0 : 30); // keep the operand order the handler reads them in
    list.sort((x, y) => score(x) - score(y));
    return list[0];
  };

  // exact behavior over mixed types identifies the plain handlers
  const mixed = gather(mixedPool(), [[0, false], ["0", 0], [1, true], [null, undefined], ["abc", "abc"]]);
  if (mixed) {
    const exact = candidatesFrom(mixed, false);
    if (exact.length) return { ...pick(exact), all: exact.map((c) => c.op) };
  }
  // otherwise the handler is an int32-domain MBA implementation
  const ints = gather(intPool());
  if (!ints) return { kind: "unknown" };
  const exact = candidatesFrom(ints, false);
  if (exact.length) return { ...pick(exact), all: exact.map((c) => c.op) };
  const trunc = candidatesFrom(ints, true);
  if (trunc.length) return { ...pick(trunc), all: trunc.map((c) => c.op) };
  return { kind: "unknown" };
}

module.exports = { fitInstruction, BINARY, UNARY };
