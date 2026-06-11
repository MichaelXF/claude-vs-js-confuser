function shuffleArr(shuffleArr, count) {
  for (var i = 0; i < count; i++) shuffleArr.push(shuffleArr.shift());
  return shuffleArr;
}

var lookup = shuffleArr(['b', 'c', 'a'], 2);
var nums   = shuffleArr([3, 1, 2], 1);

console.log(lookup); // expect ['a', 'b', 'c']
console.log(nums);   // expect [1, 2, 3]
console.log("done");
