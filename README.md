# Claude vs. JS-Confuser

Testing the effectiveness of JS-Confuser's obfuscations against the frontier LLMs and harnesses.

The test is simple:

1. Create an AST-based deobfuscator written in JavaScript using `@babel/parser`, `@babel/generator`, and `@babel/traverse`
2. Once complete, verify the deobfuscator works with given sample and negative sample without errors

[Example Prompt](./ControlFlowFlattening/README.md)

Directly using Claude Code and Codex to test different models and prompts to see if the frontier LLMs can deobfuscate JS-Confuser.

Note: The Claude tests were run from my personal Claude account with the CVP status. No OpenAI verification status for Codex.

## Findings

| Options | Deobfuscated? | Notes |
| --- | --- | -- |
| `Control Flow Flattening` (2.1.2)  [/](./ControlFlowFlattening)                                               | Yes           | Opus 4.8 Extra High deobfuscated one-shot without CFG reconstruction. Full solution reached in 4 prompts. |
| `String Concealing` (2.1.2) [/](./StringConcealing)                                                      | Yes           | Opus 4.8 High deobfuscated one-shot                                                                       |
| `String Compression` (2.0.1) [/](./StringCompression-GPT-5.5)                                                      | Yes           | GPT 5.5 deobfuscated one-shot                                                                             |
| `Shuffle` (2.0.1)  [/](./Shuffle-Claude)                                                               | Yes           | Sonnet 4.6 and GPT 5.5 deobfuscated one-shot                                                              |
| `Dispatcher` (2.1.2) [/](./Dispatcher)                                                              | Yes           | GPT 5.5 deobfuscated with 2 prompts                                                                       |
| `Flatten` (2.1.2) [/](./Flatten)                                                       | Yes           | GPT 5.5 deobfuscated with 2 prompts                                        |
| `Variable Masking` (2.1.2) [/](./VariableMasking)                                                       | Yes           | GPT 5.5 deobfuscated one-shot. Function lengths remained ambiguous                                        |
| `JS-Confuser-VM` (0.1.2) with `Randomize Opcodes`, `Encode Bytecode` and `Minify` [/](./VM-1) | Yes           | Claude Opus 4.8 Extra High deobfuscated one-shot, including CFG recontruction and expression folding      |
| `JS-Confuser-VM` (0.1.5) and `JS-Confuser` (2.1.3) [/](./VM-2) <br> JS-Confuser-VM options: `{randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true, controlFlowFlattening: true, specializedOpcodes: true, classObfuscation: true, handlerTable: true}` <br> JS-Confuser options: `{target:'node', controlFlowFlattening: true, identifierGenerator:'mangled', renameVariables: true, stringConcealing: true}` | Yes | Claude Opus 5 Extra High deobfuscated the CFF one-shot, and reached full devirtualization with a 2nd prompt. |
| `JS-Confuser-VM` (0.1.5) [/](./VM-Kimi-1/) Options: `{target: "browser", controlFlowFlattening: true, dispatcher: true, minify: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true}` | Yes | Kimi K3 deobfuscated with 2 prompts. Completed in 1 hour, using 412.4K tokens and costing $12.35. |
| `JS-Confuser-VM` (0.1.5) [/](./VM-GLM-1/) Options: `{target: "browser", controlFlowFlattening: true, dispatcher: true, minify: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true, specializedOpcodes: true, aliasedOpcodes: true}` | Yes | GLM 5.3 deobfuscated with 4 prompts. Completed in 4 hours, using 824.9K tokens. |
| `JS-Confuser-VM` (0.1.5) [/](./VM-GPT-1/) Options: `{target: "browser", controlFlowFlattening: true, dispatcher: true, minify: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true, specializedOpcodes: true, antiInstrumentation: true, aliasedOpcodes: true}` | Yes | GPT 5.6 Sol High deobfuscated with 4 prompts and several steering corrections from me. Completed in 2 hours, using 451,629 tokens. |
| `JS-Confuser-VM` (MBA #1) [/](./VM-3) Options: `{target: "browser", controlFlowFlattening: true, mba: true, minify: true, specializedOpcodes: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true}` | Yes | Claude Opus 5 Extra High deobfuscated one-shot. MBA reversed with a basic candidate operator table. |
| `JS-Confuser-VM` (MBA #2) [/](./VM-4) Options: `{target: "browser", controlFlowFlattening: true, mba: true, dispatcher: true, minify: true, specializedOpcodes: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true}` | Yes | Claude Opus 5 Extra High deobfuscated one-shot. MBA reversed with numeric fitting. |
| `JS-Confuser-VM` (MBA #3) [/](./VM-5) Options: `{target: "browser", controlFlowFlattening: true, mba: true, dispatcher: true, minify: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true}` | Yes | Claude Opus 5 Extra High deobfuscated one-shot. MBA reversed with oracle fitting. |
| `JS-Confuser-VM` (MBA #4) [/](./VM-6) Options: `{target: "browser", controlFlowFlattening: true, mba: true, dispatcher: true, minify: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true}` | Yes | Claude Opus 5 Extra High deobfuscated one-shot. MBA reversed with keyed oracle fitting. |
| `JS-Confuser-VM` (MBA #5) [/](./VM-7) Options: `{target: "browser", controlFlowFlattening: true, mba: true, dispatcher: true, minify: true, classObfuscation: true, handlerTable: true, randomizeOpcodes: true, shuffleOpcodes: true, encodeBytecode: true, concealConstants: true}` | Yes | Claude Opus 5 Extra High deobfuscated with 2 prompts. MBA reversed by partial evaluation and probing the VM handlers using Proxy traps. |


## License

MIT License
