# Distilly prompt sources

Upstream: https://github.com/titanwings/distilly
Pinned commit: 0afc45c29c360ba7bc8260f1bb0bf34e9155f4fa (dot-skill branch)

Vendored unchanged, under the included MIT license:

- persona-analyzer.md: https://github.com/titanwings/distilly/blob/0afc45c29c360ba7bc8260f1bb0bf34e9155f4fa/prompts/celebrity/persona_analyzer.md
- correction-handler.md: https://github.com/titanwings/distilly/blob/0afc45c29c360ba7bc8260f1bb0bf34e9155f4fa/prompts/shared/correction_handler.md
- LICENSE: https://github.com/titanwings/distilly/blob/0afc45c29c360ba7bc8260f1bb0bf34e9155f4fa/LICENSE

DanceMonkey's electron/persona-prompts.js adapts the analyzer's expression
fingerprint, recurring mental models, decision heuristics, evidence anchors,
contradictions and uncertainty rules into five structured card fields. It
adapts the correction handler's scene/wrong/correct distinction and separation
of work and expression corrections. Runtime uses these adapted prompts;
the upstream files are attribution and review material, never executed as
an agent skill.

The integration does not install Distilly, execute remote code, collect
external accounts, train model weights or claim to reproduce a real person.
Only source materials explicitly imported into a persona are analyzed.

