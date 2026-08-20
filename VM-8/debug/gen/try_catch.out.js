(function () {
  try {
    throw "boom";
  } catch (__exc) {
    console.log("caught:" + __exc);
    return "done";
  }
})();