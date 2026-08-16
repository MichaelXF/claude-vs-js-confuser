# Flatten Notes

## Pattern

The sample has two structural layers. The names are arbitrary; the provided sample happens to use lowercase handler names and uppercase wrapper names, but the transform does not depend on that.

- Handler functions unpack `arguments` as `[context, args]`, then read and write generated context properties such as `a["g"]` or call context methods such as `a["p"]()`.
- Wrapper functions take a rest argument, create the context object with getter/setter/object-method properties, then call a handler with the context object and that same rest argument array.

Example shape:

```js
function Z(...a) {
  var b = {
    get "g"() { return G; },
    set "g"(a) { G = a; },
    "p"(...a) { return ac(...a); }
  };
  return i(b, a);
}
```

## Transform

`flatten.js` matches only this wrapper/handler contract. For each wrapper:

- Clone the target handler body.
- Replace context getter reads with the getter return expression.
- Replace context setter assignment/update targets with the setter target.
- Replace forwarded context method calls with direct function calls.
- Promote the handler's unpacked argument array to the wrapper's function parameters, such as `function ab(..._args) { var [b, c, d] = _args; }` becoming `function ab(b, c, d)`.
- Remove now-unreferenced handlers.

The output also normalizes simple string-key member expressions, such as `process["stdout"]`, to dot access.
