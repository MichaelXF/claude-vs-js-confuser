// regular.js — an ordinary, non-obfuscated program.
// `vm.js` must recognise that there is no JS-Confuser VM here and hand the
// source back untouched.

'use strict';

const GREETING = 'hello';

function fib(n) {
  if (n < 2) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    [a, b] = [b, a + b];
  }
  return b;
}

class Counter {
  #count = 0;
  increment(by = 1) {
    this.#count += by;
    return this;
  }
  get value() {
    return this.#count;
  }
}

const shout = (who) => `${GREETING}, ${who}!`.toUpperCase();

async function readAll(items) {
  const out = [];
  for await (const item of items) out.push(item);
  return out;
}

function* naturals(limit) {
  for (let i = 0; i < limit; i++) yield i;
}

const config = {
  name: 'regular',
  nested: { deep: [1, 2, 3] },
  ['computed' + 'Key']: true,
  method() {
    try {
      return JSON.parse('{"ok":true}');
    } catch (err) {
      return { ok: false, err: err && err.message };
    } finally {
      void 0;
    }
  },
};

const results = {
  fib: fib(20),
  shout: shout('world'),
  counter: new Counter().increment().increment(4).value,
  naturals: [...naturals(5)],
  config: config.method(),
  spread: Math.max(...[3, 9, 4]),
  optional: config?.nested?.deep?.[1] ?? -1,
  regex: /ab+c/gi.test('xxABBBCxx'),
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fib, shout, Counter, naturals, readAll, results };
}
