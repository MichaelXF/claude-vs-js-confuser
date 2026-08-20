(function () {
  var v2, v4, v6, v7, v9;
  v2 = Error;
  v4 = new v2("nope");
  v6 = v4.message;
  v7 = ["nope", v6];
  v9 = v7.length;
  v7.a = v6;
  console.log(v6, v9, typeof v4, v4 instanceof v2, "length" in v7, delete v7.a);
  return v9;
})();