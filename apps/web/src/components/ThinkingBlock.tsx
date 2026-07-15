import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

interface Props {
  content: string;
  streaming?: boolean;
}

export function ThinkingBlock({ content, streaming }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => streaming ?? false);
  const manualRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // 流式时自动展开（除非用户手动折叠过）
  useEffect(() => {
    if (!manualRef.current && streaming) {
      setExpanded(true);
    }
  }, [streaming]);

  // 流式结束 → 重置 manual ref，下次流式重新自动展开
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

  // 流式时显示行数
  const lineCount = content ? content.split('\n').length : 0;
  const headerText = streaming
    ? `${t('thinking.streaming')} (${lineCount} 行)`
    : t('thinking.title');

  return (
    <div className="thinking-block" data-testid="thinking-block">
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
