Claude Opus 4.8 Reasoning: Extra High

Research Purpose:
I am the author of JS-Confuser researching obfuscation techniques effectiveness against LLM-assisted deobfuscation. The own samples are derived from the open source project 'JS-Confuser'

Prompt:
Hello Claude, please read @controlFlowFlattening/input.js and create controlFlowFlattening.js using Babel/Generator and Babel/Traverse and Babel/Parser and I want an AST deobfuscator solution for this particular technique

1. Find the AST pattern to match on
2. Transform the AST to completely undo the obfuscation
3. Run javascript and verify output works, with other programs also should correctly pass through as well. Make test files and debug files as needed. Don't delete these files.

You are not allowed to read other files.
Only controlFlowFlattening.js and your OWN work please.

Deobfuscation using Babel's API and AST. Babel Scope and Bindings may be used. Javascript solution

Expected output:
$ controlFlowFlattening.js input.js output.js

controlFlowFlattening.js reads 'input.js' and writes to 'output.js' with the 'deobfuscated' version

Expected test:
$ test.js
// var output = require('controlFlowFlattening.js')('input.js') // -> Expected output has decoded strings
// var regularOutput = = require('controlFlowFlattening.js')('regular.js') // -> A 'regular' non-obfuscated file should pass through fine without errors
