/**
 * molio mcp — stdio MCP server（WorkBuddy 连接器入口）。
 * 7 个只读 tools；stdout 是 JSON-RPC 通道，任何日志只能走 stderr（errLog）。
 * 长任务（AI 问答）拆 start/poll，handler 内绝不轮询（WorkBuddy 30s 请求上限）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DaemonClient } from '../daemon-client.js';
import { EXIT_OK } from '../exit-codes.js';
import { errLog } from '../output.js';
import { CLI_VERSION } from '../version.js';
import { registerKbAskPoll } from './tools/kb-ask-poll.js';
import { registerKbAskStart } from './tools/kb-ask-start.js';
import { registerKbRead } from './tools/kb-read.js';
import { registerKbSearch } from './tools/kb-search.js';
import { registerKbTree } from './tools/kb-tree.js';
import { registerKbVaults } from './tools/kb-vaults.js';
import { registerMolioStatus } from './tools/molio-status.js';

const INSTRUCTIONS = [
  'Molio 本机知识库连接器（只读 + AI 问答）。',
  '典型流程：kb_vaults 看有哪些库 → kb_tree / kb_search 定位内容 → kb_read 读原文；',
  '需要综合性回答时用 kb_ask_start 发起 AI 问答，再以 ≥5 秒间隔轮询 kb_ask_poll 取答（可能需要 10 秒~2 分钟）。',
  '连不上 Molio daemon 时，请提示用户先启动 Molio 桌面版。所有工具都不会修改知识库。',
].join('');

/** 组装 McpServer + 注册全部 tools（stdio 入口与测试共用）。 */
export function createMcpServer(client: DaemonClient): McpServer {
  const server = new McpServer(
    { name: 'molio-kb', version: CLI_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerMolioStatus(server, client);
  registerKbVaults(server, client);
  registerKbTree(server, client);
  registerKbRead(server, client);
  registerKbSearch(server, client);
  registerKbAskStart(server, client);
  registerKbAskPoll(server, client);
  return server;
}

export async function runMcpServer(): Promise<number> {
  const server = createMcpServer(new DaemonClient());
  await server.connect(new StdioServerTransport());
  errLog(`molio MCP server 已启动（stdio, v${CLI_VERSION}, 7 tools）`);
  return EXIT_OK;
}
