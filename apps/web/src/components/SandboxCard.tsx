import { useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useWikiLinkClick } from '../hooks/useWikiLinkClick';
import { CodeBlock } from './CodeBlock';
import {
  clampSandboxValue,
  evaluateRuleSandbox,
  parseRuleSandbox,
  type RuleSandbox,
} from '../utils/ruleSandbox';

interface Props {
  /** 围栏内的原始 JSON 文本。 */
  raw: string;
  /** 围栏是否已闭合。 */
  complete: boolean;
  /** 该消息是否仍在流式输出。 */
  streaming?: boolean;
}

/**
 * 声明式交互块（threshold-axis）：一条轨道、一个可拖参数、若干固定刻度。
 *
 * 拖动参数越过阈值 → 判定实时翻转。全部计算在前端完成，不发任何请求，
 * 也不执行任何来自模型的内容。
 */
export function SandboxCard({ raw, complete, streaming }: Props) {
  const { t } = useI18n();
  const parsed = useMemo(() => parseRuleSandbox(raw), [raw]);

  // 流式中围栏还没闭合：显示占位，不解析半截 JSON。
  if (streaming && !complete) {
    return (
      <div className="sandbox-generating" data-testid="sandbox-generating">
        {t('sandbox.generating')}
      </div>
    );
  }

  // 围栏闭合但内容不合协议：降级为代码块（模型输出不可信，不能吞掉）。
  if (!parsed.ok) {
    return <CodeBlock lang="rule-sandbox" code={raw} streaming={false} />;
  }

  return <SandboxBody sandbox={parsed.sandbox} />;
}

function SandboxBody({ sandbox }: { sandbox: RuleSandbox }) {
  const { t } = useI18n();
  // parseRuleSandbox 保证 params 恰好 1 个（单轴模板）。
  const param = sandbox.params[0];
  if (!param) return null;
  const [value, setValue] = useState(param.value);
  const axisRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const handleProseClick = useWikiLinkClick();

  const verdict = useMemo(
    () => evaluateRuleSandbox(sandbox, { [param.id]: value }),
    [sandbox, param.id, value],
  );

  const step = param.step && param.step > 0 ? param.step : (param.max - param.min) / 100;

  const percent = (v: number) => ((v - param.min) / (param.max - param.min)) * 100;

  const setValueClamped = (next: number) => {
    setValue(clampSandboxValue(next, param.min, param.max));
  };

  const valueFromClientX = (clientX: number): number => {
    const axis = axisRef.current;
    if (!axis) return value;
    const rect = axis.getBoundingClientRect();
    if (rect.width === 0) return value;
    const ratio = (clientX - rect.left) / rect.width;
    return param.min + ratio * (param.max - param.min);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setValueClamped(valueFromClientX(event.clientX));
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setValueClamped(valueFromClientX(event.clientX));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = value + step;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = value - step;
    else if (event.key === 'Home') next = param.min;
    else if (event.key === 'End') next = param.max;
    if (next === null) return;
    event.preventDefault();
    setValueClamped(next);
  };

  const formatValue = (v: number) => `${Math.round(v * 100) / 100}${param.unit ?? ''}`;

  return (
    <div className="sandbox-card" data-testid="sandbox-card">
      <div className="sandbox-card-title" data-testid="sandbox-title">
        {sandbox.title}
      </div>

      <div className="sandbox-axis-wrap">
        <div
          className="sandbox-axis"
          data-testid="sandbox-axis"
          ref={axisRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {sandbox.fixed.map((marker) => (
            <div
              key={marker.id}
              className="sandbox-marker"
              data-testid="sandbox-marker"
              data-marker-id={marker.id}
              style={{ left: `${percent(marker.value)}%` }}
            >
              <span className="sandbox-marker-label">{marker.label}</span>
            </div>
          ))}
          <div
            className="sandbox-handle"
            data-testid="sandbox-handle"
            data-param-id={param.id}
            role="slider"
            tabIndex={0}
            aria-label={param.label}
            aria-valuemin={param.min}
            aria-valuemax={param.max}
            aria-valuenow={Math.round(value * 100) / 100}
            style={{ left: `${percent(value)}%` }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="sandbox-axis-legend">
          <span className="sandbox-axis-endpoint">{formatValue(param.min)}</span>
          <span className="sandbox-axis-label">{param.label}</span>
          <span className="sandbox-axis-endpoint">{formatValue(param.max)}</span>
        </div>
      </div>

      <div className="sandbox-verdict" data-testid="sandbox-verdict" data-tone={verdict.tone}>
        <div className="sandbox-verdict-title" data-testid="sandbox-verdict-title">
          {verdict.title}
        </div>
        <div className="sandbox-verdict-detail" data-testid="sandbox-verdict-detail">
          {verdict.detail}
        </div>
        <div className="sandbox-current-value" data-testid="sandbox-current-value">
          {param.label}：{formatValue(value)}
        </div>
      </div>

      {verdict.sources && verdict.sources.length > 0 && (
        <div className="sandbox-sources" data-testid="sandbox-sources" onClick={handleProseClick}>
          <div className="quiz-section-label">{t('quiz.sources')}</div>
          {verdict.sources.map((source, sourceIndex) => (
            <div className="quiz-source-row" key={`${source.path}-${sourceIndex}`}>
              <button
                type="button"
                className="kb-wiki-link quiz-source"
                data-testid="sandbox-source"
                data-file-path={source.path}
              >
                {source.path}
              </button>
              {source.quote && <span className="quiz-source-quote">{source.quote}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
