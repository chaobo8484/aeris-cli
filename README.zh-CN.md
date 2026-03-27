# Odradek

[![License](https://img.shields.io/github/license/chaobo8484/odradek-cli)](https://github.com/chaobo8484/odradek-cli/blob/main/LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=claude&logoColor=white)
[![X (formerly Twitter)](https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/Xiayin8484)


[English](README.md) | **简体中文**

Odradek 是一个用于分析、增强和诊断 Claude Code / Agent 工作流的 CLI 工具。

## 亮点

- 交互式终端聊天与命令自动补全
- 进入项目之前的工作目录信任检查
- Prompt / Rules / Agent 资产扫描
- Claude JSONL Token、上下文健康度与上下文噪声分析
- 基于 `.env` 的项目级配置
- 基于 `/model` 的会话级模型切换
- 可选的项目上下文注入

## 环境要求

- Node.js `>= 18`
- npm `>= 9`

## 安装

```bash
npm install
```

## 快速开始

1. 复制环境变量模板。

```bash
cp .env.example .env
```

PowerShell：

```powershell
Copy-Item .env.example .env
```

2. 编辑 `.env`。

推荐做法：

- 必填 `ODRADEK_CLAUDE_API_KEY`
- 只有在你使用自定义或兼容网关时，才需要特别设置 `ODRADEK_CLAUDE_BASE_URL`
- 如果你希望在 CLI 中通过 `/model` 自由切换模型，就不要设置 `ODRADEK_CLAUDE_MODEL`

示例：

```env
ODRADEK_CLAUDE_API_KEY=your_api_key
ODRADEK_CLAUDE_BASE_URL=https://api.anthropic.com/v1
ODRADEK_PROJECT_CONTEXT_ENABLED=true
```

3. 启动 CLI。

```bash
npm run dev
```

4. 如果你没有在 `.env` 中设置 `ODRADEK_CLAUDE_MODEL`，可在 CLI 中选择模型。

```text
/model
```

## 配置说明

### 推荐配置方式

对大多数使用者来说，最清晰的方式是：

- 用 `.env` 管理项目级的 `API Key` 和 `Base URL`
- 用 `/model` 切换当前 CLI 会话的模型
- 用 `/model clear` 恢复到默认配置模型

如果项目已经提供 `.env`，通常不必再依赖 `/modelconfig` 或 `/apikey`。当然，这两个命令仍然可以用来保存本机级配置。

### 运行时优先级

从高到低：

1. 当前 CLI 会话通过 `/model` 设置的模型
2. `process.env`、`.env`、`.env.local` 中的环境变量
3. 通过 `/modelconfig` 写入的本地配置文件
4. 内置默认值

### 环境变量

| 变量 | 说明 |
|------|------|
| `ODRADEK_CLAUDE_API_KEY` | Claude / Anthropic 兼容 API Key |
| `ODRADEK_CLAUDE_BASE_URL` | API 基础地址 |
| `ODRADEK_CLAUDE_MODEL` | 项目的默认模型 |
| `ODRADEK_PROJECT_CONTEXT_ENABLED` | 是否启用项目上下文注入 |
| `ANTHROPIC_API_KEY` | 兼容 Anthropic 的备用 API Key |
| `ANTHROPIC_BASE_URL` | 兼容 Anthropic 的备用基础地址 |

### 本地配置文件路径

Windows：

```text
%APPDATA%/odradek-cli/config.json
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清空对话历史 |
| `/history` | 查看全部消息 |
| `/collapse [id\|all]` | 折叠消息 |
| `/expand [id\|all]` | 展开消息 |
| `/exit` / `/quit` | 退出 CLI |
| `/modelconfig` | 在本地配置中设置 Claude API 参数 |
| `/apikey [key\|clear]` | 设置或清除本地 API Key |
| `/model [model-name\|clear]` | 切换当前 CLI 会话的活动模型 |
| `/trustpath` | 信任当前工作目录 |
| `/trustcheck` | 检查当前目录是否已被信任 |
| `/projectcontext [on\|off\|status]` | 控制项目上下文注入 |
| `/skills [path]` | 扫描本地 `SKILL.md` 文件 |
| `/scan_prompt` | 扫描 Prompt / Rules / Agent 资产 |
| `/scan_tokens [current\|all\|path]` | 解析 Claude JSONL Token 结构 |
| `/context_health [current\|all\|path]` | 检查上下文窗口健康度 |
| `/context_noise [current\|all\|path]` | 分析上下文噪声 |
| `/todo_granularity [current\|all\|path]` | 分析 Todo 粒度与上下文负载 |

## 脚本

```bash
npm run dev
npm run build
npm start
```

## 项目结构

```text
src/
|- cli/
|- config/
|- llm/
`- index.ts
```

## 发布前检查

```bash
npm run build
npm pack --dry-run
```

发布前建议确认：

- 不要提交 `.env`
- 确保 `dist/` 已生成
- API Key 仅通过环境变量或本地配置注入
- 确认 `npm pack --dry-run` 只包含预期文件
