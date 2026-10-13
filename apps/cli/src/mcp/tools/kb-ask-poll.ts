/**
 * MCP tool: kb_ask_poll — 单次查询 AI 问答结果（绝不内部轮询，30s 上限安全）。
 * 取答路径 = GET run 状态 + 会话消息（SQLite 持久化），不依赖 SSE 回放缓冲，
 * 迟到查询也能拿到答案。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pollAsk } from '../../ask-service.js';
import type { DaemonClient } from '../../daemon-client.js';
import { runTool, toolError, toolOk } from './common.js';

export function registerKbAskPoll(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    'kb_ask_poll',
    {
      title: '查询 AI 问答结果',
      description:
        '单次查询 kb_ask_start 发起的问答 run。status 为 pending/running 时请稍后（≥5 秒）再调用；' +
        'succeeded 时 answer 为完整答案；failed/canceled 时返回错误信息。本工具不阻塞等待。',
      inputSchema: {
        runId: z.string().describe('kb_ask_start 返回的 runId'),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await pollAsk(client, args.runId);
        switch (result.status) {
          case 'succeeded':
            return toolOk({
              status: result.status,
              answer: result.answer ?? null,
              ...(result.answer ? {} : { hint: 'run 已成功但未找到 assistant 回复内容' }),
            });
          case 'failed':
          case 'canceled':
            return toolError(`AI 问答 ${result.status}：${result.error ?? '（无错误详情）'}`);
          default:
            return toolOk({
              status: result.status,
              hint: '仍在执行中，请 ≥5 秒后再次调用 kb_ask_poll',
            });
        }
      }),
  );
}
