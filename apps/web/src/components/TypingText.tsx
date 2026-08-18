// apps/web/src/components/TypingText.tsx
// 过程叙事打字机：active 时把 text 按 ~45 字/秒逐字吐出（rAF 驱动），
// 让执行中的自言自语「流出来」而不是「整块蹦出来」。
// - 完成（active=false）或 prefers-reduced-motion 时立即补全，不等动画。
// - shownRef 跨 text 增长保持（delta 到达不重置），text 变化重启 rAF 继续推进。
import { useEffect, useRef, useState } from 'react';

interface Props {
  text: string;
  /** true = 正在流式输出，逐字吐出；false = 立即显示全文。 */
  active: boolean;
}

const CHARS_PER_SEC = 45;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function TypingText({ text, active }: Props) {
  const reduced = useReducedMotion();
  const shownRef = useRef<number>(active && !reduced ? 0 : text.length);
  const [, force] = useState(0);

  useEffect(() => {
    if (!active || reduced) {
      shownRef.current = text.length;
      force((n) => n + 1);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      shownRef.current = Math.min(text.length, shownRef.current + dt * CHARS_PER_SEC);
      force((n) => n + 1);
      if (shownRef.current < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, reduced, text]);

  return <>{text.slice(0, Math.floor(shownRef.current))}</>;
}
