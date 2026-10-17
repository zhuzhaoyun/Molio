// apps/web/src/components/WorkCompleteBanner.tsx
// 产物卡 —— 逐消息 provenance：本回复写入了哪些知识库文件。
// 移入消息内（AssistantMessage 尾部、SourceChips 之前）；布局与 SourceChips 同语言：
// 发丝边框 pill + 品牌 terracotta 只在 hover/focus 兑现交互。
import { useMemo } from 'react';
import type { ToolEvent } from '../hooks/useChatCore';
import { extractWrites, classifyWritePath, writeKey } from '../utils/toolRefs';
import { useSessionWriteKinds, writeKindOf } from './SessionWriteKinds';
import { isRevealAvailable, revealInFolder } from '../utils/reveal';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVault } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import { FileIcon, FolderIcon } from './icons';

interface Props {
  tools: ToolEvent[];
}

export function WorkCompleteBanner({ tools }: Props) {
  const { t } = useI18n();
  const activeVault = useActiveVault();
  const vaultId = activeVault?.id ?? null;
  const vaultPath = activeVault?.path ?? null;
  // 与产出面板同一分层规则：横幅标题是「产出已写入知识库」，脚本 / 日志 / 库外写入
  // 不是这份会话的产出，混进来就等于给用户两个点不通/找不到的按钮。
  const writes = useMemo(
    () => extractWrites(tools).filter((w) => classifyWritePath(writeKey(w.path, vaultPath ?? undefined)) === 'product'),
    [tools, vaultPath],
  );
  const { openFile } = useFileNavigation();
  // 「在资源管理器中显示」：仅桌面壳（window.__electron__）且选中 vault 时渲染
  const revealReady = isRevealAvailable() && !!vaultPath;
  // 新建 / 更新来自会话级判据（与产出面板同一真值源）；少了这个上下文就判不出来，
  // 此时不标图标 —— 宁可不说，也不要按工具名猜。
  const kinds = useSessionWriteKinds();

  if (writes.length === 0) return null;

  return (
    <div className="work-complete" data-testid="work-complete-banner">
      <span className="work-complete-title">
        <FileIcon size={11} />
        {t('complete.title')}
      </span>
      <div className="work-complete-files">
        {writes.map((w) => {
          const kind = writeKindOf(kinds, w.path, vaultPath ?? undefined);
          return (
          <span key={w.path} className="work-complete-file-wrap">
            <button
              type="button"
              className="work-complete-file"
              data-testid="work-complete-file"
              data-kind={kind ?? ''}
              title={w.path}
              disabled={!vaultId}
              onClick={() => { if (vaultId) openFile(vaultId, w.path); }}
            >
              <span className="work-complete-file-icon" aria-hidden>
                {kind === 'create' ? '＋' : kind === 'update' ? '✎' : ''}
              </span>
              <span className="work-complete-file-label">{w.label}</span>
            </button>
            {revealReady && (
              <button
                type="button"
                className="work-complete-file-reveal"
                data-testid="work-complete-file-reveal"
                title={t('complete.reveal')}
                aria-label={`${t('complete.reveal')} · ${w.path}`}
                onClick={() => { if (vaultPath) revealInFolder(vaultPath, w.path); }}
              >
                <FolderIcon size={11} />
              </button>
            )}
          </span>
          );
        })}
      </div>
    </div>
  );
}
