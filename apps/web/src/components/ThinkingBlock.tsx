import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

interface Props {
  content: string;
  streaming?: boolean;
  /** 运行中是否自动展开 —— 仅当思考是当前视觉焦点时（无工具的纯思考阶段）。
      工具开始运行时置 false → 折叠让位给操作日志。 */
  autoExpand?: boolean;
}

export function ThinkingBlock({ content, streaming, autoExpand }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => streaming && (autoExpand ?? false));
  const manualRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // 运行中：autoExpand 决定自动展开/折叠（焦点转移），用户手动操作后不再跟随
  useEffect(() => {
    if (!streaming) return;
    if (manualRef.current) return;
    setExpanded(!!autoExpand);
  }, [streaming, autoExpand]);

  // 流式结束 → 重置 manual ref，下次流式重新按规则自动
  useEffect(() => {
    if (!streaming) {
      manualRef.current = false;
    }
  }, [streaming]);

  // 自动滚底
  useEffect(() => {
    if (expanded && streaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, expanded, streaming]);

  const toggle = () => {
    manualRef.current = true;
    setExpanded((prev) => !prev);
  };

  // 流式时显示行数；折叠态用中性文案（思考已沉淀、让位给操作日志，不再是"进行中"）
  const lineCount = content ? content.split('\n').length : 0;
  const headerText = !streaming
    ? t('thinking.title')
    : expanded
      ? `${t('thinking.streaming')} (${lineCount} 行)`
      : `${t('thinking.title')} · ${lineCount} 行`;

  return (
    <div className="thinking-block" data-testid="thinking-block" data-collapsed={!expanded}>
      <div className="thinking-header" onClick={toggle}>
        <span>{expanded ? '▾' : '▸'}</span>
        <span>{headerText}</span>
      </div>
      {expanded && (
        <div className="thinking-content" ref={contentRef}>{content}</div>
      )}
    </div>
  );
}
