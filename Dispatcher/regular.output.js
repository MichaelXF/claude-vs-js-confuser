"use strict";

function add(left, right) {
  return left + right;
}

module.exports = {
  add,
  value: add(2, 3),
};
