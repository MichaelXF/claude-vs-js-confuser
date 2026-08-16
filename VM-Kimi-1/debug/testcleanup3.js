// Probe 3: trace cleanup pass behavior
const C = require('./cleanup');
const generate = require('@babel/generator').default;
const id = n => ({ type: 'Identifier', name: n });
const exprStmt = e => ({ type: 'ExpressionStatement', expression: e });
const assign = (l, r) => ({ type: 'AssignmentExpression', operator: '=', left: l, right: r });
const memC = (o, p) => ({ type: 'MemberExpression', object: o, property: p, computed: true });
const call = (c, a) => ({ type: 'CallExpression', callee: c, arguments: a });
const lit = v => ({ type: 'StringLiteral', value: v });
const blockStmt = body => ({ type: 'BlockStatement', body });

const mkBody = () => [
  {
    type: 'IfStatement',
    test: id('g2'),
    consequent: blockStmt([{ type: 'ReturnStatement', argument: id('undefined') }]),
    alternate: blockStmt([
      exprStmt(assign(id('a13'), lit('div'))),
      exprStmt(assign(id('at0'), call(memC(id('document'), lit('createElement')), [id('a13')]))),
      exprStmt(assign(id('a2'), id('at0'))),
    ]),
  },
];

// manual instrumentation of a single pass on the else-branch
const body = mkBody();
const elseBody = body[0].alternate.body;
console.log('reads a13 in rest:', C.__test__ ? 'n/a' : 'need internals');
// re-implement the check inline using exported helpers? cleanup only exports cleanup/isPure/hasCall.
// Use cleanup with a logging wrapper:
const origCleanup = C.cleanup;
let passes = 0;
// monkey-patch not possible for internals; instead call cleanup and inspect after each manual step.
origCleanup(body, 'a');
console.log(generate({ type: 'Program', body }, {}).code);
