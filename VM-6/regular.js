// regular.js -- an ordinary, non-obfuscated file.  vm.js must pass it through
// unchanged (semantically) and without errors.
'use strict';

var registry = {};

function encode(text, key) {
  var acc = key,
    out = '',
    i = 0;
  while (i < text.length) {
    acc = acc + -1640531527 | 0;
    out += String.fromCharCode(text.charCodeAt(i) ^ (acc ^ acc >>> 13) & 65535);
    i = i + 1;
  }
  return out;
}

function register(name, fn) {
  registry[name] = fn;
  return registry;
}

class Counter {
  constructor(start) {
    this.value = start || 0;
  }
  add(n) {
    this.value += n;
    return this;
  }
  get double() {
    return this.value * 2;
  }
}

function summarize(list) {
  var total = 0;
  for (var i = 0; i < list.length; i++) total += list[i];
  var labels = [];
  for (var k in { a: 1, b: 2 }) labels.push(k);
  try {
    if (total > 1000) throw new Error('too big');
  } catch (e) {
    total = -1;
  } finally {
    labels.push('done');
  }
  return { total: total, labels: labels, avg: list.length ? total / list.length : 0 };
}

register('encode', encode);
register('summarize', summarize);

var counter = new Counter(5).add(3).add(2);
var report = summarize([1, 2, 3, 4, 5]);
var arrow = (x) => x * 2;
var spread = Math.max(...[3, 9, 4]);

console.log(encode('hello world', 12345));
console.log(JSON.stringify(report));
console.log(counter.value, counter.double, arrow(21), spread);
console.log(Object.keys(registry).join(','), typeof missingGlobalThing);
