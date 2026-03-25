# Aeris

[![License](https://img.shields.io/github/license/chaobo8484/aeris-cli)](https://github.com/chaobo8484/aeris-cli/blob/main/LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=claude&logoColor=white)
[![X (formerly Twitter)](https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/Xiayin8484)


**English** | [简体中文](README.zh-CN.md)

A CLI tool to analyze, improve, and diagnose Claude Code / Agent workflows.

## Features

- Interactive terminal chat
- `/` command hints, arrow-key navigation, `Tab` completion
- Conversation history with fold / unfold
- Multi-provider chat with Claude and OpenRouter
- Provider/model settings, local API key management, model switching
- Trust check for the current working directory
- Scan project Prompt / Rules / Agent assets
- Claude JSONL token analysis and context health checks
- Optional project context injection

## Requirements

- Node.js `>= 18`
- npm `>= 9`

## Install

```bash
npm install
```

## Configuration

Prefer environment variables or a `.env` file for local dev, CI/CD, and servers.

1. Copy the example env file

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

2. Set your provider values

Claude example:

```env
AERIS_ACTIVE_PROVIDER=claude
AERIS_CLAUDE_API_KEY=your_api_key
AERIS_CLAUDE_BASE_URL=https://api.anthropic.com/v1
AERIS_CLAUDE_MODEL=your_claude_model
AERIS_PROJECT_CONTEXT_ENABLED=true
```

OpenRouter example:

```env
AERIS_ACTIVE_PROVIDER=openrouter
AERIS_OPENROUTER_API_KEY=your_openrouter_api_key
AERIS_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
AERIS_OPENROUTER_MODEL=provider/model-name
AERIS_PROJECT_CONTEXT_ENABLED=true
```

3. Start the app

```bash
npm run dev
```

Provider API settings come from `.env`. Inside the CLI, use `/provider` to switch provider and `/model` to switch the current session model.

**Windows config path:**

```text
%APPDATA%/aeris-cli/config.json
```

**Precedence (highest first):**

1. Session model override from `/model`
2. System env / `.env`
3. Built-in defaults

**Environment variables:**

| Variable | Purpose |
|----------|---------|
| `AERIS_ACTIVE_PROVIDER` | Active runtime provider (`claude` or `openrouter`) |
| `AERIS_CLAUDE_API_KEY` | Claude API key |
| `AERIS_CLAUDE_BASE_URL` | API base URL |
| `AERIS_CLAUDE_MODEL` | Model name |
| `AERIS_OPENROUTER_API_KEY` | OpenRouter API key |
| `AERIS_OPENROUTER_BASE_URL` | OpenRouter API base URL |
| `AERIS_OPENROUTER_MODEL` | OpenRouter default model |
| `AERIS_PROJECT_CONTEXT_ENABLED` | Toggle project context |
| `ANTHROPIC_API_KEY` | Anthropic-compatible key |
| `ANTHROPIC_BASE_URL` | Anthropic-compatible base URL |
| `OPENROUTER_API_KEY` | OpenRouter fallback key name |

## Scripts

```bash
npm run dev    # development
npm run build  # production build
npm start      # run built app
```

On first launch, Aeris asks whether to trust the current working directory. After that, use `.env` for provider settings, `/provider` to switch the active provider, and `/model` to switch the current session model.

## CLI commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear conversation |
| `/history` | Show all messages |
| `/collapse [id or all]` | Collapse messages |
| `/expand [id or all]` | Expand messages |
| `/exit` / `/quit` | Exit |
| `/provider [claude\|openrouter]` | Switch active provider |
| `/model [name]` | Switch model for the active provider |
| `/trustpath` | Trust current directory |
| `/trustcheck` | Check trust status |
| `/projectcontext [on, off, or status]` | Project context injection |
| `/scan_prompt` | Scan Prompt / Rules / Agent assets |
| `/scan_tokens [current, all, or path]` | Parse Claude JSONL token structure |
| `/context_health [current, all, or path]` | Context window health |
| `/context_noise [current, all, or path]` | Context noise analysis |
| `/todo_granularity [current, all, or path]` | Todo granularity vs. context load |

## Project layout

```text
src/
├─ cli/
├─ config/
├─ llm/
└─ index.ts
```

## Pre-release checklist

```bash
npm run build
npm pack --dry-run
```

Before publishing:

- Do not commit `.env`
- Ensure `dist/` is built
- Inject API keys via env only
- Verify `npm pack --dry-run` includes only intended files
