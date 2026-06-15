# Claude vs. JS-Confuser

Testing the effectiveness of JS-Confuser's obfuscations against the frontier LLMs and harnesses.

The test is simple:

1. Create an AST-based deobfuscator written in JavaScript using `@babel/parser`, `@babel/generator`, and `@babel/traverse`
2. Once complete, verify the deobfuscator works with given sample and negative sample without errors

[Example Prompt](./ControlFlowFlattening/README.md)

Directly using Claude Code and Codex to test different models and prompts to see if the frontier LLMs can deobfuscate JS-Confuser.

Note: The Claude tests were run from my personal Claude account with the CVP status. No OpenAI verification status for Codex.

## Findings

| Option                    | Deobfuscated? | Notes                                                                                                     |
| ------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `Control Flow Flattening` | Yes           | Opus 4.8 Extra High deobfuscated one-shot without CFG reconstruction. Full solution reached in 4 prompts. |
| `String Concealing`       | Yes           | Opus 4.8 High deobfuscated one-shot                                                                       |
| `String Compression`      | Yes           | GPT 5.5 deobfuscated one-shot                                                                             |
| `Shuffle`                 | Yes           | Sonnet 4.6 and GPT 5.5 deobfuscated one-shot                                                              |
| `Dispatcher`              | Yes           | GPT 5.5 deobfuscated with 2 prompts                                                                       |
| `Variable Masking`        | Yes           | GPT 5.5 deobfuscated one-shot. Function lengths remained ambiguous                                        |

## License

MIT License
