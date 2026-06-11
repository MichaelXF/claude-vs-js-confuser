function normalRotate(items, count) {
  for (var index = 0; index < count; index++) items.push(items.pop());
  return items;
}
const value = normalRotate([1, 2, 3], 1);
console.log(value.join(","));