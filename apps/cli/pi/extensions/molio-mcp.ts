/**
 * Pi 扩展：自动注册 Molio 知识库 MCP server（stdio）。
 *
 * 安装本 Pi package 后，pi 会话启动时自动连接 `molio` MCP server，
 * 暴露 7 个只读工具（molio_status / kb_vaults / kb_tree / kb_read /
 * kb_search / kb_ask_start / kb_ask_poll），无需手动 `pi mcp add`。
 *
 * 约定（见 pi.dev docs/extensions.md）：
 * - factory 内只做注册，不启动进程/长命资源（连接由 pi 在 session start 建立）；
 * - 用户级 mcp.json 里的同名 server（`pi mcp add molio …`）优先于本注册，
 *   因此手动配置可以覆盖这里的默认值。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 进 pi system prompt 的 server 简介（pi docs/mcp.md：description 用于工具发现与排名）。 */
const SERVER_DESCRIPTION =
  "Molio 本地知识库（只读）：kb_search 全文搜索、kb_read 读原文、kb_tree 浏览文件树、kb_vaults 列知识库、kb_ask_start/kb_ask_poll 基于用户积累做 AI 问答、molio_status 连通性自检。需要 Molio 桌面版正在运行。";

export default function (pi: ExtensionAPI) {
  // 优先用本包自带的 CLI 入口（npm 发布包与本地安装都带 dist/src/index.js，
  // 见 package.json files）。用 process.execPath 而不是裸 "node"，
  // 避免依赖 PATH 上的 Node 版本。
  const bundledEntry = fileURLToPath(
    new URL("../../dist/src/index.js", import.meta.url),
  );

  if (existsSync(bundledEntry)) {
    pi.registerMcpServer("molio", {
      command: process.execPath,
      args: [bundledEntry, "mcp"],
      description: SERVER_DESCRIPTION,
    });
    return;
  }

  // 兜底：dist 缺失（如从 git 源安装且未构建）时退回 npx 现装。
  // 注意 Windows 下 npx 是 .cmd，能否直接 spawn 取决于 pi 的 stdio 实现；
  // 该路径仅为兜底，正常 npm 安装不会走到。
  pi.registerMcpServer("molio", {
    command: "npx",
    args: ["-y", "@molio/cli", "mcp"],
    description: SERVER_DESCRIPTION,
  });
}
