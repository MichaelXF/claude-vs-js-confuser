// Calls the VM's dispatcher functions directly to resolve computed jump targets.
const path = require("path");
const { load } = require("./harness");
const { funcKey } = require("./disasm");

const { exports: ex, entryCall } = load(path.join(__dirname, "..", "input.js"));
const { g, r, A } = ex;
const base = entryCall[0];
const code = base.i;

function makeFn(desc) {
  return new r(desc);
}
function callFn(desc, args) {
  const vm = new g(code, base.k, base.b);
  return A(vm, makeFn(desc), undefined, args, 0);
}

const topKey = entryCall[1].C.x | 0;
const key37 = funcKey([5, 37, 0, 72, 1, 0, 2899460229, 1, 2], topKey);
const key2830 = funcKey([60, 2830, 3, 16, 0, 0, 1619337940], key37);
const key1758 = funcKey([66, 1758, 2, 48, 1, 0, 618912150, 1, 9], key37);
const key2980 = funcKey([32, 2980, 3, 16, 0, 0, 29999522], key1758);
console.log("keys", { topKey, key37, key2830, key1758, key2980 });

const d2830 = { d: 3, Q: 16, m: 2830, F: 0, x: key2830 };
const d2980 = { d: 3, Q: 16, m: 2980, F: 0, x: key2980 };

console.log("dispatch2830(500481719, 50508, 45714) =", callFn(d2830, [500481719, 50508, 45714]));
console.log("dispatch2830(3918839479, 50508, 45714) =", callFn(d2830, [3918839479, 50508, 45714]));
console.log("dispatch2830(3419634779, 9624, 15314) =", callFn(d2830, [3419634779, 9624, 15314]));
console.log("dispatch2830(1349742855, 5052, 59503) =", callFn(d2830, [1349742855, 5052, 59503]));
