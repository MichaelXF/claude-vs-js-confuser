// Probe 2: cleanup inside IfStatement branches
const { cleanup } = require('./cleanup');
const generate = require('@babel/generator').default;
const id = n => ({ type: 'Identifier', name: n });
const exprStmt = e => ({ type: 'ExpressionStatement', expression: e });
const assign = (l, r) => ({ type: 'AssignmentExpression', operator: '=', left: l, right: r });
const memC = (o, p) => ({ type: 'MemberExpression', object: o, property: p, computed: true });
const call = (c, a) => ({ type: 'CallExpression', callee: c, arguments: a });
const lit = v => ({ type: 'StringLiteral', value: v });
const blockStmt = body => ({ type: 'BlockStatement', body });

const body = [
  {
    type: 'VariableDeclaration', kind: 'var',
    declarations: ['a11', 'a13', 'at0', 'a2'].map(n => ({ type: 'VariableDeclarator', id: id(n), init: null })),
  },
  {
    type: 'IfStatement',
    test: id('g2'),
    consequent: blockStmt([{ type: 'ReturnStatement', argument: id('undefined') }]),
    alternate: blockStmt([
      exprStmt(assign(id('a11'), id('document'))),
      exprStmt(assign(id('a13'), lit('div'))),
      exprStmt(assign(id('at0'), call(memC(id('a11'), lit('createElement')), [id('a13')]))),
      exprStmt(assign(id('a2'), id('at0'))),
    ]),
  },
];
cleanup(body, 'a');
console.log(generate({ type: 'Program', body }, {}).code);
