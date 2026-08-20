(function () {
  var v0, v2;
  v0 = console;
  try {
    v2 = "A";
  } catch (__exc) {
    v0.log("B");
    return "B";
  }
  v0.log(v2);
  return v2;
})();