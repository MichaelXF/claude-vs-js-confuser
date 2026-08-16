// Deterministic harness: mock Date.now + Math.random, capture logs during calls.
const path = process.argv[2];

const logs = [];
globalThis.window = globalThis;
globalThis.document = {
  createElement: function (tag) {
    return { style: {}, offsetWidth: 140, tagName: tag };
  },
  body: { appendChild: function (x) { return x; } },
};
// deterministic mocks
let nowVal = 1786765158000;
Date.now = () => (nowVal += 7);
let randVal = 0.424242;
Math.random = () => randVal;
console.log = (...args) => { logs.push(args.map(String).join(' ')); };

require(require('path').resolve(process.cwd(), path));

try { window._k1crlxlk2w8(); } catch (e) { process.stdout.write('CALL1 ERROR: ' + e.message + '\n'); }
try { window._k1crlxlk2w8(); } catch (e) { process.stdout.write('CALL2 ERROR: ' + e.message + '\n'); }
process.stdout.write('LOGS:\n' + logs.join('\n') + '\n');
