const assert = require("assert");
const vm = require("vm");
const { deobfuscateShuffle } = require("./Shuffle-GPT-5.5");

function captureLogs(code) {
  const logs = [];
  const context = {
    console: {
      log: (...args) =>
        logs.push(
          args
            .map((arg) =>
              Array.isArray(arg) ? JSON.stringify(arg) : String(arg),
            )
            .join(" "),
        ),
    },
  };

  vm.runInNewContext(code, context);
  return logs;
}

const shuffleInput = `
function U2GrCS(U2GrCS, W9E8Prf) {
  for (var yUuP4y = 0; yUuP4y < W9E8Prf; yUuP4y++) U2GrCS.push(U2GrCS.shift());
  return U2GrCS;
}
console.log(U2GrCS([8, 9, 10, 1, 2, 3, 4, 5, 6, 7], 13));
`;

const passThroughInput = `
function normalRotate(items, count) {
  for (var index = 0; index < count; index++) items.push(items.pop());
  return items;
}

const value = normalRotate([1, 2, 3], 1);
console.log(value.join(","));
`;

const transformedShuffle = deobfuscateShuffle(shuffleInput);
console.log(transformedShuffle);
assert(!transformedShuffle.includes("function U2GrCS"));
assert(
  transformedShuffle.includes("console.log([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])"),
);
assert.deepStrictEqual(
  captureLogs(transformedShuffle),
  captureLogs(shuffleInput),
);

const transformedPassThrough = deobfuscateShuffle(passThroughInput);
assert(transformedPassThrough.includes("function normalRotate"));
assert.deepStrictEqual(
  captureLogs(transformedPassThrough),
  captureLogs(passThroughInput),
);

console.log("Shuffle deobfuscator tests passed");
