/**
 * Pure helpers for the composer runtime/model pill — kept out of the component
 * so node:test can cover them without React/DOM.
 */
import type { RuntimeModelOption } from '@molio/contracts';

/** 菜单里的一个可选项；id=null 表示「跟随 CLI 默认」。 */
export interface ModelOption {
  id: string | null;
  label: string;
}

/**
 * 组装「模型」分组的选项列表：顶部固定「跟随默认」，剔除 runtime 自带的
 * id=default 原生项（与「跟随默认」语义重复），按 id 去重、保持原顺序。
 */
export function buildModelOptions(models: RuntimeModelOption[], defaultLabel: string): ModelOption[] {
  const options: ModelOption[] = [{ id: null, label: defaultLabel }];
  const seen = new Set<string>();
  for (const m of models) {
    if (!m.id || m.id === 'default' || seen.has(m.id)) continue;
    seen.add(m.id);
    options.push({ id: m.id, label: m.label });
  }
  return options;
}

/** pill 文案：`Runtime` 或 `Runtime · Model`；无 agent 返回空串（宿主不渲染）。 */
export function formatPillLabel(
  agentName: string | null,
  model: string | null,
  models: RuntimeModelOption[],
): string {
  if (!agentName) return '';
  if (!model) return agentName;
  const label = models.find((m) => m.id === model)?.label ?? model;
  return `${agentName} · ${label}`;
}
