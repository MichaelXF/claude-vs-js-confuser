var __ITER_DONE = {};
function __forInKeys(o) {
  var k = [];
  for (var p in o) k.push(p);
  return {
    keys: k,
    i: 0
  };
}
function __iterNext(it) {
  return it.i < it.keys.length ? it.keys[it.i++] : __ITER_DONE;
}
(function () {
  var v5, v6, v7;
  v5 = __forInKeys({
    x: "x",
    y: "y"
  });
  v6 = "";
  v7 = __iterNext(v5);
  if (v7 === __ITER_DONE) {
    console.log(v6);
    return v6;
  }
  v6 = v6 + v7;
  while (true) {
    v7 = __iterNext(v5);
    if (v7 === __ITER_DONE) {
      break;
    }
    v6 = v6 + v7;
  }
  console.log(v6);
  return v6;
})();