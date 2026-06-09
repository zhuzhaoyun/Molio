# Molio (墨流)

> AI-Powered Local Knowledge Management & Document Creation Platform

[English](README_EN.md) | **[中文](README.md)**

Molio is a local-first desktop application that unifies knowledge base management, AI-assisted writing, and multi-platform publishing into one seamless workflow. By orchestrating local AI runtimes (Claude Code, OpenAI Codex, Gemini CLI, Qwen Code), it enables document creation entirely on your device — no cloud uploads required.

## Features

- **Knowledge Base Management** — Obsidian-like local Vault system with file tree browsing, create, edit, and delete
- **AI-Assisted Writing** — Document creation via local AI runtimes with multi-turn conversation, tool calling, and streaming output
- **Multi-Runtime Orchestration** — Switch between Claude Code / OpenAI Codex / Gemini CLI / Qwen Code with one click
- **Project Context Loading** — AI processes automatically load `CLAUDE.md` and document structure from the project directory
- **Markdown Typesetting** — Integrated [doocs/md](https://github.com/doocs/md) engine for WeChat and platform-specific formatting
- **Multi-Platform Publishing** — One-click distribution to 30+ platforms via [doocs/cose](https://github.com/doocs/cose)
- **Desktop App** — Packaged as a native Windows application with Electron, ready to use out of the box

## Screenshots

<p align="center">
  <img src="docs/img/main.png" alt="Home" width="100%" />
  <br/>
  <sup>Home: AI chat interface, select agent and send messages with streaming response</sup>
</p>

<p align="center">
  <img src="docs/img/wiki_knowledge.png" alt="Knowledge Base" width="100%" />
  <br/>
  <sup>Knowledge Base: Vault file tree management, Markdown rendering and browsing</sup>
</p>

<p align="center">
  <img src="docs/img/Layout%20.png" alt="Typesetting Editor" width="100%" />
  <br/>
  <sup>Typesetting Editor: Split-pane real-time preview with theme, font, and color styling</sup>
</p>

<p align="center">
  <img src="docs/img/publish.png" alt="Multi-Platform Publishing" width="100%" />
  <br/>
  <sup>Multi-Platform Publishing: One-click sync to 30+ content platforms</sup>
</p>

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite 6 + TypeScript |
| Backend | Hono + Node.js + SQLite (better-sqlite3) |
| Desktop | Electron 40 + electron-builder |
| Build | pnpm workspace monorepo |
| Testing | node:test (built-in) |

## Project Structure

```
Molio/
├── packages/
│   └── contracts/       @molio/contracts — Shared type definitions
├── apps/
│   ├── daemon/          @molio/daemon   — Hono HTTP server (API + SSE)
│   ├── web/             @molio/web      — Vite + React frontend
│   └── desktop/         @molio/desktop  — Electron desktop shell
└── package.json         Monorepo root config
```

## Quick Start

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- At least one AI runtime CLI installed:
  - [Claude Code](https://claude.ai/claude-code)
  - [OpenAI Codex CLI](https://github.com/openai/codex)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [Qwen Code](https://github.com/QwenLM/qwen-code)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/zhuzhaoyun/Molio.git
cd Molio

# Install dependencies
pnpm install

# Start development environment (daemon + web)
pnpm dev

# Or start individually
pnpm dev:daemon   # Backend only :3100
pnpm dev:web      # Frontend only :5173
```

### Build Desktop App

```bash
# One-click build + generate unpacked version
pnpm desktop:run

# Or full packaging as installer
pnpm package

# Generate unpacked directory only (no installer)
pnpm package:dir
```

### Testing & Type Checking

```bash
pnpm test         # Run all tests (node:test)
pnpm typecheck    # Full type checking
pnpm build        # Build all packages
```

## API Overview

The daemon provides REST API + SSE event streaming:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/agents` | List available AI runtimes |
| POST | `/api/runs` | Create a new AI run |
| GET | `/api/runs/:id/events` | SSE event stream (streaming output) |
| POST | `/api/runs/:id/tool-result` | Submit tool call results |
| GET/POST/DELETE | `/api/knowledge/vaults` | Knowledge base Vault management |
| GET/POST/DELETE | `/api/knowledge/vaults/:id/files/*` | File read/write/delete |
| GET | `/api/knowledge/vaults/:id/tree` | File tree scan |
| GET/PUT | `/api/config` | Application configuration |
| CRUD | `/api/projects` | Project management |

## Community

<img src="docs/img/qrcode.png" alt="Community QR Code" width="200" />

## Acknowledgments

Molio is inspired and supported by these excellent open-source projects:

- **[WeKnora](https://github.com/Tencent/WeKnora)** — Knowledge management platform, providing design reference for Molio's KB module
- **[multica](https://github.com/multica-ai/multica)** — Open-source Agent management platform, inspiring Molio's multi-runtime orchestration and Agent interaction design
- **[doocs/md](https://github.com/doocs/md)** — WeChat Markdown editor, powering Molio's document typesetting and multi-platform formatting via its core rendering engine `@md/core`

Thanks to the authors and communities of these projects for enabling Molio to stand on the shoulders of giants.

## License

[Modified Apache 2.0](LICENSE) — Based on Apache License 2.0 with additional commercial use restrictions. Free for internal and non-commercial use; commercial hosting/embedding requires a commercial license.
