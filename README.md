<div align="center">

# Odradek
<img src="images/odradek.jpg" alt="Odradek Logo" width="75%"/>

[![License](https://img.shields.io/github/license/chaobo8484/odradek-cli)](https://github.com/chaobo8484/odradek-cli/blob/main/LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
[![X](https://img.shields.io/badge/X-Follow-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/Xiayin8484)

**English** | [简体中文](README.zh-CN.md)

</div>

## Overview

Odradek is a CLI tool for **diagnosing and enhancing Claude Code, Codex, and similar AI coding Agents**. It enables you to:

- Chat with LLMs directly in the terminal while running diagnostics
- Parse agent session logs to understand token structures and context pressure
- Perform multi-dimensional noise evaluation to identify potential issues
- Scan and inventory prompt assets, rules, and Skill documentation
- Seamlessly switch between multiple providers (Claude / OpenRouter / Qwen)

<img src="images/homepage.png" alt="Odradek Homepage">

## Core Features

| Feature | Description |
|---------|-------------|
| **Multi-Provider Support** | Switch between Claude, OpenRouter, and Qwen seamlessly with `/provider` and `/model` |
| **Layered System Prompts** | Multi-tier prompt configuration from app-level to workspace-level, covering base / provider / model layers |
| **Evidence-first Noise Evaluation** | Four-dimensional noise analysis (outcome, process, context, validation) with confidence scores per signal |
| **Token Structure Parsing** | Parse JSONL session logs with structured data on token field aggregates, role breakdowns, and tool-call distributions |
| **Context Health Detection** | Monitor context window utilization and provide truncation warnings |
| **Todo Granularity Analysis** | Analyze todo granularity scores, state transitions, and context usage to detect under/over-granular decomposition |
| **Prompt Asset Scanning** | Auto-scan prompt files, rules, agent configs, and system-prompt assets in workspaces |
| **Skill Documentation Inventory** | Scan `SKILL.md` and supporting resources (agents/scripts/references) with instruction token estimates |
| **Project Context Injection** | Intelligently index workspace files and dynamically inject relevant context based on LLM queries |
| **JSON Diagnostic Export** | Export diagnostic data (noise_eval / context_health / scan_tokens) to JSON for secondary analysis |

## Preview

<div align="center">
<table>
<tr>
<td><img src="images/chat.png" alt="Chat view" width="100%"/></td>
<td><img src="images/chatwithllm.png" alt="LLM chat view" width="100%"/></td>
</tr>
<tr>
<td><img src="images/noiseeval.png" alt="Noise evaluation view" width="100%"/></td>
<td><img src="images/noiseeval1.png" alt="Noise evaluation details" width="100%"/></td>
</tr>
</table>
</div>

## Feature Areas

| Area | What it covers | Key commands |
| --- | --- | --- |
| **Runtime Control** | Active provider, model overrides, trust state, project-context toggle | `/state`, `/provider`, `/model`, `/trustpath`, `/trustcheck`, `/projectcontext` |
| **Prompt and Rule Inspection** | Prompt assets, workspace rules, `SKILL.md` inventory | `/scan_prompt`, `/rules`, `/skills` |
| **Session Diagnostics** | Token structure, context health, Evidence-first noise evaluation, todo granularity | `/scan_tokens`, `/context_health`, `/noise_eval`, `/todo_granularity` |
| **Conversation Utilities** | History, collapse/expand, clear, export | `/history`, `/collapse`, `/expand`, `/clear`, `/export` |

## Requirements

- Node.js `>= 20`
- npm `>= 9`

## Install

Install globally:

```bash
npm install -g odradek-cli
odradek
```

Or run it once:

```bash
npx odradek-cli@latest
```

## Quick Start

1. Configure environment variables or a `.env` file for your provider
2. Start the CLI with `odradek`
3. Trust the current workspace when prompted
4. Run diagnostic commands

```text
/state                    # Check runtime status
/provider                 # Confirm current provider
/scan_tokens codex current  # Parse session token structure
/noise_eval codex current   # Run Evidence-first noise evaluation
```

Swap `codex` for `claude` to analyze Claude logs instead.

## Configuration

Odradek loads configuration from:

1. shell environment variables
2. app-level `.env` / `.env.local`
3. workspace `.env` / `.env.local` files from repo root down to the current directory
4. local config file defaults

Existing shell env vars win. Among `.env` files, the closer workspace file overrides broader defaults.

Recommended app-level `.env` path:

```text
Windows: %APPDATA%/odradek-cli/.env
macOS:   ~/Library/Application Support/odradek-cli/.env
Linux:   ~/.config/odradek-cli/.env
```

Local config file path:

```text
Windows: %APPDATA%/odradek-cli/config.json
macOS:   ~/Library/Application Support/odradek-cli/config.json
Linux:   ~/.config/odradek-cli/config.json
```

### Runtime Provider Examples

Claude:

```env
ODRADEK_ACTIVE_PROVIDER=claude
ODRADEK_CLAUDE_API_KEY=your_claude_api_key
ODRADEK_CLAUDE_BASE_URL=https://api.anthropic.com/v1
# ODRADEK_CLAUDE_MODEL=claude-sonnet-4-20250514
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

OpenRouter:

```env
ODRADEK_ACTIVE_PROVIDER=openrouter
ODRADEK_OPENROUTER_API_KEY=your_openrouter_api_key
ODRADEK_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
ODRADEK_OPENROUTER_MODEL=provider/model-name
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

Qwen:

```env
ODRADEK_ACTIVE_PROVIDER=qwen
ODRADEK_QWEN_API_KEY=your_dashscope_api_key
ODRADEK_QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ODRADEK_QWEN_MODEL=qwen3.5-plus
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `ODRADEK_ACTIVE_PROVIDER` | Active runtime provider: `claude`, `openrouter`, or `qwen` |
| `ODRADEK_CLAUDE_API_KEY` | Claude API key |
| `ODRADEK_CLAUDE_BASE_URL` | Claude-compatible base URL |
| `ODRADEK_CLAUDE_MODEL` | Default Claude model |
| `ODRADEK_OPENROUTER_API_KEY` | OpenRouter API key |
| `ODRADEK_OPENROUTER_BASE_URL` | OpenRouter base URL |
| `ODRADEK_OPENROUTER_MODEL` | Default OpenRouter model |
| `ODRADEK_QWEN_API_KEY` | DashScope API key |
| `ODRADEK_QWEN_BASE_URL` | Qwen compatible-mode base URL |
| `ODRADEK_QWEN_MODEL` | Default Qwen model |
| `ODRADEK_PROJECT_CONTEXT_ENABLED` | Enable or disable automatic project-context injection |
| `ANTHROPIC_API_KEY` | Fallback Claude API key name |
| `ANTHROPIC_BASE_URL` | Fallback Claude base URL name |
| `OPENROUTER_API_KEY` | Fallback OpenRouter API key name |
| `DASHSCOPE_API_KEY` | Fallback Qwen API key name |

## Layered System Prompts

Odradek can assemble layered system prompts before each model request.

Workspace prompt paths:

```text
.odradek/system-prompts/base.md
.odradek/system-prompts/providers/<provider>.md
.odradek/system-prompts/models/<model>.md
```

App-level prompt path:

```text
%APPDATA%/odradek-cli/system-prompts/
```

Load order:

1. app-level `base.md`
2. app-level `providers/<provider>.md`
3. app-level `models/<model>.md`
4. workspace `.odradek/system-prompts/base.md`
5. workspace `.odradek/system-prompts/providers/<provider>.md`
6. workspace `.odradek/system-prompts/models/<model>.md`

## Commands

### Runtime and workspace

| Command | Description |
| --- | --- |
| `/help` | Show all available commands |
| `/state` | Show runtime, workspace, config, and trust status |
| `/provider [claude\|openrouter\|qwen]` | Switch the active runtime provider |
| `/model [model-name\|clear]` | Set or clear the session model override |
| `/projectcontext [on\|off\|status]` | Control project-context injection |
| `/trustpath` | Trust the current working directory |
| `/trustcheck` | Check whether the current directory is trusted |

### Prompt and workspace inspection

| Command | Description |
| --- | --- |
| `/scan_prompt` | Scan prompt, rules, agent, and system-prompt assets in the workspace |
| `/rules [path]` | Extract explicit rule and instruction lines from a workspace |
| `/skills [path]` | Scan local `SKILL.md` files and supporting resources |

### Claude and Codex diagnostics

These commands support the source prefix `claude` or `codex`:

| Command | Description |
| --- | --- |
| `/scan_tokens [claude\|codex] [current\|all\|path]` | Parse session JSONL token structures |
| `/context_health [claude\|codex] [current\|all\|path]` | Inspect context-window health |
| `/noise_eval [claude\|codex] [current\|all\|path]` | Run evidence-first noise evaluation |
| `/context_noise [claude\|codex] [current\|all\|path]` | Alias for `/noise_eval` |
| `/todo_granularity [claude\|codex] [current\|all\|path]` | Analyze todo granularity against session context usage |

Useful examples:

```text
/scan_tokens codex current
/context_health codex all
/noise_eval claude current
/todo_granularity codex current
```

### Conversation and export

| Command | Description |
| --- | --- |
| `/history` | Show all conversation messages |
| `/collapse [id\|all]` | Collapse messages |
| `/expand [id\|all]` | Expand messages |
| `/clear` | Clear conversation history |
| `/analyze` | Show a simple conversation count summary |
| `/export [claude\|codex] [state\|noise_eval\|context_health\|scan_tokens\|rules\|skills\|scan_prompt\|todo_granularity\|all]` | Export diagnostic datasets to JSON |
| `/exit` or `/quit` | Exit the CLI |

Exports are written to:

```text
.odradek/exports/
```

Example:

```text
/export codex all
/export claude noise_eval
```

## Development

```bash
npm install
```

Copy the env template:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Run the dev CLI:

```bash
npm run dev
```

Build and run the compiled version:

```bash
npm run build
npm start
```

Optional local link:

```bash
npm link
odradek
```

Undo the global link:

```bash
npm unlink -g odradek-cli
```

Core scripts:

```bash
npm run dev
npm run build
npm start
```

## Project Layout

```text
src/
|- cli/                    # CLI core: command registry, handlers, session management
|   |- ink/                # Ink terminal UI components
|   |- ClaudeTranscriptParser.ts   # Claude/Codex session parser
|   |- NoiseEvaluator.ts            # Evidence-first noise evaluation engine
|   |- ContextNoiseAnalyzer.ts      # Context noise analysis
|   |- PromptAssetScanner.ts       # Prompt asset scanner
|   |- RuleScanner.ts              # Rule extractor
|   |- SkillScanner.ts             # SKILL.md inventory
|   |- TodoGranularityAnalyzer.ts   # Todo granularity analysis
|   |- ConversationManager.ts       # Conversation history management
|   |- ConfigStore.ts              # Configuration storage
|   `- tokenEstimate.ts            # Token estimation
|- config/                  # Config loading, Provider catalog
|- llm/                     # LLM adapter layer: multi-provider support
|   |- adapters/             # Claude / OpenRouter / Qwen adapters
|   |- LLMClient.ts         # LLM client
|   |- ProjectContextBuilder.ts    # Project context injection
|   `- PersistentProjectIndex.ts   # Persistent project index
`- index.ts                 # CLI entry point
```

## Release

```bash
npm run build
npm pack --dry-run
npm publish
```

For a scoped public package:

```bash
npm publish --access public
```

## Report Bugs

Issues and suggestions are welcome in [GitHub Issues](https://github.com/chaobo8484/odradek-cli/issues).

## About

As an independent developer, I welcome technical discussion, collaboration, and career opportunities.

| Contact | Address | 
| --- | --- |
| Email | stratospherelabs@protonmail.com |
| Email | chaobo_pro at outlook dot com |
| X (Twitter) | [@Xiayin8484](https://x.com/Xiayin8484) |

## Star History

<a href="https://www.star-history.com/?repos=chaobo8484%2Fodradek-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&legend=top-left" />
 </picture>
</a>
