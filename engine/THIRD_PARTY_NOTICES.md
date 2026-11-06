# Third-party notices

## xterm.js

`media/terminal/xterm.min.js` and `media/terminal/xterm.css` are from
`@xterm/xterm` 5.5.0 (MIT). The complete license is included in
`media/terminal/LICENSE.xterm`. Source: https://github.com/xtermjs/xterm.js/tree/5.5.0.
The browser renderer is vendored; no Node package is loaded by a page or required at runtime.

zer0ne coding includes or adapts the following third-party material.

## Open Claude UI — MIT License

The chat surface, motion, scroll-fade and interaction refinements in
`media/base.css`, `media/chat.css`, `media/chat.js` and `media/project-panel.js`
adapt patterns from https://github.com/Caho1/open-claude-ui to the existing
JavaScript UI and engine events.

MIT License

Copyright (c) 2026 Caho1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenAI Codex — Apache License 2.0

`src/tools/sandbox.ts` contains a macOS Seatbelt profile adapted from
`codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` and
`seatbelt_network_policy.sbpl` in https://github.com/openai/codex.

Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0). Changes: condensed, file reads
allowed globally, writes limited to the workspace and temp folders via
parameters.

## codex-router — MIT License

The local-model fit check in `src/localModels.ts` (weights + 20% overhead
against GPU / RAM budgets, registry template inspection for tool support) and
the notes on which small models handle agent prompts follow
https://github.com/duolahypercho/codex-router.

```text
MIT License

Copyright (c) 2026 codex-router contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Mermaid — MIT License

`media/mermaid.min.js` is Mermaid (https://github.com/mermaid-js/mermaid),
Copyright (c) 2014–2024 Knut Sveidqvist and contributors, MIT License.

## Pi — MIT License

The account sign-in flows in `src/accounts.ts` (ChatGPT browser and device
sign-in, xAI and Kimi device codes, token refresh) and the Responses-API
request shape in `src/codexClient.ts` follow `@earendil-works/pi-ai`
(https://github.com/earendil-works/pi), Copyright (c) Mario Zechner,
MIT License. The idle cache warmer's savings gate follows the same project.

```text
MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## oh-my-pi — MIT License

The Claude Code / Codex session import (`src/foreignSessions.ts`) follows
https://github.com/can1357/oh-my-pi (Copyright (c) 2025 Mario Zechner, 2025-2026
Can Bölük, 2026 Stencil Labs, Inc., MIT License — the same permission notice as
Pi above).

## Agent Client Protocol registry — Apache License 2.0

Providers & models reads the agent registry of
https://github.com/agentclientprotocol/registry (fetched at run time from
cdn.agentclientprotocol.com; a validated copy of 2026-09-29 is bundled in
`src/acp/registrySnapshot.ts`) to list the coding agents whose vendors let
their plans sign in through their own software. The protocol is
https://agentclientprotocol.com.

## t3code — MIT License

The approach of running the vendors' own CLIs and agents for subscription
sign-in (Claude, Codex, Antigravity, Cursor, OpenCode, Grok…) instead of
handling their OAuth tokens follows https://github.com/pingdotgg/t3code
(`apps/server/src/provider`); no code was copied.

## js-yaml — MIT License

The engine bundles js-yaml 4.3.2 (MIT License) for Markdown frontmatter. Its full
license ships in `out/vendor/js-yaml.LICENSE`. Source: https://github.com/nodeca/js-yaml.

## llmfit — MIT License

The engine includes the llmfit v1.1.17 Windows executable and a filtered snapshot
of its Hugging Face model database, and runs its JSON recommendation interface.
Other supported platforms download the same pinned release with SHA-256
verification. Source: https://github.com/AlexsJones/llmfit/tree/v1.1.17.
The full license (Copyright (c) 2026 Alex Jones) ships in
`out/vendor/llmfit.LICENSE` and beside the bundled executable.

## llama.cpp — MIT License

The engine bundles architecture names extracted from llama.cpp b11169 and reads
the matching release's architecture table when another engine build is installed.
Source: https://github.com/ggml-org/llama.cpp/tree/b11169.
The full license ships in `out/vendor/llama.LICENSE`.

## MetalForge Filament

`media/filament.js` is not part of this repository and is not covered by its
MIT License. Where a build includes the file, it contains the Filament shader,
simulation configuration and fluid/particle preview engine from
[MetalForge](https://metalforge.xyz/editor), bundled locally with no requests to
MetalForge at runtime. Without the file, the welcome screen has no animation.

