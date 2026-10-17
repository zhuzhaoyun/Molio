/**
 * MCP tool: kb_ask_start — 发起 AI 问答（秒回 runId，不阻塞）。
 * WorkBuddy MCP 请求 30s 上限 → AI run 可能跑几分钟，绝不在此 handler 内等待；
 * 取答交给 kb_ask_poll 由调用方 agent 轮询。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startAsk } from '../../ask-service.js';
import type { DaemonClient } from '../../daemon-client.js';
import { runTool, toolOk } from './common.js';

export function registerKbAskStart(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    'kb_ask_start',
    {
      title: '发起知识库 AI 问答',
      description:
        '基于知识库发起一次 AI 问答，立即返回 {runId, conversationId}，不等待答案。' +
        'AI 回答通常需要 10 秒~2 分钟，请随后以 ≥5 秒间隔重复调用 kb_ask_poll(runId) 直到 status 变为终态。',
      inputSchema: {
        question: z.string().describe('要问 AI 的问题（中文即可，越具体越好）'),
        vaultId: z.string().optional().describe('知识库 id 或名称，缺省用当前激活知识库'),
        agentId: z.string().optional().describe('AI runtime id（缺省自动选择第一个可用的）'),
      },
    },
    (args) =>
      runTool(async () => {
        const start = await startAsk(client, {
          question: args.question,
          vaultArg: args.vaultId,
          agentArg: args.agentId,
        });
        return toolOk({
          runId: start.runId,
          conversationId: start.conversationId ?? null,
          vaultId: start.vaultId,
          vaultName: start.vaultName,
          agentId: start.agentId,
          next: `请用 kb_ask_poll(runId: "${start.runId}") 轮询取答（建议间隔 ≥5 秒）`,
        });
      }),
  );
}
