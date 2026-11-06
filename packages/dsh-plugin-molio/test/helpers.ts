/**
 * 测试助手 — 捕获式假 Context（收集 apply/register 注册的工具定义）与
 * 最小 ToolRunContext 构造（直接驱动 defineTool 产物的 execute）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/** 假 Context：只实现 tools.register 捕获面。 */
export interface CapturingContext {
  ctx: Context;
  registered: ToolDefinition[];
  disposers: Array<() => void>;
}

export function capturingContext(): CapturingContext {
  const registered: ToolDefinition[] = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    tools: {
      register(def: ToolDefinition) {
        registered.push(def);
        const dispose = (): void => {
          const i = registered.indexOf(def);
          if (i >= 0) registered.splice(i, 1);
        };
        disposers.push(dispose);
        return dispose;
      },
    },
  } as unknown as Context;
  return { ctx, registered, disposers };
}

/** 最小可驱动 execute 的 ToolRunContext（只填 execute 实际用到的字段）。 */
export function fakeExec(
  name: string,
  args: unknown,
  signal: AbortSignal = new AbortController().signal,
): Parameters<ToolDefinition['execute']>[1] {
  return {
    callId: `call-${name}-1`,
    rootCallId: `call-${name}-1`,
    name,
    arguments: args,
    signal,
    token: Symbol('exec-token'),
    deferContext() {},
    concludeTurn() {},
  } as unknown as Parameters<ToolDefinition['execute']>[1];
}

/** 按名字取已注册工具，缺失即测试失败。 */
export function getTool(registered: ToolDefinition[], name: string): ToolDefinition {
  const tool = registered.find((t) => t.name === name);
  if (!tool) {
    throw new Error(
      `工具 ${name} 未注册（实际注册: ${registered.map((t) => t.name).join(', ')}）`,
    );
  }
  return tool;
}
