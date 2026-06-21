# Molio (墨流)

> Obsidian-compatible local knowledge base + Claude Code GUI + WeChat AI Assistant — all data stays on your machine

[English](README_EN.md) | **[中文](README.md)**

Molio is a **local-first** desktop app that unifies knowledge management, AI writing, and multi-platform publishing. Open your existing Obsidian Vault directly, clip web pages with the Chrome extension, write documents via Claude Code / Codex / Gemini CLI in a graphical UI, or chat with your knowledge base from your phone via WeChat — everything stays on your machine, nothing goes through third-party servers.

## Features

- **🗂️ Obsidian-Compatible Vault** — Point it at your existing Obsidian directory, zero migration; plain Markdown files, no vendor lock-in, switch back anytime
- **✂️ Built-in Web Clipper** — Chrome extension clips web pages to your knowledge base with one click, auto-opens the desktop app to the saved file
- **🤖 Claude Code / Codex / Gemini CLI GUI** — No command line needed; pick an agent, send messages, watch streaming output in the UI, auto-loads project `CLAUDE.md` context
- **💬 WeChat AI Assistant** — Scan a QR code to connect your personal WeChat; chat with your local knowledge base from your phone; send article links for auto-summary and save
- **🎨 Powered by doocs/md Typesetting** — One-click formatting for WeChat, Zhihu, and more; split-pane real-time preview
- **🚀 Publish to 30+ Platforms** — Built on [doocs/cose](https://github.com/doocs/cose), write once and publish everywhere — no more copy-pasting across platforms
- **🔒 All Data Stays Local** — Knowledge base, AI conversations, and WeChat messages all stored on your machine, never routed through third-party servers

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

- **[multica](https://github.com/multica-ai/multica)** — Open-source Agent management platform, inspiring Molio's multi-runtime orchestration and Agent interaction design
- **[doocs/md](https://github.com/doocs/md)** — WeChat Markdown editor, powering Molio's document typesetting and multi-platform formatting via its core rendering engine `@md/core`
- **[doocs/cose](https://github.com/doocs/cose)** — Multi-platform content distribution extension, powering Molio's publishing capabilities via its platform adapter layer
- **[WeKnora](https://github.com/Tencent/WeKnora)** — Tencent's open-source knowledge management platform, providing design philosophy reference for Molio's KB module

Thanks to the authors and communities of these projects for enabling Molio to stand on the shoulders of giants.

## License

[Modified Apache 2.0](LICENSE) — Based on Apache License 2.0 with additional commercial use restrictions. Free for internal and non-commercial use; commercial hosting/embedding requires a commercial license.
