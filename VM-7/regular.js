// An ordinary, non-obfuscated file. `vm.js` must pass it through untouched.
"use strict";

var DEFAULTS = { retries: 3, delay: 250, label: "task" };

function extend(target, source) {
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
  }
  return target;
}

function Scheduler(options) {
  this.options = extend(extend({}, DEFAULTS), options || {});
  this.queue = [];
  this.done = [];
}

Scheduler.prototype.push = function (name, fn) {
  if (typeof fn !== "function") throw new TypeError(name + " is not a function");
  this.queue.push({ name: name, fn: fn, attempts: 0 });
  return this;
};

Scheduler.prototype.run = function () {
  var results = [];
  while (this.queue.length) {
    var job = this.queue.shift();
    for (;;) {
      job.attempts++;
      try {
        results.push({ name: job.name, value: job.fn(), attempts: job.attempts });
        break;
      } catch (err) {
        if (job.attempts >= this.options.retries) {
          results.push({ name: job.name, error: String(err.message), attempts: job.attempts });
          break;
        }
      }
    }
    this.done.push(job.name);
  }
  return results;
};

function summarize(results) {
  var ok = results.filter(function (r) { return !r.error; });
  return ok.length + "/" + results.length + " succeeded (" + ok.map(function (r) { return r.name; }).join(", ") + ")";
}

var scheduler = new Scheduler({ retries: 2, label: "demo" });
var flaky = 0;

scheduler
  .push("always", function () { return 1 + 1; })
  .push("flaky", function () { if (flaky++ < 1) throw new Error("not yet"); return "ok"; })
  .push("never", function () { throw new Error("broken"); });

var report = summarize(scheduler.run());
if (typeof module !== "undefined" && module.exports) module.exports = { Scheduler: Scheduler, report: report };
