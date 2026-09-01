// apps/web/src/utils/toolGroups.ts
// 工具分组逻辑 —— 从 AssistantMessage 抽出，供 AssistantMessage / WorkBlock 共享，
// 避免两个组件互相导入形成循环依赖。
import type { ToolEvent } from '../hooks/useChat';

// Tools that should never be grouped (always shown individually)
export const UNGROUPABLE = new Set(['AskUserQuestion', 'ask_user_question']);

export type ToolItem =
  | { kind: 'single'; tool: ToolEvent }
  | { kind: 'group'; toolName: string; tools: ToolEvent[] }
  | { kind: 'batch'; tools: ToolEvent[] };

/** 交互式工具项（AskUserQuestion）——必须常显，不得收入 WorkBlock 折叠。 */
export function isInteractive(item: ToolItem): item is Extract<ToolItem, { kind: 'single' }> {
  return item.kind === 'single' && UNGROUPABLE.has(item.tool.name);
}

/**
 * Group consecutive same-type tool calls (≥2 same name), then group
 * consecutive different-name singles into a batch when ≥3.
 */
export function groupTools(tools: ToolEvent[]): ToolItem[] {
  // First pass: same-name grouping
  const pass1 = groupSameName(tools);

  // Second pass: merge consecutive different-name singles → batch when ≥3
  const result: ToolItem[] = [];
  let i = 0;
  while (i < pass1.length) {
    const item = pass1[i]!;
    if (item.kind !== 'single') {
      result.push(item);
      i++;
      continue;
    }

    // Collect consecutive singles with different names
    const batchTools: ToolEvent[] = [item.tool];
    let j = i + 1;
    while (j < pass1.length && pass1[j]!.kind === 'single') {
      const nextTool = (pass1[j] as { kind: 'single'; tool: ToolEvent }).tool;
      // Don't batch if same name as the previous tool (shouldn't happen after pass1,
      // but guard against edge cases)
      if (nextTool.name === batchTools[batchTools.length - 1]!.name) break;
      // Don't batch UNGROUPABLE tools — they need their interactive card
      if (UNGROUPABLE.has(nextTool.name)) break;
      batchTools.push(nextTool);
      j++;
    }

    if (batchTools.length >= 3) {
      result.push({ kind: 'batch', tools: batchTools });
    } else {
      for (const t of batchTools) {
        result.push({ kind: 'single', tool: t });
      }
    }
    i = j;
  }

  return result;
}

/**
 * Group consecutive same-name tool calls.
 * Only groups when ≥2 consecutive tools share the same name.
 */
export function groupSameName(tools: ToolEvent[]): ToolItem[] {
  const result: ToolItem[] = [];
  let i = 0;

  while (i < tools.length) {
    const tool = tools[i]!;

    // AskUserQuestion is always single
    if (UNGROUPABLE.has(tool.name)) {
      result.push({ kind: 'single', tool });
      i++;
      continue;
    }

    // Count consecutive same-type tools
    let j = i + 1;
    while (j < tools.length && tools[j]!.name === tool.name && !UNGROUPABLE.has(tools[j]!.name)) {
      j++;
    }
    const count = j - i;

    if (count >= 2) {
      // Group them
      result.push({ kind: 'group', toolName: tool.name, tools: tools.slice(i, j) });
    } else {
      // Single tool
      result.push({ kind: 'single', tool });
    }
    i = j;
  }

  return result;
}
