import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../api/client';
import { useActiveVault, useActiveVaultId } from '../stores/vaultStore';
import { onboardingStore } from '../stores/onboardingStore';
import { isRevealAvailable, revealInFolder } from '../utils/reveal';
import { SaveIcon, CheckIcon, FolderIcon } from './icons';

interface Props {
  /** Raw markdown content of the assistant message to persist. */
  content: string;
  /**
   * Show the action's name next to the icon. Used while the onboarding guide is
   * on the save step: the toolbar is hover-revealed and icon-only, so a first-run
   * user has no way to find "保存到知识库" (user feedback 2026-10-19).
   */
  labeled?: boolean;
}

/** Pick a readable filename from the reply's first non-empty line. */
function deriveTitle(content: string): string {
  const firstLine = content.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // Strip markdown heading markers, leading bullets, and emphasis/inline-code
  // characters so the filename reads as plain text.
  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  const truncated = cleaned.length > 40 ? cleaned.slice(0, 40).trim() : cleaned;
  return truncated || 'AI 回答';
}

function timestampStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * One-click "save this reply to the active knowledge base" button.
 *
 * Writes the assistant message's raw markdown to the active vault as a new
 * .md file (title from the first line + timestamp to avoid collisions).
 * Reuses the .icon-btn / .copied styles so it matches the toolbar visually
 * and gets the same accent pulse on success.
 */
export function SaveToKbButton({ content, labeled }: Props) {
  const vaultId = useActiveVaultId();
  const activeVault = useActiveVault();
  const [saved, setSaved] = useState(false);
  // 保存成功的文件名：驱动「在资源管理器中显示」伴随按钮（与 saved 同一 2.5s 窗口）
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [tip, setTip] = useState<string>(vaultId ? '保存到知识库' : '先选择一个知识库');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 仅桌面壳（window.__electron__）且选中 vault 时提供定位能力（纯浏览器不渲染）
  const canReveal = isRevealAvailable() && !!activeVault?.path;

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Keep the tooltip in sync when the vault selection changes.
  useEffect(() => {
    if (saved) return; // don't clobber a transient "已保存" mid-flight
    setTip(vaultId ? '保存到知识库' : '先选择一个知识库');
  }, [vaultId, saved]);

  const save = useCallback(async () => {
    if (!vaultId) return;
    const filename = `${deriveTitle(content)}-${timestampStamp()}.md`;
    try {
      await api.writeFile(vaultId, filename, content);
      onboardingStore.markSave();
      setSaved(true);
      setSavedPath(filename);
      setTip(`已保存 · ${filename}`);
      if (timerRef.current) clearTimeout(timerRef.current);
      // 成功反馈窗 6s（check + tooltip + 「在资源管理器中显示」伴随图标同进退）：
      // 非技术用户读完 tooltip 再移动鼠标，2.5s 不够用。失败分支维持 2.5s——错误反馈要干脆。
      timerRef.current = setTimeout(() => {
        setSaved(false);
        setSavedPath(null);
        setTip('保存到知识库');
      }, 6000);
    } catch {
      setSaved(false);
      setTip('保存失败');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setTip('保存到知识库'), 2500);
    }
  }, [vaultId, content]);

  // 引导态的文字标签刻意不跟 `tip` 走：保存成功后 tip 会带文件名，作为按钮文字太长。
  const label = !vaultId ? '先选择一个知识库' : saved ? '已保存' : '保存到知识库';

  return (
    <>
      <button
        type="button"
        // labeled 只会在引导的保存步为 true；此时再给一个短促呼吸环，
        // 把「这一步点这里」从文字提示变成视觉提示（保存成功即停）。
        className={`icon-btn${saved ? ' copied' : ''}${labeled ? ' icon-btn--labeled' : ''}${labeled && !saved ? ' icon-btn--guide' : ''}`}
        data-tip={tip}
        data-testid="msg-save-kb-btn"
        onClick={save}
        disabled={!vaultId}
        aria-label={tip}
      >
        {saved ? <CheckIcon size={15} /> : <SaveIcon size={15} />}
        {labeled && <span className="icon-btn__label">{label}</span>}
      </button>
      {saved && canReveal && savedPath && (
        <button
          type="button"
          className="icon-btn"
          data-tip="在资源管理器中显示"
          data-testid="msg-save-kb-reveal-btn"
          aria-label={`在资源管理器中显示 · ${savedPath}`}
          onClick={() => { if (activeVault?.path && savedPath) revealInFolder(activeVault.path, savedPath); }}
        >
          <FolderIcon size={15} />
        </button>
      )}
    </>
  );
}
