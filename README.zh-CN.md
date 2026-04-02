<div align="center">

# Odradek
<img src="images/odradek.jpg" alt="Odradek Logo" width="75%"/>

[![License](https://img.shields.io/github/license/chaobo8484/odradek-cli)](https://github.com/chaobo8484/odradek-cli/blob/main/LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
[![X](https://img.shields.io/badge/X-Follow-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/Xiayin8484)

[English](README.md) | **简体中文**

</div>

## 项目简介

Odradek 是一款专为 **Claude Code、Codex 等 AI 编码 Agent** 打造的诊断与增强 CLI 工具。通过它你可以：

- 在终端内直接与 LLM 对话，同时完成诊断分析
- 解析 Agent 会话日志，洞察 Token 结构与上下文压力
- 对工作区进行多维度噪声评估，发现潜在问题
- 扫描并盘点 Prompt 资产、规则和 Skill 文档
- 支持多 Provider（Claude / OpenRouter / Qwen）无缝切换

<img src="images/homepage.png" alt="Odradek Homepage">

## 核心特性

| 特性 | 说明 |
|------|------|
| **多 Provider 支持** | 使用 `/provider` 和 `/model` 在同一会话中无缝切换 Claude、OpenRouter、Qwen |
| **分层 System Prompt** | 支持从应用级到工作区级的多层级 Prompt 配置，覆盖 base / provider / model 三个层级 |
| **Evidence-first 噪声评估** | 从 outcome、process、context、validation 四个维度执行证据优先的噪声分析，每个信号携带置信度评分 |
| **Token 结构解析** | 解析 JSONL 会话日志，呈现 Token 字段聚合、角色分布、工具调用分布等结构化数据 |
| **上下文健康度检测** | 基于 context window 使用率判断当前会话的上下文压力，提供 truncation 预警 |
| **Todo 粒度分析** | 分析 Todo 任务的粒度评分、状态流转、上下文占用，发现过粗或过细的任务分解 |
| **Prompt 资产扫描** | 自动扫描工作区中的 Prompt 文件、规则、Agent 配置和 system-prompt 资产 |
| **Skill 文档盘点** | 扫描 `SKILL.md` 及其配套资源（agents/scripts/references 等），评估指令 Token 规模 |
| **项目上下文注入** | 智能索引工作区文件，基于 LLM 查询动态注入相关上下文，降低上下文噪声 |
| **JSON 诊断导出** | 将诊断数据（noise_eval / context_health / scan_tokens 等）导出为 JSON 便于二次分析 |

## 预览

<div align="center">
<table>
<tr>
<td><img src="images/chat.png" alt="聊天界面" width="100%"/></td>
<td><img src="images/chatwithllm.png" alt="LLM 对话界面" width="100%"/></td>
</tr>
<tr>
<td><img src="images/noiseeval.png" alt="噪声评估界面" width="100%"/></td>
<td><img src="images/noiseeval1.png" alt="噪声评估详情" width="100%"/></td>
</tr>
</table>
</div>

## 功能分区

| 分区 | 说明 | 关键命令 |
| --- | --- | --- |
| **运行态控制** | Provider、模型覆盖、信任状态、项目上下文开关 | `/state`、`/provider`、`/model`、`/trustpath`、`/trustcheck`、`/projectcontext` |
| **Prompt 与规则检查** | Prompt 资产扫描、规则提取、`SKILL.md` 盘点 | `/scan_prompt`、`/rules`、`/skills` |
| **会话诊断** | Token 结构、上下文健康度、Evidence-first 噪声评估、Todo 粒度分析 | `/scan_tokens`、`/context_health`、`/noise_eval`、`/todo_granularity` |
| **对话工具** | 历史记录、折叠展开、清空、导出 | `/history`、`/collapse`、`/expand`、`/clear`、`/export` |

## 环境要求

- Node.js `>= 20`
- npm `>= 9`

## 安装

全局安装：

```bash
npm install -g odradek-cli
odradek
```

或直接运行：

```bash
npx odradek-cli@latest
```

## 快速开始

1. 配置 Provider 的环境变量或 `.env` 文件
2. 运行 `odradek`
3. 首次进入时信任当前工作区
4. 执行诊断命令

```text
/state                    # 查看运行态
/provider                 # 确认当前 Provider
/scan_tokens codex current  # 解析当前会话 Token 结构
/noise_eval codex current   # 执行 Evidence-first 噪声评估
```

将 `codex` 改为 `claude` 即可分析 Claude 日志。

## 配置说明

Odradek 的配置来源优先级大致如下：

1. Shell 环境变量
2. 应用级 `.env` / `.env.local`
3. 从仓库根目录到当前目录的工作区 `.env` / `.env.local`
4. 本地 `config.json` 默认值

现有的 shell 环境变量优先级最高。多个 `.env` 文件同时存在时，离当前目录更近的配置会覆盖更外层的默认值。

推荐的应用级 `.env` 路径：

```text
Windows: %APPDATA%/odradek-cli/.env
macOS:   ~/Library/Application Support/odradek-cli/.env
Linux:   ~/.config/odradek-cli/.env
```

本地配置文件路径：

```text
Windows: %APPDATA%/odradek-cli/config.json
macOS:   ~/Library/Application Support/odradek-cli/config.json
Linux:   ~/.config/odradek-cli/config.json
```

### 运行时 Provider 示例

Claude：

```env
ODRADEK_ACTIVE_PROVIDER=claude
ODRADEK_CLAUDE_API_KEY=your_claude_api_key
ODRADEK_CLAUDE_BASE_URL=https://api.anthropic.com/v1
# ODRADEK_CLAUDE_MODEL=claude-sonnet-4-20250514
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

OpenRouter：

```env
ODRADEK_ACTIVE_PROVIDER=openrouter
ODRADEK_OPENROUTER_API_KEY=your_openrouter_api_key
ODRADEK_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
ODRADEK_OPENROUTER_MODEL=provider/model-name
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

Qwen：

```env
ODRADEK_ACTIVE_PROVIDER=qwen
ODRADEK_QWEN_API_KEY=your_dashscope_api_key
ODRADEK_QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ODRADEK_QWEN_MODEL=qwen3.5-plus
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

### 环境变量清单

| 变量名 | 说明 |
| --- | --- |
| `ODRADEK_ACTIVE_PROVIDER` | 当前运行时 provider，支持 `claude`、`openrouter`、`qwen` |
| `ODRADEK_CLAUDE_API_KEY` | Claude API Key |
| `ODRADEK_CLAUDE_BASE_URL` | Claude 兼容接口地址 |
| `ODRADEK_CLAUDE_MODEL` | 默认 Claude 模型 |
| `ODRADEK_OPENROUTER_API_KEY` | OpenRouter API Key |
| `ODRADEK_OPENROUTER_BASE_URL` | OpenRouter 接口地址 |
| `ODRADEK_OPENROUTER_MODEL` | 默认 OpenRouter 模型 |
| `ODRADEK_QWEN_API_KEY` | DashScope API Key |
| `ODRADEK_QWEN_BASE_URL` | Qwen compatible-mode 接口地址 |
| `ODRADEK_QWEN_MODEL` | 默认 Qwen 模型 |
| `ODRADEK_PROJECT_CONTEXT_ENABLED` | 是否启用项目上下文自动注入 |
| `ANTHROPIC_API_KEY` | Claude API Key 的兼容变量名 |
| `ANTHROPIC_BASE_URL` | Claude Base URL 的兼容变量名 |
| `OPENROUTER_API_KEY` | OpenRouter API Key 的兼容变量名 |
| `DASHSCOPE_API_KEY` | Qwen API Key 的兼容变量名 |

## 分层 System Prompt

Odradek 会在发起模型请求前按层加载 System Prompt。

工作区路径：

```text
.odradek/system-prompts/base.md
.odradek/system-prompts/providers/<provider>.md
.odradek/system-prompts/models/<model>.md
```

应用级路径：

```text
%APPDATA%/odradek-cli/system-prompts/
```

加载顺序：

1. 应用级 `base.md`
2. 应用级 `providers/<provider>.md`
3. 应用级 `models/<model>.md`
4. 工作区 `.odradek/system-prompts/base.md`
5. 工作区 `.odradek/system-prompts/providers/<provider>.md`
6. 工作区 `.odradek/system-prompts/models/<model>.md`

## 命令说明

### 运行态与工作区

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看所有命令 |
| `/state` | 查看运行态、工作区、配置和信任状态 |
| `/provider [claude\|openrouter\|qwen]` | 切换当前运行时 provider |
| `/model [model-name\|clear]` | 设置或清除会话级模型覆盖 |
| `/projectcontext [on\|off\|status]` | 控制项目上下文注入 |
| `/trustpath` | 信任当前工作目录 |
| `/trustcheck` | 检查当前目录是否已被信任 |

### Prompt 与工作区资产检查

| 命令 | 说明 |
| --- | --- |
| `/scan_prompt` | 扫描工作区中的 Prompt、规则、Agent 和 system-prompt 资产 |
| `/rules [path]` | 提取工作区中的显式规则与指令行 |
| `/skills [path]` | 扫描本地 `SKILL.md` 及其配套资源 |

### Claude / Codex 会话诊断

这些命令都支持 `claude` 或 `codex` 作为数据源前缀：

| 命令 | 说明 |
| --- | --- |
| `/scan_tokens [claude\|codex] [current\|all\|path]` | 解析会话 JSONL 的 token 结构 |
| `/context_health [claude\|codex] [current\|all\|path]` | 查看上下文窗口健康度 |
| `/noise_eval [claude\|codex] [current\|all\|path]` | 执行 evidence-first 噪声评估 |
| `/context_noise [claude\|codex] [current\|all\|path]` | `/noise_eval` 的兼容别名 |
| `/todo_granularity [claude\|codex] [current\|all\|path]` | 分析 Todo 粒度与上下文使用情况 |

常见示例：

```text
/scan_tokens codex current
/context_health codex all
/noise_eval claude current
/todo_granularity codex current
```

### 对话与导出

| 命令 | 说明 |
| --- | --- |
| `/history` | 查看全部对话消息 |
| `/collapse [id\|all]` | 折叠消息 |
| `/expand [id\|all]` | 展开消息 |
| `/clear` | 清空当前会话历史 |
| `/analyze` | 查看当前对话的基础统计 |
| `/export [claude\|codex] [state\|noise_eval\|context_health\|scan_tokens\|rules\|skills\|scan_prompt\|todo_granularity\|all]` | 导出诊断数据为 JSON |
| `/exit` 或 `/quit` | 退出 CLI |

导出文件默认写入：

```text
.odradek/exports/
```

示例：

```text
/export codex all
/export claude noise_eval
```

## 开发

安装依赖：

```bash
npm install
```

复制环境变量模板：

```bash
cp .env.example .env
```

PowerShell：

```powershell
Copy-Item .env.example .env
```

启动开发模式：

```bash
npm run dev
```

构建并运行编译后的版本：

```bash
npm run build
npm start
```

可选的本地全局链接：

```bash
npm link
odradek
```

取消本地全局链接：

```bash
npm unlink -g odradek-cli
```

核心脚本：

```bash
npm run dev
npm run build
npm start
```

## 项目结构

```text
src/
|- cli/                    # CLI 核心：命令注册、处理器、会话管理
|   |- ink/                # Ink 终端 UI 组件
|   |- ClaudeTranscriptParser.ts   # Claude/Codex 会话解析器
|   |- NoiseEvaluator.ts            # Evidence-first 噪声评估引擎
|   |- ContextNoiseAnalyzer.ts      # 上下文噪声分析
|   |- PromptAssetScanner.ts       # Prompt 资产扫描
|   |- RuleScanner.ts              # 规则提取
|   |- SkillScanner.ts             # SKILL.md 盘点
|   |- TodoGranularityAnalyzer.ts   # Todo 粒度分析
|   |- ConversationManager.ts       # 会话历史管理
|   |- ConfigStore.ts              # 配置存储
|   `- tokenEstimate.ts            # Token 估算
|- config/                  # 配置加载、Provider 目录
|- llm/                     # LLM 适配层：多 Provider 支持
|   |- adapters/             # Claude / OpenRouter / Qwen 适配器
|   |- LLMClient.ts         # LLM 客户端
|   |- ProjectContextBuilder.ts    # 项目上下文注入
|   `- PersistentProjectIndex.ts   # 持久化项目索引
`- index.ts                 # CLI 入口
```

## 发布

```bash
npm run build
npm pack --dry-run
npm publish
```

如果是 scoped public package：

```bash
npm publish --access public
```

## 问题反馈

欢迎通过 [GitHub Issues](https://github.com/chaobo8484/odradek-cli/issues) 提交问题和建议。

## 关于

作为独立开发者，欢迎各类技术交流、项目合作和职业机会。请通过以下方式与我取得联系：

| 联系方式 | 地址 | 备注 |
|---------|------|------|
| Email | stratospherelabs@protonmail.com | 反馈 |
| Email | chaobo_pro at outlook dot com | 个人 |
| X (Twitter) | [@Xiayin8484](https://x.com/Xiayin8484) | 社交媒体 |

## Star History

<a href="https://www.star-history.com/?repos=chaobo8484%2Fodradek-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=chaobo8484/odradek-cli&type=date&legend=top-left" />
 </picture>
</a>
