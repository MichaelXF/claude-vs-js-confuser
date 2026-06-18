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
| `Variable Masking` (2.1.2) [/](./VariableMasking)                                                       | Yes           | GPT 5.5 deobfuscated one-shot. Function lengths remained ambiguous                                        |
| `JS-Confuser-VM` (0.1.2) with `Randomize Opcodes`, `Encode Bytecode` and `Minify` [/](./VM-1) | Yes           | Claude Opus 4.8 Extra High deobfuscated one-shot, including CFG recontruction and expression folding      |

## License

MIT License
