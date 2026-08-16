// Probe: why doesn't cleanup inline single-read pure assignments?
const { cleanup } = require('./cleanup');
const generate = require('@babel/generator').default;
const id = n => ({ type: 'Identifier', name: n });
const exprStmt = e => ({ type: 'ExpressionStatement', expression: e });
const assign = (l, r) => ({ type: 'AssignmentExpression', operator: '=', left: l, right: r });
const memC = (o, p) => ({ type: 'MemberExpression', object: o, property: p, computed: true });
const call = (c, a) => ({ type: 'CallExpression', callee: c, arguments: a });
const lit = v => ({ type: 'StringLiteral', value: v });

// a11 = document; at0 = a11["createElement"](a13);
const body = [
  exprStmt(assign(id('a11'), id('document'))),
  exprStmt(assign(id('at0'), call(memC(id('a11'), lit('createElement')), [id('a13')]))),
];
cleanup(body, 'a');
console.log(generate({ type: 'Program', body }, {}).code);
