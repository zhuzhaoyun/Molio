/**
 * Runtime/model pill — composer-row 里展示并切换「当前 runtime · 模型」。
 *
 * 自包含组件：数据来自 chatRuntimeStore（选择态）+ useAgents（runtime/模型列表），
 * 宿主（主页 ChatComposer / KB 会话 ChatComposer）零 prop 接线。
 * 交互范式沿用 ConversationHistoryMenu：按钮 + 上弹菜单 + 点击外部关闭。
 *
 * 选择语义（用户拍板）：切模型/切 runtime 对**下一条消息**即时生效；
 * 模型按 runtime 记入 localStorage（chatRuntimeStore 持久化），全局默认仍在设置页。
 *
 * 条目两行式（借鉴 VS Code Claude Code 插件的模型选择器）：主行 = 实际会运行的
 * 模型，副行 = 来源/角色说明（如「Opus 映射 · glm-5.3-flash[1M]」——CC Switch
 * 写入 ~/.claude/settings.json 的映射由 daemon 解析后随 AgentInfo 下发）。
 * 「运行时」组常驻：未安装的 runtime 灰态显示，点击跳「设置 → 运行时」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useAgents } from '../hooks/useAgents';
import { chatRuntimeStore, useChatRuntime } from '../stores/chatRuntimeStore';
import { buildModelOptions, formatPillLabel } from './runtimeModelOptions';

/** 未安装 runtime 行的点击事件 —— App 层监听并导航到设置页（SPA 内跳转）。 */
export const OPEN_RUNTIME_SETTINGS_EVENT = 'molio:open-runtime-settings';

/** 选中项右侧的对勾（模型组 / 运行时组共用）。 */
function CheckIcon() {
  return (
    <svg className="composer-model-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function RuntimeModelPill() {
  const { t } = useI18n();
  const { agents } = useAgents();
  const { agentId, model } = useChatRuntime();
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭（与 ConversationHistoryMenu 同款）
  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [show]);

  const pickModel = useCallback((id: string | null) => {
    chatRuntimeStore.setModel(id);
    setShow(false);
  }, []);

  const pickRuntime = useCallback((id: string) => {
    chatRuntimeStore.setAgentId(id);
    setShow(false);
  }, []);

  // 所选 runtime 不在列表（未加载/已被移除）→ 不渲染 pill。
  // 注意：必须放在全部 hook 调用之后——agent 列表从空到有时 hook 数量不能变。
  const current = agents.find((a) => a.id === agentId);
  if (!current) return null;

  const label = formatPillLabel(current.name, model, current.models, current.defaultModel?.label);
  const defaultDetail = current.defaultModel?.label
    ? t('composer.currentDefault', { model: current.defaultModel.label })
    : undefined;
  const modelOptions = buildModelOptions(current.models, t('composer.modelDefault'), defaultDetail);

  return (
    // 菜单的定位锚点是 .composer（而非本 wrapper）——见 chat.css 的说明：
    // 锚 wrapper 会让菜单压住 textarea 被其拦截点击
    <div className="composer-model-wrap" ref={ref}>
      <button
        type="button"
        className="composer-model-pill"
        data-testid="composer-model-pill"
        aria-expanded={show}
        title={t('composer.modelMenu')}
        onClick={() => setShow((v) => !v)}
      >
        <span className="composer-model-pill-label">{label}</span>
        <svg className="composer-model-caret" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {show && (
        <div className="composer-model-menu" data-testid="composer-model-menu">
          <div className="composer-model-group">{t('composer.modelGroup')}</div>
          {modelOptions.map((opt) => (
            <button
              key={opt.id ?? '__default__'}
              type="button"
              className="composer-model-option"
              data-testid="composer-model-option"
              onClick={() => pickModel(opt.id)}
            >
              <span className="composer-model-option-text">
                <span className="composer-model-option-label">{opt.label}</span>
                {opt.detail && <span className="composer-model-option-detail">{opt.detail}</span>}
              </span>
              {model === opt.id && <CheckIcon />}
            </button>
          ))}
          <div className="composer-model-divider" />
          <div className="composer-model-group">{t('composer.runtimeGroup')}</div>
          {agents.map((a) => {
            if (a.available) {
              return (
                <button
                  key={a.id}
                  type="button"
                  className="composer-model-option"
                  data-testid="composer-runtime-option"
                  onClick={() => pickRuntime(a.id)}
                >
                  <span className="composer-model-option-text">
                    <span className="composer-model-option-label">{a.name}</span>
                  </span>
                  {a.id === agentId && <CheckIcon />}
                </button>
              );
            }
            // 未安装：灰态，点击跳「设置 → 运行时」去安装
            return (
              <button
                key={a.id}
                type="button"
                className="composer-model-option is-unavailable"
                data-testid="composer-runtime-option-unavailable"
                title={t('composer.notInstalledHint')}
                onClick={() => {
                  setShow(false);
                  window.dispatchEvent(new CustomEvent(OPEN_RUNTIME_SETTINGS_EVENT));
                }}
              >
                <span className="composer-model-option-text">
                  <span className="composer-model-option-label">{a.name}</span>
                  <span className="composer-model-option-detail">{t('composer.notInstalledHint')}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
