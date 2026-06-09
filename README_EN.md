# Molio (墨流)

> The Local AI Workstation for Knowledge Workers: Manage Knowledge → Write with Local AI → Publish with One Click. Your Data Never Leaves.

[English](README_EN.md) | **[中文](README.md)**

Molio unifies knowledge base management, AI-assisted writing, and multi-platform publishing into one seamless workflow — a **local-first** desktop application. All data stays on your device; by orchestrating local AI runtimes (Claude Code, OpenAI Codex, Gemini CLI, Qwen Code), it enables document creation entirely on your machine — no cloud uploads required.

## Features

- **Knowledge Base Management** — LLM_Wiki-inspired self-managing knowledge base with file tree browsing, create, edit, and delete, automatically building a searchable knowledge network
- **AI-Assisted Writing** — Document creation via local AI runtimes with multi-turn conversation, tool calling, and streaming output
- **Multi-Runtime Orchestration** — Switch between Claude Code / OpenAI Codex / Gemini CLI / Qwen Code with one click
- **Project Context Loading** — AI processes automatically load `CLAUDE.md`, built-in `wiki_prompt`, and document structure from the project directory
- **Markdown Typesetting** — Integrated [doocs/md](https://github.com/doocs/md) engine for WeChat and platform-specific formatting
- **Multi-Platform Publishing** — One-click distribution to 30+ platforms via [doocs/cose](https://github.com/doocs/cose)
- **Local-First, Data Privacy** — All data stays on your device; AI runtimes invoke local CLI directly, no document content ever leaves your machine

## Screenshots

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/img/main.png" alt="Home" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>AI Chat: Select agent and send messages with streaming response</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/img/wiki_knowledge.png" alt="Knowledge Base" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>Vault file tree management, Markdown rendering and browsing</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/img/Layout%20.png" alt="Typesetting Editor" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>Split-pane real-time preview with theme, font, and color styling</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/img/publish.png" alt="Multi-Platform Publishing" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>One-click sync to 30+ content platforms</sub>
    </td>
  </tr>
</table>

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

## Community

<img src="docs/img/qrcode.png" alt="Community QR Code" width="200" />

## Acknowledgments

Molio is inspired and supported by these excellent open-source projects:

- **[WeKnora](https://github.com/Tencent/WeKnora)** — Knowledge management platform, providing design reference for Molio's KB module
- **[multica](https://github.com/multica-ai/multica)** — Open-source Agent management platform, inspiring Molio's multi-runtime orchestration and Agent interaction design
- **[doocs/md](https://github.com/doocs/md)** — WeChat Markdown editor, powering Molio's document typesetting and multi-platform formatting via its core rendering engine `@md/core`
- **[doocs/cose](https://github.com/doocs/cose)** — Multi-platform content distribution extension, powering Molio's publishing capabilities via its platform adapter layer

Thanks to the authors and communities of these projects for enabling Molio to stand on the shoulders of giants.

## License

[Modified Apache 2.0](LICENSE) — Based on Apache License 2.0 with additional commercial use restrictions. Free for internal and non-commercial use; commercial hosting/embedding requires a commercial license.
